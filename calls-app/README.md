# Chumz Call Center

A call-center system for Chumz customer support. Real call handling — inbound IVR, hold queue, ring-all agent routing, and agent-initiated outbound calls — runs on a self-hosted Asterisk PBX with agents taking calls through a browser WebRTC softphone. This Express app is the dashboard's backend: Google SSO and the JSON API the React app talks to. Every agent needs SIP credentials provisioned (see `SYSTEM_DESIGN.md`) to take calls — there's no other way to go "available" today.

## Layout

- **`ari-app/`** (separate deploy target — a VPS running Asterisk, not this repo's `npm start`) — the real call engine: IVR menu, hold queue, ring-all agent routing, inbound/outbound call bridging, business hours, presence integrity. Talks to Asterisk over ARI and to the same Supabase project as everything else.
- **`calls-app/`** — this Express backend: Google SSO (`auth.js`) and the JSON API (`api.js`) the React app talks to. `npm start` runs it.
- **`web/`** — the React admin console (Vite + TypeScript), served by this Express app at `/app` once built. See [`web/README.md`](../web/README.md) for setup.
- **`calls-app/migrations/`** — SQL migrations for the Supabase database, numbered and applied in order via the Supabase SQL editor (no migration-runner tooling). All are safe to re-run.

## Where to start

- **[`SYSTEM_DESIGN.md`](../SYSTEM_DESIGN.md)** (repo root) — architecture, data model, call routing (inbound and outbound, in detail), auth/roles, known limitations, and what's deliberately not built yet. Read this first.
- **[`web/README.md`](../web/README.md)** — frontend setup, dev workflow, and build/deploy notes.

## Running locally

```bash
cd calls-app
npm install
npm start
```

This runs the dashboard backend only — it talks to Supabase, but has no connection to Asterisk. Real call flow can't be exercised without the actual VPS; see `SYSTEM_DESIGN.md` for how that piece fits together.

Requires `SUPABASE_URL`, `SUPABASE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, and `JWT_SECRET` as environment variables — see `SYSTEM_DESIGN.md`'s Auth section for what each does. `AT_WEBHOOK_SECRET` is optional (locks down `/events`, Africa's Talking's call-events callback).
