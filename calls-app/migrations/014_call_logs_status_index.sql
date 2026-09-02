-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- status is the primary filter for /api/queue, /api/calls/live, and the
-- by-hour stats query, but had no index — every one of those was a full
-- scan of call_logs, which only grows (no retention/archiving policy exists
-- yet). Cheap now while the table is still small; the value only goes up
-- from here.
create index if not exists call_logs_status_idx on call_logs (status);
