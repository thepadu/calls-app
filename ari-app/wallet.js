// Charges Chumz's own prepaid call-cost wallet for a finished call, settled
// once at call-end from the exact `duration` value index.js already
// computes and writes to call_logs — not a live per-second ticker. See
// DECISIONS.md's finance-wallet entry for why (Twilio/Africa's Talking both
// bill this way too: simpler, immune to a poller crashing mid-call, and
// there's no new call-lifecycle tracking to get wrong).
const { getWalletRate, applyWalletTransaction } = require('./supabase');

// Unanswered/abandoned calls never bridged, so they have no billable
// talk-time — duration is 0/undefined for those, and this is a deliberate
// no-op rather than a 0-cents transaction cluttering the ledger.
async function applyCallUsageCharge(sessionId, durationSeconds, alertGChat) {
    if (!durationSeconds) return;

    const rateMicrosPerSecond = await getWalletRate();
    if (!rateMicrosPerSecond) return;

    const amountCents = -Math.round((durationSeconds * rateMicrosPerSecond) / 1_000_000);
    if (!amountCents) return;

    // reference is 'call:<session_id>' — call-end can theoretically fire
    // more than once for the same session (a retried teardown), and
    // wallet_apply_transaction's unique constraint on this exact string is
    // what makes a duplicate call here a safe no-op instead of a double
    // charge.
    const result = await applyWalletTransaction({
        type: 'usage',
        amountCents,
        reference: `call:${sessionId}`
    });

    if (result?.low_balance_crossed) {
        alertGChat(
            `⚠️ Wallet balance is now KES ${(result.balance_cents / 100).toFixed(2)} — at or below the configured low-balance threshold.`
        );
    }
}

module.exports = { applyCallUsageCharge };
