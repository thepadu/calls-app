-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- 014 indexed status alone, but every hot query that filters on it
-- (/api/queue, /api/calls/live) also orders by created_at in the same
-- query — a composite index serves both the filter and the sort in one
-- pass, where the single-column index can only serve the filter and still
-- has to sort the matching rows separately. The composite index also
-- satisfies any query that filters on status alone (leftmost-prefix rule),
-- so 014's index is now redundant; dropped here rather than left to
-- quietly double the write cost of every call_logs insert/update forever.
drop index if exists call_logs_status_idx;
create index if not exists call_logs_status_created_at_idx on call_logs (status, created_at);
