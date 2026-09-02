// Copied from calls-app/lib/phone.js — duplicated rather than shared
// since this app deploys to a different server (the Asterisk VPS) than the
// main Express app (DigitalOcean App Platform), so a relative import isn't
// possible. Keep these two copies in sync if the normalization rules ever
// change.

function normalizePhone(phone) {
    if (!phone) return null;
    phone = phone.replace(/\s+/g, '').trim();
    if (phone.startsWith('+')) return phone.substring(1);
    if (phone.startsWith('0')) return '254' + phone.substring(1);
    return phone;
}

module.exports = { normalizePhone };
