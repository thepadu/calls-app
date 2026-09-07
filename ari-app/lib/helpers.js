const crypto = require('crypto');

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

module.exports = { errText, safeEqual, isWithinBusinessHours, parseSipUsername };
