-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Supports self-service SIP agent provisioning (POST
-- /api/agents/:id/sip-credentials) — replaces the previous manual SSH +
-- hand-edited pjsip.conf + manual Supabase insert process.
--
-- provisioned_by_email + the existing created_at together are the audit
-- trail for a create-only v1 (who provisioned whom, and when) — no
-- separate audit table needed until there's more than one action type to
-- log per agent (e.g. a future self-service regenerate).
--
-- asterisk_synced_at doubles as audit info and the durable "is this
-- actually live on Asterisk" flag: it survives a DO App Platform process
-- recycle, unlike any in-memory retry state, which is why the /sync retry
-- endpoint re-reads it from the DB rather than requiring the original
-- request's context.
alter table agent_sip_credentials
    add column if not exists provisioned_by_email text,
    add column if not exists asterisk_synced_at timestamptz;
