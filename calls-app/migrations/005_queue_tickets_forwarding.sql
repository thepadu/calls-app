-- Run in the Supabase SQL editor before deploying the real hold-queue,
-- tickets, and call-forwarding features. Idempotent (safe to re-run).

-- 'ringing': the outbound call placing an agent on standby has been
-- initiated but not yet answered. 'break': manual 4th status (design
-- reference's Agent Available/On Call/Break/Offline cycle).
do $$
begin
    if exists (select 1 from pg_constraint where conname = 'agents_status_check') then
        alter table agents drop constraint agents_status_check;
    end if;
    alter table agents
        add constraint agents_status_check
        check (status in ('available', 'on_call', 'ringing', 'break', 'offline'));
end $$;

create table if not exists tickets (
    id bigint generated always as identity primary key,
    session_id text references call_logs (session_id),
    caller_name text,
    caller_number text,
    tag text,
    priority text not null default 'Medium' check (priority in ('Low', 'Medium', 'High', 'Urgent')),
    status text not null default 'Open' check (status in ('Open', 'Resolved', 'Escalated', 'Follow-up needed', 'No resolution')),
    assigned_agent_id bigint references agents (id),
    notes text,
    created_at timestamptz not null default now()
);

create index if not exists tickets_session_id_idx on tickets (session_id);

create table if not exists ticket_tags (
    name text primary key
);

insert into ticket_tags (name)
values ('Billing'), ('Technical'), ('Sales'), ('Complaint'), ('General'), ('Retention')
on conflict (name) do nothing;

create table if not exists forwarding_config (
    id integer primary key default 1,
    enabled boolean not null default false,
    constraint forwarding_config_singleton check (id = 1)
);

insert into forwarding_config (id, enabled) values (1, false) on conflict (id) do nothing;

create table if not exists forwarding_rules (
    id bigint generated always as identity primary key,
    condition text not null check (condition in ('no_answer', 'busy', 'always', 'after_hours')),
    destination text not null,
    created_at timestamptz not null default now()
);
