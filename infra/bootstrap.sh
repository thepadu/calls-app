#!/usr/bin/env bash
# Provisions a fresh Ubuntu 24.04 LTS box into a working copy of the
# sip.chumz.online VPS — Asterisk, coturn, Node, Caddy, fail2ban, and this
# repo's own ari-app deployment. Written 2026-09-08 by reading every package
# and its exact installed version directly off the live box (dpkg -l,
# node -v, caddy version, etc.), not from memory — this is the prerequisite
# the original production-readiness audit named before real Terraform/
# Ansible is worth it: a rebuild had never actually been rehearsed, and
# infra/'s config-file mirror alone (this file's whole reason for existing)
# turned out NOT to be enough — nobody had noticed fail2ban's custom
# Asterisk jail (jail.local) or Asterisk's own custom logger.conf (both
# needed for the fail2ban protection this project already relies on) were
# untracked anywhere until writing this script surfaced it.
#
# NOT fully automated end-to-end — three things below are flagged INSTEAD
# OF automated, deliberately: they're either live credentials that can't
# live in this script, or a manual download this script can't safely
# pin a URL for. Read every "MANUAL STEP" comment before assuming this
# alone rebuilds the box.
#
# Run as root on a fresh Ubuntu 24.04 droplet. Idempotent-ish (apt/dpkg
# operations are, the config-file copies are) but not re-run-tested against
# an already-provisioned box — this is a rebuild script, not a config-drift
# corrector (chumz-safe-restart.sh/needrestart already cover that).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$REPO_ROOT/infra"

echo "== 1/8: base packages =="
apt-get update
apt-get install -y \
    asterisk asterisk-config asterisk-core-sounds-en asterisk-core-sounds-en-gsm \
    asterisk-modules asterisk-moh-opsound-gsm \
    coturn mpg123 ufw fail2ban needrestart \
    sox libsox-fmt-alsa \
    git curl ca-certificates gnupg \
    debian-keyring debian-archive-keyring apt-transport-https

# Kenya is a single timezone with no DST (EAT, UTC+3) — set it here so
# `date`/log-file mtimes/anything a human reads on the box directly reads in
# local time. Doesn't affect any application logic: ari-app's own business-
# hours check (ari-app/lib/helpers.js's isWithinBusinessHours) computes
# Nairobi time from UTC explicitly and ignores the system TZ entirely, and
# its own log timestamps use toISOString() (always UTC) for the same reason.
timedatectl set-timezone Africa/Nairobi

echo "== 2/8: Node.js 20.x (NodeSource's own repo — Ubuntu 24.04's default apt Node is older) =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v20.* ]]; then
    mkdir -p /usr/share/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
    cat > /etc/apt/sources.list.d/nodesource.sources <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_20.x
Suites: nodistro
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/nodesource.gpg
EOF
    apt-get update
    apt-get install -y nodejs
fi

echo "== 3/8: Caddy (Cloudsmith's official repo — not in Ubuntu's own apt sources) =="
if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    apt-get install -y caddy
fi

echo "== 4/8: coturn — the Debian package installs disabled by default =="
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
systemctl enable coturn

echo "== 5/8: tracked config files =="
cp "$INFRA/caddy/Caddyfile" /etc/caddy/Caddyfile
cp "$INFRA/asterisk/http.conf" /etc/asterisk/http.conf
cp "$INFRA/asterisk/extensions.conf" /etc/asterisk/extensions.conf
cp "$INFRA/asterisk/musiconhold.conf" /etc/asterisk/musiconhold.conf
cp "$INFRA/asterisk/logger.conf" /etc/asterisk/logger.conf
cp "$INFRA/fail2ban/jail.local" /etc/fail2ban/jail.local
cp "$INFRA/fail2ban/asterisk-tls-scan.conf" /etc/fail2ban/filter.d/asterisk-tls-scan.conf
cp "$INFRA/needrestart/chumz.conf" /etc/needrestart/conf.d/chumz.conf
for unit in chumz-safe-restart.service chumz-safe-restart.timer chumz-ari-app.service \
            chumz-healthcheck.service chumz-healthcheck.timer; do
    cp "$INFRA/systemd/$unit" "/etc/systemd/system/$unit"
