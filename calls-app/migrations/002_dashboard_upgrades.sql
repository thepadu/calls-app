-- Run this in the Supabase SQL editor before deploying the dashboard upgrades.

alter table call_logs
    add column if not exists ticket_status text not null default 'open',
    add column if not exists agent_number text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'call_logs_ticket_status_check') then
        alter table call_logs
            add constraint call_logs_ticket_status_check
            check (ticket_status in ('open', 'in_progress', 'resolved'));
    end if;
end $$;

create index if not exists call_logs_agent_number_idx on call_logs (agent_number);
create index if not exists call_logs_created_at_idx on call_logs (created_at);
