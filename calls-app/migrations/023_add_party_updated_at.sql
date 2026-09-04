-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Lets ari-app tell how long a call_logs row has been sitting at
-- add_party_status='dialing' — needed to sweep up a request that got
-- silently orphaned (the claiming UPDATE committed, but this process never
-- received the response confirming it, e.g. a timeout on a slow network
-- round trip). See sweepStaleAddPartyRequests in ari-app/supabase.js.
alter table call_logs add column if not exists add_party_updated_at timestamptz;
