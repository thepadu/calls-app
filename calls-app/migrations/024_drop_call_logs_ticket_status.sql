-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- call_logs.ticket_status (added in 002_dashboard_upgrades.sql) was never
-- written by any current code path — ticket state lives entirely in the
-- separate `tickets` table, with its own status vocabulary. Confirmed via
-- grep across both calls-app and ari-app, and across web/src, that nothing
-- reads or writes this column or ever sends `?ticket=` to GET /api/calls.
-- The GET /api/calls ticket= filter that used to read this column has been
-- removed in the same change that adds this migration.
alter table call_logs drop column if exists ticket_status;
