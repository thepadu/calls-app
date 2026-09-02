-- Run this in the Supabase SQL editor before deploying the roles/IVR-greeting
-- feature. Safe to re-run (idempotent).

alter table agents
    add column if not exists role text not null default 'agent';

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'agents_role_check') then
        alter table agents
            add constraint agents_role_check
            check (role in ('agent', 'supervisor'));
    end if;
end $$;

-- Single-row config table for the IVR greeting (previously hardcoded in
-- app.js). Enforced to exactly one row via a fixed primary key.
create table if not exists ivr_config (
    id integer primary key default 1,
    greeting text not null,
    updated_at timestamptz not null default now(),
    constraint ivr_config_singleton check (id = 1)
);

insert into ivr_config (id, greeting)
values (1, 'Welcome to Chumz customer support.')
on conflict (id) do nothing;
