const crypto = require('crypto');
const { isValidE164, normalizePhone } = require('./lib/phone');
const { invalidateAgentCache } = require('./lib/agentCache');

// A cross-VPS call to ari-app's internal provisioning endpoint (see Track B
// of the SIP-provisioning plan) — mirrors the SUPABASE_TIMEOUT_MS pattern
// already used on the ari-app side (ari-app/supabase.js): a hung WAN call
// must not hang the supervisor's request indefinitely.
const INTERNAL_SYNC_TIMEOUT_MS = 10000;

async function syncAgentToAsterisk(supabase, agentId, sipUsername, sipPassword) {
    const internalUrl = process.env.ARI_APP_INTERNAL_URL;
    const internalSecret = process.env.ARI_APP_INTERNAL_SECRET;
    if (!internalUrl || !internalSecret) {
        console.error('❌ ARI_APP_INTERNAL_URL/ARI_APP_INTERNAL_SECRET not configured — cannot sync SIP credentials to Asterisk');
        return { ok: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INTERNAL_SYNC_TIMEOUT_MS);
    try {
        const response = await fetch(`${internalUrl}/internal/provision-agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Chumz-Internal-Secret': internalSecret },
            body: JSON.stringify({ agentId, sipUsername, sipPassword }),
            signal: controller.signal
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error(`❌ ari-app provision-agent responded ${response.status}: ${body}`);
            return { ok: false };
        }
        await supabase.from('agent_sip_credentials').update({ asterisk_synced_at: new Date().toISOString() }).eq('agent_id', agentId);
        return { ok: true };
    } catch (err) {
        console.error('❌ Failed to sync SIP credentials to Asterisk:', err.message);
        return { ok: false };
    } finally {
        clearTimeout(timer);
    }
}

// Must match ari-app/supabase.js's GHOST_AGENT_STALE_MS — this is only used
// to keep the topbar's "N agents live" count from overcounting a dead tab
// during the window before that sweep flips it back to offline, not to
// enforce staleness itself (ari-app owns that).
const GHOST_AGENT_STALE_MS = 90 * 1000;

// JSON API for the React web app (/web). Mirrors the data shown on the old
// HTML dashboard (dashboard.js, now removed) but as JSON instead of rendered
// markup.
module.exports = function (app, supabase, requireAuth, requireSupervisor) {

    // A row is a pure agent-leg record (see app.js's /events handler) —
    // exclude it from caller-facing call lists, it only feeds agent stats.
    // Real outbound calls (agent dialing out via the browser softphone) also
    // carry agent_number with no option_pressed, but are explicitly tagged
    // direction='Outbound' and must NOT be swept up by this heuristic.
    function isAgentLegRow(row) {
        return !!row.agent_number && !row.option_pressed && row.direction !== 'Outbound';
    }

    // Ticket write endpoints validate enum fields (priority/status) but let
    // every free-text field through unchecked — this at least guards the
    // shape (a string, within a sane length) without requiring a schema
    // library for one endpoint.
    function isValidTicketText(value, maxLen) {
        return typeof value === 'string' && value.length <= maxLen;
    }

    // tickets.assigned_agent_id is `bigint references agents(id)` — a
    // number, not free text. The frontend's assignee dropdown always sends
    // it as a JSON number, which isValidTicketText's `typeof === 'string'`
    // check rejected outright — assigning an agent at ticket creation (or
    // via a later edit) failed with "Invalid assigned_agent_id" every time.
    function isValidAgentId(value) {
        return Number.isInteger(value);
    }

    // Cheap enough at this project's scale to just fetch and map by phone
    // per-request (same pattern GET /api/agents/stats already uses) rather
    // than a SQL join — the agents table is tiny.
    async function attachAgentNames(rows) {
        const { data: agentRows } = await supabase.from('agents').select('id, phone, name');
        // agent_id is the reliable match — set by ari-app on every call since
        // migration 016. agent_number is the fallback for rows written before
        // that (or if a phone happens to be the only thing set): the
        // softphone flow keeps agents.phone's leading +, the legacy Africa's
        // Talking flow strips it (app.js's normalizePhone), so both sides are
        // normalized to the same no-plus form here rather than matched as-is.
        const nameById = new Map((agentRows || []).map(a => [a.id, a.name]));
        const nameByPhone = new Map((agentRows || []).map(a => [normalizePhone(a.phone), a.name]));
        return rows.map(row => ({
            ...row,
            agent_name:
                (row.agent_id != null ? nameById.get(row.agent_id) : null) ??
                (row.agent_number ? nameByPhone.get(normalizePhone(row.agent_number)) ?? null : null)
        }));
    }

    // Best-effort direction classification. IVR-originated rows often don't
    // have `direction` set until the /events callback lands, so absence of
    // an explicit 'Outbound' is treated as incoming. Verify against real
    // traffic before relying on this for anything business-critical.
    function classifyDirection(row) {
        if (row.direction === 'Outbound') return 'outgoing';
        return 'incoming';
    }

    // A call is "missed" if it was made (or forwarded) but no Chumz agent
    // ever actually picked it up: abandoned before anyone answered
    // ('failed' — see markMissedIfAbandoned in the ARI app), routed
    // elsewhere because nobody was online ('forwarded'), or arriving
    // outside business hours ('after_hours'). All three are distinct
    // reasons for the same underlying fact.
    function isMissed(row) {
        return row.status === 'failed' || row.status === 'forwarded' || row.status === 'after_hours';
    }

    // Stamps last_seen_at alongside the status change — any explicit change
    // (the agent themselves, or a supervisor confirming it by hand) is a
    // live signal, so it resets the staleness clock reconcileGhostAgents
    // (ari-app) uses, preventing a freshly-set "available" from being swept
    // back to offline before the next heartbeat lands. Falls back to a
    // plain status update if last_seen_at doesn't exist yet (migration
    // 010_agent_last_seen.sql not yet applied) — status changes must keep
    // working regardless of migration timing.
    async function updateAgentStatus(agentId, fields) {
        const result = await supabase
            .from('agents')
            .update({ ...fields, last_seen_at: new Date().toISOString() })
            .eq('id', agentId)
            .select()
            .single();

        if (result.error?.message?.includes('last_seen_at')) {
            return supabase.from('agents').update(fields).eq('id', agentId).select().single();
        }

        return result;
    }

    // Going "available" just flips the DB flag — the ARI app rings this
    // agent's *browser* directly the moment it sees status='available'. An
    // agent with no row in agent_sip_credentials has no browser softphone to
    // ring at all, so there's nothing useful "available" can mean for them
    // yet (the old fallback here — a real, billed phone call into a
    // phone-standby hold-queue loop — was removed 2026-08-19: the queue it
    // dequeued from had nothing feeding it since real inbound calls moved to
    // the SIP trunk, so it always just told the agent "No calls waiting").
    async function setAgentStatus(agent, status) {
        if (status !== 'available') {
            return updateAgentStatus(agent.id, { status });
        }

        const { data: sipCreds } = await supabase
            .from('agent_sip_credentials')
            .select('agent_id')
            .eq('agent_id', agent.id)
            .maybeSingle();

        if (!sipCreds) {
            throw new Error('No softphone set up for your account yet — ask a supervisor to provision one before going available');
        }

        return updateAgentStatus(agent.id, { status: 'available' });
    }

    app.get('/api/me', requireAuth, (req, res) => {
        res.json({ user: req.user });
    });

    // GET /api/calls?tab=all|incoming|outgoing|missed&option=&status=&ticket=&caller=&from=&to=
    // GET /api/calls?tab=...&page=1&pageSize=50 — tab/isAgentLegRow filtering
    // happens in JS (see below), so pagination is applied after that rather
    // than via a SQL .range(), which would need every one of those filters
    // translated into (and correctly composed as) PostgREST query params —
    // riskier to get subtly wrong than fetching a wide-enough page and
    // slicing it. Fine at this project's scale; worth revisiting only if
    // call_logs grows enough that a 2000-row fetch itself becomes the
    // bottleneck (see SYSTEM_DESIGN.md).
    app.get('/api/calls', requireAuth, async (req, res) => {
        const { tab, to, option, status, ticket, caller } = req.query;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));

        // Caps the common case (no explicit range = "recent activity") so
        // this doesn't keep fetching more rows every day forever as
        // call_logs grows — a caller who explicitly asks for a wider range
        // still gets exactly that, unchanged.
        const DEFAULT_WINDOW_DAYS = 30;
        const from = req.query.from || new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

        let query = supabase
            .from('call_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(2000);

        query = query.gte('created_at', `${from}T00:00:00`);
        if (to) query = query.lte('created_at', `${to}T23:59:59`);
        if (option) query = query.eq('option_pressed', option);
        if (status) query = query.eq('status', status);
        if (ticket) query = query.eq('ticket_status', ticket);
        if (caller) query = query.ilike('caller', `%${caller}%`);

        const { data, error } = await query;

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load calls' });
        }

        let calls = data.filter(row => !isAgentLegRow(row)).map(row => ({
            ...row,
            direction: classifyDirection(row),
            missed: isMissed(row)
        }));

        // classifyDirection() calls anything that isn't an explicit Outbound
        // row "incoming" — which includes abandoned/forwarded/after-hours
        // rows, since those never got an Outbound leg either. Left alone,
        // that makes "Incoming" nearly identical to "All" (everything minus
        // outbound) instead of just the calls an agent actually answered, so
        // every tab here also excludes/requires isMissed to keep the three
        // tabs a true, non-overlapping partition of "All".
        // NOTE: calls[].direction was already set to classifyDirection(row)'s
        // *result* ('incoming'/'outgoing') by the .map() above — checking it
        // directly here rather than calling classifyDirection() again.
        // classifyDirection() itself checks row.direction === 'Outbound', so
        // re-calling it on these already-transformed rows compared that
        // literal string against 'incoming'/'outgoing' and always fell
        // through to 'incoming' — the outgoing tab was empty, summary.outbound
        // was always 0, and every tab downstream of it inherited the same
        // wrong classification. classifyDirection() is still correct to call
        // on `data` (the raw, untransformed rows) elsewhere below.
        if (tab === 'incoming') calls = calls.filter(row => row.direction === 'incoming' && !isMissed(row));
        if (tab === 'outgoing') calls = calls.filter(row => row.direction === 'outgoing');

        if (tab === 'missed') {
            // Also requires 'incoming' so a failed *outbound* dial (which
            // gets status 'failed' too, see finishOutboundCall in the ARI
            // app) shows up only in Outgoing, not double-counted here as a
            // missed inbound call.
            calls = calls.filter(row => isMissed(row) && row.direction === 'incoming');

            // Tells the agent at a glance whether this caller has already
            // been called back — derived from the data itself (any later
            // Outbound row to the same number) rather than a separate
            // tracked flag, so it can never drift out of sync with what
            // actually happened.
            const outboundTimesByCaller = new Map();
            data.forEach(row => {
                if (classifyDirection(row) !== 'outgoing' || !row.caller) return;
                const times = outboundTimesByCaller.get(row.caller) ?? [];
                times.push(row.created_at);
                outboundTimesByCaller.set(row.caller, times);
            });
            calls = calls.map(row => ({
                ...row,
                called_back: (outboundTimesByCaller.get(row.caller) ?? []).some(t => new Date(t) > new Date(row.created_at))
            }));
        }

        const summary = {
            total: calls.length,
            login: calls.filter(c => c.option_pressed === '1').length,
            deposit: calls.filter(c => c.option_pressed === '2').length,
            agentRequests: calls.filter(c => c.option_pressed === '3').length,
            outbound: calls.filter(c => c.direction === 'outgoing').length,
            // Inbound-only, same reasoning as the missed-tab filter above —
            // a failed outbound dial shouldn't inflate this into counting
            // calls Chumz placed as calls Chumz "missed".
            missed: calls.filter(c => isMissed(c) && c.direction === 'incoming').length,
            missedByReason: {
                abandoned: calls.filter(c => c.status === 'failed' && c.direction === 'incoming').length,
                forwarded: calls.filter(c => c.status === 'forwarded').length,
                afterHours: calls.filter(c => c.status === 'after_hours').length
            }
        };

        const rangeStart = (page - 1) * pageSize;
        const pageOfCalls = await attachAgentNames(calls.slice(rangeStart, rangeStart + pageSize));

        res.json({
            calls: pageOfCalls,
            page,
            pageSize,
            total: calls.length,
            totalPages: Math.max(1, Math.ceil(calls.length / pageSize)),
            summary
        });
    });

    // GET /api/calls/live — every call currently in flight (IVR, queued, or
    // mid-conversation). Used by the Dashboard's "Live Now" panel; the
    // dedicated Live Queue page uses /api/queue below for the narrower
    // "who's actually waiting" view with wait-time stats.
    app.get('/api/calls/live', requireAuth, async (req, res) => {
        const { data, error } = await supabase
            .from('call_logs')
            .select('*')
            .in('status', ['ivr_started', 'input_received', 'queued', 'ongoing'])
            .order('created_at', { ascending: false });

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load live calls' });
        }

        res.json({ calls: await attachAgentNames(data.filter(row => !isAgentLegRow(row))) });
    });

    // GET /api/queue — the Live Queue page: this is the design's intended
    // incoming-calls screen, so it needs to show a call from the moment it
    // reaches the IVR, not just once it's actually on hold (status
    // 'queued'). Rows are informational, not individually actionable from
    // the browser — accepting a call happens by an available agent pressing
    // a digit on their phone (see SYSTEM_DESIGN.md), not by clicking a row.
    app.get('/api/queue', requireAuth, async (req, res) => {
        const { data, error } = await supabase
            .from('call_logs')
            .select('*')
            .in('status', ['ivr_started', 'input_received', 'queued'])
            .order('created_at', { ascending: true });

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load queue' });
        }

        const rows = data.map(row => ({
            ...row,
            stage: row.status === 'queued' ? 'Waiting' : 'In Menu',
            waitSeconds: Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000)
        }));

        // Wait-time stats only count callers actually on hold — someone
        // still navigating the IVR menu hasn't started waiting for an agent
        // yet, so including them would understate how long the queue really is.
        const waits = rows.filter(row => row.stage === 'Waiting').map(row => row.waitSeconds);

        res.json({
            calls: rows,
            stats: {
                inQueue: waits.length,
                avgWaitSeconds: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
                longestWaitSeconds: waits.length ? Math.max(...waits) : 0
            }
        });
    });

    // ── Dashboard: calls by hour ─────────────────────────────────────────
    // Must be registered before /api/calls/:sessionId below — Express
    // matches routes in registration order, and "by-hour" is itself a valid
    // (if useless) session id as far as that dynamic route is concerned. It
    // silently swallowed every request here for a while before this was
    // caught: always returned {call: null}, so the calls-by-hour chart
    // (Dashboard and Analytics) was permanently empty.
    app.get('/api/calls/by-hour', requireAuth, async (req, res) => {
        // setHours()/getHours() run in the server's own timezone (UTC on
        // DigitalOcean App Platform), not Nairobi's — shifting every bucket by however far off
        // that is and misattributing the hours right around Nairobi midnight
        // to the wrong calendar day. ari-app's isWithinBusinessHours has the
        // exact same hazard and solves it the same way: manually apply the
        // EAT offset (Nairobi has no DST, always UTC+3) and read back with
        // the UTC getters instead of trusting the process's local time.
        const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
        const nairobiNow = new Date(Date.now() + EAT_OFFSET_MS);
        const startOfDayNairobi = Date.UTC(nairobiNow.getUTCFullYear(), nairobiNow.getUTCMonth(), nairobiNow.getUTCDate());
        const startOfDay = new Date(startOfDayNairobi - EAT_OFFSET_MS);

        const { data, error } = await supabase
            .from('call_logs')
            .select('created_at')
            .gte('created_at', startOfDay.toISOString());

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load call volume' });
        }

        const hourCounts = new Array(24).fill(0);
        data.forEach(row => {
            const hour = new Date(new Date(row.created_at).getTime() + EAT_OFFSET_MS).getUTCHours();
            hourCounts[hour]++;
        });

        res.json({
            hours: hourCounts.map((count, hour) => ({ hour, count }))
        });
    });

    // GET /api/calls/:sessionId — a single call's current state, by session
    // id. Used by the floating dialer to poll for "is the call I just placed
    // still dialing / connected / over" without any push infra. Registered
    // after /api/calls/live, /api/queue, and /api/calls/by-hour above so
    // those literal paths aren't shadowed by this dynamic segment.
    app.get('/api/calls/:sessionId', requireAuth, async (req, res) => {
        const { data, error } = await supabase
            .from('call_logs')
            .select('*')
            .eq('session_id', req.params.sessionId)
            .maybeSingle();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load call' });
        }

        res.json({ call: data ?? null });
    });

    // A bare count, not the roster itself — safe for the topbar's "N agents
    // live" badge to show to any authenticated user, unlike the full
    // roster (which is requireSupervisor-gated below, phone numbers/emails
    // included).
    app.get('/api/agents/available-count', requireAuth, async (req, res) => {
        const { data, error } = await supabase
            .from('agents')
            .select('id, last_seen_at, agent_sip_credentials(sip_username)')
            .eq('status', 'available');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load agent count' });
        }

        // Mirrors ari-app's ghost-agent staleness check so this badge
        // doesn't overcount a dead tab for the ~90s window before that
        // sweep would otherwise flip it back to offline. Agents with no SIP
        // credentials are on the legacy phone-ring flow and never send a
        // browser heartbeat at all, so they're not held to this check.
        const staleBeforeMs = Date.now() - GHOST_AGENT_STALE_MS;
        const count = data.filter(a => {
            if (!a.agent_sip_credentials?.sip_username) return true;
            return a.last_seen_at && new Date(a.last_seen_at).getTime() >= staleBeforeMs;
        }).length;

        res.json({ count });
    });

    // A live snapshot of the roster's presence, for the Analytics page —
    // any authenticated user can see the aggregate counts (no names/phones
    // exposed here, that's the requireSupervisor roster route below).
    app.get('/api/agents/status-summary', requireAuth, async (req, res) => {
        const { data, error } = await supabase.from('agents').select('status');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load agent status summary' });
        }

        const counts = { available: 0, on_call: 0, ringing: 0, break: 0, offline: 0 };
        data.forEach(a => {
            if (a.status in counts) counts[a.status]++;
        });

        res.json({ counts });
    });

    // Any authenticated user can see performance numbers (an agent needs
    // their own for the Dashboard's "My performance" card) — but the
    // response is name-based, not phone-number-based, so plain agents don't
    // get a side-channel view of colleagues' raw phone numbers through an
    // endpoint that was never meant to expose the roster (that's
    // requireSupervisor-gated separately, below).
    app.get('/api/agents/stats', requireAuth, async (req, res) => {
        // Pagination is opt-in (only kicks in if the caller explicitly asks
        // for a page) — Dashboard's leaderboard and "my performance" card
        // both need the *complete* set to sort/look up against correctly,
        // the same way it always has; only the Agents page's Performance
        // table asks for a page.
        const explicitPaging = req.query.page !== undefined || req.query.pageSize !== undefined;
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

        const [{ data: callData, error: callError }, { data: agentRows, error: agentError }] = await Promise.all([
            // No .not('agent_number', 'is', null) filter here anymore — that
            // silently excluded every call from an agent with no phone
            // number set (9 of 10 real agents, confirmed live) before it
            // even reached the JS below, since their calls only ever had
            // agent_id set, never agent_number.
            supabase.from('call_logs').select('agent_id, agent_number, status, duration, direction'),
            supabase.from('agents').select('id, name, phone')
        ]);

        if (callError || agentError) {
            console.error(callError || agentError);
            return res.status(500).json({ error: 'Failed to load agent stats' });
        }

        // agent_id (set by ari-app since migration 016) is the reliable
        // match. agent_number is the fallback for rows written before that —
        // it isn't even stored consistently on its own: the softphone flow
        // keeps agents.phone's leading +, the legacy Africa's Talking flow
        // strips it (app.js's normalizePhone), so both sides are normalized
        // to the same no-plus form for keying/lookup here.
        const agentById = new Map(agentRows.map(a => [a.id, a]));
        const nameByPhone = new Map(agentRows.map(a => [normalizePhone(a.phone), a]));

        const stats = {};
        callData.forEach(row => {
            let agent = row.agent_id != null ? agentById.get(row.agent_id) : null;
            if (!agent && row.agent_number) agent = nameByPhone.get(normalizePhone(row.agent_number));

            // A row with neither field set never had an agent at all (e.g.
            // an abandoned call nobody answered) — nothing to bucket. A row
            // with agent_number set but matching no *current* agent (a
            // stray/legacy value) still gets its own "Unknown agent" bucket,
            // same as before, keyed by that raw value so it doesn't merge
            // with a different stray value.
            if (!agent && !row.agent_number) return;
            const key = agent ? `id:${agent.id}` : `unknown:${normalizePhone(row.agent_number)}`;

            if (!stats[key]) stats[key] = { agent, total: 0, answered: 0, missed: 0, durationSum: 0 };
            stats[key].total++;
            if (row.status === 'completed') {
                stats[key].answered++;
                stats[key].durationSum += row.duration || 0;
            } else if (isMissed(row) && classifyDirection(row) === 'incoming') {
                // Matches GET /api/calls' definition exactly — these two
                // endpoints previously disagreed (this one also excluded
                // 'forwarded'/'after_hours' and included the now-unused
                // 'unknown'), which would have made any missed-call chart
                // built from both sources visibly inconsistent. The direction
                // check matters here specifically: an agent's own failed
                // outbound callback (e.g. clicking "Call back" on a missed
                // call and the customer not answering) has agent_number set
                // and status 'failed' too — without this, it inflated that
                // agent's missed count with calls they placed, not calls
                // they failed to answer.
                stats[key].missed++;
            }
        });

        const allAgents = Object.values(stats).map(s => ({
            id: s.agent?.id ?? null,
            name: s.agent?.name ?? 'Unknown agent',
            total: s.total,
            answered: s.answered,
            missed: s.missed,
            avgHandleTime: s.answered ? Math.round(s.durationSum / s.answered) : 0
        }));

        if (!explicitPaging) {
            return res.json({ agents: allAgents, page: 1, pageSize: allAgents.length, total: allAgents.length, totalPages: 1 });
        }

        const rangeStart = (page - 1) * pageSize;

        res.json({
            agents: allAgents.slice(rangeStart, rangeStart + pageSize),
            page,
            pageSize,
            total: allAgents.length,
            totalPages: Math.max(1, Math.ceil(allAgents.length / pageSize))
        });
    });

    // Lets an agent flip their own presence without needing to already know
    // their agent id — resolved from the JWT's baked-in agentId (set once
    // at login) when present, falling back to an email match for sessions
    // issued before that existed. Agents with neither linked need a
    // supervisor to set their status via the roster endpoints instead.
    app.patch('/api/agents/me/status', requireAuth, async (req, res) => {
        const { status } = req.body;

        if (!['available', 'break', 'offline'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const agentQuery = req.user.agentId
            ? supabase.from('agents').select().eq('id', req.user.agentId)
            : supabase.from('agents').select().ilike('email', req.user.email);
        const { data: agent, error: lookupError } = await agentQuery.maybeSingle();

        if (lookupError || !agent) {
            return res.status(404).json({ error: 'No agent record linked to your account yet' });
        }

        try {
            const { data, error } = await setAgentStatus(agent, status);
            if (error) throw new Error(error.message);
            invalidateAgentCache();
            res.json({ agent: data });
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });

    // Sent every ~20s by the browser softphone while its WebRTC registration
    // is live (see softphone.tsx) — this is what lets reconcileGhostAgents
    // (ari-app) tell a genuinely-connected "available" agent apart from one
    // whose status is stale left over from a dead tab, a lost connection, or
    // just how the row was seeded/provisioned. Not requireSupervisor — an
    // agent calling this only ever touches their own row.
    app.patch('/api/agents/me/heartbeat', requireAuth, async (req, res) => {
        // update() matching zero rows is not an error as far as Supabase is
        // concerned — an email mismatch here would silently no-op forever,
        // which is exactly what happened before this used agentId: the
        // heartbeat "succeeded" on every call while never actually touching
        // any row, so reconcileGhostAgents (ari-app) kept correctly-per-its-
        // own-logic flipping a genuinely-connected agent back to offline
        // every ~90s, since nothing was ever refreshing last_seen_at.
        const query = req.user.agentId
            ? supabase.from('agents').update({ last_seen_at: new Date().toISOString() }).eq('id', req.user.agentId)
            : supabase.from('agents').update({ last_seen_at: new Date().toISOString() }).ilike('email', req.user.email);
        const { error } = await query;

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to record heartbeat' });
        }

        res.json({ ok: true });
    });

    // Name-only list any authenticated user can fetch — enough to populate
    // a ticket's "assign to" dropdown without exposing the full roster
    // (phone numbers, emails) that GET /api/agents (below) is gated on.
    app.get('/api/agents/assignable', requireAuth, async (req, res) => {
        const { data, error } = await supabase.from('agents').select('id, name').order('name');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load agents' });
        }

        res.json({ agents: data });
    });

    // Drives the active-call status bar and the wrap-up prompt: the
    // logged-in agent's own in-progress call, if any. `call_logs.agent_number`
    // is tagged by /events once Dequeue bridges someone to this agent's
    // phone (see app.js) — this just looks that row up by the agent's own
    // linked phone number.
    app.get('/api/agents/me/active-call', requireAuth, async (req, res) => {
        const agentQuery = req.user.agentId
            ? supabase.from('agents').select('phone, status').eq('id', req.user.agentId)
            : supabase.from('agents').select('phone, status').ilike('email', req.user.email);
        const { data: agent } = await agentQuery.maybeSingle();

        if (!agent) {
            return res.json({ call: null, agentStatus: null });
        }

        // agent_id (set by ari-app since migration 016) first — the only
        // reliable match, since agent_number requires agents.phone to be
        // set at all, which it never is for an agent provisioned through
        // the modern SIP flow (confirmed live: 9 of 10 real agents), no
        // matter how the phone-format mismatch below is handled. Falls back
        // to the old phone-based match only for rows written before that
        // migration.
        let call = null;
        if (req.user.agentId) {
            const { data } = await supabase
                .from('call_logs')
                .select('*')
                .eq('agent_id', req.user.agentId)
                .eq('status', 'ongoing')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            call = data;
        }
        if (!call && agent.phone) {
            // agent_number isn't stored consistently: the softphone flow
            // writes agents.phone as-is (with its leading +), but the legacy
            // Africa's Talking flow runs it through normalizePhone() first,
            // which strips it (app.js).
            const { data } = await supabase
                .from('call_logs')
                .select('*')
                .in('agent_number', [agent.phone, normalizePhone(agent.phone)])
                .eq('status', 'ongoing')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            call = data;
        }

        res.json({ call: call ?? null, agentStatus: agent.status });
    });

    // Blind-add-a-party MVP: ari-app has no HTTP server of its own, so these
    // two columns on the agent's own ongoing call_logs row are the only way
    // to signal a live call in progress — ari-app's poll loop claims
    // add_party_status='requested' rows and originates the new leg itself.
    // `GET /api/agents/me/active-call` above already returns these columns
    // for free (it selects '*'), so the frontend can poll status with zero
    // extra endpoint work.
    app.post('/api/calls/active/add-party', requireAuth, async (req, res) => {
        const { destination } = req.body;
        if (typeof destination !== 'string' || !destination.trim()) {
            return res.status(400).json({ error: 'Destination is required' });
        }

        const agentQuery = req.user.agentId
            ? supabase.from('agents').select('phone').eq('id', req.user.agentId)
            : supabase.from('agents').select('phone').ilike('email', req.user.email);
        const { data: agent } = await agentQuery.maybeSingle();
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        // See the matching comment on GET /api/agents/me/active-call above —
        // agent_id first (the only reliable match), agent_number as a
        // fallback for rows written before migration 016.
        let call = null;
        if (req.user.agentId) {
            const { data } = await supabase
                .from('call_logs')
                .select('session_id, add_party_status')
                .eq('agent_id', req.user.agentId)
                .eq('status', 'ongoing')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            call = data;
        }
        if (!call && agent.phone) {
            const { data } = await supabase
                .from('call_logs')
                .select('session_id, add_party_status')
                .in('agent_number', [agent.phone, normalizePhone(agent.phone)])
                .eq('status', 'ongoing')
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();
            call = data;
        }

        if (!call) {
            return res.status(400).json({ error: 'No active call' });
        }
        if (['requested', 'dialing'].includes(call.add_party_status)) {
            return res.status(409).json({ error: 'Already adding a party to this call' });
        }

        const { error } = await supabase
            .from('call_logs')
            .update({ add_party_destination: destination.trim(), add_party_status: 'requested' })
            .eq('session_id', call.session_id);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to request add-party' });
        }

        res.json({ ok: true });
    });

    // Lets the React app register as a real WebRTC softphone (SIP.js) —
    // credentials are provisioned server-side in agent_sip_credentials, kept
    // in its own table (not columns on `agents`) since they're a more
    // sensitive device secret than anything else exposed about an agent.
    app.get('/api/agents/me/sip-credentials', requireAuth, async (req, res) => {
        const agentQuery = req.user.agentId
            ? supabase.from('agents').select('id').eq('id', req.user.agentId)
            : supabase.from('agents').select('id').ilike('email', req.user.email);
        const { data: agent } = await agentQuery.maybeSingle();

        if (!agent) {
            return res.status(404).json({ error: 'No agent record linked to your account yet' });
        }

        const { data: creds, error } = await supabase
            .from('agent_sip_credentials')
            .select('sip_username, sip_password')
            .eq('agent_id', agent.id)
            .maybeSingle();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load SIP credentials' });
        }

        if (!creds) {
            return res.status(404).json({ error: 'No softphone credentials provisioned for your account yet' });
        }

        res.json({
            username: creds.sip_username,
            password: creds.sip_password,
            domain: process.env.SOFTPHONE_SIP_DOMAIN || 'sip.chumz.online',
            wssUrl: process.env.SOFTPHONE_WSS_URL || 'wss://sip.chumz.online:8089/ws',
            // TURN relay for agents on networks where a direct/STUN-only ICE
            // path fails (symmetric NAT, restrictive mobile/corporate
            // firewalls) — without this the browser had no NAT-traversal
            // fallback at all. No hardcoded password fallback (unlike
            // url/username, which aren't credentials) — this used to default
            // to a real TURN password checked into source, silently
            // resurfacing it forever if the env var was ever unset. That
            // credential should be rotated on the TURN server itself.
            turnUrl: process.env.SOFTPHONE_TURN_URL || 'turn:64.227.160.38:3478',
            turnUsername: process.env.SOFTPHONE_TURN_USERNAME || 'chumzagent',
            turnPassword: process.env.SOFTPHONE_TURN_PASSWORD
        });
    });

    // ── Agent roster management (supervisors only) ─────────────────────
    // Full CRUD, including reads — the roster includes phone numbers and
    // emails, which plain agents have no need to see even though the page
    // showing it is also hidden from their nav.

    app.get('/api/agents', requireSupervisor, async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
        const rangeStart = (page - 1) * pageSize;
        // Strip characters PostgREST's .or() filter syntax treats as
        // structural (comma separates conditions, parens group them) —
        // otherwise a search term containing them would corrupt the filter
        // string instead of just failing to match anything.
        const q = (typeof req.query.q === 'string' ? req.query.q : '').trim().replace(/[,()]/g, '');

        // agent_sip_credentials(...) lets the roster show provisioning state
        // per agent (no softphone / pending sync / active) — sip_password is
        // deliberately never selected here; the only place a password may
        // ever surface is the agent's own GET /api/agents/me/sip-credentials.
        let query = supabase
            .from('agents')
            .select('*, agent_sip_credentials(sip_username, provisioned_by_email, asterisk_synced_at, created_at)', { count: 'exact' })
            .order('id', { ascending: true });
        // Matches name OR phone — searching against two columns needs an
        // .or() rather than chained .ilike() calls (which would AND them).
        if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);

        const { data, error, count } = await query.range(rangeStart, rangeStart + pageSize - 1);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load agents' });
        }

        res.json({
            agents: data,
            page,
            pageSize,
            total: count ?? 0,
            totalPages: Math.max(1, Math.ceil((count ?? 0) / pageSize))
        });
    });

    app.post('/api/agents', requireSupervisor, async (req, res) => {
        const { name, phone, email, role } = req.body;

        if (!name || !isValidE164(phone)) {
            return res.status(400).json({ error: 'Name and a valid phone number (e.g. +254712345678) are required' });
        }

        if (role !== undefined && !['agent', 'supervisor'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const { data, error } = await supabase
            .from('agents')
            .insert({ name, phone, email: email || null, status: 'offline', role: role || 'agent' })
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to create agent' });
        }

        invalidateAgentCache();
        res.status(201).json({ agent: data });
    });

    app.patch('/api/agents/:id', requireSupervisor, async (req, res) => {
        const { id } = req.params;
        const { name, phone, email, status, role } = req.body;

        if (phone !== undefined && !isValidE164(phone)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        if (status !== undefined && !['available', 'on_call', 'ringing', 'break', 'offline'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        if (role !== undefined && !['agent', 'supervisor'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const fieldUpdates = {};
        if (name !== undefined) fieldUpdates.name = name;
        if (phone !== undefined) fieldUpdates.phone = phone;
        if (email !== undefined) fieldUpdates.email = email || null;
        if (role !== undefined) fieldUpdates.role = role;

        let agent;

        if (Object.keys(fieldUpdates).length > 0) {
            const { data, error } = await supabase.from('agents').update(fieldUpdates).eq('id', id).select().single();
            if (error) {
                console.error(error);
                return res.status(500).json({ error: 'Failed to update agent' });
            }
            agent = data;
        } else {
            const { data, error } = await supabase.from('agents').select().eq('id', id).single();
            if (error) {
                console.error(error);
                return res.status(404).json({ error: 'Agent not found' });
            }
            agent = data;
        }

        if (status !== undefined) {
            try {
                const { data, error } = await setAgentStatus(agent, status);
                if (error) throw new Error(error.message);
                agent = data;
            } catch (err) {
                return res.status(502).json({ error: err.message });
            }
        }

        invalidateAgentCache();
        res.json({ agent });
    });

    app.delete('/api/agents/:id', requireSupervisor, async (req, res) => {
        const { error } = await supabase.from('agents').delete().eq('id', req.params.id);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to delete agent' });
        }

        invalidateAgentCache();
        res.json({ ok: true });
    });

    // Provisions a browser softphone for an agent end-to-end: generates
    // credentials, saves them, and pushes them to the Asterisk VPS via
    // ari-app's internal endpoint — replacing what used to require SSH +
    // hand-editing pjsip.conf. Never returns sip_password; credential
    // hand-off stays exclusively through the agent's own
    // GET /api/agents/me/sip-credentials (below), matching the existing
    // "supervisor never sees/copies a plaintext password" rule for this table.
    app.post('/api/agents/:id/sip-credentials', requireSupervisor, async (req, res) => {
        const agentId = parseInt(req.params.id, 10);
        if (!Number.isInteger(agentId)) {
            return res.status(400).json({ error: 'Invalid agent id' });
        }

        const { data: agent, error: agentError } = await supabase.from('agents').select('id, name').eq('id', agentId).maybeSingle();
        if (agentError) {
            console.error(agentError);
            return res.status(500).json({ error: 'Failed to load agent' });
        }
        if (!agent) {
            return res.status(404).json({ error: 'Agent not found' });
        }

        const { data: existing } = await supabase.from('agent_sip_credentials').select('agent_id').eq('agent_id', agentId).maybeSingle();
        if (existing) {
            return res.status(409).json({ error: 'This agent already has softphone credentials' });
        }

        // Server-derived only, no supervisor input — matches the manual
        // convention already used in pjsip.conf (first name, lowercase,
        // e.g. [simon]). A real collision (two agents sharing a first name)
        // is resolved deterministically by suffixing the numeric id, rather
        // than by asking the supervisor to pick — this endpoint takes no
        // free-text fields at all.
        const sanitized = (agent.name || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        const baseUsername = /^[a-z]/.test(sanitized) ? sanitized.slice(0, 28) : `agent${agentId}`;
        const { data: usernameClash } = await supabase.from('agent_sip_credentials').select('agent_id').eq('sip_username', baseUsername).maybeSingle();
        const sipUsername = usernameClash ? `${baseUsername}${agentId}`.slice(0, 32) : baseUsername;

        // base64url avoids characters (=, +, /) that are structurally
        // meaningful in pjsip.conf's ini format — defense in depth even
        // though this value never comes from free text.
        const sipPassword = crypto.randomBytes(18).toString('base64url');

        const { error: insertError } = await supabase.from('agent_sip_credentials').insert({
            agent_id: agentId,
            sip_username: sipUsername,
            sip_password: sipPassword,
            provisioned_by_email: req.user.email
        });

        if (insertError) {
            console.error(insertError);
            return res.status(500).json({ error: 'Failed to save SIP credentials' });
        }

        const syncResult = await syncAgentToAsterisk(supabase, agentId, sipUsername, sipPassword);
        // 202 (not 500) when only the Asterisk push failed — the DB row is
        // real and retryable via the /sync endpoint below, so this isn't a
        // failed request, just an incomplete one.
        res.status(syncResult.ok ? 201 : 202).json({ ok: true, agentId, sipUsername, asteriskSynced: syncResult.ok });
    });

    // Idempotent retry for the split-failure case above: re-reads the
    // already-saved credentials and re-pushes them, rather than requiring
    // the original request's in-memory context (which a DO App Platform
    // process recycle would lose anyway).
    app.post('/api/agents/:id/sip-credentials/sync', requireSupervisor, async (req, res) => {
        const agentId = parseInt(req.params.id, 10);
        if (!Number.isInteger(agentId)) {
            return res.status(400).json({ error: 'Invalid agent id' });
        }

        const { data: creds, error } = await supabase
            .from('agent_sip_credentials')
            .select('sip_username, sip_password')
            .eq('agent_id', agentId)
            .maybeSingle();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load SIP credentials' });
        }
        if (!creds) {
            return res.status(404).json({ error: 'No softphone credentials provisioned for this agent yet' });
        }

        const syncResult = await syncAgentToAsterisk(supabase, agentId, creds.sip_username, creds.sip_password);
        res.status(syncResult.ok ? 200 : 202).json({ ok: true, agentId, asteriskSynced: syncResult.ok });
    });

    // ── IVR menu (supervisors only) ─────────────────────────────────────

    app.get('/api/ivr-config', requireSupervisor, async (req, res) => {
        const { data, error } = await supabase
            .from('ivr_config')
            .select('greeting, tts_voice, tts_speed_scale, rating_enabled')
            .eq('id', 1)
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load IVR greeting' });
        }

        res.json({
            greeting: data.greeting,
            tts_voice: data.tts_voice,
            tts_speed_scale: data.tts_speed_scale,
            rating_enabled: data.rating_enabled
        });
    });

    // 'lady'/'man' are the only voice keys ari-app/tts.js's allowlist
    // currently maps to a real Piper model — null means "use the server's
    // default voice" (today's unconfigured behavior).
    const IVR_VOICES = ['lady', 'man', null];

    app.patch('/api/ivr-config', requireSupervisor, async (req, res) => {
        const { greeting, tts_voice, tts_speed_scale, rating_enabled } = req.body;

        if (greeting !== undefined && (typeof greeting !== 'string' || !greeting.trim())) {
            return res.status(400).json({ error: 'Greeting cannot be empty' });
        }
        if (tts_voice !== undefined && !IVR_VOICES.includes(tts_voice)) {
            return res.status(400).json({ error: 'Invalid voice' });
        }
        if (tts_speed_scale !== undefined && (typeof tts_speed_scale !== 'number' || tts_speed_scale < 0.5 || tts_speed_scale > 2.0)) {
            return res.status(400).json({ error: 'Speed must be between 0.5 and 2.0' });
        }

        const updates = { updated_at: new Date().toISOString() };
        if (greeting !== undefined) updates.greeting = greeting.trim();
        if (tts_voice !== undefined) updates.tts_voice = tts_voice;
        if (tts_speed_scale !== undefined) updates.tts_speed_scale = tts_speed_scale;
        if (rating_enabled !== undefined) updates.rating_enabled = !!rating_enabled;

        const { data, error } = await supabase
            .from('ivr_config')
            .update(updates)
            .eq('id', 1)
            .select('id');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to update greeting' });
        }
        // Supabase's .update() doesn't error on zero rows matched — this
        // would otherwise report success while a supervisor's edited
        // greeting silently never saved (e.g. the seed row is missing).
        if (!data.length) {
            return res.status(500).json({ error: 'IVR config row is missing — contact an engineer' });
        }

        res.json({ ok: true });
    });

    app.get('/api/ivr-options', requireSupervisor, async (req, res) => {
        const { data, error } = await supabase.from('ivr_options').select('*').order('digit', { ascending: true });

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load IVR options' });
        }

        res.json({ options: data });
    });

    app.post('/api/ivr-options', requireSupervisor, async (req, res) => {
        const { digit, label, response_message, action } = req.body;

        if (!/^[0-9*#]$/.test(digit || '')) {
            return res.status(400).json({ error: 'digit must be a single key (0-9, *, #)' });
        }

        if (!label || !['message', 'transfer_agent', 'repeat_menu'].includes(action)) {
            return res.status(400).json({ error: 'label and a valid action are required' });
        }

        // A 'message' option with no response_message means a caller who
        // presses that digit hears nothing at all and gets immediately
        // hung up on (ari-app's runIvrMenu only plays it `if
        // (option.response_message)`, then hangs up unconditionally for
        // this action) — invisible in the editor, since nothing here
        // stopped it from being saved looking "complete".
        if (action === 'message' && (!response_message || !response_message.trim())) {
            return res.status(400).json({ error: 'A response message is required for the "message" action' });
        }

        const { data, error } = await supabase
            .from('ivr_options')
            .insert({ digit, label, response_message: response_message || null, action })
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to create IVR option (digit may already exist)' });
        }

        res.status(201).json({ option: data });
    });

    app.patch('/api/ivr-options/:digit', requireSupervisor, async (req, res) => {
        const { label, response_message, action } = req.body;

        if (action !== undefined && !['message', 'transfer_agent', 'repeat_menu'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action' });
        }

        // Same reasoning as POST /api/ivr-options — but a PATCH can touch
        // only one of action/response_message at a time, so the *resulting*
        // combination (this update merged with whatever's already saved)
        // is what actually needs checking, not just what this one request
        // happened to include. Only worth the extra lookup when one of
        // those two fields is actually in play.
        if (action === 'message' || response_message !== undefined) {
            const { data: current } = await supabase
                .from('ivr_options')
                .select('action, response_message')
                .eq('digit', req.params.digit)
                .maybeSingle();
            const effectiveAction = action !== undefined ? action : current?.action;
            const effectiveMessage = response_message !== undefined ? response_message : current?.response_message;
            if (effectiveAction === 'message' && (!effectiveMessage || !effectiveMessage.trim())) {
                return res.status(400).json({ error: 'A response message is required for the "message" action' });
            }
        }

        const updates = { updated_at: new Date().toISOString() };
        if (label !== undefined) updates.label = label;
        if (response_message !== undefined) updates.response_message = response_message;
        if (action !== undefined) updates.action = action;

        const { data, error } = await supabase
            .from('ivr_options')
            .update(updates)
            .eq('digit', req.params.digit)
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to update IVR option' });
        }

        res.json({ option: data });
    });

    app.delete('/api/ivr-options/:digit', requireSupervisor, async (req, res) => {
        const { error } = await supabase.from('ivr_options').delete().eq('digit', req.params.digit);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to delete IVR option' });
        }

        res.json({ ok: true });
    });

    // ── Tickets (Tags & Tickets page) ───────────────────────────────────
    // Any authenticated user can read/create/update tickets — this is
    // day-to-day agent work, not roster/config management.

    // GET /api/tickets?page=1&pageSize=50&session_id=... — the session_id
    // filter is for the call-details drawer (a call can have 0-N tickets,
    // there's no unique constraint on tickets.session_id).
    app.get('/api/tickets', requireAuth, async (req, res) => {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
        const rangeStart = (page - 1) * pageSize;

        let query = supabase
            .from('tickets')
            .select('*, agents(name)', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(rangeStart, rangeStart + pageSize - 1);

        if (req.query.session_id) query = query.eq('session_id', req.query.session_id);
        if (req.query.status) query = query.eq('status', req.query.status);
        if (req.query.tag) query = query.eq('tag', req.query.tag);

        const { data, error, count } = await query;

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load tickets' });
        }

        res.json({
            tickets: data.map(t => ({ ...t, assigned_agent_name: t.agents?.name ?? null, agents: undefined })),
            page,
            pageSize,
            total: count ?? 0,
            totalPages: Math.max(1, Math.ceil((count ?? 0) / pageSize))
        });
    });

    app.post('/api/tickets', requireAuth, async (req, res) => {
        const { session_id, caller_name, caller_number, tag, priority, status, assigned_agent_id, notes } = req.body;

        if (priority !== undefined && !['Low', 'Medium', 'High', 'Urgent'].includes(priority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        const validStatuses = ['Open', 'Resolved', 'Escalated', 'Follow-up needed', 'No resolution'];
        if (status !== undefined && !validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        if (session_id !== undefined && session_id !== null && !isValidTicketText(session_id, 128)) {
            return res.status(400).json({ error: 'Invalid session_id' });
        }
        if (caller_name !== undefined && caller_name !== null && !isValidTicketText(caller_name, 120)) {
            return res.status(400).json({ error: 'Invalid caller_name' });
        }
        if (caller_number !== undefined && caller_number !== null && !isValidTicketText(caller_number, 32)) {
            return res.status(400).json({ error: 'Invalid caller_number' });
        }
        if (tag !== undefined && tag !== null && !isValidTicketText(tag, 60)) {
            return res.status(400).json({ error: 'Invalid tag' });
        }
        if (notes !== undefined && notes !== null && !isValidTicketText(notes, 2000)) {
            return res.status(400).json({ error: 'Invalid notes' });
        }
        if (assigned_agent_id !== undefined && assigned_agent_id !== null && !isValidAgentId(assigned_agent_id)) {
            return res.status(400).json({ error: 'Invalid assigned_agent_id' });
        }

        const { data, error } = await supabase
            .from('tickets')
            .insert({
                session_id: session_id || null,
                caller_name: caller_name || null,
                caller_number: caller_number || null,
                tag: tag || null,
                priority: priority || 'Medium',
                status: status || 'Open',
                assigned_agent_id: assigned_agent_id || null,
                notes: notes || null
            })
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to create ticket' });
        }

        res.status(201).json({ ticket: data });
    });

    app.patch('/api/tickets/:id', requireAuth, async (req, res) => {
        const { status, priority, tag, assigned_agent_id, notes } = req.body;

        const validStatuses = ['Open', 'Resolved', 'Escalated', 'Follow-up needed', 'No resolution'];
        if (status !== undefined && !validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        if (priority !== undefined && !['Low', 'Medium', 'High', 'Urgent'].includes(priority)) {
            return res.status(400).json({ error: 'Invalid priority' });
        }

        if (tag !== undefined && tag !== null && !isValidTicketText(tag, 60)) {
            return res.status(400).json({ error: 'Invalid tag' });
        }
        if (notes !== undefined && notes !== null && !isValidTicketText(notes, 2000)) {
            return res.status(400).json({ error: 'Invalid notes' });
        }
        if (assigned_agent_id !== undefined && assigned_agent_id !== null && !isValidAgentId(assigned_agent_id)) {
            return res.status(400).json({ error: 'Invalid assigned_agent_id' });
        }

        const updates = {};
        if (status !== undefined) updates.status = status;
        if (priority !== undefined) updates.priority = priority;
        if (tag !== undefined) updates.tag = tag;
        if (assigned_agent_id !== undefined) updates.assigned_agent_id = assigned_agent_id;
        if (notes !== undefined) updates.notes = notes;

        const { data, error } = await supabase.from('tickets').update(updates).eq('id', req.params.id).select().single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to update ticket' });
        }

        res.json({ ticket: data });
    });

    // Aggregate counts for the Analytics page — by tag, by priority, and a
    // resolution rate (Resolved / total). Cheap enough to just fetch and
    // reduce in JS at this project's scale (same pattern as the calls/agent
    // stats endpoints above) rather than a SQL aggregate query.
    app.get('/api/tickets/stats', requireAuth, async (req, res) => {
        const { data, error } = await supabase.from('tickets').select('tag, priority, status');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load ticket stats' });
        }

        const byTag = {};
        const byPriority = {};
        data.forEach(t => {
            const tag = t.tag || 'Untagged';
            byTag[tag] = (byTag[tag] || 0) + 1;
            byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
        });

        res.json({
            total: data.length,
            resolved: data.filter(t => t.status === 'Resolved').length,
            byTag,
            byPriority
        });
    });

    app.get('/api/ticket-tags', requireAuth, async (req, res) => {
        const { data, error } = await supabase.from('ticket_tags').select('name').order('name');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load tags' });
        }

        res.json({ tags: data.map(t => t.name) });
    });

    app.post('/api/ticket-tags', requireSupervisor, async (req, res) => {
        const { name } = req.body;

        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Tag name is required' });
        }

        const { error } = await supabase.from('ticket_tags').insert({ name: name.trim() });

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to add tag (it may already exist)' });
        }

        res.status(201).json({ ok: true });
    });

    app.delete('/api/ticket-tags/:name', requireSupervisor, async (req, res) => {
        const { error } = await supabase.from('ticket_tags').delete().eq('name', req.params.name);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to remove tag' });
        }

        res.json({ ok: true });
    });

    // ── Call Forwarding (supervisors only) ──────────────────────────────
    // The ARI app (ari-app/index.js) reuses the 'no_answer' condition's
    // destination as its "nobody is logged in at all" forwarding target —
    // checked once at IVR entry, not a live mid-queue redirect. 'busy' and
    // 'always' are saved here but not yet consulted by anything. 'after_hours'
    // is superseded by the dedicated Business Hours message below — a rule
    // saved with that condition is just informational for now.

    app.get('/api/forwarding-config', requireSupervisor, async (req, res) => {
        const { data, error } = await supabase.from('forwarding_config').select('enabled').eq('id', 1).single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load forwarding config' });
        }

        res.json({ enabled: data.enabled });
    });

    app.patch('/api/forwarding-config', requireSupervisor, async (req, res) => {
        const { enabled } = req.body;

        const { data, error } = await supabase
            .from('forwarding_config')
            .update({ enabled: !!enabled })
            .eq('id', 1)
            .select('id');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to update forwarding config' });
        }
        // Supabase's .update() doesn't error on zero rows matched — this
        // would otherwise report success while a supervisor's toggle
        // silently never saved (e.g. the seed row is missing).
        if (!data.length) {
            return res.status(500).json({ error: 'Forwarding config row is missing — contact an engineer' });
        }

        res.json({ ok: true });
    });

    app.get('/api/forwarding-rules', requireSupervisor, async (req, res) => {
        const { data, error } = await supabase.from('forwarding_rules').select('*').order('id');

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load forwarding rules' });
        }

        res.json({ rules: data });
    });

    app.post('/api/forwarding-rules', requireSupervisor, async (req, res) => {
        const { condition, destination } = req.body;

        if (!['no_answer', 'busy', 'always', 'after_hours'].includes(condition)) {
            return res.status(400).json({ error: 'Invalid condition' });
        }

        if (typeof destination !== 'string' || !destination.trim()) {
            return res.status(400).json({ error: 'Destination is required' });
        }

        // Upsert, not insert — the UI has no way to edit an existing rule,
        // only add and delete, so "change the no_answer destination" means
        // clicking "+ Add rule" again. A plain insert left the old row in
        // place too, and getNoAgentsForwardingDestination() (ari-app) had no
        // way to know which of the two duplicates for the same condition
        // was actually meant to be current.
        const { data, error } = await supabase
            .from('forwarding_rules')
            .upsert({ condition, destination: destination.trim() }, { onConflict: 'condition' })
            .select()
            .single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to add rule' });
        }

        res.status(201).json({ rule: data });
    });

    app.delete('/api/forwarding-rules/:id', requireSupervisor, async (req, res) => {
        const { error } = await supabase.from('forwarding_rules').delete().eq('id', req.params.id);

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to remove rule' });
        }

        res.json({ ok: true });
    });

    // ── Business Hours (supervisors only) ────────────────────────────────
    // Checked by the ARI app at the start of every inbound call (see
    // isWithinBusinessHours in ari-app/index.js) — outside these hours, the
    // caller hears after_hours_message instead of the normal IVR menu.

    app.get('/api/business-hours', requireSupervisor, async (req, res) => {
        const { data, error } = await supabase.from('business_hours').select('*').eq('id', 1).maybeSingle();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to load business hours' });
        }

        res.json({ hours: data });
    });

    app.patch('/api/business-hours', requireSupervisor, async (req, res) => {
        const { enabled, open_time, close_time, active_days, after_hours_message } = req.body;

        const fieldUpdates = {};

        if (enabled !== undefined) fieldUpdates.enabled = !!enabled;

        if (open_time !== undefined) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(open_time)) return res.status(400).json({ error: 'Invalid open time' });
            fieldUpdates.open_time = open_time;
        }

        if (close_time !== undefined) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(close_time)) return res.status(400).json({ error: 'Invalid close time' });
            fieldUpdates.close_time = close_time;
        }

        if (active_days !== undefined) {
            if (!Array.isArray(active_days) || active_days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
                return res.status(400).json({ error: 'Invalid active days' });
            }
            fieldUpdates.active_days = active_days;
        }

        if (after_hours_message !== undefined) {
            if (typeof after_hours_message !== 'string' || !after_hours_message.trim()) {
                return res.status(400).json({ error: 'After-hours message cannot be empty' });
            }
            fieldUpdates.after_hours_message = after_hours_message;
        }

        const { data, error } = await supabase.from('business_hours').update(fieldUpdates).eq('id', 1).select().single();

        if (error) {
            console.error(error);
            return res.status(500).json({ error: 'Failed to update business hours' });
        }

        res.json({ hours: data });
    });

};
