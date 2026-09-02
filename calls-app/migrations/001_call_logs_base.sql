-- Base schema for call_logs. This table predates any migration file in this
-- repo — it was originally set up directly in Supabase, so there was never
-- a script that could recreate it. Written retroactively so a missing or
-- partially-set-up database (e.g. wrong Supabase project, or a fresh one)
-- can be brought up to the schema every route in this app assumes.
--
-- Safe to run against an existing call_logs table — every statement is
-- idempotent (won't touch columns that already exist, won't error if the
-- table's already there).

create table if not exists call_logs (
    session_id text primary key
);

alter table call_logs
    add column if not exists caller text,
    add column if not exists option_pressed text,
    add column if not exists status text,
    add column if not exists duration integer,
    add column if not exists direction text,
    add column if not exists created_at timestamptz not null default now();
