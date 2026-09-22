-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Hold music already showed who uploaded it and when — the higher-stakes
-- settings (business hours, call forwarding, call rating) that actually
-- change live call routing had no equivalent trail. See DECISIONS.md's
-- UX-audit entry.
alter table business_hours
    add column if not exists updated_at timestamptz,
    add column if not exists updated_by text;

alter table forwarding_config
    add column if not exists updated_at timestamptz,
    add column if not exists updated_by text;

-- Not reusing ivr_config's existing `updated_at` for this — that column is
-- stamped on ANY ivr_config edit (greeting, tts_voice, ...), so it can't
-- tell a supervisor when call rating specifically last changed without
-- risking a misleading answer. Dedicated columns instead.
alter table ivr_config
    add column if not exists rating_updated_at timestamptz,
    add column if not exists rating_updated_by text;
