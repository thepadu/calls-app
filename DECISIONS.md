# Decisions

A running log of non-obvious architectural, infra, and tradeoff decisions for this project — the "why," not the "what" (the code and `SYSTEM_DESIGN.md` cover that). Started 2026-09-04, going forward; not a complete history of everything ever decided. Newest entries at the bottom.

Entry shape: date, the decision, alternatives considered, why.

---

## 2026-09-04 — Hold music plays via Asterisk's `mode=mp3` (mpg123), not `mode=files`

**Decision**: The `[custom]` MOH class in `musiconhold.conf` uses `mode=mp3` (shells out to `mpg123` to decode on the fly), and `mpg123` was installed on the VPS for this.

**Alternatives considered**: `mode=files` pointing at the uploaded raw MP3 — simpler config, no new system package.

**Why**: This box's Asterisk build has no native MP3 format module, and `mode=files` only plays formats Asterisk can decode itself (wav/gsm/sln/ulaw/ogg). Confirmed live: with `mode=files`, Asterisk silently never even registered the class — no error, the class just didn't show up in `moh show classes`. `sox` (already used elsewhere in this app for Piper TTS) also has no MP3 support built into this box's copy, ruling out a transcode-at-upload-time approach without also adding a codec library. `mode=mp3` was the smallest fix: one small, standard system package, zero changes to the upload code (still stores/serves plain MP3 as uploaded).

## 2026-09-04 — DigitalOcean auto-deploy needed manual reconnection after the GitHub repo rename

**Decision**: No code change — flagged that `calls-app`'s DigitalOcean App Platform source was still pointing at the old GitHub repo name (`at-voice-app`) after the repo was renamed to `calls-app`, and had the user reconnect it via the DO dashboard (Settings → source).

**Alternatives considered**: Trigger a deploy manually via `doctl apps create-deployment` — attempted, but the API token in use doesn't have permission for that action, so it wasn't a real option here regardless.

**Why**: A push to `main` stopped triggering deploys with no error surfaced anywhere obvious — DO's GitHub webhook/App-installation link doesn't automatically follow a repo rename. Worth remembering if deploys silently stop working again after any future repo-level change (rename, transfer, etc.) — check the DO app's source connection first, not the code.

## 2026-09-04 — Orphaned add-party requests get swept by age, not tracked in memory

**Decision**: Added `call_logs.add_party_updated_at` and a periodic sweep (`sweepStaleAddPartyRequests`, `ari-app/supabase.js`) that fails any row stuck at `add_party_status='dialing'` for more than 2 minutes — same shape as the existing `sweepStaleCalls`.

**Alternatives considered**: An in-memory `Set` of session ids this process has actually claimed, checked against `add_party_status='dialing'` rows on a sweep — rejected because it's more bookkeeping (add/remove across multiple call sites) for no real benefit: an age-based DB sweep also correctly handles the same orphan surviving a process restart (in-memory state doesn't survive that either way), and it matches a pattern already used elsewhere in this file, which a future maintainer will recognize on sight.

