-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- DELETE /api/agents/:id failed for virtually every real agent — anyone
-- who has ever taken a call or been assigned a ticket — because
-- call_logs.agent_id and tickets.assigned_agent_id both reference
-- agents(id) with the default ON DELETE RESTRICT, and the API surfaced
-- this as a generic, unexplained 500 "Failed to delete agent". Call and
-- ticket history is exactly the kind of record a call center needs to
-- keep after someone leaves — SET NULL preserves every row (agent_number
-- and whatever else was already captured stays intact) while actually
-- letting the agent be removed from the active roster, matching what the
-- "Remove agent" confirm-dialog UI already implies should just work.
-- agent_sip_credentials already correctly cascades (migration 007) and
-- needs no change.

do $$
declare
    fk_name text;
begin
    select tc.constraint_name into fk_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.table_name = 'call_logs'
        and kcu.column_name = 'agent_id'
        and tc.constraint_type = 'FOREIGN KEY';
    if fk_name is not null then
        execute format('alter table call_logs drop constraint %I', fk_name);
    end if;
end $$;
alter table call_logs add constraint call_logs_agent_id_fkey
    foreign key (agent_id) references agents(id) on delete set null;

do $$
declare
    fk_name text;
begin
    select tc.constraint_name into fk_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.table_name = 'tickets'
        and kcu.column_name = 'assigned_agent_id'
        and tc.constraint_type = 'FOREIGN KEY';
    if fk_name is not null then
        execute format('alter table tickets drop constraint %I', fk_name);
    end if;
end $$;
alter table tickets add constraint tickets_assigned_agent_id_fkey
    foreign key (assigned_agent_id) references agents(id) on delete set null;
