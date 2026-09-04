const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// supabase-js instantiates a Realtime client unconditionally (even though
// this app never subscribes to anything), which needs a WebSocket
// implementation — Node 20 has no native `WebSocket` global (that only
// landed in Node 22), so it must be provided explicitly here.

// @supabase/supabase-js has no built-in request timeout — a hung connection
// or an unresponsive Supabase-side incident just hangs the awaiting call
// forever. Confirmed live: two real customers' IVR sessions got stuck for
// 20+ minutes (only ever "resolved" by the periodic stale-call sweep
// correcting the database row after the fact — the actual in-progress call
// handling itself never resumed) when a Supabase request during runIvrMenu
// never came back. Every call site here already checks the returned
// {error} and degrades gracefully (skip this agent, treat as no data,
// fall back to a default) — a custom fetch that aborts after
// SUPABASE_TIMEOUT_MS turns "hangs forever" into "fails after 8s", which
// that existing handling was already written to survive.
const SUPABASE_TIMEOUT_MS = 8000;
function timeoutFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    realtime: { transport: ws },
    global: { fetch: timeoutFetch }
});

// Re-fetched fresh on every call (and every runIvrMenu recursion) rather
// than cached — a supervisor editing the greeting or switching voice/speed
// in the dashboard takes effect on the very next prompt, not after a
// restart. Falls back to safe defaults on error so a config problem can
// never itself break the whole IVR.
async function getIvrConfig() {
    const { data, error } = await supabase
        .from('ivr_config')
        .select('greeting, tts_voice, tts_speed_scale, rating_enabled, menu_enabled')
        .eq('id', 1)
        .single();
    if (error) {
        console.error('❌ Failed to load ivr_config:', error.message);
        // menu_enabled defaults true on error — fail toward the existing
        // interactive-menu behavior, not toward silently skipping it.
        return { greeting: 'Welcome to Chumz customer support.', ttsVoice: null, ttsSpeedScale: 1.0, ratingEnabled: false, menuEnabled: true };
    }
    return {
        greeting: data.greeting,
        ttsVoice: data.tts_voice,
        ttsSpeedScale: data.tts_speed_scale ?? 1.0,
        ratingEnabled: data.rating_enabled ?? false,
        menuEnabled: data.menu_enabled ?? true
    };
}

async function getIvrOptions() {
    const { data, error } = await supabase.from('ivr_options').select('*').order('digit', { ascending: true });
    if (error) {
        console.error('❌ Failed to load ivr_options:', error.message);
        return [];
    }
    return data;
}

async function upsertCallLog(row) {
    const { error } = await supabase.from('call_logs').upsert(row, { onConflict: 'session_id' });
    if (error) console.error('❌ Failed to upsert call_logs:', error.message);
}

async function getAvailableAgentsWithSip() {
    const { data, error } = await supabase
        .from('agents')
        .select('id, name, phone, agent_sip_credentials(sip_username)')
        .eq('status', 'available');
    if (error) {
        console.error('❌ Failed to load available agents:', error.message);
        return [];
    }
    return data.filter(a => a.agent_sip_credentials?.sip_username);
}

async function setAgentStatus(agentId, status) {
    const { error } = await supabase.from('agents').update({ status }).eq('id', agentId);
    if (error) console.error('❌ Failed to update agent status:', error.message);
}

async function getAgentPhone(agentId) {
    const { data, error } = await supabase.from('agents').select('phone').eq('id', agentId).maybeSingle();
    if (error) {
        console.error('❌ Failed to load agent phone:', error.message);
        return null;
    }
    return data?.phone ?? null;
}

async function getAgentBySipUsername(sipUsername) {
    if (!sipUsername) return null;
    const { data, error } = await supabase
        .from('agent_sip_credentials')
        .select('agents(id, name, phone)')
        .eq('sip_username', sipUsername)
        .maybeSingle();
    if (error) {
        console.error('❌ Failed to load agent by SIP username:', error.message);
        return null;
    }
    return data?.agents ?? null;
}

