-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Adds a supervisor-configurable call-routing strategy, replacing today's
-- one fixed behavior (ring every available agent at once) with a choice of
-- four. See DECISIONS.md's 2026-10-01 entry for the full design and why
-- all four reduce to one selection function with no new per-customer state.
--
-- available_since is the "how long has this agent been idle" clock the
-- three non-ring_all strategies sort candidates by — stamped by
-- setAgentStatus (ari-app/supabase.js) on every transition TO 'available',
-- including a ring timing out unanswered, which is what makes
-- idle_sequential/idle_first_broadcast self-advance to the next agent with
-- no new "already tried" bookkeeping: an agent who just failed to answer
-- gets *bumped to the back* of the idle ordering automatically.
alter table agents
    add column if not exists available_since timestamptz;

-- Backfill: an agent already sitting 'available' when this runs has no
-- real idle-start time on record — now() is a reasonable starting point
-- (not instantly first-in-line, not permanently null/last either).
update agents set available_since = now() where status = 'available' and available_since is null;

create table if not exists routing_config (
    id integer primary key default 1,
    strategy text not null default 'ring_all'
        check (strategy in ('ring_all', 'idle_top_n', 'idle_first_broadcast', 'idle_sequential')),
    -- Only read for strategy = 'idle_top_n': how many of the longest-idle
    -- available agents to ring simultaneously.
    top_n_group_size integer not null default 2 check (top_n_group_size >= 1),
    -- Only read for strategy = 'idle_first_broadcast': how long the single
    -- longest-idle agent rings alone before broadening to everyone.
    broadcast_fallback_seconds integer not null default 8 check (broadcast_fallback_seconds >= 1),
    updated_at timestamptz,
    updated_by text,
    constraint routing_config_singleton check (id = 1)
);

insert into routing_config (id) values (1) on conflict (id) do nothing;
