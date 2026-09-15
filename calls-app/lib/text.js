// Escapes Postgres LIKE/ILIKE metacharacters (%, _, and the backslash
// escape character itself) so a value passed to .ilike() is matched as a
// literal string, not interpreted as a wildcard pattern. Without this, an
// email like "first_last@chumz.io" read as a pattern (`_` = any single
// char) can match a completely different stored row that merely differs by
// one character at that position — see auth.js/api.js's agent-by-email
// lookups, all of which use .ilike() for case-insensitivity but never meant
// for the input itself to behave like a pattern.
function escapeLikePattern(value) {
    return String(value ?? '').replace(/[\\%_]/g, '\\$&');
}

module.exports = { escapeLikePattern };
