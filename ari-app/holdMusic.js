const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Mirrors PJSIP_CONF_PATH's env-override pattern in pjsipConfig.js — the
// [custom] class in /etc/asterisk/musiconhold.conf points here (see
// infra/asterisk/musiconhold.conf). A single fixed filename, not a library:
// this app tracks one active custom track at a time, replaced wholesale on
// every upload.
const MOH_CUSTOM_DIR = process.env.MOH_CUSTOM_DIR || '/var/lib/asterisk/moh-custom';
const MOH_CUSTOM_FILE = path.join(MOH_CUSTOM_DIR, 'hold.mp3');

// Defense in depth — calls-app's multer config caps uploads at the same
// size, but this process never trusts its caller's validation alone (the
// internal HTTP channel is authenticated, not sandboxed).
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function execFileP(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout, stderr });
        });
    });
}

// Same atomic-write + reload-and-verify discipline as pjsipConfig.js's
// applyAndVerify: temp file + rename (never an in-place write a crash could
// leave truncated), then a real Asterisk reload, then verify the reload
// actually picked up the class rather than trusting a 0 exit code alone —
// `moh reload` can succeed even if musiconhold.conf itself is missing the
// [custom] stanza (e.g. the one-time infra step was never done on this box).
async function writeCustomTrack(audioBuffer) {
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        throw new Error(`Audio exceeds the ${MAX_AUDIO_BYTES}-byte cap`);
    }
    fs.mkdirSync(MOH_CUSTOM_DIR, { recursive: true });

    // Snapshot whatever's currently live (if anything) before overwriting,
    // so a failed verify below can restore it — the same rollback
    // discipline pjsipConfig.js's applyAndVerify uses for pjsip.conf, just
    // for a binary file. Without this, every caller placed on hold after a
    // failed upload got whatever the new, unverified file produced, with no
    // way back to the previous known-good audio short of re-uploading it.
    const previousPath = path.join(MOH_CUSTOM_DIR, `.hold.mp3.previous-${crypto.randomUUID()}`);
    const hadPrevious = fs.existsSync(MOH_CUSTOM_FILE);
    if (hadPrevious) {
        fs.copyFileSync(MOH_CUSTOM_FILE, previousPath);
    }

    const tmpPath = path.join(MOH_CUSTOM_DIR, `.hold.mp3.tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, audioBuffer);
    fs.renameSync(tmpPath, MOH_CUSTOM_FILE);

    try {
        await execFileP('asterisk', ['-rx', 'moh reload']);
        const { stdout } = await execFileP('asterisk', ['-rx', 'moh show classes']);
        if (!/Class:\s*custom\b/.test(stdout)) {
            throw new Error(
                "Wrote the file but Asterisk doesn't report a 'custom' MOH class after reload — check the [custom] stanza in /etc/asterisk/musiconhold.conf"
            );
        }
    } catch (err) {
        if (hadPrevious) {
            fs.renameSync(previousPath, MOH_CUSTOM_FILE);
            await execFileP('asterisk', ['-rx', 'moh reload']).catch(() => {});
        } else {
            fs.unlinkSync(MOH_CUSTOM_FILE);
        }
        throw err;
    } finally {
        fs.rmSync(previousPath, { force: true });
    }
}

module.exports = { writeCustomTrack, MAX_AUDIO_BYTES };
