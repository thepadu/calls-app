-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Lets a supervisor pick a Piper voice and speaking rate for IVR prompts,
-- and provides a forward-compatible hook for playing a pre-recorded human
-- sound instead of TTS for specific prompts (upload feature not built yet —
-- this just reserves the column so that feature doesn't need another
-- migration later). tts_voice is a short key (e.g. 'lady'/'man'), not a
-- filesystem path — ari-app/tts.js maps it through a server-side allowlist
-- so a bad value here can't point Piper at an arbitrary file.
alter table ivr_config add column if not exists tts_voice text;
alter table ivr_config add column if not exists tts_speed_scale real not null default 1.0;
alter table ivr_config add column if not exists prompt_overrides jsonb not null default '{}';
