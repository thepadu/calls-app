-- Run this in the Supabase SQL editor before deploying the agents/IVR
-- management feature.

create table if not exists agents (
    id bigint generated always as identity primary key,
    name text not null,
    phone text not null,
    email text,
    status text not null default 'offline' check (status in ('available', 'offline')),
    created_at timestamptz not null default now()
);

create unique index if not exists agents_email_unique_idx on agents (email) where email is not null;

-- Seeds the two numbers that were previously hardcoded in app.js, so call
-- routing doesn't go dark on deploy. Edit these to real names/emails from
-- the new Agents page once it's live — the placeholder emails are unique
-- but not meaningful.
insert into agents (name, phone, email, status)
values
    ('Agent 1', '+254717134114', 'agent1@chumz.io', 'available'),
    ('Agent 2', '+254740323941', 'agent2@chumz.io', 'available')
on conflict do nothing;

create table if not exists ivr_options (
    digit text primary key,
    label text not null,
    response_message text,
    action text not null default 'message' check (action in ('message', 'transfer_agent', 'repeat_menu')),
    updated_at timestamptz not null default now()
);

-- Seeds the exact menu that was previously hardcoded in app.js, so the IVR
-- says the same thing on deploy as it did before this migration.
insert into ivr_options (digit, label, response_message, action)
values
    ('1', 'Login Issue', 'For login issues, please update the choomz app and reset your PIN. Goodbye.', 'message'),
    ('2', 'Deposit Issue', 'For deposit issues, please forward your M Pesa message to WhatsApp 0717134114. Goodbye.', 'message'),
    ('3', 'Agent Request', 'Please hold as your call is transferred to an available agent.', 'transfer_agent'),
    ('9', 'Repeat Menu', null, 'repeat_menu')
on conflict (digit) do nothing;
