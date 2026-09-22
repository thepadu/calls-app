-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Splits the wallet's single per-second rate into an inbound and an
-- outbound rate — Africa's Talking genuinely charges very differently by
-- direction (roughly 4.5x more for outbound than inbound in Kenya), so one
-- shared rate was never actually correct. See DECISIONS.md.
alter table wallet
    add column if not exists inbound_rate_micros_per_second bigint not null default 0,
    add column if not exists outbound_rate_micros_per_second bigint not null default 0;

-- Backfill both from whatever the old single rate was set to, even though
-- it's 0 today — never assume nobody set it.
update wallet
    set inbound_rate_micros_per_second = rate_micros_per_second,
        outbound_rate_micros_per_second = rate_micros_per_second
    where id = 1;

alter table wallet drop column if exists rate_micros_per_second;

-- Nullable and separate from `type` deliberately: direction is an orthogonal
-- tag on a usage row, not a different kind of ledger operation — keeping it
-- its own column is what lets "total spend by direction" stay a plain
-- where/group by later instead of parsing it out of `type`. Only ever set
-- on 'usage' rows; top-ups/reversals have no direction.
alter table wallet_transactions
    add column if not exists direction text check (direction in ('inbound', 'outbound'));

-- `create or replace function` only replaces a function with the exact same
-- parameter list — adding p_direction here changed the signature, so
-- Postgres created a SECOND overload instead of replacing the original
-- 5-parameter one. Any caller that didn't pass all 6 named parameters
-- (calls-app's top-up route, which has no direction to pass) then matched
-- both overloads and PostgREST refused to guess which one to run
-- (PGRST203 "Could not choose the best candidate function") — hit this live
-- in production. Must drop the old signature explicitly first.
drop function if exists wallet_apply_transaction(text, bigint, text, text, text);

create or replace function wallet_apply_transaction(
    p_type text,
    p_amount_cents bigint,
    p_reference text,
    p_description text default null,
    p_created_by text default null,
    p_direction text default null
) returns table (applied boolean, balance_cents bigint, low_balance_crossed boolean) as $$
#variable_conflict use_column
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

    insert into wallet_transactions (type, amount_cents, reference, description, created_by, balance_after_cents, direction)
        values (p_type, p_amount_cents, p_reference, p_description, p_created_by, v_new_balance, p_direction);

    return query select
        true,
        v_new_balance,
        (p_amount_cents < 0 and v_old_balance > v_threshold and v_new_balance <= v_threshold);
end;
$$ language plpgsql;
