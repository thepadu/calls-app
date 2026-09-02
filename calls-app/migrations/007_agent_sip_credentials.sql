-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Maps an agent to their PJSIP/WebRTC endpoint on the self-hosted Asterisk
-- box (sip.chumz.online) — this is what lets the ARI call-routing app (runs
-- on the Asterisk VPS, see ari-app/) look up "which registered browser
-- softphone belongs to agent N" instead of the old phone-call-based standby
-- flow. Kept as its own table (not columns on `agents`) for the same reason
-- `agents.email`/`phone` visibility is already scoped carefully elsewhere —
-- SIP credentials are more sensitive than name/status and most of the app
-- never needs them.
create table if not exists agent_sip_credentials (
    agent_id bigint primary key references agents (id) on delete cascade,
    sip_username text not null unique,
    sip_password text not null,
    created_at timestamptz not null default now()
);
