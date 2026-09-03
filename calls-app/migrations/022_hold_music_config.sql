-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Singleton config for the hold-queue's music-on-hold. ari-app reads this
-- live (same pattern as business_hours/ivr_config) to decide which Asterisk
-- MOH class to start on the holding bridge. 'custom' means a supervisor has
-- uploaded a track via POST /api/hold-music (stored on the VPS filesystem
-- itself, not in Supabase — this table only tracks which class is active
-- and display metadata for the settings UI).
create table if not exists hold_music_config (
    id int primary key default 1,
    active_class text not null default 'default',
    custom_filename text,
    uploaded_at timestamptz,
    uploaded_by text,
    constraint hold_music_config_singleton check (id = 1),
    constraint hold_music_config_active_class check (active_class in ('default', 'custom'))
);

insert into hold_music_config (id) values (1) on conflict (id) do nothing;
