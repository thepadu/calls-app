require('dotenv').config();

// A crash here drops every active call on the system, not just one — worth
// containing whatever can be contained. An unhandled rejection (Node 15+
// terminates by default) is logged and the process keeps running, since
// it's almost always scoped to one call's async chain rather than
// corrupting shared state. A genuinely uncaught synchronous exception exits
// deliberately (systemd's Restart=always brings it back up) rather than
// risk continuing to route calls with state integrity no longer guaranteed.
process.on('unhandledRejection', reason => {
    console.error('❌ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', err => {
    console.error('❌ Uncaught exception, exiting:', err);
    process.exit(1);
});

const crypto = require('crypto');
const http = require('http');
const ari = require('ari-client');
const { normalizePhone } = require('./lib/phone');
const { synthesize, invalidate } = require('./tts');
const {
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
    claimAddPartyRequests,
    setAddPartyStatus,
    markMissedIfAbandoned,
    reconcileStaleCallsOnStartup,
    reconcileStaleAgentsOnStartup,
    reconcileGhostAgents,
    sweepStaleCalls
} = require('./supabase');
const { writeAgentBlock, deprovisionAgentBlock } = require('./pjsipConfig');

// ari-client's error objects don't reliably carry a string .message — for at
// least some ARI REST error responses (e.g. a 404 against a channel that
// hung up a moment earlier), .message is itself Asterisk's parsed JSON error
// body ({"message": "Channel not found"}), not a string. console.error(...,
// err.message) on one of those prints a confusing multi-line object dump
// instead of a readable line, discovered live when a real customer's hangup
// race hit exactly this. Used wherever an ARI-originated error gets logged.
function errText(err) {
    if (typeof err?.message === 'string') return err.message;
    if (err?.message) {
        try {
            return JSON.stringify(err.message);
        } catch {
            /* fall through */
        }
    }
    return String(err);
}

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USERNAME = process.env.ARI_USERNAME;
const ARI_PASSWORD = process.env.ARI_PASSWORD;
const APP_NAME = process.env.ARI_APP_NAME || 'chumz-ivr';
const MENU_TIMEOUT_MS = 15000;
const RATING_TIMEOUT_MS = 8000;
const QUEUE_POLL_MS = 3000;
// dequeueNext alone has no notion of "give up" — it just retries every tick
// forever if agents keep being unavailable or keep not answering. Without
// this ceiling, a customer can sit on hold indefinitely with no code path
// that ever ends the call for them.
const MAX_QUEUE_WAIT_MS = 5 * 60 * 1000;
const ADD_PARTY_POLL_MS = 3000;
// Catches call_logs rows stuck in a non-terminal status with nothing left to
// ever resolve them — an orphaned outbound-agent leg from a mid-call
// restart, or a row from Africa's Talking's legacy /events webhook (its own
// ATVId_-prefixed session ids aren't real Asterisk channel ids, so this
// process's channel-based reconciliation can never recognize one as
// abandoned). 20 minutes is short enough to clear orphans quickly; a real
// call still running past that isn't harmed — its own eventual completion
// write overwrites this by session_id regardless.
const STALE_CALL_ONGOING_MAX_AGE_MS = 20 * 60 * 1000;
// A caller stuck in ivr_started/input_received/queued/dialing — never yet
// bridged to an agent — for anywhere near this long is already a service
// failure on its own, independent of the orphan-detection reasoning above;
// kept far shorter than the 'ongoing' threshold, which a real long call
// can legitimately exceed.
const STALE_CALL_PREBRIDGE_MAX_AGE_MS = 5 * 60 * 1000;
const STALE_CALL_SWEEP_MS = 2 * 60 * 1000;
const ARI_HEARTBEAT_MS = 15000;
const ARI_HEARTBEAT_TIMEOUT_MS = 5000;
const GHOST_AGENT_POLL_MS = 30000;
// A single ghost reconciliation is a normal, expected event (a tab closed
// without a clean disconnect, a laptop put to sleep) — but the same agent
// hitting this repeatedly in a short window is the signature of a genuinely
// unstable connection (confirmed via live investigation: a browser tab
// backgrounded long enough to get throttled, or real mobile network
// instability), not a one-off. Flagging that pattern here replaces "someone
// has to notice it by manually tailing logs" with an automatic signal that
// scales past one agent being watched by hand.
const GHOST_FLAP_WINDOW_MS = 60 * 60 * 1000;
const GHOST_FLAP_THRESHOLD = 3;
const ghostReconcileTimestamps = new Map();
// A ring failure ("Allocation failed" from PJSIP — no active registration to
// route to) most often means this agent's SIP session has already died even
// though their heartbeat/DB status hasn't caught up yet (reconcileGhostAgents
// runs periodically, not instantly). Observed live: the same customer
// getting re-matched to the same dead agent on every 3s poll tick, over and
// over, because the original catch here unconditionally reset them back to
// 'available' after every failure. Two consecutive failures for the same
// agent now flips them offline immediately instead of retrying them forever
// — their own softphone reconnecting brings them back the normal way.
const RING_FAILURE_THRESHOLD = 2;
const ringFailureCounts = new Map(); // agentId -> consecutive origination-failure count
const HOLDING_BRIDGE_NAME = 'support-queue';
// AT's trunk rules explicitly prohibit masking outbound caller ID — every
// agent-placed call must present the same assigned Voice number, regardless
// of which agent's endpoint actually placed it.
const OUTBOUND_CALLER_ID = '0711082161';

// In-memory only — this process is the single, always-running owner of
// real-time call state (unlike the old Express+Supabase model, which had to
// persist everything since any request could hit a different, short-lived
// process). Supabase call_logs/agents are still updated throughout, purely
// for the dashboard's visibility — they are not read back to decide what
// happens next inside this process.
const waitingQueue = []; // { channel, sessionId, joinedAt }
const agentLegBySessionId = new Map(); // agent leg channel id -> { channel: customerChannel, sessionId, agentId }
const ringGroupBySessionId = new Map(); // customer sessionId -> [{ channel: agentChannel, agentId }, ...]
const claimedSessions = new Set(); // customer sessionIds already won by an agent — guards the simultaneous-answer race
const outboundBySessionId = new Map(); // agent-originated sessionId -> { agentChannel, destChannel, bridge, bridged, cleaned, answeredAt }
const activeBridgeBySessionId = new Map(); // customer sessionId -> the live agent<->customer mixing bridge, for add-a-party
const partyChannelsBySessionId = new Map(); // customer sessionId -> Set of extra channels added (or still dialing) via add-a-party

let client;
let holdingBridge;
let holdingBridgeCreation; // in-flight bridges.create() promise — see getHoldingBridge

// Starts immediately (not inside main()) so it can answer while the process
// is still connecting, or after ari.connect() has failed — distinguishing
// "process down" (connection refused) from "process up but not routing
// calls" (200 with ariHealthy: false) is the whole point. Previously this
// process had no HTTP surface at all, so an external monitor could only
// check the unrelated dashboard app and never learn anything about whether
// calls could actually be handled.
let ariHealthy = false;
const HEALTH_PORT = process.env.ARI_HEALTH_PORT || 3001;
const INTERNAL_SECRET = process.env.ARI_APP_INTERNAL_SECRET;

// Constant-time comparison for the shared secret gating /internal/* — a
// plain !== leaks timing info proportional to how many leading characters
// match, which matters here since this endpoint writes system config and
// is reachable from the public internet (via Caddy) once DO's own static
// IP-less egress rules out IP allowlisting as the real access control.
// crypto.timingSafeEqual itself throws on mismatched buffer lengths, so
// the length check has to happen first, not be replaced by it.
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req, maxBytes = 4096) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

const SIP_USERNAME_RE = /^[a-z][a-z0-9]{0,31}$/;
const SIP_PASSWORD_RE = /^[A-Za-z0-9_-]{16,64}$/;

// Starts immediately (not inside main()) so it can answer while the process
// is still connecting, or after ari.connect() has failed — distinguishing
// "process down" (connection refused) from "process up but not routing
// calls" (200 with ariHealthy: false) is the whole point. Previously this
// process had no HTTP surface at all, so an external monitor could only
// check the unrelated dashboard app and never learn anything about whether
// calls could actually be handled.
//
// Bound to localhost only — Caddy (on the VPS, in front of this) is the
// only intended public entry point, now that this server also carries the
// privileged /internal/provision-agent route below.
http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(ariHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ariConnected: ariHealthy }));
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/provision-agent') {
        if (!INTERNAL_SECRET || !safeEqual(req.headers['x-chumz-internal-secret'], INTERNAL_SECRET)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }

        const { agentId, sipUsername, sipPassword } = body;
        // Validated here even though the caller (the dashboard's API) is
        // the one generating these values — this endpoint, not the caller,
        // is the actual boundary against writing malformed/malicious
        // content into pjsip.conf, and that boundary shouldn't rely on the
        // caller having stayed well-behaved.
        if (!Number.isInteger(agentId) || agentId <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid agentId' }));
            return;
        }
        if (typeof sipUsername !== 'string' || !SIP_USERNAME_RE.test(sipUsername)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid sipUsername' }));
            return;
        }
        if (typeof sipPassword !== 'string' || !SIP_PASSWORD_RE.test(sipPassword)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid sipPassword' }));
            return;
        }

        try {
            const result = await writeAgentBlock({ agentId, sipUsername, sipPassword });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
            const status = err.code === 'BLOCK_CONFLICT' ? 409 : 500;
            console.error('❌ provision-agent failed:', errText(err));
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errText(err) }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/deprovision-agent') {
        if (!INTERNAL_SECRET || !safeEqual(req.headers['x-chumz-internal-secret'], INTERNAL_SECRET)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }

        const { agentId } = body;
        if (!Number.isInteger(agentId) || agentId <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid agentId' }));
            return;
        }

        try {
            const result = await deprovisionAgentBlock(agentId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
            console.error('❌ deprovision-agent failed:', errText(err));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errText(err) }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/internal/hangup-call') {
        if (!INTERNAL_SECRET || !safeEqual(req.headers['x-chumz-internal-secret'], INTERNAL_SECRET)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        let body;
        try {
            body = await readJsonBody(req);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
        }

        const { sessionId } = body;
        if (typeof sessionId !== 'string' || !sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid sessionId' }));
            return;
        }

        if (!client) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ARI not connected yet' }));
            return;
        }

        // session_id IS the customer channel's own Asterisk channel id
        // throughout this app (set at StasisStart, never regenerated) — so
        // this needs no lookup through waitingQueue/ringGroupBySessionId/
        // activeBridgeBySessionId to find "the right thing to hang up" for
        // whichever of those states the call happens to be in right now.
        // Hanging up the customer's own channel is exactly what the
        // existing customer-initiated-hangup path already does, and the
        // existing global StasisEnd handler already does all the right
        // cleanup from there (queue splicing, ring-group clearing, and for
        // a bridged call, teardown()'s bridge-destroy + agent-leg-hangup +
        // agent-back-to-available + final call_logs write) — reusing that
        // pipeline instead of duplicating any of it here.
        try {
            await client.channels.hangup({ channelId: sessionId });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, hungUp: true }));
        } catch (err) {
            // Already gone (caller hung up first, or a genuinely stale row
            // with nothing left) — not an error, just nothing to do.
            // Confirmed live against the real error shape: ari-client's
            // swaggerError wraps a 404's raw response body as a plain
            // string Error.message (here, the literal JSON text
            // '{\n  "message": "Channel not found"\n}\n'), not a parsed
            // object — a substring check is what actually matches it,
            // an exact-equality check against errText(err) does not.
            if (errText(err).includes('Channel not found')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, hungUp: false }));
                return;
            }
            console.error(`❌ hangup-call failed for ${sessionId}:`, errText(err));
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errText(err) }));
        }
        return;
    }

    res.writeHead(404);
    res.end();
}).listen(HEALTH_PORT, '127.0.0.1', () => console.log(`🩺 Health check listening on :${HEALTH_PORT}/healthz`));

