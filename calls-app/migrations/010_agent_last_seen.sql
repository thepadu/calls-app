-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- "Ghost agent" fix: agents.status alone was never trustworthy — an agent
-- provisioned (or seeded) with status='available' who never actually opened
-- the dashboard, or one whose browser tab died without a clean logout,
-- stays "available" forever with nothing to correct it. last_seen_at is
-- stamped by the browser's softphone heartbeat (see POST
-- /api/agents/me/heartbeat) and by any status change; the ARI app
-- periodically flips anyone stale back to 'offline' — see
-- reconcileGhostAgents in ari-app/supabase.js.
alter table agents
    add column if not exists last_seen_at timestamptz;
