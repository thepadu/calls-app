-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Personal quick-dial numbers an agent saves for themselves — scoped by
-- owner_agent_id, never shared across agents (simplest, most private
-- reading of "let agents add contacts"; revisit if a shared org-wide
-- directory turns out to be what's actually wanted). Agent-to-agent calling
-- itself needs no new storage — it dials straight off the existing `agents`
-- table via a reserved internal dialplan prefix (see ari-app/index.js).
create table if not exists contacts (
    id bigint generated always as identity primary key,
    owner_agent_id bigint not null references agents (id) on delete cascade,
    name text not null,
    phone text not null,
    created_at timestamptz not null default now()
);

create index if not exists contacts_owner_agent_id_idx on contacts (owner_agent_id);