// Kenya has a single timezone with no DST (EAT, UTC+3) — not worth a tz
// library dependency for that. active_days is 0=Sunday..6=Saturday.
function isWithinBusinessHours(hours) {
    const nairobiNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const day = nairobiNow.getUTCDay();
    if (!hours.active_days.includes(day)) return false;

    const minutesNow = nairobiNow.getUTCHours() * 60 + nairobiNow.getUTCMinutes();
    const [openH, openM] = hours.open_time.split(':').map(Number);
    const [closeH, closeM] = hours.close_time.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    return minutesNow >= openMinutes && minutesNow < closeMinutes;
}

// A load test proved this apparently-rare failure isn't actually rare under
// load: a CPU-saturated box can make Asterisk report a perfectly good cached
// file as "failed" simply because it couldn't service the playback in time,
// not because the file is corrupt. A genuinely corrupt file fails
// deterministically — every single play attempt, regardless of load — so
// requiring a few CONSECUTIVE failures before invalidating (and resetting
// the count on any success) tells the two apart: real corruption racks up
// consecutive failures fast, while overload-induced ones land sporadically,
// interspersed with successes, and never reach the threshold on their own.
const PLAYBACK_FAILURE_THRESHOLD = 3;
const playbackFailureCounts = new Map(); // soundName -> consecutive failure count

async function playText(channel, text, voiceOpts) {
    const soundName = await synthesize(text, voiceOpts);
    const playback = client.Playback();
    // Not awaited — channel.play() resolves once the command is accepted,
    // not once playback finishes; PlaybackFinished is what actually signals
    // completion. Still needs a .catch(): if the caller hangs up right as
    // this command reaches Asterisk, the channel is already gone by the
    // time it's processed and this rejects with "Channel not found" — with
    // no await and nothing else referencing this promise, that was an
    // unhandled rejection every time a caller hung up mid-greeting/menu.
    channel.play({ media: `sound:${soundName}` }, playback).catch(() => {});

    // Races against the channel's own StasisEnd: per the comment above, if
    // the caller hangs up right as channel.play() reaches Asterisk, no
    // Playback is ever actually created and PlaybackFinished never fires.
    // Several call sites (the queue-timeout apology, forwarding/message
    // prompts, the after-hours message) await this with no competing
    // timeout of their own — without this race, a hangup at exactly that
    // moment hung the calling function forever and permanently leaked a
    // listener on the shared `client` EventEmitter.
    const finished = await new Promise(resolve => {
        const onFinished = (event, pb) => {
            channel.removeListener('StasisEnd', onHangup);
            resolve(pb);
        };
        const onHangup = () => {
            playback.removeListener('PlaybackFinished', onFinished);
            resolve(null);
        };
        playback.once('PlaybackFinished', onFinished);
        channel.once('StasisEnd', onHangup);
    });

    // A garbled/corrupt cached synthesis (Piper/sox occasionally produce one
    // despite exiting 0 — see tts.js) doesn't reject channel.play() or stop
    // PlaybackFinished from firing; Asterisk just logs "Playback failed" and
    // moves on, leaving the caller in dead air with nothing here noticing.
    // Confirmed in production: the same cached greeting stayed broken for
    // every caller across multiple days until manually deleted. Checking
    // the finished playback's own state and invalidating the cache on
    // anything but a clean finish makes that self-healing instead — the
    // caller still hears nothing this one time, but a later caller gets a
    // freshly re-synthesized (hopefully good) file rather than the same
    // permanently-broken one.
    if (finished?.state && finished.state !== 'done') {
        const failures = (playbackFailureCounts.get(soundName) || 0) + 1;
        if (failures >= PLAYBACK_FAILURE_THRESHOLD) {
            console.error(
                `❌ ${soundName} failed ${failures} times in a row — invalidating cache as likely corrupt`
            );
            invalidate(text, voiceOpts);
            playbackFailureCounts.delete(soundName);
        } else {
            playbackFailureCounts.set(soundName, failures);
            console.error(
                `❌ Playback finished in unexpected state "${finished.state}" for ${soundName} (${failures}/${PLAYBACK_FAILURE_THRESHOLD} consecutive — not invalidating yet)`
            );
        }
    } else if (finished) {
        // A clean finish proves this exact file is fine right now — clears
        // any failures accumulated from an earlier overload spike so they
        // can never slowly add up to the threshold across unrelated events.
        playbackFailureCounts.delete(soundName);
    }
}

// Returns { promise, cancel } rather than a bare promise — when this loses
// the Promise.race in runIvrMenu (the common case, since a barge-in digit or
// the eventual timeout usually settles after the shorter prompt), the caller
// MUST call cancel() or this leaks a listener on the shared, long-lived
// `client` EventEmitter (and a stray timer) every single menu loop.
function waitForDigitOrTimeout(channelId, timeoutMs) {
    let onDtmf, timer, done = false;
    const promise = new Promise(resolve => {
        onDtmf = (event, evChannel) => {
            if (evChannel.id !== channelId || done) return;
            done = true;
            cleanup();
            resolve(event.digit);
        };
        timer = setTimeout(() => {
            if (done) return;
            done = true;
            cleanup();
            resolve(null);
        }, timeoutMs);
        client.on('ChannelDtmfReceived', onDtmf);
    });
    function cleanup() {
        clearTimeout(timer);
        client.removeListener('ChannelDtmfReceived', onDtmf);
    }
    return { promise, cancel: cleanup };
}

