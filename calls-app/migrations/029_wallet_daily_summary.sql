-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- The Wallet page's transaction history was a flat, ever-growing list of
-- individual rows — every top-up, usage debit, and reversal, one row each,
-- no rollup. Once real call volume produces a usage row per call, that
-- list becomes unreadable fast. This view groups by day so the default
-- view is a day-by-day summary; the individual rows for a given day are
-- still available (calls-app/api.js's /api/wallet?day=YYYY-MM-DD), just
-- not the default.
create or replace view wallet_daily_summary as
select
    -- Grouped by Nairobi calendar day, not whatever timezone Postgres's
    -- session defaults to (typically UTC) — a call at 1am EAT is 10pm UTC
    -- the previous day, and a supervisor reading "today's" summary means
    -- their own business day, not a UTC one. Same reasoning as
    -- ari-app/lib/helpers.js's isWithinBusinessHours computing Nairobi
    -- time explicitly rather than trusting the environment.
    (created_at at time zone 'Africa/Nairobi')::date as day,
    count(*) as transaction_count,
    coalesce(sum(amount_cents) filter (where type = 'topup'), 0) as topup_cents,
    -- Usage amounts are stored negative (see wallet_apply_transaction) —
    -- flipped to positive here since "inbound cost today" reads more
    -- naturally than a negative number in a summary row.
    coalesce(sum(-amount_cents) filter (where type = 'usage' and direction = 'inbound'), 0) as inbound_usage_cents,
    coalesce(sum(-amount_cents) filter (where type = 'usage' and direction = 'outbound'), 0) as outbound_usage_cents,
    coalesce(sum(amount_cents) filter (where type = 'reversal'), 0) as reversal_cents,
    sum(amount_cents) as net_change_cents,
    -- The running balance right after the day's last transaction (by
    -- actual write order, not just created_at, since two rows can share a
    -- timestamp) — "balance at end of day", not a recomputed sum.
    (array_agg(balance_after_cents order by created_at desc, id desc))[1] as ending_balance_cents
from wallet_transactions
group by 1;
