#!/usr/bin/env bash
# Checks the things this codebase has actually been bitten by with no
# warning: ari-app losing its ARI connection (the week-long inbound outage
# /healthz's ariConnected field exists to catch — see index.js), the TURN
# relay credentials silently drifting out of sync with coturn (the
# 2026-09-07 one-way-audio bug, see DECISIONS.md), and calls-app itself
# going down on DigitalOcean — which had genuinely nothing watching it at
# all before this, technical or otherwise. Every one of these was only ever
# found by manually going and looking after someone reported a symptom;
# this is what turns that into a page instead.
#
# State-edge-triggered, not "alert every run": a naive re-alert every
# 5 minutes while something stays down would drown a real incident's first
# alert in noise and train everyone to ignore this channel. A state file
# per check means exactly two messages per incident — one when it breaks,
# one when it recovers — regardless of how long it stays down.
set -euo pipefail

LOG_TAG="chumz-healthcheck"
STATE_DIR="/var/lib/chumz-healthcheck"
# Webhook URL and TURN test credentials are live secrets — kept in a
# root-only env file, never in this tracked script, same reasoning as why
# pjsip.conf/rtp.conf's own credentials never enter git (see infra/README.md).
ENV_FILE="/etc/chumz-healthcheck.env"

log() { logger -t "$LOG_TAG" "$1"; echo "$1"; }

if [ ! -f "$ENV_FILE" ]; then
    log "❌ $ENV_FILE missing — cannot alert, exiting"
    exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

if [ -z "${GCHAT_WEBHOOK_URL:-}" ]; then
    log "❌ GCHAT_WEBHOOK_URL not set in $ENV_FILE — cannot alert, exiting"
    exit 1
fi

mkdir -p "$STATE_DIR"

notify() {
    local text="$1"
    curl -s -X POST -H "Content-Type: application/json" \
        -d "{\"text\": \"${text}\"}" \
        "$GCHAT_WEBHOOK_URL" >/dev/null 2>&1 || log "⚠️ Failed to post to Google Chat"
}

# Only posts (and only touches the state file) on an actual OK<->FAIL
# transition — repeated calls with the same outcome are silent no-ops.
report() {
    local check_name="$1" ok="$2" fail_message="$3" recover_message="$4"
    local state_file="$STATE_DIR/$check_name"
    local prev="unknown"
    [ -f "$state_file" ] && prev=$(cat "$state_file")

    if [ "$ok" = "true" ]; then
        if [ "$prev" = "fail" ]; then
            notify "✅ $recover_message"
            log "✅ $check_name recovered"
        fi
        echo "ok" > "$state_file"
    else
        if [ "$prev" != "fail" ]; then
            notify "🔴 $fail_message"
            log "🔴 $check_name failing: $fail_message"
        fi
        echo "fail" > "$state_file"
    fi
}

# --- Check 1: ari-app's own ARI connection ---------------------------------
healthz_ok=false
if response=$(curl -s -m 5 -w '\n%{http_code}' http://127.0.0.1:3001/healthz 2>/dev/null); then
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    if [ "$http_code" = "200" ] && echo "$body" | grep -q '"ariConnected":true'; then
        healthz_ok=true
    fi
fi
report "healthz" "$healthz_ok" \
    "chumz-ari-app: /healthz is down or ariConnected:false — calls may not be routing. Check: systemctl status chumz-ari-app" \
    "chumz-ari-app: /healthz is back to ariConnected:true"

# --- Check 2: TURN relay credentials still match coturn --------------------
# A real allocate-and-relay round trip, not just "is the port open" — that's
# exactly the class of failure config review alone missed on 2026-09-07.
turn_ok=false
if [ -n "${TURN_ADDR:-}" ] && [ -n "${TURN_USERNAME:-}" ] && [ -n "${TURN_PASSWORD:-}" ]; then
    if turnutils_uclient -y -u "$TURN_USERNAME" -w "$TURN_PASSWORD" "$TURN_ADDR" 2>&1 | grep -q "Total lost packets"; then
        turn_ok=true
    fi
fi
report "turn" "$turn_ok" \
    "coturn: TURN relay allocation test failed — agents on networks that need the relay may get one-way or no audio. Check /etc/asterisk/rtp.conf's turnpassword against /etc/turnserver.conf's user= line" \
    "coturn: TURN relay allocation test is passing again"

# --- Check 3: calls-app's own /healthz on DigitalOcean ---------------------
# Run from the VPS, not from DO itself, deliberately — checking a service
# from inside the same platform it runs on can miss a whole class of outage
# (DNS, DO's edge, the box's own egress) that only shows up from the
# outside, which is the only vantage point a real caller/agent ever has.
CALLS_APP_URL="${CALLS_APP_HEALTHZ_URL:-https://calls-app-v6a38.ondigitalocean.app/healthz}"
callsapp_ok=false
if http_code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$CALLS_APP_URL" 2>/dev/null) && [ "$http_code" = "200" ]; then
    callsapp_ok=true
fi
report "callsapp" "$callsapp_ok" \
    "calls-app: $CALLS_APP_URL is down or not returning 200 — the dashboard/API may be unreachable. Check: doctl apps list-deployments, doctl apps logs" \
    "calls-app: $CALLS_APP_URL is back to 200"
