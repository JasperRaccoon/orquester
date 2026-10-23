#!/usr/bin/env bash
# Runs ON the VPS (delivered by ./deploy.sh via scp — never `bash -s`).
# Routine update cycle: fetch/reset -> pnpm install -> SPA build -> Go + orq-agent
# build (best-effort) -> native-module guard -> chown -> restart -> health. Inputs via env:
#   SUDO       "" or "sudo" — prefix for privileged commands (git/pnpm/node/chown/systemctl)
#   BRANCH     branch to deploy (default main)
#   RESET_REF  ref to reset to (default origin/$BRANCH; rollback passes a sha)
#   DOMAIN     the target's public domain (optional): adds ORQUESTER_PUBLIC_URL=https://$DOMAIN
#              to /etc/orquester/daemon.env when it has none
#   ENV_FILE   for local testing only (default /etc/orquester/daemon.env)
#   REPO_DIR   for local testing only (default /opt/orquester)
set -euo pipefail
trap 'echo "[remote-update] FAILED at line $LINENO" >&2' ERR

SUDO="${SUDO:-}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/orquester}"
RESET_REF="${RESET_REF:-origin/$BRANCH}"
DOMAIN="${DOMAIN:-}"
ENV_FILE="${ENV_FILE:-/etc/orquester/daemon.env}"

cd "$REPO_DIR"
old_head="$($SUDO git rev-parse HEAD)"
# Base the Caddyfile-drift check on the last SUCCESSFUL deploy, not the current
# checkout: a deploy that dies after `git reset` leaves the tree at the new HEAD,
# and on the retry old==new would silently skip the reconcile reminder.
state_file="$REPO_DIR/.git/orq-last-deployed-head"
drift_base="$old_head"
if last_ok="$($SUDO cat "$state_file" 2>/dev/null)" \
   && $SUDO git rev-parse --verify --quiet "$last_ok^{commit}" >/dev/null 2>&1; then
  drift_base="$last_ok"
fi
$SUDO git fetch origin -q
$SUDO git rev-parse --verify --quiet "$RESET_REF^{commit}" >/dev/null \
  || { echo "[remote-update] ref not found: $RESET_REF" >&2; exit 1; }
$SUDO git reset --hard -q "$RESET_REF"
new_head="$($SUDO git rev-parse HEAD)"
echo "[remote-update] HEAD: ${old_head:0:7} -> ${new_head:0:7}"

# CI=1: non-interactive (a pnpm-version-mismatch prompt would wedge the deploy).
# </dev/null: pnpm must never read stdin. Build runs bare: set -e catches failures.
$SUDO env CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null
$SUDO env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null
# orq-agent (apps/box-agent, Go): install the pinned toolchain and prebuild
# apps/box-agent/dist. Best-effort — a failure warns and the deploy continues: the
# daemon still starts and builds on demand into the appdir, or reports orq-agent
# builds unavailable. A stale dist is removed so boxes never get an outdated agent.
# Refs without the box agent (old rollbacks) skip this.
box_agent="skipped"
if [ -f apps/box-agent/package.json ]; then
  if ! $SUDO bash deploy/install-go.sh </dev/null; then
    box_agent="FAILED: Go toolchain install (deploy/install-go.sh)"
  elif ! $SUDO env GO=/usr/local/go/bin/go GOTOOLCHAIN=local pnpm --filter @orquester/box-agent build </dev/null; then
    box_agent="FAILED: pnpm --filter @orquester/box-agent build"
  else
    box_agent="ok"
  fi
  if [ "$box_agent" != "ok" ]; then
    $SUDO rm -rf apps/box-agent/dist
    echo "[remote-update] WARNING: orq-agent not prebuilt — $box_agent (see output above)." >&2
    echo "[remote-update]          Continuing: the daemon builds it on demand, or boxes report builds unavailable." >&2
  fi
fi
# The daemon loads better-sqlite3 and node-pty under /usr/bin/node (the unit's
# ExecStart interpreter): prove they load there, rebuilding any that don't,
# BEFORE the restart, so a deploy never restarts into a daemon that cannot start.
if ! $SUDO env CI=1 /usr/bin/node scripts/ensure-node-native.mjs </dev/null; then
  echo "[remote-update] native modules do not load under /usr/bin/node $(/usr/bin/node -v) — NOT restarting." >&2
  echo "[remote-update] The running daemon keeps its current process; fix the rebuild and re-deploy." >&2
  exit 1
fi
$SUDO chown -R root:root "$REPO_DIR"

if ! $SUDO git diff --quiet "$drift_base" "$new_head" -- deploy/Caddyfile; then
  echo "[remote-update] NOTE: deploy/Caddyfile changed (${drift_base:0:7}..${new_head:0:7})."
  echo "[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain"
  echo "[remote-update]       substituted), then: ${SUDO:+$SUDO }systemctl reload caddy"
fi

# The daemon's public origin, from the target's domain (an existing value is kept). Refs from
# before the helper existed (old rollbacks) skip it.
if [ -f deploy/lib/ensure-public-url.sh ]; then
  $SUDO bash deploy/lib/ensure-public-url.sh "$ENV_FILE" "$DOMAIN" </dev/null
fi

# The unit and the needrestart exclusion, from this checkout: a changed unit is reloaded here and
# applies at the restart below — nothing else is restarted. Refs from before the script skip it.
if [ -f deploy/install-unit.sh ]; then
  $SUDO bash deploy/install-unit.sh </dev/null
fi

$SUDO systemctl restart orquester
# A loaded host can take well over 30 s to bring the daemon up; wait up to 2 min.
curl -fsS --retry 120 --retry-delay 1 --retry-max-time 150 --retry-connrefused http://127.0.0.1:47831/health; echo
printf '%s\n' "$new_head" | $SUDO tee "$state_file" >/dev/null
echo "[remote-update] service=$(systemctl is-active orquester)"
echo "[remote-update] bundle=$(curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js' | head -n1)"
echo "[remote-update] box-agent=$box_agent"
echo "[remote-update] OK"
