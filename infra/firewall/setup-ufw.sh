#!/usr/bin/env bash
# Reconstructs the ufw ruleset currently live on sip.chumz.online. There's
# no single source-of-truth file for ufw the way there is for Caddy/Asterisk
# config — this script IS that source of truth, generated from
# `ufw status verbose` on the real box. Safe to re-run (`ufw allow` is
# idempotent — re-adding an identical rule is a no-op, not a duplicate).
#
# NOT meant to run unattended against a live box with real traffic — read
# it, confirm it matches intent, and run interactively.
set -euo pipefail

# SSH — needed to manage the box at all.
ufw allow 22/tcp comment 'SSH'

# Caddy — public HTTPS (softphone WSS, ari-app's /internal/* and /healthz
# proxy targets) and the HTTP port ACME needs for cert issuance/renewal.
ufw allow 80/tcp comment 'Caddy HTTP/ACME'
ufw allow 443/tcp comment 'Caddy HTTPS'

# Africa's Talking SIP trunk — locked to their known source IP, both
# directions of the actual call signaling (not the WSS/443 path above,
# which is browser softphones only).
ufw allow from 197.248.0.196 to any port 5060 proto udp comment 'AT SIP trunk'
ufw allow from 197.248.0.196 to any port 5060 proto tcp comment 'AT SIP trunk'

# coturn — TURN/STUN control (3478) and the relay port range real calls
# actually use once a relay candidate is negotiated.
ufw allow 3478/udp comment 'coturn TURN/STUN'
ufw allow 3478/tcp comment 'coturn TURN/STUN'
ufw allow 49152:49999/udp comment 'coturn relay range'

# RTP media range for direct (non-relayed) call audio.
ufw allow 10000:20000/udp comment 'RTP media'

# Flagged, not yet removed — see infra/README.md's "Known items" section.
# Nothing is listening on 5061 (checked live via `ss -tlnp`), likely a
# leftover from a removed/never-implemented SIP-TLS transport.
ufw allow 5061/tcp comment 'UNUSED? no listener bound as of 2026-08-31 - confirm before removing'