// Two customers can both call this before either has set `holdingBridge` —
// without a lock, each would create its own bridge and only one would ever
// be remembered, orphaning whichever customer ended up in the other one.
// Concurrent callers now await the same in-flight creation instead of racing.
async function getHoldingBridge() {
    if (holdingBridge) {
        try {
            await holdingBridge.get();
            return holdingBridge;
        } catch {
            holdingBridge = null;
        }
    }
    if (!holdingBridgeCreation) {
        holdingBridgeCreation = client.bridges
            .create({ type: 'holding', name: HOLDING_BRIDGE_NAME })
            .finally(() => {
                holdingBridgeCreation = null;
            });
    }
    holdingBridge = await holdingBridgeCreation;
    return holdingBridge;
}

async function runIvrMenu(channel, sessionId) {
    const [ivrConfig, options] = await Promise.all([getIvrConfig(), getIvrOptions()]);
    const { greeting, ttsVoice, ttsSpeedScale } = ivrConfig;
    const voiceOpts = { voiceKey: ttsVoice, speedScale: ttsSpeedScale };

    // Menu deliberately disabled (menu_enabled=false), or a supervisor left
    // zero options configured — either way there's no usable menu to play.
    // Previously this recursed into itself forever (every branch below
    // eventually calls runIvrMenu again, and options.find() can never match
    // with an empty list), leaving a caller stuck hearing the greeting +
    // "temporarily unavailable"/"invalid input" on a ~15-20s loop
    // indefinitely. Both cases collapse into the same safe path: play the
    // greeting once, then go straight to the queue — the same "ring all
    // available agents" path the menu's own transfer_agent option already
    // uses below, so no new agent-routing logic is needed.
    if (!ivrConfig.menuEnabled || options.length === 0) {
        await playText(channel, greeting.trim(), voiceOpts);
        return enterQueue(channel, sessionId);
    }

    const menuText = `${greeting.trim()} ${options.map(o => `Press ${o.digit} for ${o.label}.`).join(' ')}`;

    // Play + listen for a barge-in digit concurrently — a caller shouldn't
    // have to wait out the whole prompt before pressing a key. Whichever
    // side loses gets cancelled explicitly — see waitForDigitOrTimeout's
    // comment on why that matters.
    const digitWait = waitForDigitOrTimeout(channel.id, MENU_TIMEOUT_MS);
    const digit = await Promise.race([playText(channel, menuText, voiceOpts).then(() => null), digitWait.promise]);
    digitWait.cancel();

    if (!digit) {
        await upsertCallLog({ session_id: sessionId, status: 'input_received' });
        await playText(channel, 'No option was selected.', voiceOpts);
        return runIvrMenu(channel, sessionId);
    }

    await upsertCallLog({ session_id: sessionId, option_pressed: digit, status: 'input_received' });

    const option = options.find(o => o.digit === digit);

    if (!option) {
        await playText(channel, 'Invalid input. Please try again.', voiceOpts);
        return runIvrMenu(channel, sessionId);
    }

    if (option.action === 'repeat_menu') {
        return runIvrMenu(channel, sessionId);
    }

    if (option.action === 'transfer_agent') {
        if (option.response_message) await playText(channel, option.response_message, voiceOpts);

        // Forwarding is a fallback for nobody being logged in at all — an
        // agent or two being busy on other calls is the normal case and
        // should just queue, not forward.
        const availableAgents = await getAvailableAgentsWithSip();
        if (availableAgents.length === 0) {
            const destination = await getNoAgentsForwardingDestination();
            if (destination) {
                console.log(`↪️  ${sessionId}: no agents online, forwarding to ${destination}`);
                // 'forwarded', not 'completed' — no Chumz agent actually took
                // this call, so it belongs in the missed-calls count same as
                // an abandoned one, just with a distinct, honest reason.
                await upsertCallLog({ session_id: sessionId, status: 'forwarded' });
                await channel.setChannelVar({ variable: 'FORWARD_DEST', value: destination });
                return channel.continueInDialplan({ context: 'forward-external', extension: 's', priority: 1 });
            }
        }

        return enterQueue(channel, sessionId);
    }

    // action === 'message'
    if (option.response_message) await playText(channel, option.response_message, voiceOpts);
    await upsertCallLog({ session_id: sessionId, status: 'completed' });
    await channel.hangup().catch(() => {});
}

async function enterQueue(channel, sessionId) {
    const bridge = await getHoldingBridge();
    await bridge.addChannel({ channel: channel.id });
    // Captured here (not re-read from the module-level holdingBridge later)
    // so that if a later customer's getHoldingBridge() call has to replace a
    // dead bridge, this customer's eventual bridgeAgentLeg still removes
    // them from the bridge they're actually sitting in — not whatever
    // bridge happens to be current by then.
    waitingQueue.push({ channel, sessionId, joinedAt: Date.now(), bridge });
    await upsertCallLog({ session_id: sessionId, status: 'queued' });
    console.log(`⏳ ${sessionId} entered the hold queue (${waitingQueue.length} waiting)`);
}

// Guards against overlapping runs — setInterval fires every QUEUE_POLL_MS
// regardless of whether the previous call (which can take up to `timeout`
// seconds inside channels.originate) has finished. Without this, two
// overlapping attempts can both grab the same agent, race on their
// setAgentStatus calls, and leave the agent stuck on 'ringing' forever.
let dequeueInFlight = false;

async function tryDequeueNext() {
    if (dequeueInFlight || waitingQueue.length === 0) return;
    dequeueInFlight = true;
    try {
        await dequeueNext();
    } finally {
        dequeueInFlight = false;
    }
}

// Rings every currently-available agent's browser at once — first to
// answer wins (see bridgeAgentLeg's claim check), the rest get hung up and
// put back to 'available' the moment someone else wins.
async function dequeueNext() {
    const agents = await getAvailableAgentsWithSip();
    if (agents.length === 0) return;
    // getAvailableAgentsWithSip is a real network round trip — the sole
    // waiting customer can hang up (and get spliced out by the global
    // StasisEnd handler) while it's in flight, leaving nothing left to shift.
    if (waitingQueue.length === 0) return;

    const waiting = waitingQueue.shift();
    console.log(`📲 Ringing ${agents.length} available agent(s) for ${waiting.sessionId}`);

    // The agent's browser should see who's actually calling, not a generic
    // label — pulled straight off the customer's own channel object, still
    // in scope from when they first entered Stasis.
    const customerNumber = normalizePhone(waiting.channel.caller.number) || 'Unknown-Caller';

    const ringGroup = [];
    // Registered before origination starts, not after every originate()
    // resolves — the global StasisEnd handler below looks up this map to
    // stop sibling rings the instant the customer hangs up, and origination
    // can take a couple seconds across several agents. Populating it only
    // at the end left a customer hangup during that window with nothing to
    // find, so already-ringing agents kept ringing for someone who'd left.
    ringGroupBySessionId.set(waiting.sessionId, ringGroup);

    await Promise.all(
        agents.map(async agent => {
            await setAgentStatus(agent.id, 'ringing');
            // Same reasoning as ringGroupBySessionId above, applied to the
            // per-channel map: Asterisk's StasisStart event (over the
            // separate WebSocket) and this originate() call's HTTP response
            // travel independently with no guaranteed ordering. Populating
            // agentLegBySessionId only after originate() resolved meant a
            // StasisStart that won that race found nothing here, hung the
            // agent channel up, and — critically — never re-queued the
            // customer, stranding them on hold with nothing left to ever
            // dequeue them again. Pre-assigning the channel ID lets this be
            // registered before the request is even sent.
            const channelId = `agent-leg-${crypto.randomUUID()}`;
            agentLegBySessionId.set(channelId, {
                channel: waiting.channel,
                sessionId: waiting.sessionId,
                agentId: agent.id,
                bridge: waiting.bridge,
                joinedAt: waiting.joinedAt
            });
            try {
                const agentChannel = await client.channels.originate({
                    channelId,
                    endpoint: `PJSIP/${agent.agent_sip_credentials.sip_username}`,
                    app: APP_NAME,
                    appArgs: `agent-leg:${agent.id}:${waiting.sessionId}`,
                    // No spaces — ari-client's HTTP layer doesn't URL-encode
                    // query params correctly, and a raw space here silently
                    // produces a malformed request ("Allocation failed")
                    // rather than an encoding error.
                    callerId: customerNumber,
                    timeout: 25
                });
                ringGroup.push({ channel: agentChannel, agentId: agent.id });
                ringFailureCounts.delete(agent.id);
            } catch (err) {
                agentLegBySessionId.delete(channelId);
                console.error(`❌ Failed to ring agent ${agent.id}:`, errText(err));
                const failures = (ringFailureCounts.get(agent.id) || 0) + 1;
                if (failures >= RING_FAILURE_THRESHOLD) {
                    console.warn(
                        `⚠️ Agent ${agent.id} failed to ring ${failures} times in a row — flipping offline instead of retrying again next tick`
                    );
                    ringFailureCounts.delete(agent.id);
                    await setAgentStatus(agent.id, 'offline');
                } else {
                    ringFailureCounts.set(agent.id, failures);
                    await setAgentStatus(agent.id, 'available');
                }
            }
        })
    );

    if (ringGroup.length === 0) {
        ringGroupBySessionId.delete(waiting.sessionId);
        waitingQueue.unshift(waiting); // nobody could actually be reached — retry next tick
    }
}

