// In-memory cache of agent phone numbers, so /events (an Africa's Talking
// webhook fired on every call state change) doesn't hit Supabase on every
// single callback just to check "is this leg's destination an agent?".
//
// Known limitation: this cache is per-process. If this app is ever scaled
// to multiple DigitalOcean App Platform instances, each instance's cache can drift from the
// others for up to TTL_MS. The short TTL bounds the staleness; a real fix
// (if that ever matters) is a shared cache like Redis.
const TTL_MS = 30 * 1000;

let cache = { data: null, expiresAt: 0 };

async function getAgentPhones(supabase, normalizePhone) {
    if (cache.data && Date.now() < cache.expiresAt) return cache.data;

    const { data, error } = await supabase.from('agents').select('phone');

    if (error) {
        console.error('❌ Failed to refresh agent phone cache:', error);
        return cache.data || [];
    }

    cache = {
        data: data.map(a => ({ phone: a.phone, normalized: normalizePhone(a.phone) })),
        expiresAt: Date.now() + TTL_MS
    };

    return cache.data;
}

function invalidateAgentCache() {
    cache = { data: null, expiresAt: 0 };
}

module.exports = { getAgentPhones, invalidateAgentCache };
