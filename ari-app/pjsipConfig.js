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

function findExistingBlock(content, agentId) {
    const marker = `; chumz-agent:${agentId}`;
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) return null;

    // The block runs from the marker to the next "; chumz-agent:" marker or
    // EOF — every block this module ever writes is immediately followed by
    // exactly one blank line before the next section, so this is safe to
    // reconstruct without a stricter grammar.
    const nextMarkerIndex = content.indexOf('; chumz-agent:', markerIndex + marker.length);
    return content.slice(markerIndex, nextMarkerIndex === -1 ? content.length : nextMarkerIndex);
}

// Atomic replace (temp file + rename), never fs.appendFileSync — a crash
// mid-write must never leave pjsip.conf truncated. Ownership/mode are
// copied from the original file so Asterisk (which reads it, not writes
// it) never loses read access after the swap. Strictly additive: an
// existing marker block that doesn't byte-for-byte match what would be
// generated is left untouched and reported as a conflict, so this can
// never silently rewrite one of the ~10 hand-written legacy blocks or a
// previous auto-provisioned one.
async function writeAgentBlock({ agentId, sipUsername, sipPassword }) {
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
    const stat = fs.statSync(PJSIP_CONF_PATH);
    const tmpPath = path.join(path.dirname(PJSIP_CONF_PATH), `.pjsip.conf.tmp-${crypto.randomUUID()}`);

    fs.writeFileSync(tmpPath, newContent, 'utf8');
    fs.chmodSync(tmpPath, stat.mode);
    try {
        fs.renameSync(tmpPath, PJSIP_CONF_PATH);
    } catch (err) {
        fs.unlinkSync(tmpPath);
        throw err;
    }

    try {
        await execFileP('asterisk', ['-rx', 'pjsip reload']);
        // `pjsip reload` can exit 0 even when the new config has a parse
        // error — actually check the endpoint came up, not just that the
        // reload command itself didn't error.
        const { stdout } = await execFileP('asterisk', ['-rx', `pjsip show endpoint ${sipUsername}`]);
        if (!stdout.includes(`Endpoint:  ${sipUsername}`)) {
            throw new Error(`pjsip reload did not bring up endpoint ${sipUsername}`);
        }
    } catch (err) {
        // Roll back: restore exactly what was there before this write and
        // reload again, so a bad write never leaves Asterisk running on a
        // half-applied config.
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.chmodSync(tmpPath, stat.mode);
        fs.renameSync(tmpPath, PJSIP_CONF_PATH);
        await execFileP('asterisk', ['-rx', 'pjsip reload']).catch(() => {});
        throw err;
    }

    return { alreadyProvisioned: false };
}

module.exports = { writeAgentBlock, PJSIP_CONF_PATH };