// Ends the call for anyone who's been waiting past MAX_QUEUE_WAIT_MS —
// dequeueNext has no notion of giving up on its own, so without this a
// customer can sit on hold forever if agents keep being unavailable or keep
// not answering. Uses the same "no agents online" forwarding config as the
// IVR-entry check, since a queue timeout is the same situation (nobody's
// realistically going to answer) just discovered later.
async function timeoutStaleQueueEntries() {
    const cutoff = Date.now() - MAX_QUEUE_WAIT_MS;
    const stale = waitingQueue.filter(w => w.joinedAt <= cutoff);
    if (stale.length === 0) return;

    for (const entry of stale) {
        const idx = waitingQueue.indexOf(entry);
        if (idx !== -1) waitingQueue.splice(idx, 1);
        await giveUpOnQueuedCustomer(entry).catch(err =>
            console.error(`❌ Failed to time out queued call ${entry.sessionId}:`, err.message)
        );
    }
}

async function giveUpOnQueuedCustomer({ channel, sessionId, bridge }) {
    const { ttsVoice, ttsSpeedScale } = await getIvrConfig();
    const voiceOpts = { voiceKey: ttsVoice, speedScale: ttsSpeedScale };

    await (bridge || holdingBridge).removeChannel({ channel: channel.id }).catch(() => {});

    const destination = await getNoAgentsForwardingDestination();
    if (destination) {
        console.log(`⌛↪️  ${sessionId}: queue wait exceeded ${MAX_QUEUE_WAIT_MS / 1000}s, forwarding to ${destination}`);
        await upsertCallLog({ session_id: sessionId, status: 'forwarded' });
        await channel.setChannelVar({ variable: 'FORWARD_DEST', value: destination }).catch(() => {});
        await channel.continueInDialplan({ context: 'forward-external', extension: 's', priority: 1 }).catch(() => {});
        return;
    }

    console.log(`⌛ ${sessionId}: queue wait exceeded ${MAX_QUEUE_WAIT_MS / 1000}s, no forwarding configured — apologizing and hanging up`);
    await playText(channel, "We're sorry, all our agents are still busy right now. Please try again shortly.", voiceOpts).catch(() => {});
    await upsertCallLog({ session_id: sessionId, status: 'failed' });
    await channel.hangup().catch(() => {});
}

// Hangs up every ringing leg except the winner and reverts their agent
// status — called the instant one agent answers.
async function stopSiblingRings(customerSessionId, winningChannelId) {
    const siblings = ringGroupBySessionId.get(customerSessionId) || [];
    ringGroupBySessionId.delete(customerSessionId);

    await Promise.all(
        siblings
            .filter(sib => sib.channel.id !== winningChannelId)
            .map(async sib => {
                agentLegBySessionId.delete(sib.channel.id);
                await sib.channel.hangup().catch(() => {});
                await setAgentStatus(sib.agentId, 'available');
            })
    );
}

async function bridgeAgentLeg(agentChannel, agentId, customerSessionId) {
    const pending = agentLegBySessionId.get(agentChannel.id);
    agentLegBySessionId.delete(agentChannel.id);
    const customerChannel = pending ? pending.channel : null;
    const customerHoldingBridge = pending ? pending.bridge : null;

    // No `await` between this check and claimedSessions.add() below — both
    // run synchronously in the same event-loop turn, so two agents
    // answering "simultaneously" still resolve one-at-a-time here. Whoever
    // loses the race sees claimedSessions already holding this session and
    // backs off instead of double-bridging the same customer channel.
    //
    // ringGroupBySessionId.has(...) catches a narrower, earlier version of
    // the same race: this agent's originate() can still be in flight (not
    // yet pushed into the ring group array in dequeueNext) when the
    // customer hangs up — the global StasisEnd handler's stopSiblingRings
    // call only hangs up legs already IN that array, and deletes this map
    // entry regardless, so its absence here reliably means the customer's
    // own cleanup already ran even for a leg that arrived too late to be
    // in the array yet. Checked BEFORE answer() specifically so a customer
    // who already left never sees the agent's softphone briefly "answer"
    // only to be instantly torn down a moment later.
    if (!customerChannel || claimedSessions.has(customerSessionId) || !ringGroupBySessionId.has(customerSessionId)) {
        await agentChannel.hangup().catch(() => {});
        await setAgentStatus(agentId, 'available');
        return;
    }
    claimedSessions.add(customerSessionId);

    await stopSiblingRings(customerSessionId, agentChannel.id);

    // Catches the customer hanging up in the narrow window while we're still
    // awaiting the agent's answer() below — the real cleanup listeners aren't
    // attached until after answer() succeeds, so without this a hangup here
    // would only ever surface later as a failed bridge.addChannel once the
    // agent's leg tries to connect to an already-gone customer channel.
    let customerHungUpEarly = false;
    const onEarlyCustomerHangup = () => {
        customerHungUpEarly = true;
    };
    customerChannel.once('StasisEnd', onEarlyCustomerHangup);

    try {
        await agentChannel.answer();
    } catch (err) {
        // The agent rejected, hung up, or the leg failed before actually
        // connecting. Without this, the customer was stranded forever: the
        // claim was never released, so no other agent could ever be bridged
        // to them, they were already dropped from waitingQueue by the
        // dequeue that started this ring, and nothing would retry them.
        console.log(`📵 Agent ${agentId} didn't answer ${customerSessionId}: ${err.message}`);
        customerChannel.removeListener('StasisEnd', onEarlyCustomerHangup);
        claimedSessions.delete(customerSessionId);
        await agentChannel.hangup().catch(() => {});
        await setAgentStatus(agentId, 'available');
        if (!customerHungUpEarly) {
            // Preserve the customer's original bridge and joinedAt (from
            // `pending`, captured back in enterQueue) rather than fabricating
            // fresh ones — a new joinedAt here would reset their wait-time
            // clock on every non-answer, letting the MAX_QUEUE_WAIT_MS
            // timeout below be dodged indefinitely by repeated retries, and
            // a missing bridge here silently falls back to the module-level
            // holdingBridge, which can be a different bridge if it was ever
            // recreated in between (see enterQueue's comment on why bridge
            // is captured per-customer instead of re-read).
            waitingQueue.unshift({
                channel: customerChannel,
                sessionId: customerSessionId,
                joinedAt: pending.joinedAt,
                bridge: customerHoldingBridge
            });
        }
        return;
    }

    customerChannel.removeListener('StasisEnd', onEarlyCustomerHangup);
    if (customerHungUpEarly) {
        console.log(`📵 Customer hung up before agent ${agentId} finished answering ${customerSessionId}`);
        claimedSessions.delete(customerSessionId);
        await agentChannel.hangup().catch(() => {});
        await setAgentStatus(agentId, 'available');
        return;
    }

    // Registered right after answer() succeeds — before the bridge-setup
    // sequence below, which has several awaits (bridge create, remove from
    // holding, add channels, DB writes). Attaching these listeners only
    // after all of that finished meant a hangup during that window fired
    // StasisEnd before anything was listening for it: standard EventEmitter
    // semantics, an event that fires before you subscribe is simply missed.
    // The agent would be left claimed, on_call, and bridged to a channel
    // that no longer existed, with nothing to ever clean it up.
    // Split from a single shared cleanup() into two directions: only an
    // agent-initiated hangup can plausibly route the customer into a rating
    // prompt afterward (bridge.destroy() doesn't hang up member channels —
    // that's exactly why the explicit agentChannel.hangup() below is still
    // needed — so the customer leg is left live and controllable). A
    // customer-initiated hangup means there's nothing left to prompt.
    let cleaned = false;
    const state = { bridge: null, startedAt: null };
    const teardown = async finalStatus => {
        if (cleaned) return;
        cleaned = true;
        claimedSessions.delete(customerSessionId);
        activeBridgeBySessionId.delete(customerSessionId);
        // Every party added via add-a-party, including one still ringing and
        // not yet actually in the bridge — otherwise a channel mid-dial when
        // the original call ends is never hung up here, only whenever
        // Asterisk's own dial timeout eventually gives up on it.
        const partyChannels = partyChannelsBySessionId.get(customerSessionId);
        partyChannelsBySessionId.delete(customerSessionId);
        if (state.bridge) await state.bridge.destroy().catch(() => {});
        await agentChannel.hangup().catch(() => {});
        if (partyChannels) await Promise.all([...partyChannels].map(ch => ch.hangup().catch(() => {})));
        await setAgentStatus(agentId, 'available');
        await upsertCallLog({
            session_id: customerSessionId,
            status: finalStatus,
            duration: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0
        });
        console.log(`📴 Call ended: ${customerSessionId} <-> agent ${agentId} (${finalStatus})`);
    };

    // teardown()'s own agentChannel.hangup() below cascades into a second
    // StasisEnd for the agent leg even when the CUSTOMER hung up first —
    // without this flag, that cascade would run runRatingIvr() against a
    // customerChannel that's already gone. channel.play() fails silently
    // against a dead channel (see playText's own .catch), so PlaybackFinished
    // then never fires and that call hangs forever: a permanently-pending
    // promise plus its listener, leaked on every customer-initiated hangup.
    let customerGone = false;

    customerChannel.once('StasisEnd', async () => {
        customerGone = true;
        await teardown('completed');
        await customerChannel.hangup().catch(() => {});
    });

    agentChannel.once('StasisEnd', async () => {
        await teardown('completed');
        if (customerGone) return;
        const { ratingEnabled, ttsVoice, ttsSpeedScale } = await getIvrConfig();
        if (ratingEnabled) {
            await runRatingIvr(customerChannel, customerSessionId, { voiceKey: ttsVoice, speedScale: ttsSpeedScale }).catch(err =>
                console.error(`❌ Rating IVR error for ${customerSessionId}:`, err.message)
            );
        } else {
            await customerChannel.hangup().catch(() => {});
        }
    });

    try {
        const bridge = await client.bridges.create({ type: 'mixing' });
        state.bridge = bridge;
        activeBridgeBySessionId.set(customerSessionId, bridge);
        await (customerHoldingBridge || holdingBridge).removeChannel({ channel: customerChannel.id }).catch(() => {});
        await bridge.addChannel({ channel: [customerChannel.id, agentChannel.id] });

        state.startedAt = Date.now();
        await setAgentStatus(agentId, 'on_call');
        // agent_id is the reliable identifier — agent_number (kept for
        // backward compatibility with rows/code that still read it) is
        // matched against agents.phone, which is null for every agent
        // provisioned through the modern SIP flow (confirmed live: 9 of 10
        // real agents), silently breaking their attribution, their own
        // active-call lookup, and their stats entirely.
        const agentPhone = await getAgentPhone(agentId);
        await upsertCallLog({ session_id: customerSessionId, status: 'ongoing', agent_id: agentId, agent_number: agentPhone });

        console.log(`🔗 Bridged ${customerSessionId} with agent ${agentId}`);
    } catch (err) {
        // Previously unhandled — this rejection propagated all the way to
        // the generic StasisStart catch, leaving the claim held forever,
        // the agent stuck (never reverted to available), and no StasisEnd
        // listener state to fall back on either. Now it's exactly one of
        // several ways teardown() can be reached, all idempotent. The bridge
        // never really formed, so this always takes the plain-hangup path,
        // never the rating one.
        console.error(`❌ Error bridging agent ${agentId} to ${customerSessionId}:`, err.message);
        await teardown('failed');
        await customerChannel.hangup().catch(() => {});
    }
}

