# VPS infrastructure config (sip.chumz.online)

This directory is a **mirror** of the system-level config that runs the Asterisk VPS — Caddy, Asterisk's own `http.conf`/`extensions.conf`, and the systemd units/scripts that keep everything alive safely. None of it deploys automatically; it exists so the config that actually runs production has history, review, and a recovery reference, instead of living only as `.bak-<timestamp>` files on the box itself.

## What's here, and where it really lives

| Repo path | Live path on the VPS |
|---|---|
| `caddy/Caddyfile` | `/etc/caddy/Caddyfile` |
| `asterisk/http.conf` | `/etc/asterisk/http.conf` |
| `asterisk/extensions.conf` | `/etc/asterisk/extensions.conf` |
| `systemd/chumz-safe-restart.sh` | `/usr/local/sbin/chumz-safe-restart.sh` |
| `systemd/chumz-safe-restart.service` | `/etc/systemd/system/chumz-safe-restart.service` |
| `systemd/chumz-safe-restart.timer` | `/etc/systemd/system/chumz-safe-restart.timer` |
| `systemd/chumz-ari-app.service` | `/etc/systemd/system/chumz-ari-app.service` |
| `needrestart/chumz.conf` | `/etc/needrestart/conf.d/chumz.conf` |
| `firewall/setup-ufw.sh` | reconstructs the live `ufw` ruleset (not a file mirror — `ufw` doesn't have one editable source file) |

**Deliberately excluded: `/etc/asterisk/pjsip.conf`.** It holds every agent's live SIP password in plaintext. It's already managed as code, just not as a flat file — the marker-comment-based provisioning system that writes/removes agent blocks lives in `ari-app/pjsipConfig.js`, which *is* tracked. The live file itself should never enter git history, on this repo or any other.

`asterisk.service` isn't here either — it's the unmodified package-provided unit at `/usr/lib/systemd/system/asterisk.service`, not a local override.

## Why this setup, not full automation

Full push-to-deploy for VPS config would need to thread through the same "confirm zero active calls before touching anything" discipline `chumz-safe-restart.sh` already encodes for service restarts — safe to do, but a bigger project than what today's gap actually calls for. This is the lighter-weight fix: a real diff and a real commit exist before a live change ships, without needing new deploy tooling.

## Workflow

**Before hand-editing anything on the VPS**, pull the current live file down and diff it against this directory first — someone else (or a previous session) may have changed it since this mirror was last updated.

```bash
ssh -i ~/.ssh/id_ed25519 root@sip.chumz.online "cat /etc/caddy/Caddyfile" | diff - infra/caddy/Caddyfile
```

**After making a live change** (following the existing safety discipline — back up the live file first, check `asterisk -rx 'core show channels count'` is `0` before anything that touches Asterisk, reload rather than restart where possible, verify before moving on): pull the new content back down, overwrite the matching file here, and commit with a real message explaining *why*, not just what changed.

```bash
ssh -i ~/.ssh/id_ed25519 root@sip.chumz.online "cat /etc/caddy/Caddyfile" > infra/caddy/Caddyfile
git add infra/caddy/Caddyfile
git commit -m "..."
```

## Known items flagged, not yet acted on

- `ufw` still allows `5061/tcp` (see `firewall/setup-ufw.sh`) with nothing listening on it — likely a leftover from a removed/never-implemented SIP-TLS transport. Confirm intent before removing.
