#!/usr/bin/env bash
# Installs or upgrades the Fiberifi NOC panel on a clean Ubuntu server.
#
#   sudo ./deploy/install.sh
#
# Optional settings:
#   DOMAIN=noc.fiberifi.com  ADMIN_EMAIL=admin@fiberifi.com
#
# Safe to run again to upgrade: the database and /etc/noc-fiberifi.env are kept.
set -euo pipefail

DOMAIN="${DOMAIN:-noc.fiberifi.com}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@fiberifi.com}"
APP_USER=noc
APP_DIR=/opt/noc-fiberifi
DATA_DIR=/var/lib/noc-fiberifi
ENV_FILE=/etc/noc-fiberifi.env
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=24

say() { printf '\n==> %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi
if [ ! -f "$SOURCE_DIR/package-lock.json" ]; then
  echo "Run this from inside the noc-fiberifi folder." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

say "Installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg openssl rsync

node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]
}

if node_ok; then
  say "Node.js $(node --version) is already installed"
else
  # Ubuntu's own package is used when it is new enough, which avoids a third-party repository.
  candidate="$(apt-cache policy nodejs | awk '/Candidate:/ {print $2}' | sed -E 's/^[0-9]+://; s/\..*//')"
  if [ -n "$candidate" ] && [ "$candidate" != "(none)" ] && [ "$candidate" -ge "$NODE_MAJOR" ] 2>/dev/null; then
    say "Installing Node.js from Ubuntu"
    apt-get install -y -qq nodejs npm
  else
    say "Installing Node.js $NODE_MAJOR from NodeSource"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs
  fi
fi
node_ok || { echo "Node.js $NODE_MAJOR or newer is required, found $(node --version 2>/dev/null || echo none)." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || apt-get install -y -qq npm

# Caddy's own repository: Ubuntu 26.04 ships 2.6.2, which is years behind for an internet-facing TLS proxy.
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy from its official repository"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/caddy.gpg
  echo "deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" >/etc/apt/sources.list.d/caddy.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

say "Creating the service account and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
install -d -m 0755 "$APP_DIR"

say "Copying the application"
rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude .git --exclude test "$SOURCE_DIR/" "$APP_DIR/"
chown -R root:root "$APP_DIR"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if [ ! -f "$ENV_FILE" ]; then
  say "Creating $ENV_FILE"
  umask 027
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
DATA_DIR=$DATA_DIR
PUBLIC_URL=https://$DOMAIN
ADMIN_EMAIL=$ADMIN_EMAIL
# Encrypts the Cloudflare token. If this changes, the token must be entered again.
APP_SECRET=$(openssl rand -hex 32)
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
else
  say "Keeping the existing $ENV_FILE"
fi

say "Installing the services"
install -m 0644 "$APP_DIR/deploy/noc-fiberifi.service" /etc/systemd/system/noc-fiberifi.service
install -m 0755 "$APP_DIR/deploy/noc-reset-admin" /usr/local/bin/noc-reset-admin

if [ -f /etc/caddy/Caddyfile ] && ! grep -q 'noc-fiberifi' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-noc"
fi
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" >/etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

# Only opens ports on a firewall that is already on. Turning one on here could cut off SSH.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
  say "Opening ports 80 and 443 in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi

say "Starting the panel"
first_install=0
[ -f "$DATA_DIR/noc.db" ] || first_install=1
systemctl daemon-reload
systemctl enable --quiet noc-fiberifi caddy
systemctl restart noc-fiberifi

for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
  echo "The panel did not start. Check: journalctl -u noc-fiberifi -n 50" >&2
  exit 1
fi
systemctl reload-or-restart caddy

echo
echo "The panel is running at https://$DOMAIN"
echo "TLS is issued automatically once $DOMAIN points at this server and ports 80 and 443 are open."
if [ "$first_install" = 1 ]; then
  echo
  echo "First admin login. This is shown once and must be changed when you sign in:"
  noc-reset-admin "$ADMIN_EMAIL"
fi