// Only reached from bridgeAgentLeg's agent-hung-up path, on a customer
// channel that's still live but no longer bridged to anyone. Reuses the
// exact "play a prompt, race it against a digit-or-timeout" idiom already
// proven in runIvrMenu. A digit outside 1-5, a timeout, or the customer
// hanging up mid-prompt all just skip the rating write and hang up —
// nothing here can leave the channel stuck.
async function runRatingIvr(customerChannel, sessionId, voiceOpts) {
    console.log(`⭐ ${sessionId}: playing rating prompt`);
    let customerGone = false;
    const onGone = () => {
        customerGone = true;
    };
    customerChannel.once('StasisEnd', onGone);

    const digitWait = waitForDigitOrTimeout(customerChannel.id, RATING_TIMEOUT_MS);
    const digit = await Promise.race([
        playText(customerChannel, 'Please rate this call from 1 to 5, with 5 being excellent.', voiceOpts)
            .then(() => null)
            .catch(() => null),
        digitWait.promise
    ]);
    digitWait.cancel();
    customerChannel.removeListener('StasisEnd', onGone);

    if (!customerGone && digit && /^[1-5]$/.test(digit)) {
        await upsertCallLog({ session_id: sessionId, rating: Number(digit) });
        console.log(`⭐ ${sessionId} rated ${digit}/5`);
    } else {
        console.log(`⭐ ${sessionId}: no rating captured (customerGone=${customerGone}, digit=${digit ?? 'none'})`);
    }

    await customerChannel.hangup().catch(() => {});
}

// ARI channel names look like "PJSIP/simon-00000123" — the part between the
// slash and the trailing dash is the endpoint name, which doubles as the
// sip_username the agent registered with.
// Asterisk channel names are PJSIP/<endpoint>-<hex-id>, where the trailing
// hex id is always separated by the LAST hyphen — matching up to the FIRST
// hyphen instead would silently break attribution for any sip_username that
// itself contains one (sip_username has no format constraint in the schema).
function parseSipUsername(channelName) {
    const match = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(channelName || '');
    return match ? match[1] : null;
}

