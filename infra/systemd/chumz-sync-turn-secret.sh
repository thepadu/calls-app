#!/usr/bin/env bash
# Propagates TURN_ADDR/TURN_USERNAME/TURN_PASSWORD from the canonical VPS
# secrets file (/opt/chumz-ari-app/.env) into /etc/asterisk/rtp.conf and
# /etc/turnserver.conf — neither of those is read by anything that
# understands env vars (Asterisk and coturn both parse their own config
# files directly), so this script is what replaces hand-editing all three
# files whenever the TURN password changes. See DECISIONS.md's 2026-09-08
# secret-consolidation entry and infra/README.md for why this exists — the
# same drift between these files with nothing keeping them in sync already
# caused a real one-way-audio incident once (2026-09-07).
#
# Run by hand, as root, after changing TURN_ADDR/TURN_USERNAME/TURN_PASSWORD
# in /opt/chumz-ari-app/.env. Only edits rtp.conf/turnserver.conf and prints
# a diff — does NOT reload Asterisk or restart coturn itself; run the
# commands this script prints at the end yourself, after confirming zero
# active calls, same as every other live change to these services.
set -euo pipefail

ENV_FILE="/opt/chumz-ari-app/.env"
RTP_CONF="/etc/asterisk/rtp.conf"
TURNSERVER_CONF="/etc/turnserver.conf"
BACKUP_DIR="/root/config-backups"

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Must run as root (needs to read $ENV_FILE and write $RTP_CONF/$TURNSERVER_CONF)." >&2
    exit 1
fi

for f in "$ENV_FILE" "$RTP_CONF" "$TURNSERVER_CONF"; do
    [ -f "$f" ] || { echo "❌ $f not found." >&2; exit 1; }
done

# shellcheck source=/dev/null
source "$ENV_FILE"
for var in TURN_ADDR TURN_USERNAME TURN_PASSWORD; do
    [ -n "${!var:-}" ] || { echo "❌ $var not set in $ENV_FILE." >&2; exit 1; }
done

# Refuse to guess if either file's shape isn't exactly what's expected —
# better to stop loudly here than silently corrupt a live Asterisk/coturn
# config file with a sed that matched the wrong line, or none at all.
rtp_matches=$(grep -c '^turnpassword=' "$RTP_CONF")
if [ "$rtp_matches" -ne 1 ]; then
    echo "❌ Expected exactly one 'turnpassword=' line in $RTP_CONF, found $rtp_matches. Not touching it." >&2
    exit 1
fi
turnserver_matches=$(grep -c '^user=' "$TURNSERVER_CONF")
if [ "$turnserver_matches" -ne 1 ]; then
    echo "❌ Expected exactly one 'user=' line in $TURNSERVER_CONF, found $turnserver_matches. Not touching it." >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp=$(date +%Y%m%d-%H%M%S)
rtp_backup="$BACKUP_DIR/rtp.conf.$stamp"
turnserver_backup="$BACKUP_DIR/turnserver.conf.$stamp"
cp "$RTP_CONF" "$rtp_backup"
cp "$TURNSERVER_CONF" "$turnserver_backup"
echo "Backed up to $rtp_backup and $turnserver_backup."

sed -i \
    -e "s/^turnaddr=.*/turnaddr=${TURN_ADDR}/" \
    -e "s/^turnusername=.*/turnusername=${TURN_USERNAME}/" \
    -e "s/^turnpassword=.*/turnpassword=${TURN_PASSWORD}/" \
    "$RTP_CONF"
sed -i "s/^user=.*/user=${TURN_USERNAME}:${TURN_PASSWORD}/" "$TURNSERVER_CONF"

echo
echo "--- $RTP_CONF diff (only these lines should differ) ---"
diff "$rtp_backup" "$RTP_CONF" || true
echo
echo "--- $TURNSERVER_CONF diff (only this line should differ) ---"
diff "$turnserver_backup" "$TURNSERVER_CONF" || true

echo
echo "Review the diffs above. If they only show the expected TURN line(s):"
echo "  1. Confirm zero active calls:  asterisk -rx \"core show channels count\""
echo "  2. asterisk -rx \"core reload\""
echo "  3. systemctl restart coturn"
echo "  4. Re-run chumz-healthcheck.sh and confirm the TURN check passes."
