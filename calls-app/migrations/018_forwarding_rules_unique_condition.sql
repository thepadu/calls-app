-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- forwarding_rules had no unique constraint on `condition`, and the UI only
-- supports add/delete (no edit) -- so a supervisor "updating" a rule by
-- clicking "+ Add rule" again with a new destination created a second row
-- for the same condition instead of replacing the first.
-- getNoAgentsForwardingDestination()'s .limit(1).maybeSingle() with no
-- .order() then picked between them arbitrarily in live call routing --
-- the supervisor's intended change could silently never take effect.
--
-- Keeps only the most recently created row per condition (the one a
-- supervisor most likely intended to be current) before adding the
-- constraint, in case duplicates already exist.
delete from forwarding_rules a
    using forwarding_rules b
    where a.condition = b.condition
    and a.created_at < b.created_at;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'forwarding_rules_condition_key') then
        alter table forwarding_rules add constraint forwarding_rules_condition_key unique (condition);
    end if;
end $$;
