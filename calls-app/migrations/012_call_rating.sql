-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Lets a customer rate a completed call via DTMF (1-5) right before the
-- line disconnects. Off by default — this changes live customer-facing
-- call flow, so a supervisor opts in deliberately (same pattern as
-- business_hours.enabled / forwarding_config.enabled).
alter table call_logs add column if not exists rating smallint;
alter table ivr_config add column if not exists rating_enabled boolean not null default false;
