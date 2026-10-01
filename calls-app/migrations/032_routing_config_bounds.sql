-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Tightens routing_config's bounds to match calls-app/api.js's own
-- validation, added the same day as migration 031 after a review pass
-- caught a real gap: broadcast_fallback_seconds had no upper bound, so a
-- supervisor could set it anywhere near (or past) ari-app's own
-- MAX_QUEUE_WAIT_MS (5 minutes, index.js) — a waiting customer would then
-- get forwarded/apologized-to and removed from the queue before
-- idle_first_broadcast's own fallback ever got a chance to broaden the
-- ring, silently defeating the whole point of picking that strategy.
-- 120s leaves a comfortable margin for the broadened ring itself to still
-- ring out before the overall abandon timeout. top_n_group_size's new cap
-- is a plain sanity bound (matches the Settings page's own input max),
-- not tied to another system constant the way the fallback delay is.
alter table routing_config drop constraint if exists routing_config_top_n_group_size_check;
alter table routing_config add constraint routing_config_top_n_group_size_check
    check (top_n_group_size >= 1 and top_n_group_size <= 50);

alter table routing_config drop constraint if exists routing_config_broadcast_fallback_seconds_check;
alter table routing_config add constraint routing_config_broadcast_fallback_seconds_check
    check (broadcast_fallback_seconds >= 1 and broadcast_fallback_seconds <= 120);
