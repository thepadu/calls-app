// Shared by the floating dialer, add-party, Contacts, and Agents roster
// inputs. Kenya-local entry (0712345678) stays the fast, convenient path —
// this is a Kenya-based call center and that's the overwhelming majority
// of real traffic — but a leading "+" is now treated as an explicit
// international E.164 number and passed through rather than rejected.
// Deliberately not a full country-code-selector UI (flags, search, per-
// country formatting/masking) — that's real complexity for what's a
// genuine but rare case here; a liberal "+<digits>" entry with real E.164
// validation matches how the backend (calls-app/lib/phone.js's
// isValidE164) already treats this exact boundary.
export function formatPhone(phone: string): string {
    const trimmed = phone.replace(/\s+/g, '').trim();
    if (trimmed.startsWith('0')) return '254' + trimmed.substring(1);
    if (trimmed.startsWith('+')) return trimmed.substring(1);
    return trimmed;
}

// formatPhone above always returns bare digits (every call site re-adds
// its own leading "+" when it actually places the call/saves the
// contact). A Kenya-shaped result (starts "254") only checks the overall
// length — 254 + a 9-digit subscriber number — rather than restricting
// which digit follows 254 to a mobile prefix (7 or 1): that used to reject
// real, legitimate Kenya landline numbers too (e.g. a Nairobi 020 number,
// +254207640622 — the gap that prompted this exact fix), which was never
// actually the point of the check; catching an obviously truncated/
// mistyped number by length is. Anything else is validated as general
// E.164-minus-the-plus (8-15 digits), mirroring isValidE164's own
// `+\d{8,15}` exactly.
export function isValidPhone(phone: string): boolean {
    if (phone.startsWith('254')) return /^254\d{9}$/.test(phone);
    return /^\d{8,15}$/.test(phone);
}