// Reverse of getAgentBySipUsername — needed for agent-to-agent internal
// calling, where the dialed extension carries the target's agents.id (see
// the `_9.` dialplan context) and we need their PJSIP endpoint name to
// originate to. Also returns their current status so the caller can reject
// (rather than blindly ring) a target that isn't actually available —
// best-effort, not a hard lock, same as every other status-flag check in
// this codebase. Returns null (not an error) for an agent with no SIP
// credentials provisioned yet — the caller treats that as "can't reach
// this target" rather than throwing.
async function getAgentSipCredentials(agentId) {
    const { data, error } = await supabase
        .from('agent_sip_credentials')
        .select('sip_username, agents(status)')
        .eq('agent_id', agentId)
        .maybeSingle();
    if (error) {
        console.error('❌ Failed to load SIP credentials for agent:', error.message);
        return null;
    }
    if (!data?.sip_username) return null;
    return { sipUsername: data.sip_username, status: data.agents?.status ?? null };
}

// "No agents online" forwarding — reuses the existing 'no_answer' condition
// (the closest semantic fit of the four already in the schema; there's no
// dedicated "nobody logged in" condition) rather than adding a new one.
async function getNoAgentsForwardingDestination() {
    const { data: config } = await supabase.from('forwarding_config').select('enabled').eq('id', 1).maybeSingle();
    if (!config?.enabled) return null;

    // Ordered defensively even though `condition` is now unique
    // (migration 018) — picks the most recently set one rather than an
    // arbitrary row if this ever runs against a database from before that
    // constraint existed.
    const { data: rule } = await supabase
        .from('forwarding_rules')
        .select('destination')
        .eq('condition', 'no_answer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    return rule?.destination ?? null;
}

// Atomic claim: the UPDATE's own WHERE clause is what prevents a row being
// claimed twice — Postgres commits one request's WHERE add_party_status =
// 'requested' before the next can match it, so overlapping poll ticks (or a
// slow one still in flight when the next fires) can't both originate a leg
// for the same request. Mirrors reconcileStaleCallsOnStartup's same
// update-and-select-in-one-call pattern.
async function claimAddPartyRequests() {
    const { data, error } = await supabase
        .from('call_logs')
        .update({ add_party_status: 'dialing', add_party_updated_at: new Date().toISOString() })
        .eq('add_party_status', 'requested')
        .select('session_id, add_party_destination');
    if (error) {
        console.error('❌ Failed to claim add-party requests:', error.message);
        return [];
    }
    return data ?? [];
}

async function setAddPartyStatus(sessionId, status) {
    const { error } = await supabase
        .from('call_logs')
        .update({ add_party_status: status, add_party_updated_at: new Date().toISOString() })
        .eq('session_id', sessionId);
    if (error) console.error('❌ Failed to update add-party status:', error.message);
}

// Covers a gap the two in-code recovery paths in index.js (bridgeAddPartyDest's
// StasisEnd handler, completeAddParty's bridge-race catch) can't: those only
// ever run for a leg this process actually originated. If claimAddPartyRequests'
// own UPDATE above commits on Supabase's side but this process never receives
// the response (confirmed live — AbortError from timeoutFetch's 8s timeout,
// or a transient Bad Gateway, both seen in production), the row is left at
// 'dialing' with this process never having learned the session id exists —
// nothing else ever looks at it again, since the next poll only claims
// 'requested' rows. Same shape as sweepStaleCalls: age-based reconciliation
// of a non-terminal status, run on the same interval.
async function sweepStaleAddPartyRequests(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const { data, error } = await supabase
        .from('call_logs')
        .update({ add_party_status: 'failed' })
        .eq('add_party_status', 'dialing')
        .lt('add_party_updated_at', cutoff)
        .select('session_id');
    if (error) {
        console.error('❌ Stale add-party sweep failed:', error.message);
        return [];
    }
    return data ?? [];
}

// Fails safe: if the table doesn't exist yet (migration not applied) or the
// query errors for any other reason, treat hours as "not enforced" rather
// than risk blocking every inbound call on a config problem.
async function getBusinessHours() {
    const { data, error } = await supabase.from('business_hours').select('*').eq('id', 1).maybeSingle();
    if (error || !data) {
        if (error) console.error('❌ Failed to load business hours:', error.message);
        return { enabled: false };
    }
    return data;
}

// Same fail-safe shape as getBusinessHours — if the table isn't there yet
// (migration not applied) or the query errors, fall back to Asterisk's
// always-present 'default' class rather than risk startMoh() failing with a
// class that doesn't exist.
async function getHoldMusicConfig() {
    const { data, error } = await supabase.from('hold_music_config').select('*').eq('id', 1).maybeSingle();
    if (error || !data) {
        if (error) console.error('❌ Failed to load hold music config:', error.message);
        return { active_class: 'default' };
    }
    return data;
}

// A call that leaves Stasis while still sitting in a pre-answer status was
// never connected to an agent — genuinely missed. 'ongoing' gets 'completed'
// (not 'failed') here for exactly one reason: a call that survived an
// ari-app restart mid-bridge (see reconcileStaleCallsOnStartup) has no
// teardown() closure left to ever write its real outcome — this global
// StasisEnd handler is the only thing left that will ever see it end, and
// something did answer it, so it doesn't belong in missed-call stats. Both
// updates are safe to run unconditionally for every hung-up channel: each
// only ever matches a row still sitting in the exact status it targets, so
// a call whose own teardown() already wrote 'completed'/'failed' first is
// simply a no-op here — this can never overwrite that real outcome.
async function markMissedIfAbandoned(sessionId) {
    const [preBridge, ongoing] = await Promise.all([
        supabase
            .from('call_logs')
            .update({ status: 'failed' })
            .eq('session_id', sessionId)
            .in('status', ['ivr_started', 'input_received', 'queued']),
        supabase
            .from('call_logs')
            .update({ status: 'completed' })
            .eq('session_id', sessionId)
            .eq('status', 'ongoing')
    ]);
    if (preBridge.error) console.error('❌ Failed to mark abandoned call as failed:', preBridge.error.message);
    if (ongoing.error) console.error('❌ Failed to close out orphaned ongoing call:', ongoing.error.message);
}

// Runs once at startup. This process's in-memory queue/ring-group state
// always starts empty, so any call_logs row still sitting in a non-terminal
// status is orphaned from a previous process instance (crash or deploy
// restart) — but ari-app restarting doesn't touch Asterisk itself, so
// "orphaned in the database" and "the real channel is gone" are two
// different things. `liveChannelIds` (from client.channels.list(), the same
// ground truth reconcileGhostOnCallAgents uses) is what tells them apart:
//   - session_id not live: the channel really is gone — mark 'failed', same
//     as before.
//   - still live, pre-bridge (never reached an agent): nothing will ever
//     ring an agent for this caller or time them out now — they'd otherwise
//     sit on hold music forever. Returned (not hung up here — this module
//     has no ARI client) so index.js can actually end the real call; the
//     existing global StasisEnd handler's markMissedIfAbandoned then closes
//     the row out once that hangup lands, exactly like any other abandoned
//     call.
//   - still live, 'ongoing': a real conversation, still being bridged by
//     Asterisk with zero help from this process — left alone entirely
//     (channel AND row). Forcibly cutting off a live call just because
//     ari-app restarted would be worse than the bug this fixes; the widened
//     markMissedIfAbandoned above closes this row out correctly once the
//     call actually ends.
async function reconcileStaleCallsOnStartup(liveChannelIds) {
    const { data, error } = await supabase
        .from('call_logs')
        .select('session_id, status')
        .in('status', ['ivr_started', 'input_received', 'queued', 'dialing', 'ongoing']);
    if (error) {
        console.error('❌ Failed to load stale calls on startup:', error.message);
        return { reconciled: 0, toHangUp: [] };
    }

    const dead = data.filter(row => !liveChannelIds.has(row.session_id));
    const stillLivePreBridge = data.filter(row => liveChannelIds.has(row.session_id) && row.status !== 'ongoing');

    if (dead.length > 0) {
        const { error: updateError } = await supabase
            .from('call_logs')
            .update({ status: 'failed' })
            .in('session_id', dead.map(row => row.session_id));
        if (updateError) console.error('❌ Failed to mark dead stale calls as failed:', updateError.message);
    }

    return { reconciled: dead.length, toHangUp: stillLivePreBridge.map(row => row.session_id) };
}

// Runs continuously, not just at startup — unlike reconcileStaleCallsOnStartup
// (which checks every non-terminal row against Asterisk's real live-channel
// list once, right when this process's own in-memory state is known to be
// empty), this needs a real age cutoff: most non-terminal rows at any given
// instant are just normal in-progress calls, not orphans, and there's no
// fresh "process just started" moment here to justify a real-channel check
// on every poll. This is the only safety net for a 'dialing' row (an
// outbound call's agent-leg channel) orphaned by anything OTHER than an
// ari-app restart — reconcileStaleCallsOnStartup's own real-channel check
// already covers the restart case for every non-terminal status, 'dialing'
// included. Also still the only thing that will ever clean up an old
// Africa's Talking legacy /events-webhook row (from before calls-app
// stopped writing them, see DECISIONS.md) — those use AT's own
// ATVId_-prefixed session ids, never real Asterisk channel ids, so no
// channel-based check could ever recognize one as abandoned. A real
// still-in-progress call isn't harmed by this running — teardown()'s own
// final upsert (matched by session_id) overwrites whatever this wrote the
// moment the call actually ends for real.
// Two thresholds, not one: a customer legitimately sitting in
// ivr_started/input_received/queued/dialing (never yet bridged to an
// agent) for anywhere near `maxAgeMs` is already a service failure on its
// own — these should time out much sooner than an actual bridged 'ongoing'
// call, which can legitimately run long. Confirmed live: the live/queue
// dashboard was showing a customer as still "incoming" for up to ~20-25
// minutes after an orphaned StasisEnd (ari-app crash/restart, or any
// unhandled exception before the normal hangup path's upsertCallLog runs)
// — splitting the threshold this way cuts that worst case to roughly the
// sweep interval plus preBridgeMaxAgeMs, without touching how long a real
// 'ongoing' call is allowed to run.
async function sweepStaleCalls(preBridgeMaxAgeMs, ongoingMaxAgeMs) {
    const preBridgeCutoff = new Date(Date.now() - preBridgeMaxAgeMs).toISOString();
    const ongoingCutoff = new Date(Date.now() - ongoingMaxAgeMs).toISOString();

    const [preBridgeResult, ongoingResult] = await Promise.all([
        supabase
            .from('call_logs')
            .update({ status: 'failed' })
            .in('status', ['ivr_started', 'input_received', 'queued', 'dialing'])
            .lt('created_at', preBridgeCutoff)
            .select('session_id'),
        supabase
            .from('call_logs')
            .update({ status: 'failed' })
            .eq('status', 'ongoing')
            .lt('created_at', ongoingCutoff)
            .select('session_id')
    ]);

    if (preBridgeResult.error) console.error('❌ Stale-call sweep (pre-bridge) failed:', preBridgeResult.error.message);
    if (ongoingResult.error) console.error('❌ Stale-call sweep (ongoing) failed:', ongoingResult.error.message);

    return [...(preBridgeResult.data ?? []), ...(ongoingResult.data ?? [])];
}

// This process's in-memory bridge/pending-call state always starts empty, so
// any agent still marked 'on_call' from before a restart cannot actually be
// on a call this process knows about or can ever clean up — left alone
// they'd silently sit out of ring-all rotation forever, with no heartbeat
// check ever correcting it (reconcileGhostAgents deliberately excludes
// on_call, since a *real* on-call agent's heartbeat legitimately goes stale
// while the softphone tab is busy with a call, not because they left).
async function reconcileStaleAgentsOnStartup() {
    const { data, error } = await supabase
        .from('agents')
        .update({ status: 'available' })
        .eq('status', 'on_call')
        .select('id');
    if (error) {
        console.error('❌ Failed to reconcile stale on-call agents on startup:', error.message);
        return 0;
    }
    return data?.length ?? 0;
}

// "Ghost agent" fix: agents.status alone is never trustworthy on its own —
// a row seeded/provisioned with status='available' that nobody ever
// actually logged into, or a browser tab that died without a clean logout,
// stays "available" forever with nothing to correct it, and the dashboard
// (and ring-all) both trust it blindly. last_seen_at is stamped by the
// browser's heartbeat (PATCH /api/agents/me/heartbeat, sent every ~20s
// while the softphone is registered) and by any explicit status change —
// anyone claiming to be available/ringing without a recent heartbeat is
// flipped back to offline. Scoped to agents with SIP credentials only:
// agents still on the old real-phone-ring flow don't run a browser
// heartbeat at all, and "available" legitimately doesn't require one for them.
const GHOST_AGENT_STALE_MS = 90 * 1000;

async function reconcileGhostAgents() {
    // Compared as epoch millis, not raw strings — Postgres/PostgREST's
    // "+00:00" suffix and JS's own toISOString() "Z" suffix don't sort
    // consistently against each other as plain strings.
    const staleBeforeMs = Date.now() - GHOST_AGENT_STALE_MS;

    const { data, error } = await supabase
        .from('agents')
        .select('id, last_seen_at, agent_sip_credentials(sip_username)')
        .in('status', ['available', 'ringing']);

    if (error) {
        console.error('❌ Failed to check for ghost agents:', error.message);
        return 0;
    }

    const staleIds = data
        .filter(a => a.agent_sip_credentials?.sip_username)
        .filter(a => !a.last_seen_at || new Date(a.last_seen_at).getTime() < staleBeforeMs)
        .map(a => a.id);

    if (staleIds.length === 0) return [];

    const { error: updateError } = await supabase.from('agents').update({ status: 'offline' }).in('id', staleIds);
    if (updateError) {
        console.error('❌ Failed to reconcile ghost agents:', updateError.message);
        return [];
    }

    return staleIds;
}

// Runtime counterpart to reconcileStaleAgentsOnStartup: reconcileGhostAgents
// deliberately never touches on_call (a real on-call agent's heartbeat
// legitimately goes stale while the softphone tab is busy with a call), and
// the startup reconciliation only ever runs once, at process start. If this
// process's own bridge-teardown listener never fires for a given call
// (crashed listener, an orphaned channel, an unhandled exception before
// cleanup runs), nothing else ever corrects that agent's status — they sit
// out of both ring-all and internal-call routing (which rejects any target
// not exactly 'available') until the whole process restarts. Returns just
// the sip_username needed to cross-check against Asterisk's live channel
// list — see reconcileGhostOnCallAgents in index.js for why that's the
// ground truth used, not this process's own in-memory bookkeeping.
async function getOnCallAgentsWithSip() {
    const { data, error } = await supabase
        .from('agents')
        .select('id, agent_sip_credentials(sip_username)')
        .eq('status', 'on_call');
    if (error) {
        console.error('❌ Failed to load on-call agents:', error.message);
        return [];
    }
    return data.filter(a => a.agent_sip_credentials?.sip_username).map(a => ({ id: a.id, sipUsername: a.agent_sip_credentials.sip_username }));
}

module.exports = {
    supabase,
    getIvrConfig,
    getIvrOptions,
    upsertCallLog,
    getAvailableAgentsWithSip,
    setAgentStatus,
    getAgentPhone,
    getAgentBySipUsername,
    getAgentSipCredentials,
    getNoAgentsForwardingDestination,
    getBusinessHours,
    getHoldMusicConfig,
    claimAddPartyRequests,
    setAddPartyStatus,
    sweepStaleAddPartyRequests,
    markMissedIfAbandoned,
    reconcileStaleCallsOnStartup,
    reconcileStaleAgentsOnStartup,
    reconcileGhostAgents,
    getOnCallAgentsWithSip,
    sweepStaleCalls
};
