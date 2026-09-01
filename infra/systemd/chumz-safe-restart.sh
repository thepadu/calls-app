#!/usr/bin/env bash
# Restarts asterisk/chumz-ari-app/coturn ONLY when needrestart has flagged
# them as running on outdated libraries AND there are zero active calls.
# Pairs with /etc/needrestart/conf.d/chumz.conf (which stops needrestart
# from doing this itself, unconditionally) — this is the deliberate,
# safety-gated replacement for that automatic behavior, automating the same
# "confirm zero active calls, then restart" check that was previously done
# by hand for every ari-app deploy.
set -euo pipefail

LOG_TAG="chumz-safe-restart"
SERVICES="asterisk.service chumz-ari-app.service coturn.service"

log() { logger -t "$LOG_TAG" "$1"; echo "$1"; }

# A single check at the top of the script left a real gap: nothing stopped
# a call from starting in the time between that check and the actual
# restart further down (several seconds, once you count the needrestart
# scan and the loop itself) — exactly the failure mode this script exists
# to prevent. Called again immediately before each restart below instead
# of trusting one stale reading.
zero_active_calls() {
    local n
    n=$(asterisk -rx "core show channels count" 2>/dev/null | grep -o '^[0-9]\+' | head -1 || echo "unknown")
    [ "$n" = "0" ]
}

flagged=$(needrestart -b 2>/dev/null | awk -F': ' '/^NEEDRESTART-SVC:/ {print $2}')

pending=()
for svc in $SERVICES; do
    if grep -qx "$svc" <<<"$flagged"; then
        pending+=("$svc")
    fi
done

if [ ${#pending[@]} -eq 0 ]; then
    log "No pending restarts for: $SERVICES"
    exit 0
fi

if ! zero_active_calls; then
    log "Restart pending for [${pending[*]}] but deferred — active calls present"
    exit 0
fi

log "Zero active calls — proceeding with restart for: ${pending[*]}"

# Fixed order: asterisk itself before the app that depends on its ARI
# connection, so chumz-ari-app doesn't reconnect against a mid-restart
# Asterisk and immediately need a second reconnect cycle.
for svc in asterisk.service chumz-ari-app.service coturn.service; do
    for p in "${pending[@]}"; do
        if [ "$p" = "$svc" ]; then
            if ! zero_active_calls; then
                log "Aborting remaining restarts — a call started since the last check (before restarting $svc)"
                exit 0
            fi
            log "Restarting $svc"
            systemctl restart "$svc"
            sleep 2
            if systemctl is-active --quiet "$svc"; then
                log "$svc restarted successfully"
            else
                log "WARNING: $svc failed to come back up after restart"
            fi
        fi
    done
done
