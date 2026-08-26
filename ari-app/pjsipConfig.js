const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PJSIP_CONF_PATH = process.env.PJSIP_CONF_PATH || '/etc/asterisk/pjsip.conf';

function execFileP(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout, stderr });
        });
    });
}

// The auth/aor/endpoint keys here are copied verbatim from a real, live
// agent block (`[simon]`/`[simon-auth]`) rather than guessed — an invented
// value that "looks right" (wrong context, wrong codec, missing
// dtls_auto_generate_cert) produces an agent whose softphone silently can
// never connect, indistinguishable from a network problem from the
// dashboard's side.
function renderAgentBlock({ agentId, sipUsername, sipPassword }) {
    return `
; chumz-agent:${agentId}
[${sipUsername}-auth]
type = auth
auth_type = userpass
username = ${sipUsername}
password = ${sipPassword}

[${sipUsername}]
type = aor
max_contacts = 1
remove_existing = yes
qualify_frequency = 30

[${sipUsername}]
type = endpoint
context = test-webrtc
rtp_timeout = 120
disallow = all
allow = opus,ulaw
transport = transport-wss
webrtc = yes
dtls_auto_generate_cert = yes
aors = ${sipUsername}
auth = ${sipUsername}-auth
`;
}

// Anchored to a whole line, not a plain substring search — `agentId=5`'s
// marker ("; chumz-agent:5") is a literal substring of agent 15's/55's
// ("; chumz-agent:15"/"; chumz-agent:55"), so an unanchored indexOf() found
// the WRONG agent's block for any numeric-prefix pair of ids and reported a
// false BLOCK_CONFLICT, permanently blocking that agent from ever being
// provisioned. `agentId` must be the entire rest of the line.
function findMarkerIndex(content, agentId) {
    const match = new RegExp(`^; chumz-agent:${agentId}$`, 'm').exec(content);
    return match ? match.index : -1;
}

// The block runs from the marker to the next "; chumz-agent:" marker or
// EOF — every block this module ever writes is immediately followed by
// exactly one blank line before the next section, so this is safe to
// reconstruct without a stricter grammar. Shared by findExistingBlock
// (provisioning's conflict check) and deprovisioning's removal — one place
// that knows how to locate a block's exact extent.
function findBlockRange(content, agentId) {
    const start = findMarkerIndex(content, agentId);
    if (start === -1) return null;
    const nextMarkerIndex = content.indexOf('; chumz-agent:', start + 1);
    return { start, end: nextMarkerIndex === -1 ? content.length : nextMarkerIndex };
}

function findExistingBlock(content, agentId) {
    const range = findBlockRange(content, agentId);
    return range ? content.slice(range.start, range.end) : null;
}

// Serializes every write to pjsip.conf (provision AND deprovision) through
// one queue — the standard, minimal way to make an async critical section
// exclusive within a single Node process. Without this, two concurrent
// requests could interleave across the reload/verify `await`s below (each
// yields the event loop), and one request's rollback-to-pre-write-snapshot
// could silently destroy the other's already-succeeded write. Provisioning
// is a rare, deliberate admin action, not a hot path — full serialization
// has no meaningful cost here, and it removes the race at the source rather
// than trying to make rollback "smarter" about a partial, stale snapshot.
let writeQueue = Promise.resolve();
function withLock(fn) {
    const result = writeQueue.then(fn, fn);
    writeQueue = result.then(() => {}, () => {});
    return result;
}

