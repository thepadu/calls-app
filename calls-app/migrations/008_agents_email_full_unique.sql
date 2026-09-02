-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- migrations/003 created a *partial* unique index (`where email is not
-- null`) — Postgres won't use a partial index to satisfy a plain
-- `ON CONFLICT (email)` clause unless the same WHERE condition is repeated
-- there too, which Supabase's `.upsert(..., { onConflict: 'email' })` (used
-- by auth.js to provision a row on first login) doesn't do. Multiple NULL
-- emails are still fine under a full UNIQUE constraint — NULLs are never
-- considered equal to each other, so they don't collide.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'agents_email_key') then
        alter table agents add constraint agents_email_key unique (email);
    end if;
end $$;
