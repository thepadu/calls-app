-- Run this BEFORE (re-)running 005_queue_tickets_forwarding.sql.
--
-- call_logs.session_id never actually had a unique/primary-key constraint on
-- the live table (001's `create table if not exists` was a no-op — the table
-- already existed, created manually before any migration existed). Because
-- of that, every `.upsert(..., { onConflict: 'session_id' })` call in app.js
-- has silently been doing a plain INSERT this whole time — there was no
-- constraint for Postgres to detect a conflict against. Every real call has
-- been leaving 2-3 rows behind (one from /ivr, one from /handle-input, one
-- from /events) instead of one row updated in place.
--
-- Three separate, self-contained statements — each recomputes what it needs
-- from the current table state, so there's no dependency on execution order
-- or session-scoped objects (a prior version used a temp table, which broke
-- across pooled-connection statements; then an unreferenced data-modifying
-- CTE, which Postgres isn't guaranteed to execute if the main query never
-- reads its output).
--
-- 1) Merge: every row sharing a session_id gets overwritten with the most
--    complete data across all of that session's rows (not just whichever
--    row happens to be newest — /events' upsert, for example, never carries
--    option_pressed, so keeping only the latest row would silently drop it).
update call_logs c
set
    caller = m.caller,
    option_pressed = m.option_pressed,
    status = m.status,
    duration = m.duration,
    direction = m.direction,
    agent_number = m.agent_number,
    ticket_status = m.ticket_status,
    created_at = m.created_at
from (
    select
        session_id,
        (array_agg(caller order by created_at desc) filter (where caller is not null))[1] as caller,
        (array_agg(option_pressed order by created_at desc) filter (where option_pressed is not null))[1] as option_pressed,
        (array_agg(status order by created_at desc) filter (where status is not null))[1] as status,
        (array_agg(duration order by created_at desc) filter (where duration is not null))[1] as duration,
        (array_agg(direction order by created_at desc) filter (where direction is not null))[1] as direction,
        (array_agg(agent_number order by created_at desc) filter (where agent_number is not null))[1] as agent_number,
        (array_agg(ticket_status order by created_at desc) filter (where ticket_status is not null))[1] as ticket_status,
        min(created_at) as created_at
    from call_logs
    group by session_id
) m
where c.session_id = m.session_id;

-- 2) Now every duplicate row for a given session_id is identical — drop all
--    but one of them.
delete from call_logs c
where c.ctid not in (
    select min(ctid) from call_logs group by session_id
);

-- 3) Safe to add the constraint now that no session_id repeats.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'call_logs_session_id_key') then
        alter table call_logs add constraint call_logs_session_id_key unique (session_id);
    end if;
end $$;
