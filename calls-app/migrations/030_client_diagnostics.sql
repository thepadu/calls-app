-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Phase 1 of the 2026-09-27 mid-call echo investigation (see DECISIONS.md):
-- the browser softphone's ICE-restart/reconnect recovery paths
-- (web/src/lib/softphone.tsx) only ever logged to that agent's own browser
-- console — unrecoverable once the tab closes, which is exactly what made
-- the reported echo unprovable after the fact. This table gives those
-- events a durable, queryable home so the next occurrence can be confirmed
-- and correlated against call duration instead of inferred from Asterisk's
-- own coarse logs days later.
create table if not exists client_diagnostics (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    agent_id bigint references agents(id) on delete set null,
    -- One of: 'ice_restart_attempt', 'ice_restart_recovered',
    -- 'ice_restart_failed', 'ws_disconnect', 'ws_reconnect'. A plain text
    -- column with an application-level allowlist (POST /api/client-diagnostics),
    -- not a check constraint or enum — this is diagnostic, evolving data;
    -- a new event type shouldn't ever need a migration to start being logged.
    event_type text not null,
    -- Seconds into the call at the time of the event, when known (null for
    -- ws_disconnect/ws_reconnect, which aren't necessarily tied to an active
    -- call) — this is the actual correlator, not session_id: sip.js's own
    -- Session id is a SIP dialog/call-id, unrelated to call_logs.session_id
    -- (Asterisk's own channel uniqueid), so there's no reliable join between
    -- the two without plumbing the Asterisk channel id into the browser,
    -- which nothing today does.
    call_duration_seconds integer,
    -- Free-text context (e.g. the ICE state/reason string already computed
    -- in softphone.tsx's own console.warn) — kept as a hint for a human
    -- reading this table directly, not parsed by any code.
    detail text
);

create index if not exists client_diagnostics_agent_time_idx on client_diagnostics (agent_id, created_at);
