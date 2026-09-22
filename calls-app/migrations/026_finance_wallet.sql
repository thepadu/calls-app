-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Finance wallet: tracks Chumz's own prepaid call-cost balance, billed per
-- second at call-end from the same `duration` value ari-app already
-- computes and writes to call_logs (see DECISIONS.md's finance-wallet
-- entry for the full reasoning — settle-at-end, not a live ticker).
--
-- Single-row config, same shape as ivr_config (004_agent_roles_and_ivr_config.sql):
-- exactly one row, enforced via a fixed primary key.
create table if not exists wallet (
    id smallint primary key default 1,
    balance_cents bigint not null default 0,
    -- Millionths of a cent per second, not cents-per-second — a rate like
    -- KES 0.50/sec needs sub-cent precision, and this avoids ever using a
    -- float. Only one multiply-and-round happens per call (settle-at-end),
    -- so there's no per-tick drift to worry about.
    rate_micros_per_second bigint not null default 0,
    low_balance_threshold_cents bigint not null default 0,
    updated_at timestamptz not null default now(),
    constraint wallet_singleton check (id = 1)
);

insert into wallet (id) values (1) on conflict (id) do nothing;

-- Append-only ledger. balance_after_cents is a snapshot for audit/debugging
-- (what the running balance was right after this entry), not itself the
-- source of truth — wallet.balance_cents is, kept in sync in the same
-- transaction by wallet_apply_transaction below.
create table if not exists wallet_transactions (
    id bigserial primary key,
    type text not null check (type in ('topup', 'usage', 'reversal')),
    amount_cents bigint not null,
    -- Idempotency key: 'call:<session_id>' for a usage debit, a
    -- server-generated UUID for a manual top-up/reversal. Enforced unique so
    -- a retried debit or duplicate top-up submission can never double-apply.
    reference text not null unique,
    balance_after_cents bigint not null,
    description text,
    created_by text,
    created_at timestamptz not null default now()
);

create index if not exists wallet_transactions_created_at_idx on wallet_transactions (created_at desc);

-- The one place this balance is ever mutated from — both ari-app (usage
-- debits) and calls-app (manual top-ups) call this via supabase.rpc(),
-- rather than duplicating atomic-update-plus-idempotency-check logic in two
-- separate Node codebases.
--
-- Debits are never rejected for insufficient funds: by the time a call is
-- billed (settle-at-end, after it's already happened), refusing to record
-- the cost would just make the ledger wrong. Blocking new calls on a low
-- balance is a distinct, currently out-of-scope decision — see
-- DECISIONS.md. low_balance_crossed only reports the edge (this specific
-- transaction moved the balance from above the threshold to at-or-below
-- it) so the caller can alert once per crossing rather than on every debit
-- while already low.
create or replace function wallet_apply_transaction(
    p_type text,
    p_amount_cents bigint,
    p_reference text,
    p_description text default null,
    p_created_by text default null
) returns table (applied boolean, balance_cents bigint, low_balance_crossed boolean) as $$
declare
    v_old_balance bigint;
    v_new_balance bigint;
    v_threshold bigint;
begin
    if exists (select 1 from wallet_transactions wt where wt.reference = p_reference) then
        select w.balance_cents into v_new_balance from wallet w where w.id = 1;
        return query select false, v_new_balance, false;
        return;
    end if;

    select w.balance_cents, w.low_balance_threshold_cents into v_old_balance, v_threshold
        from wallet w where w.id = 1;

    update wallet
        set balance_cents = balance_cents + p_amount_cents, updated_at = now()
        where id = 1
        returning balance_cents into v_new_balance;

    insert into wallet_transactions (type, amount_cents, reference, description, created_by, balance_after_cents)
        values (p_type, p_amount_cents, p_reference, p_description, p_created_by, v_new_balance);

    return query select
        true,
        v_new_balance,
        (p_amount_cents < 0 and v_old_balance > v_threshold and v_new_balance <= v_threshold);
end;
$$ language plpgsql;
