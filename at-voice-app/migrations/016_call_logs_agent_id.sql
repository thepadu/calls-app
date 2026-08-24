-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- call_logs has attributed every call to an agent via agent_number, matched
-- against agents.phone -- but agents.phone is only actually set for agents
-- provisioned before the modern SIP-based softphone flow existed; every
-- agent onboarded since (9 of 10 real agents, confirmed live) has phone =
-- null, so every call they've ever handled got agent_number = null too.
-- Both the inbound-bridge and outbound-call code paths already correctly
-- identify WHICH agent handled a call internally (by SIP username / agent
-- id) before this point -- they just had nowhere reliable to store it.
-- This column is that place. agent_number stays as-is for backward
-- compatibility with historical rows and any code not yet updated to
-- prefer this column.
alter table call_logs add column if not exists agent_id bigint references agents(id);
create index if not exists call_logs_agent_id_idx on call_logs (agent_id);