// An agent's browser dials out by sending a plain SIP INVITE to Asterisk,
// which the dialplan now routes into this Stasis app instead of a bare
// Dial() — the only way to actually log the call and know which agent placed
// it. The agent leg is answered immediately (so their SIP.js session
// transitions to Established right away) while the real destination is
// dialed out separately; the two are bridged only once the destination
// genuinely answers, mirroring the same answer-then-bridge sequencing
// already proven for inbound agent legs. A ring() indication gives the
// agent real ringback audio for however long the destination actually
// takes to pick up, instead of silence.
// `internalTarget` ({ targetAgentId, sipUsername }), when present, means this
// is an agent-to-agent call — dials the target's own PJSIP endpoint directly
// instead of the external `destination`@at-trunk. Everything else (answer,
// ringback, pending/StasisEnd bookkeeping, the no-answer backstop) is
// identical between the two, so this one function stays the single place
// that logic lives rather than being duplicated for internal calls.
async function handleOutboundAgentCall(agentChannel, destination, internalTarget = null) {
    const sessionId = agentChannel.id;
    const calledNumber = internalTarget ? null : normalizePhone(destination);

    try {
        await agentChannel.answer();
    } catch (err) {
        console.error(`❌ Failed to answer outbound agent leg ${sessionId}:`, err.message);
        await agentChannel.hangup().catch(() => {});
        return;
    }

    // Registered immediately after answer() succeeds, before any further
    // awaits — an agent hanging up during the ring() call below would
    // otherwise fire StasisEnd before anything is listening for it, leaving
    // this session's pending state (and the real PSTN dial further down)
    // to run to completion for an agent who already hung up.
    const pending = {
        agentChannel,
        agentId: null,
        // The callee of an internal agent-to-agent call — tracked
        // separately from agentId (always the caller) so both sides of the
        // call get flipped to on_call/available together. Without this,
        // the callee's own status never changes: dequeueNext could route
        // an unrelated customer call to them mid-conversation, and the
        // frontend's ghost-call reconciliation (no call_logs row is ever
        // attributed to them either) would force-end their real call.
        internalTargetAgentId: internalTarget?.targetAgentId ?? null,
        destChannel: null,
        bridge: null,
        bridged: false,
        cleaned: false,
        answeredAt: null,
        noAnswerTimer: null
    };
    outboundBySessionId.set(sessionId, pending);

    agentChannel.once('StasisEnd', () => {
        finishOutboundCall(sessionId, pending.bridged ? 'completed' : 'failed').catch(err =>
            console.error('❌ Error finishing outbound call:', err.message)
        );
    });

    if (pending.cleaned) return; // agent already hung up — don't dial the real destination for nothing

    // Gives the agent audible ringback while the destination is actually
    // ringing (confirmed via live SIP trace: the destination can genuinely
    // ring for 10+ real seconds before pickup) — without this the agent
    // hears silence the whole time, indistinguishable from "nothing is
    // happening". Stopped in completeOutboundBridge once real audio takes
    // over, or in finishOutboundCall if the call ends before that. Not
    // awaited — this is pure agent-side audio feedback, unrelated to
    // dialing the real destination, which should start as fast as possible
    // (same reasoning as the log/originate parallelization just below).
    agentChannel.ring().catch(() => {});

    // The destination should start dialing as fast as possible — measured
    // live, the agent lookup + call log write below took ~665ms combined
    // (two sequential Supabase round trips), all of it previously spent
    // *before* originate() was even called. Neither is needed to place the
    // call itself, only to log/attribute it, so they now run concurrently
    // with origination instead of blocking it. Safe ordering-wise: the
    // initial 'dialing' row lands well before any real PSTN answer could
    // possibly arrive (that alone takes several seconds), so there's no
    // realistic risk of it overwriting completeOutboundBridge's later
    // 'ongoing' write.
    const calledLabel = internalTarget ? `agent #${internalTarget.targetAgentId}` : calledNumber;

    const logPromise = (async () => {
        const agentInfo = await getAgentBySipUsername(parseSipUsername(agentChannel.name));
        pending.agentId = agentInfo?.id ?? null;
        console.log(`📤 Outbound call ${sessionId}: agent ${agentInfo?.name || 'unknown'} -> ${calledLabel}`);
        await upsertCallLog({
            session_id: sessionId,
            caller: internalTarget ? `internal:${internalTarget.targetAgentId}` : calledNumber,
            direction: 'Outbound',
            status: 'dialing',
            agent_id: agentInfo?.id ?? null,
            agent_number: agentInfo?.phone || null
        });
    })();

    const originatePromise = client.channels
        .originate({
            endpoint: internalTarget ? `PJSIP/${internalTarget.sipUsername}` : `PJSIP/${destination}@at-trunk`,
            app: APP_NAME,
            appArgs: `outbound-dest:${sessionId}`,
            callerId: OUTBOUND_CALLER_ID,
            timeout: 30
        })
        .catch(async err => {
            console.error(`❌ Failed to originate outbound call to ${calledLabel}:`, err.message);
            // Wait for the concurrent 'dialing' write to land first (best
            // effort — ignore if it itself failed) so this 'failed' write is
            // guaranteed to be the last one in, not overwritten by a
            // slower-to-land 'dialing' upsert racing in after it.
            await logPromise.catch(() => {});
            return finishOutboundCall(sessionId, 'failed');
        });

    // Backstop for an unanswered call: originate()'s own `timeout: 30` above
    // is supposed to be Asterisk's job, but that's a narrower, less
    // battle-tested enforcement path than dialplan-timeout handling (there's
    // no independent check here otherwise) — reported live as calls that
    // just hang instead of ending. Cleared on a real bridge
    // (completeOutboundBridge) or the destination's own StasisEnd
    // (finishOutboundCall clears it unconditionally); finishOutboundCall is
    // already idempotent via `pending.cleaned`, so a late/duplicate fire
    // here is a harmless no-op, not a new failure mode.
    pending.noAnswerTimer = setTimeout(() => {
        finishOutboundCall(sessionId, 'failed').catch(err =>
            console.error('❌ Error finishing unanswered outbound call:', err.message)
        );
    }, 33000);

    await Promise.all([logPromise, originatePromise]);
}

// Agent-to-agent calling: the dialplan's `_9X.` context (reserved — real
// numbers all match `_+X.` instead, so there's no collision risk) hands us
// `9<targetAgentId>` as the dialed extension. Resolved to a PJSIP endpoint
// name up front so handleOutboundAgentCall never has to know the difference
// between "dial this raw destination" and "dial this teammate" beyond the
// one internalTarget object.
async function handleInternalAgentCall(agentChannel, targetAgentIdRaw) {
    const sessionId = agentChannel.id;
    const targetAgentId = parseInt(targetAgentIdRaw, 10);
    const target = Number.isInteger(targetAgentId) ? await getAgentSipCredentials(targetAgentId) : null;

    // Every rejection path below writes a 'failed' call_logs row before
    // hanging up — previously this function just hung up silently, leaving
    // a mistyped/unavailable-target internal call invisible in call
    // history (the global StasisEnd/markMissedIfAbandoned fallback is a
    // no-op too, since it has no row to match against).
    const reject = async reason => {
        console.error(`❌ Internal call to agent ${targetAgentIdRaw} rejected: ${reason}`);
        await upsertCallLog({
            session_id: sessionId,
            caller: `internal:${targetAgentIdRaw}`,
            direction: 'Outbound',
            status: 'failed'
        }).catch(() => {});
        await agentChannel.hangup().catch(() => {});
    };

    if (!target) {
        await reject('invalid id, or target agent not provisioned for softphone');
        return;
    }

    // No extra DB round-trip — the caller's own SIP username is already
    // derivable from the channel name, same helper used for logging below.
    if (target.sipUsername === parseSipUsername(agentChannel.name)) {
        await reject('cannot call yourself');
        return;
    }

    if (target.status !== 'available') {
        await reject(`target agent is currently '${target.status}', not available`);
        return;
    }

    await handleOutboundAgentCall(agentChannel, null, { targetAgentId, sipUsername: target.sipUsername });
}

// The destination leg USUALLY enters Stasis while still ringing, well
// before answer — but confirmed live (see the state-staleness bug this
// replaced) that a quickly-answered call on this trunk can already be 'Up'
// by the time StasisStart fires and we get control of it. That means
// waiting on a *future* ChannelStateChange to 'Up' is not sufficient by
// itself — there may never be one, since the channel is already there.
// Checked both ways: immediately against the freshly-constructed channel
// object's own state (accurate at this exact moment, unlike stashing this
// same reference and re-reading .state off it after later events — that
// staleness is what broke this originally), and via the listener for the
// case where it's still genuinely ringing.
async function bridgeOutboundDest(destChannel, sessionId) {
    const pending = outboundBySessionId.get(sessionId);
    if (!pending) {
        await destChannel.hangup().catch(() => {});
        return;
    }
    pending.destChannel = destChannel;

    const onStateChange = (event, updatedChannel) => {
        if (updatedChannel.state !== 'Up') return;
        destChannel.removeListener('ChannelStateChange', onStateChange);
        completeOutboundBridge(sessionId).catch(err => console.error('❌ Error bridging outbound call:', err.message));
    };
    destChannel.on('ChannelStateChange', onStateChange);

    destChannel.once('StasisEnd', () => {
        destChannel.removeListener('ChannelStateChange', onStateChange);
        finishOutboundCall(sessionId, pending.bridged ? 'completed' : 'failed').catch(err =>
            console.error('❌ Error finishing outbound call:', err.message)
        );
    });

    if (destChannel.state === 'Up') {
        destChannel.removeListener('ChannelStateChange', onStateChange);
        completeOutboundBridge(sessionId).catch(err => console.error('❌ Error bridging outbound call (already up):', err.message));
    }
}

async function completeOutboundBridge(sessionId) {
    const pending = outboundBySessionId.get(sessionId);
    // `bridging` guards against re-entry while this is still in flight
    // (async, so a second ChannelStateChange event could otherwise start a
    // second concurrent attempt); `bridged` is only set true once the
    // bridge has actually, successfully formed — previously it was set
    // eagerly up front, so a failure in bridges.create()/addChannel() below
    // would still leave the call logged as 'completed' rather than
    // 'failed' when it later ended (finishOutboundCall branches on exactly
    // this flag), and the agent's status would never actually flip to
    // on_call at all since that line was never reached.
    if (!pending || pending.bridging || pending.bridged || !pending.destChannel) return;
    pending.bridging = true;
    // A real answer — the no-answer backstop no longer applies to this call,
    // and must not fire later mid-conversation and hang up an ongoing call.
    clearTimeout(pending.noAnswerTimer);

    try {
        await pending.agentChannel.ringStop().catch(() => {});
        const bridge = await client.bridges.create({ type: 'mixing' });
        pending.bridge = bridge;
        await bridge.addChannel({ channel: [pending.agentChannel.id, pending.destChannel.id] });
        await upsertCallLog({ session_id: sessionId, status: 'ongoing' });

        pending.bridged = true;
        pending.answeredAt = Date.now();

        // Without this, the roster and ring-all both kept seeing the agent
        // as 'available' for the entire duration of an outbound call — a
        // new customer could be routed straight to someone already busy.
        if (pending.agentId) await setAgentStatus(pending.agentId, 'on_call');
        // Same reasoning for the other side of an internal agent-to-agent
        // call — the callee's own status is otherwise never touched by
        // this flow at all (see the comment on pending.internalTargetAgentId).
        if (pending.internalTargetAgentId) await setAgentStatus(pending.internalTargetAgentId, 'on_call');

        console.log(`🔗 Outbound call bridged: ${sessionId}`);
    } catch (err) {
        console.error(`❌ Failed to complete outbound bridge for ${sessionId}:`, err.message);
        await finishOutboundCall(sessionId, 'failed');
    }
}