// Shared by both provisioning and deprovisioning: atomic replace (temp file
// + rename, never fs.appendFileSync — a crash mid-write must never leave
// pjsip.conf truncated), reload, then a caller-supplied `verify()` against
// the reload's own output (`pjsip reload` can exit 0 even when the new
// config has a parse error). On verify failure, rolls back to the exact
// pre-write snapshot (`beforeContent`, captured by the caller) and reloads
// again, so a bad write never leaves Asterisk running on a half-applied
// config. Safe to roll back to a plain snapshot ONLY because writeQueue
// (below) guarantees no other write can happen in between — see its own
// comment for why that guarantee matters here specifically.
async function applyAndVerify(beforeContent, newContent, verify) {
    const stat = fs.statSync(PJSIP_CONF_PATH);
    const tmpPath = path.join(path.dirname(PJSIP_CONF_PATH), `.pjsip.conf.tmp-${crypto.randomUUID()}`);

    function atomicWrite(text) {
        fs.writeFileSync(tmpPath, text, 'utf8');
        fs.chmodSync(tmpPath, stat.mode);
        fs.renameSync(tmpPath, PJSIP_CONF_PATH);
    }

    try {
        atomicWrite(newContent);
    } catch (err) {
        fs.unlinkSync(tmpPath);
        throw err;
    }

    try {
        await execFileP('asterisk', ['-rx', 'pjsip reload']);
        const { stdout } = await execFileP('asterisk', ['-rx', 'pjsip show endpoints']);
        verify(stdout);
    } catch (err) {
        atomicWrite(beforeContent);
        await execFileP('asterisk', ['-rx', 'pjsip reload']).catch(() => {});
        throw err;
    }
}

// The auth/aor/endpoint keys in renderAgentBlock are copied verbatim from a
// real, live agent block (`[simon]`/`[simon-auth]`) rather than guessed —
// an invented value that "looks right" (wrong context, wrong codec, missing
// dtls_auto_generate_cert) produces an agent whose softphone silently can
// never connect, indistinguishable from a network problem from the
// dashboard's side. Strictly additive: an existing marker block that
// doesn't byte-for-byte match what would be generated is left untouched and
// reported as a conflict, so this can never silently rewrite one of the
// ~10 hand-written legacy blocks or a previous auto-provisioned one.
async function writeAgentBlock({ agentId, sipUsername, sipPassword }) {
    return withLock(async () => {
        const content = fs.readFileSync(PJSIP_CONF_PATH, 'utf8');
        const newBlock = renderAgentBlock({ agentId, sipUsername, sipPassword });
        const existing = findExistingBlock(content, agentId);

        if (existing !== null) {
            if (existing.trim() === newBlock.trim()) {
                return { alreadyProvisioned: true };
            }
            const err = new Error(`Agent ${agentId} already has a differing pjsip.conf block`);
            err.code = 'BLOCK_CONFLICT';
            throw err;
        }

        const newContent = content.replace(/\s*$/, '\n') + newBlock;
        await applyAndVerify(content, newContent, stdout => {
            if (!stdout.includes(`Endpoint:  ${sipUsername}`)) {
                throw new Error(`pjsip reload did not bring up endpoint ${sipUsername}`);
            }
        });

        return { alreadyProvisioned: false };
    });
}

// Removes an agent's block entirely — used when an agent is deleted from
// the roster, so their real SIP credentials stop working on Asterisk
// immediately rather than lingering indefinitely (the previous behavior:
// deleting an agent only removed the Supabase row, leaving pjsip.conf
// untouched and their softphone credentials fully functional forever).
// No-ops cleanly if the agent was never SIP-provisioned in the first place
// (a legacy phone-only agent) — verified by findExistingBlock returning
// null, not by assuming the caller already knows.
async function deprovisionAgentBlock(agentId) {
    return withLock(async () => {
        const content = fs.readFileSync(PJSIP_CONF_PATH, 'utf8');
        const range = findBlockRange(content, agentId);
        if (!range) {
            return { removed: false };
        }

        const removedUsernameMatch = /^\[([a-z0-9]+)-auth\]/m.exec(content.slice(range.start));
        const sipUsername = removedUsernameMatch ? removedUsernameMatch[1] : null;

        const newContent = content.slice(0, range.start) + content.slice(range.end);
        await applyAndVerify(content, newContent, stdout => {
            if (sipUsername && stdout.includes(`Endpoint:  ${sipUsername}`)) {
                throw new Error(`pjsip reload did not actually remove endpoint ${sipUsername}`);
            }
        });

        return { removed: true };
    });
}

module.exports = { writeAgentBlock, deprovisionAgentBlock, PJSIP_CONF_PATH };