**Why**: Found via log analysis (see the week's log audit) — `claimAddPartyRequests`'s claiming `UPDATE ... RETURNING` can commit on Supabase's side while the HTTP response is lost to a timeout or transient `Bad Gateway` (confirmed: 5 occurrences in under a week of production logs). When that happens, this process never learns the session id, so none of the *other* already-existing recovery paths for a stuck add-party request (both in `bridgeAddPartyDest`/`completeAddParty`, `ari-app/index.js`) ever run — they only cover legs this process actually originated. Without this sweep, the dashboard would show "Adding party…" for that call forever.

## 2026-09-04 — `calls-app` now sets `trust proxy` for DigitalOcean's edge proxy

**Decision**: `app.set('trust proxy', 1)` added to `calls-app/app.js`.

**Alternatives considered**: None seriously — this is the standard, documented fix for an Express app behind exactly one reverse proxy.

**Why**: Found via log analysis — every rate-limited request was logging an `express-rate-limit` validation error (`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`) because Express didn't know to trust DigitalOcean App Platform's `X-Forwarded-For` header. Confirmed this wasn't actually breaking requests (still got correct responses), but it meant the rate limiter likely wasn't identifying real client IPs correctly, and the resulting log noise was making genuine errors harder to spot — directly slowed down this same log audit.

## 2026-09-04 — Startup reconciliation now checks real Asterisk channel state before marking a call "failed"

**Decision**: `reconcileStaleCallsOnStartup` (`ari-app/supabase.js`) now takes a `Set` of currently-live Asterisk channel ids (from `client.channels.list()`, gathered in `index.js`'s `main()` right before calling it) and only marks a non-terminal `call_logs` row `'failed'` if its channel is actually gone. A row whose channel is still live and pre-bridge (never reached an agent) gets actively hung up instead (`client.channels.hangup()`) rather than left to sit forever; a row still live and already `'ongoing'` (a real bridged conversation) is left completely alone. `markMissedIfAbandoned` (run from the global `StasisEnd` handler for every channel that ends) was widened to also close out a still-`'ongoing'` row as `'completed'` once it actually ends, since an orphaned one no longer has a `teardown()` closure left to do that itself.

**Alternatives considered**: Leaving the blind "mark everything failed" behavior and instead trying to have `sweepStaleCalls`'s existing age-based cutoff catch these sooner — rejected because the actual bug isn't the row being wrong for a while, it's that a genuinely still-connected caller (sitting in the hold queue, hearing hold music) has nothing left in the new process that will ever ring an agent for them or time them out; an age cutoff doesn't fix that, it just marks them "failed" a bit later while they're still stuck on hold.

**Why**: Found via live investigation (VPS logs + a direct Supabase query) — a real caller (`254706651053`) entered the queue, was rung to one agent who didn't answer, and was still sitting in the hold queue three minutes later when an ARI websocket blip forced `ari-app` to restart. The blind reconciliation immediately marked that row `'failed'`, but the caller's actual Asterisk channel was very possibly still alive and on hold at that exact moment — restarting `ari-app` doesn't touch Asterisk, which keeps bridges/channels running on its own. Since the new process's in-memory queue always starts empty, nothing would ever have rung an agent for that caller again or timed them out — they'd have sat on hold indefinitely. This is the direct, confirmed cause behind this week's "call is lost when nobody answers" and "call stuck for 8 minutes" reports. A real `'ongoing'` call surviving a restart was also being wrongly marked `'failed'` on the dashboard immediately, even though the actual conversation was continuing normally in Asterisk.

## 2026-09-04 — Africa's Talking's legacy `/events` webhook reduced to a bare 200 ack

**Decision**: `calls-app/app.js`'s `/events` handler no longer upserts `call_logs`, and no longer looks up/flips a phone-matched agent offline either — it just acks 200, the same "harmless no-op" treatment already given to `/voice`. Deleted `calls-app/lib/agentCache.js` (the in-memory agent-phone cache that existed solely to support this handler's lookup) and its 4 `invalidateAgentCache()` call sites in `api.js`, since nothing reads that cache anymore.

**Alternatives considered**: Keeping the write and instead trying to merge it with the real Asterisk-driven row — not possible without a shared identifier: Africa's Talking's `sessionId` for this webhook is its own `ATVId_...` id, which has no relationship to the Asterisk channel id `ari-app` logs calls under, so the write could only ever create a second, disconnected row for the same real call, never update the real one. Keeping the agent-offline side effect as a safety net — rejected once checking `agents.phone` showed only 2 of 10 agents still have one set (Njogu, and the account owner) from before the SIP-softphone flow; for those 2, this was a live, real bug, not a safety net: a real call whose *destination* happened to equal that agent's phone would force them `offline` even while genuinely active on their SIP line, since ari-app — not this webhook — is what actually owns SIP-based presence now.

**Why**: Confirmed live (2026-09-04) that this webhook is still actively firing for real calls today, despite code comments dating back to the SIP-trunk migration assuming/hoping it had gone quiet ("unverified whether this handler still receives any traffic at all"). It hadn't gone quiet — Africa's Talking fires it independently of which mechanism actually carries the call's audio. Every real call was therefore being logged twice: once correctly by `ari-app`, and once as a confusing, differently-attributed duplicate from this legacy path. The remaining agent-offline logic was reviewed once the duplicate-logging fix went in and found to be worse than useless for the same reason — a leftover from the pre-SIP phone-based agent model that could still misfire against a live SIP call today.