async function finishOutboundCall(sessionId, status) {
    const pending = outboundBySessionId.get(sessionId);
    if (!pending || pending.cleaned) return;
    pending.cleaned = true;
    outboundBySessionId.delete(sessionId);
    clearTimeout(pending.noAnswerTimer);

    if (pending.bridge) await pending.bridge.destroy().catch(() => {});
    await pending.agentChannel.hangup().catch(() => {});
    await pending.destChannel?.hangup().catch(() => {});

    // Only revert if this call actually flipped them to on_call in the
    // first place (completeOutboundBridge) — a call that never bridged
    // never touched agent status, and forcing 'available' here could
    // stomp on an unrelated concurrent state change (e.g. mid-ring for a
    // different, incoming call).
    if (pending.agentId && pending.bridged) await setAgentStatus(pending.agentId, 'available');
    if (pending.internalTargetAgentId && pending.bridged) await setAgentStatus(pending.internalTargetAgentId, 'available');

    const duration = pending.answeredAt ? Math.round((Date.now() - pending.answeredAt) / 1000) : 0;
    await upsertCallLog({ session_id: sessionId, status, duration });

    console.log(`📴 Outbound call ended: ${sessionId} (${status})`);
}

// Blind-add-a-party MVP: calls-app has no direct line into a live call —
// this process is the only thing that can touch a real bridge — so a
// supervisor/agent request lands as two columns on the call's own
// call_logs row (set by POST /api/calls/active/add-party) and this poll
// picks it up. Same guarded-interval shape as tryDequeueNext.
let addPartyPollInFlight = false;

async function tryAddPartyPoll() {
    if (addPartyPollInFlight) return;
    addPartyPollInFlight = true;
    try {
        const requests = await claimAddPartyRequests();
        await Promise.all(requests.map(req => originateAddPartyLeg(req.session_id, req.add_party_destination)));
    } finally {
        addPartyPollInFlight = false;
    }
}

// Dials the new party exactly like handleOutboundAgentCall dials its real
// destination leg — same trunk, same endpoint shape — but this leg is never
// bridged to a fresh agent channel; bridgeAddPartyDest below merges it
// straight into the existing agent<->customer bridge once it answers.
async function originateAddPartyLeg(customerSessionId, destination) {
    if (!activeBridgeBySessionId.has(customerSessionId)) {
        // The original call already ended (or was never actually bridged)
        // by the time this request was claimed — nothing to add to.
        await setAddPartyStatus(customerSessionId, 'failed');
        return;
    }

    try {
        await client.channels.originate({
            endpoint: `PJSIP/${destination}@at-trunk`,
            app: APP_NAME,
            appArgs: `add-party-dest:${customerSessionId}`,
            callerId: OUTBOUND_CALLER_ID,
            timeout: 30
        });
    } catch (err) {
        console.error(`❌ Failed to originate add-party leg to ${destination} for ${customerSessionId}:`, err.message);
        await setAddPartyStatus(customerSessionId, 'failed');
    }
}

// The new party's channel enters Stasis the same way an outbound-dest leg
// does (see bridgeOutboundDest) — it may already be 'Up' by the time we get
// control, or still genuinely ringing. Tracked in partyChannelsBySessionId
// from the moment it enters Stasis (not just once answered) so a hangup —
// either this channel's own or the original call ending first — can never
// orphan it mid-dial.
async function bridgeAddPartyDest(destChannel, customerSessionId) {
    const partyChannels = partyChannelsBySessionId.get(customerSessionId) || new Set();
    partyChannels.add(destChannel);
    partyChannelsBySessionId.set(customerSessionId, partyChannels);

    let bridged = false;
    const onStateChange = (event, updatedChannel) => {
        if (updatedChannel.state !== 'Up') return;
        destChannel.removeListener('ChannelStateChange', onStateChange);
        bridged = true;
        completeAddParty(destChannel, customerSessionId).catch(err =>
            console.error(`❌ Error completing add-party for ${customerSessionId}:`, err.message)
        );
    };
    destChannel.on('ChannelStateChange', onStateChange);

    destChannel.once('StasisEnd', () => {
        destChannel.removeListener('ChannelStateChange', onStateChange);
        partyChannels.delete(destChannel);
        // If the original call already ended, this StasisEnd is just the
        // bridge's own teardown hanging this channel up too — leave
        // add_party_status alone (teardown doesn't touch it, and the row
        // itself is about to go to a terminal status anyway). Only report
        // in when the original call is still live: 'failed' if it never
        // got bridged (no answer / dial error), 'left' if it did and then
        // hung up on its own.
        if (activeBridgeBySessionId.has(customerSessionId)) {
            setAddPartyStatus(customerSessionId, bridged ? 'left' : 'failed').catch(() => {});
        }
    });

    if (destChannel.state === 'Up') {
        destChannel.removeListener('ChannelStateChange', onStateChange);
        bridged = true;
        await completeAddParty(destChannel, customerSessionId);
    }
}

async function completeAddParty(destChannel, customerSessionId) {
    const bridge = activeBridgeBySessionId.get(customerSessionId);
    if (!bridge) {
        // Original call ended while this leg was still ringing.
        await destChannel.hangup().catch(() => {});
        return;
    }

    try {
        await bridge.addChannel({ channel: destChannel.id });
    } catch (err) {
        // The bridge reference above can go stale between the check and
        // here (the original call ending destroys it on Asterisk's side
        // right in that window) — without this, add_party_status is left
        // stuck at 'dialing' forever, since destChannel's own StasisEnd
        // handler only reports in when the original call is still live,
        // which by then it no longer is. The dashboard would otherwise show
        // "Adding party…" indefinitely with no way to know it failed.
        console.error(`❌ Failed to add party to call ${customerSessionId}:`, err.message);
        await setAddPartyStatus(customerSessionId, 'failed').catch(() => {});
        return;
    }
    await setAddPartyStatus(customerSessionId, 'connected');
    console.log(`➕ Added party to call ${customerSessionId}`);
}

