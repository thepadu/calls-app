# Chumz Support — Web App

The React admin console, talking to the JSON API in `../calls-app/api.js`. See `../SYSTEM_DESIGN.md` for the full architecture and reasoning.

## Setup

```bash
cd web
npm install
```

This has been run and verified in the environment this was built in — `npm install` resolves clean, `npm run build`/`lint`/`test` all pass. Still worth re-running yourself as a sanity check.

## Development

Run the backend and frontend as two processes:

```bash
# Terminal 1 — from calls-app/
npm start

# Terminal 2 — from web/
npm run dev
```

Vite's dev server proxies `/api`, `/login`, `/auth`, `/logout` to `http://localhost:3000` (see `vite.config.ts`), so you get instant reload on the React side while auth and data still come from the real Express server. Real calls (the softphone, ring-all, etc.) need the actual Asterisk VPS and won't work against a bare local Express server — see `SYSTEM_DESIGN.md`.

Sign in by visiting `http://localhost:3000/login` first (this sets the session cookie), then open the Vite dev URL — the cookie is shared since both are `localhost`.

## Quality checks

```bash
npm run lint     # ESLint — passes clean
npm run format   # Prettier, writes in place
npm test         # Vitest — 13/13 passing
```

## Production build

```bash
npm run build
```

Outputs to `web/dist`, which `calls-app/app.js` serves at `/app` (e.g. `https://calls.chumz.online/app`). The platform's build command needs to install and build **both** `calls-app/` and `web/` — check how it's currently configured; a single-project setup will likely only build the backend.

## What's here

Full sidebar IA: Dashboard (KPIs, calls-by-hour chart, capped live-calls panel, leaderboard/own performance), Live Queue (who's on hold, SLA-colored wait times), Calls (Incoming/Outgoing/Missed tabs, date-range + caller filters, pagination, one-click callback with a "called back" indicator), Tags & Tickets (real ticket entity — tags, priority, assignee, notes), Analytics (supervisors only — today's totals, missed-call breakdown, full performance leaderboard), Agents (supervisors only — 5-state presence, roster CRUD, name/phone search), IVR Builder (supervisors only — greeting + menu + live preview), Settings (supervisors only — Business Hours panel, forwarding rules, and the post-call rating toggle; only the `no_answer` forwarding rule is actually wired into live routing, see `SYSTEM_DESIGN.md`).

The floating dialer and status bar drive a **real** SIP.js WebRTC softphone (`lib/softphone.tsx`) registered directly to Asterisk — not a placeholder. It handles incoming/outgoing/active call state, automatic reconnection if the connection drops, and a presence heartbeat the backend uses to tell a genuinely-connected agent apart from a stale one. A real active-call status bar, a wrap-up prompt, `T`/`E` keyboard shortcuts, live-analytics popover on every page. Role-gated via `useAuth().isSupervisor` on the frontend and `requireSupervisor` on the backend (the real boundary is server-side).

Not built: a client-side login page (real Google OAuth requires a full-page redirect anyway, so unauthenticated users are sent to the existing `/login` HTML hero page), live routing for `busy`/`always` forwarding conditions, multi-country support.