done
install -m 755 "$INFRA/systemd/chumz-safe-restart.sh" /usr/local/sbin/chumz-safe-restart.sh
install -m 755 "$INFRA/systemd/chumz-healthcheck.sh" /usr/local/sbin/chumz-healthcheck.sh
install -m 755 "$INFRA/systemd/chumz-ari-rollback.sh" /usr/local/sbin/chumz-ari-rollback.sh
install -m 755 "$INFRA/systemd/chumz-sync-turn-secret.sh" /usr/local/sbin/chumz-sync-turn-secret.sh

echo "== 6/8: firewall =="
bash "$INFRA/firewall/setup-ufw.sh"

echo "== 7/8: ari-app deployment =="
mkdir -p /opt/chumz-ari-app/backups /opt/chumz-ari-app/lib
cp -r "$REPO_ROOT/ari-app/"* /opt/chumz-ari-app/
chown -R asterisk:asterisk /opt/chumz-ari-app
su -s /bin/bash asterisk -c "cd /opt/chumz-ari-app && npm ci --omit=dev"

systemctl daemon-reload
systemctl enable chumz-ari-app chumz-safe-restart.timer chumz-healthcheck.timer fail2ban ufw
systemctl restart fail2ban

echo "== 8/8: MANUAL STEPS — cannot be automated safely, read every one =="
cat <<'EOF'

1. pjsip.conf — copy infra/asterisk/pjsip.conf.template to
   /etc/asterisk/pjsip.conf, then re-provision every real agent through the
   dashboard (Agents page) — their SIP credentials are generated fresh, not
   restored from anywhere, by design (see infra/README.md).

2. rtp.conf — recreate by hand using DECISIONS.md's 2026-09-07 TURN entry
   for the exact shape (turnaddr/turnusername/turnpassword lines must
   exist). The actual values don't need to be typed correctly here — step 4
   below overwrites them from the one canonical value in .env, so a typo
   here can't cause the rtp.conf-vs-coturn drift that bit us on 2026-09-07.

3. turnserver.conf (coturn) — recreate by hand (realm sip.chumz.online,
   external-ip = this box's public IP, lt-cred-mech, a fresh
   user=chumzagent:<password> line).

4. /opt/chumz-ari-app/.env — the single canonical secrets file for the
   whole VPS (see DECISIONS.md's 2026-09-08 entry and infra/README.md):
   SUPABASE_URL, SUPABASE_KEY, ARI_URL, ARI_USERNAME, ARI_PASSWORD,
   ARI_APP_NAME, ARI_APP_INTERNAL_SECRET, GCHAT_WEBHOOK_URL (quote it — see
   infra/README.md's note on the literal & in Google Chat webhook URLs),
   and TURN_ADDR/TURN_USERNAME/TURN_PASSWORD (same password chosen in step
   3). `chmod 600` it. Real values live only in the original box's backups
   and whoever's password manager holds them — never in this repo. Then run
   `chumz-sync-turn-secret.sh` to push the TURN_* values into rtp.conf
   (step 2) and turnserver.conf (step 3) instead of hand-typing them there
   too. Whatever password you choose still also needs to go in calls-app's
   SOFTPHONE_TURN_PASSWORD env var on DigitalOcean by hand — that's the one
   copy this script can't reach, since ari-app runs on this VPS, not on DO.

5. Piper TTS — NOT installed by this script. The live box has a
   manually-downloaded release at /opt/piper/piper/piper plus a voice model
   at /opt/piper/voices/en_US-lessac-medium.onnx (+ .onnx.json) — from
   Piper's own GitHub releases and the rhasspy/piper-voices model repo, but
   the exact release URL used originally was never independently
   re-verified while writing this script, so it isn't hardcoded here as a
   fact that might already be stale. Check https://github.com/rhasspy/piper
   for the current linux_x86_64 release and the voice model download
   instead of trusting an old URL.

6. Reload/restart order once secrets are in place: `asterisk -rx
   "core reload"`, `systemctl restart coturn`, `systemctl start
   chumz-ari-app`, then confirm with chumz-healthcheck.sh's own checks
   (or just `systemctl start chumz-healthcheck.service` once).

EOF