async function main() {
    client = await ari.connect(ARI_URL, ARI_USERNAME, ARI_PASSWORD);
    ariHealthy = true;

    client.on('StasisStart', async (event, channel) => {
        const args = event.args || [];

        // Health-probe channels from checkAriEventDelivery below — never a
        // real customer, so no call_logs write and no IVR. Just prove the
        // event actually arrived and get out of the way.
        if (args[0] === 'health-probe') {
            channel.hangup().catch(() => {});
            return;
        }

        if (args[0] && args[0].startsWith('agent-leg:')) {
            const [, agentId, customerSessionId] = args[0].split(':');
            bridgeAgentLeg(channel, agentId, customerSessionId).catch(err =>
                console.error('❌ Error bridging agent leg:', err.message)
            );
            return;
        }

        if (args[0] && args[0].startsWith('outbound-agent:')) {
            const destination = args[0].slice('outbound-agent:'.length);
            handleOutboundAgentCall(channel, destination).catch(err =>
                console.error('❌ Error handling outbound call:', err.message)
            );
            return;
        }

        if (args[0] && args[0].startsWith('internal-agent:')) {
            const targetAgentId = args[0].slice('internal-agent:'.length);
            handleInternalAgentCall(channel, targetAgentId).catch(err =>
                console.error('❌ Error handling internal agent call:', err.message)
            );
            return;
        }

        if (args[0] && args[0].startsWith('outbound-dest:')) {
            const sessionId = args[0].slice('outbound-dest:'.length);
            bridgeOutboundDest(channel, sessionId).catch(err =>
                console.error('❌ Error handling outbound destination leg:', err.message)
            );
            return;
        }

        if (args[0] && args[0].startsWith('add-party-dest:')) {
            const customerSessionId = args[0].slice('add-party-dest:'.length);
            bridgeAddPartyDest(channel, customerSessionId).catch(err =>
                console.error('❌ Error handling add-party destination leg:', err.message)
            );
            return;
        }

        const caller = normalizePhone(channel.caller.number);
        const sessionId = channel.id;
        console.log(`📞 Inbound call ${sessionId} from ${caller}`);

        try {
            await upsertCallLog({ session_id: sessionId, caller, status: 'ivr_started', direction: 'Inbound' });
            await channel.answer();

            const hours = await getBusinessHours();
            if (hours?.enabled && !isWithinBusinessHours(hours)) {
                console.log(`🌙 ${sessionId}: outside business hours, playing after-hours message`);
                await upsertCallLog({ session_id: sessionId, status: 'after_hours' });
                const { ttsVoice, ttsSpeedScale } = await getIvrConfig();
                await playText(channel, hours.after_hours_message, { voiceKey: ttsVoice, speedScale: ttsSpeedScale });
                await channel.hangup().catch(() => {});
                return;
            }

            await runIvrMenu(channel, sessionId);
        } catch (err) {
            console.error(`❌ Error handling call ${sessionId}:`, errText(err));
            await channel.hangup().catch(() => {});
        }
    });

    client.on('StasisEnd', async (event, channel) => {
        try {
            // Drop from the waiting queue if they hang up before any agent's
            // phone/browser started ringing.
            const idx = waitingQueue.findIndex(w => w.channel.id === channel.id);
            if (idx !== -1) waitingQueue.splice(idx, 1);

            // Customer sessionId === their own channel id — if they hang up
            // while a ring group is still out for them, nothing else would ever
            // stop those other agents' phones/browsers from ringing.
            if (ringGroupBySessionId.has(channel.id)) {
                await stopSiblingRings(channel.id, null);
            }
        } catch (err) {
            // Whatever went wrong above must not stop the call from being
            // marked missed below — that's the one write that keeps a row
            // from being stuck showing "waiting" in the dashboard forever.
            console.error(`❌ StasisEnd cleanup error for ${channel.id}:`, err.message);
        }

        // Catch-all for "nobody ever picked this up": a call that leaves
        // Stasis while still sitting in a pre-answer status (never bridged)
        // is a genuinely missed call — the customer either hung up in the
        // menu/queue/while ringing, or gave up entirely. The status filter
        // makes this safe to call unconditionally for every channel
        // (agent legs, outbound legs, bridged/forwarded/after-hours calls
        // all have already moved past these statuses, so this is a no-op
        // for them).
        await markMissedIfAbandoned(channel.id).catch(err =>
            console.error(`❌ Failed to mark ${channel.id} as missed:`, err.message)
        );
    });

    // ari-client has no built-in reconnect — an 'error' here means the
    // websocket to Asterisk is gone, and every in-memory map above (queue,
    // bridges, ring groups) is now stale relative to whatever Asterisk
    // thinks is happening. Rebuilding that state in place is far riskier
    // than a clean restart: exit and let systemd (Restart=always,
    // RestartSec=3) bring up a fresh connection with fresh state, the same
    // philosophy already used for uncaughtException above.
    client.on('error', err => {
        ariHealthy = false;
        console.error('❌ ARI client error — exiting for a clean restart:', err.message);
        process.exit(1);
    });

    // Reconciled BEFORE client.start()/the poll intervals below register —
    // otherwise a call could theoretically enter Stasis in the brief window
    // while these sequential startup queries are still in flight, and
    // getAvailableAgentsWithSip() could see an agent this restart hasn't
    // reconciled back from stale on-call/ringing yet.
    //
    // This process owns zero in-memory state for anything that was already
    // ivr_started/queued/ongoing before it started — a prior instance's
    // crash or a routine deploy restart both orphan those rows the same
    // way. Left alone they'd sit in call_logs looking "live" forever, since
    // nothing would ever move them to a terminal status again.
    const reconciled = await reconcileStaleCallsOnStartup();
    if (reconciled > 0) console.log(`🧹 Reconciled ${reconciled} stale in-progress call(s) from before this restart`);

    const staleAgentsReconciled = await reconcileStaleAgentsOnStartup();
    if (staleAgentsReconciled > 0)
        console.log(`🧹 Reconciled ${staleAgentsReconciled} agent(s) stuck on-call from before this restart`);

    const ghostsReconciled = await reconcileGhostAgents();
    if (ghostsReconciled.length > 0) console.log(`👻 Reconciled ${ghostsReconciled.length} ghost agent(s) back to offline on startup`);

    client.start(APP_NAME);
    setInterval(() => tryDequeueNext().catch(err => console.error('❌ Queue poll error:', err.message)), QUEUE_POLL_MS);
    setInterval(() => timeoutStaleQueueEntries().catch(err => console.error('❌ Queue timeout sweep error:', err.message)), QUEUE_POLL_MS);
    setInterval(() => tryAddPartyPoll().catch(err => console.error('❌ Add-party poll error:', err.message)), ADD_PARTY_POLL_MS);
    setInterval(
        () =>
            sweepStaleCalls(STALE_CALL_PREBRIDGE_MAX_AGE_MS, STALE_CALL_ONGOING_MAX_AGE_MS)
                .then(swept => {
                    if (swept.length > 0) console.log(`🧹 Swept ${swept.length} stale call_logs row(s)`);
                })
                .catch(err => console.error('❌ Stale-call sweep poll error:', err.message)),
        STALE_CALL_SWEEP_MS
    );

    // The 'error' handler above only fires if ari-client's websocket
    // surfaces a fatal error — it does nothing for a connection that goes
    // quiet without erroring (observed in practice as the root cause of the
    // week-long inbound outage this process exists to prevent a repeat of).
    //
    // A plain REST round-trip (the original version of this check) only
    // proves the HTTP side of the ARI connection still answers — it does
    // NOT prove the separate event-delivery websocket is still delivering
    // StasisStart/StasisEnd. Those are genuinely independent under the
    // hood, and a live load test caught exactly that split: this process
    // stopped receiving StasisStart entirely (real inbound calls would have
    // silently failed) while client.channels.list() kept succeeding and
    // this heartbeat kept reporting healthy the whole time. Originating a
    // real probe channel into this same Stasis app and requiring an actual
    // StasisStart callback for it is the only check that would have caught
    // that failure — a REST call alone cannot.
    function checkAriEventDelivery() {
        return new Promise((resolve, reject) => {
            let settled = false;
            // Pre-assigned, not read from originate()'s response — the same
            // race documented elsewhere in this file (agentLegBySessionId,
            // ringGroupBySessionId): the StasisStart event can arrive over
            // the websocket before the HTTP originate() response is even
            // parsed, so a listener keyed off the response's channel id can
            // miss the one event it's waiting for and wait out the full
            // timeout every single time.
            const probeChannelId = `health-probe-${crypto.randomUUID()}`;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                client.removeListener('StasisStart', onStart);
                reject(new Error('no StasisStart received for health-probe channel'));
            }, ARI_HEARTBEAT_TIMEOUT_MS);

            function onStart(event, channel) {
                if (settled || channel.id !== probeChannelId) return;
                settled = true;
                clearTimeout(timer);
                client.removeListener('StasisStart', onStart);
                resolve();
            }
            client.on('StasisStart', onStart);

            client.channels
                .originate({
                    channelId: probeChannelId,
                    endpoint: 'Local/probe@ari-heartbeat-sink/n',
                    app: APP_NAME,
                    appArgs: 'health-probe',
                    timeout: 5
                })
                .catch(err => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    client.removeListener('StasisStart', onStart);
                    reject(err);
                });
        });
    }

    setInterval(() => {
        checkAriEventDelivery()
            .then(() => {
                ariHealthy = true;
            })
            .catch(err => {
                ariHealthy = false;
                console.error('❌ ARI heartbeat failed — event delivery looks dead:', err.message);
                process.exit(1);
            });
    }, ARI_HEARTBEAT_MS);

    // "Ghost agents" — status says available/ringing but the browser
    // heartbeat behind it has gone stale (or never existed at all, e.g. a
    // row seeded/provisioned with status='available' that nobody ever
    // actually logged into) — see reconcileGhostAgents for the full
    // rationale. Checked continuously, not just at startup, since most
    // ghosts are created by a tab dying mid-session, not by a restart.
    setInterval(
        () =>
            reconcileGhostAgents()
                .then(staleIds => {
                    if (staleIds.length === 0) return;
                    console.log(`👻 Reconciled ${staleIds.length} ghost agent(s) back to offline`);

                    const now = Date.now();
                    for (const agentId of staleIds) {
                        const recent = (ghostReconcileTimestamps.get(agentId) || []).filter(t => now - t < GHOST_FLAP_WINDOW_MS);
                        recent.push(now);
                        ghostReconcileTimestamps.set(agentId, recent);
                        if (recent.length >= GHOST_FLAP_THRESHOLD) {
                            console.warn(
                                `⚠️ Agent ${agentId}'s softphone connection has dropped ${recent.length} times in the last hour — likely an unstable connection, not a one-off`
                            );
                        }
                    }
                })
                .catch(err => console.error('❌ Ghost agent poll error:', err.message)),
        GHOST_AGENT_POLL_MS
    );

    console.log(`✅ ARI app "${APP_NAME}" connected to ${ARI_URL} and listening`);
}

main().catch(err => {
    console.error('❌ Fatal error starting ARI app:', err);
    process.exit(1);
});
