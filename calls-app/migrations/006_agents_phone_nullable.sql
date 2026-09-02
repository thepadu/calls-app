-- Run in the Supabase SQL editor. Idempotent (dropping a constraint that's
-- already dropped is a no-op, not an error).
--
-- agents.phone was `not null` (migration 003) because every agent used to be
-- created manually, phone number in hand, via POST /api/agents. Now that
-- auth.js auto-provisions a row for every Google login (so a supervisor has
-- someone to actually promote), a brand-new agent has no phone yet — they
-- can't go "available" until a supervisor sets one, but the row itself must
-- be insertable without it.

alter table agents alter column phone drop not null;
