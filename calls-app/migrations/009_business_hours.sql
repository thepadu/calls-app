-- Run in the Supabase SQL editor. Idempotent (safe to re-run).
--
-- Singleton config the ARI app checks at the start of every inbound call —
-- outside these hours, the caller hears after_hours_message instead of the
-- normal IVR menu. active_days is 0=Sunday..6=Saturday. Times are plain
-- "HH:MM" strings interpreted in Africa/Nairobi (the business's only
-- timezone — not worth pulling in a tz library for a single-market app).
create table if not exists business_hours (
    id int primary key default 1,
    enabled boolean not null default false,
    open_time text not null default '08:00',
    close_time text not null default '17:00',
    active_days int[] not null default '{1,2,3,4,5}',
    after_hours_message text not null default 'Our support team is currently unavailable. Our business hours are Monday to Friday, 8 A M to 5 P M, East Africa Time. Please call back during those hours.',
    constraint business_hours_singleton check (id = 1)
);

insert into business_hours (id) values (1) on conflict (id) do nothing;
