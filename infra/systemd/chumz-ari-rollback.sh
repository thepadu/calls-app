#!/usr/bin/env bash
# Restores ari-app's own tracked files (index.js, supabase.js, package.json,
# package-lock.json) from the timestamped backups every deploy this project
# has made since 2026-09-04 already leaves in /opt/chumz-ari-app/backups/ —
# previously "roll back a bad deploy" meant remembering which backup file
# matched which deploy and scp'ing it back by hand. This is that same
# manual sequence, just no longer something that has to be remembered
# under pressure.
#
# Usage:
#   chumz-ari-rollback.sh              # restore each file to its own most
#                                       # recent backup — undoes whatever
#                                       # the last deploy(s) actually touched
#   chumz-ari-rollback.sh list         # show available backup timestamps
#   chumz-ari-rollback.sh <timestamp>  # restore every file that has a
#                                       # backup at exactly that timestamp
set -euo pipefail

APP_DIR="/opt/chumz-ari-app"
BACKUP_DIR="$APP_DIR/backups"
SERVICE="chumz-ari-app.service"
LOG_TAG="chumz-ari-rollback"
# Every file this project has ever backed up before overwriting — see the
# deploy steps in DECISIONS.md/this session's own history. A rollback
# that silently skipped one of these because it was added later would be
# a worse surprise than just listing them all up front.
TRACKED_FILES=(index.js supabase.js package.json package-lock.json .env)

log() { logger -t "$LOG_TAG" "$1"; echo "$1"; }

zero_active_calls() {
    local n
    n=$(asterisk -rx "core show channels count" 2>/dev/null | grep -o '^[0-9]\+' | head -1 || echo "unknown")
    [ "$n" = "0" ]
}

if [ "${1:-}" = "list" ]; then
    echo "Available backup timestamps (newest first):"
    for f in "${TRACKED_FILES[@]}"; do
        find "$BACKUP_DIR" -maxdepth 1 -name "$f.*" -printf '%f\n' 2>/dev/null
    done | sed -E 's/.*\.//' | sort -ru | uniq
    exit 0
fi

requested_ts="${1:-}"

# Picks the single newest backup for one file, or the one at an exact
# timestamp if one was requested. Empty output means "no backup to
# restore" — the caller below treats that as "leave this file alone",
# not an error, since not every deploy touches every file.
pick_backup() {
    local file="$1"
    if [ -n "$requested_ts" ]; then
        local exact="$BACKUP_DIR/$file.$requested_ts"
        [ -f "$exact" ] && echo "$exact"
        return 0
    fi
    find "$BACKUP_DIR" -maxdepth 1 -name "$file.*" 2>/dev/null | sort -r | head -1
}

restore=()
for f in "${TRACKED_FILES[@]}"; do
    src=$(pick_backup "$f")
    if [ -n "$src" ]; then
        restore+=("$f:$src")
    fi
done

if [ ${#restore[@]} -eq 0 ]; then
    log "No matching backups found${requested_ts:+ for timestamp $requested_ts} — nothing to restore"
    exit 1
fi

echo "About to restore:"
for pair in "${restore[@]}"; do
    echo "  ${pair%%:*}  <-  ${pair#*:}"
done
read -r -p "Proceed? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    log "Rollback cancelled by operator"
    exit 0
fi

if ! zero_active_calls; then
    log "Aborting — active calls present, re-run once the line is clear"
    exit 1
fi

# Back up whatever's about to be overwritten, same convention as every
# deploy this week — so a rollback is itself always reversible, and can
# never be the one operation on this box that silently destroys the
# thing it's trying to fix.
ts=$(date +%Y%m%d-%H%M%S)
for pair in "${restore[@]}"; do
    f="${pair%%:*}"; src="${pair#*:}"
    if [ -f "$APP_DIR/$f" ]; then
        cp "$APP_DIR/$f" "$BACKUP_DIR/$f.$ts"
    fi
    cp "$src" "$APP_DIR/$f"
    log "Restored $f from $(basename "$src")"
done

# A syntax error in a restored .js file must never reach `systemctl
# restart` — that would just crash-loop the live call-routing process
# instead of the calm, controlled rollback this script exists to be.
for f in index.js supabase.js; do
    if [ -f "$APP_DIR/$f" ] && ! node --check "$APP_DIR/$f"; then
        log "ABORTING before restart — $f failed node --check after restore"
        exit 1
    fi
done

if ! zero_active_calls; then
    log "Files restored, but a call started before the restart — restart manually once clear: systemctl restart $SERVICE"
    exit 1
fi

log "Restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
    log "$SERVICE restarted successfully after rollback"
else
    log "WARNING: $SERVICE failed to come back up after rollback — check: journalctl -u $SERVICE, tail /var/log/chumz-ari-app.log"
    exit 1
fi
