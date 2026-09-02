-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Blind-add-a-party MVP: an agent can add a third party to an active call.
-- ari-app has no HTTP server of its own, so these two columns on the
-- agent's own call_logs row are the only channel calls-app has to
-- signal a live call in progress — same idiom as every other cross-process
-- config in this app (business_hours.enabled, forwarding_config.enabled).
alter table call_logs add column if not exists add_party_destination text;
alter table call_logs add column if not exists add_party_status text;
