-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Phase 1 of the 2026-10-13 "keep calls ringing in the background" work
-- (see DECISIONS.md): stores each browser's Web Push subscription so
-- ari-app can push a system notification the moment it starts ringing an
-- agent, even if that agent's tab/PWA is fully closed. One agent can have
-- several subscriptions (desktop + phone, or two browsers) — all of them
-- get pushed, same "ring every registered endpoint" spirit as ring_all.
create table if not exists agent_push_subscriptions (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    agent_id bigint not null references agents(id) on delete cascade,
    -- The PushSubscription's own unique URL (from
    -- registration.pushManager.subscribe()) — naturally unique per
    -- browser+device+origin, so this is what re-subscribing (a new
    -- service worker, a cleared site data) replaces rather than duplicates.
    endpoint text not null unique,
    -- The subscription's encryption keys (PushSubscription.toJSON().keys),
    -- required by web-push to encrypt the payload — not secret in the same
    -- way a password is, but still only ever read server-side.
    p256dh text not null,
    auth text not null
);

create index if not exists agent_push_subscriptions_agent_idx on agent_push_subscriptions (agent_id);
