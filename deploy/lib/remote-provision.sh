#!/usr/bin/env bash
# Runs ON a fresh Ubuntu VPS as root (delivered by ./deploy.sh provision).
# Idempotent: safe to re-run after a partial failure. Inputs via env:
#   DOMAIN  (required) public domain — DNS A record must already point here
#   REPO    (required) git clone URL
#   BRANCH  default main
set -euo pipefail
# The generated password is normally printed once at the very end. If a later
# step aborts (daemon won't boot, Caddy, ufw), the password would exist only
# inside root-readable /etc/orquester/daemon.env and a re-run would neither
# regenerate nor reprint it — so the ERR trap must leave it behind.
on_err() {
  echo "[provision] FAILED at line $1" >&2
  if [ -n "${GENERATED_PASSWORD:-}" ]; then
    echo "[provision] NOTE: an HTTP password was already generated and installed in /etc/orquester/daemon.env:" >&2
    echo '==============================================================' >&2
    echo ' HTTP password (username from daemon.env, default: mapacho):' >&2
    echo "   $GENERATED_PASSWORD" >&2
    echo ' Save it NOW — a re-run will NOT regenerate or reprint it.' >&2
    echo '==============================================================' >&2
  fi
}
trap 'on_err $LINENO' ERR

# env validation first: a caller with a bad invocation should hear about that,
# not about privileges.
: "${DOMAIN:?DOMAIN is required}"
: "${REPO:?REPO is required}"
[ "$(id -u)" -eq 0 ] || { echo "[provision] must run as root" >&2; exit 1; }
BRANCH="${BRANCH:-main}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n[provision] %s\n' "$*"; }

log "1/7 service user"
id orquester >/dev/null 2>&1 || useradd --system --create-home \
  --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester

log "2/7 packages: apt deps, Node 20, pnpm, Caddy"
apt-get update -qq
apt-get install -y git openssh-client tmux ufw python3 make g++ curl \
  ca-certificates p7zip-full ripgrep gnupg
# Desktop tabs: virtual X display, window manager, compositor, audio and its Opus encoder.
apt-get install -y tigervnc-standalone-server openbox pulseaudio \
  pulseaudio-utils dbus-x11 libgl1-mesa-dri ffmpeg xcompmgr
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

log "3/7 repo checkout + install + build (SPA, Go toolchain, orq-agent)"
if [ ! -d /opt/orquester/.git ]; then
  mkdir -p /opt/orquester
  # An SSH clone URL needs a deploy key + known_hosts entry for root on THIS box;
  # a fresh VPS has neither. Say so instead of dying on a bare ssh error.
  git clone "$REPO" /opt/orquester || {
    echo "[provision] git clone failed: $REPO" >&2
    echo "[provision] an ssh URL (git@…) needs a deploy key in root's ~/.ssh plus a" >&2
    echo "[provision] known_hosts entry on this VPS; for a public repo use an https:// URL." >&2
    exit 1
  }
fi
cd /opt/orquester
git fetch origin -q
git checkout -q "$BRANCH"
git reset --hard -q "origin/$BRANCH"
CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null
# orq-agent (apps/box-agent, Go): pinned toolchain + prebuilt apps/box-agent/dist.
# Best-effort, like remote-update.sh: the daemon still starts without it and builds
# on demand into the appdir, or reports orq-agent builds unavailable.
BOX_AGENT_WARNING=""
if [ -f apps/box-agent/package.json ]; then
  if ! bash deploy/install-go.sh </dev/null; then
    BOX_AGENT_WARNING="Go toolchain install failed — orq-agent not prebuilt"
  elif ! GO=/usr/local/go/bin/go GOTOOLCHAIN=local pnpm --filter @orquester/box-agent build </dev/null; then
    rm -rf apps/box-agent/dist
    BOX_AGENT_WARNING="orq-agent build failed"
  fi
fi
if [ -n "$BOX_AGENT_WARNING" ]; then
  echo "[provision] WARNING: $BOX_AGENT_WARNING (see above) — continuing; deploy again to retry." >&2
fi
# The daemon loads better-sqlite3 and node-pty under /usr/bin/node (the unit's
# ExecStart interpreter): prove they load there, rebuilding any that don't,
# before the service is started below.
if ! CI=1 /usr/bin/node scripts/ensure-node-native.mjs </dev/null; then
  echo "[provision] native modules do not load under /usr/bin/node $(/usr/bin/node -v) — not starting the daemon." >&2
  exit 1
fi
chown -R root:root /opt/orquester

log "4/7 /etc/orquester/daemon.env"
GENERATED_PASSWORD=""
if [ ! -f /etc/orquester/daemon.env ]; then
  mkdir -p /etc/orquester
  GENERATED_PASSWORD="$(openssl rand -base64 32)"
  # Create the file already-restricted: a plain `> file` redirect would use
  # root's umask (0644 on stock Ubuntu) and leave the plaintext password
  # world-readable until the chmod lands.
  install -m 600 -o orquester -g orquester /dev/null /etc/orquester/daemon.env
  # base64 alphabet never contains '|' or '&' -> safe as sed replacement
  sed "s|replace-with-a-32+char-random-secret|$GENERATED_PASSWORD|" \
    deploy/daemon.env.example > /etc/orquester/daemon.env
else
  log "daemon.env already exists — leaving it untouched"
fi

log "5/7 systemd unit + session devtools + start"
cp deploy/orquester.service /etc/systemd/system/orquester.service
bash deploy/provision-devtools.sh </dev/null
systemctl daemon-reload
systemctl enable --now orquester
systemctl restart orquester
curl -fsS --retry 120 --retry-delay 1 --retry-max-time 150 --retry-connrefused http://127.0.0.1:47831/health; echo

log "6/7 Caddy vhost for $DOMAIN"
# Re-run safe: never clobber an existing Caddyfile that drifted from the
# template (hand reconciliation after a template update is expected — the
# deploy payload explicitly tells the operator to do it).
caddy_new="$(mktemp)"
sed "s|orquester.example.com|$DOMAIN|" deploy/Caddyfile > "$caddy_new"
if [ ! -f /etc/caddy/Caddyfile ]; then
  install -m 0644 "$caddy_new" /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
elif cmp -s "$caddy_new" /etc/caddy/Caddyfile; then
  log "Caddyfile already up to date"
else
  log "WARNING: /etc/caddy/Caddyfile differs from the repo template — leaving it"
  log "         untouched. Reconcile manually, then: systemctl reload caddy"
fi
rm -f "$caddy_new"

log "7/7 firewall: allow 22 + 443 only"
ufw allow 22/tcp
ufw allow 443/tcp
ufw --force enable

log "DONE — https://$DOMAIN"
if [ -n "$BOX_AGENT_WARNING" ]; then
  echo "[provision] WARNING: $BOX_AGENT_WARNING — boxes fall back to an on-demand build; deploy again to retry." >&2
fi
if [ -n "$GENERATED_PASSWORD" ]; then
  echo '=============================================================='
  echo ' HTTP password (username from daemon.env, default: mapacho):'
  echo "   $GENERATED_PASSWORD"
  echo ' Shown ONCE — save it in your password manager now.'
  echo '=============================================================='
fi
