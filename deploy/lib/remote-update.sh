#!/usr/bin/env bash
# Runs ON the VPS (delivered by ./deploy.sh via scp — never `bash -s`).
# Routine update cycle: fetch/reset -> pnpm install -> SPA build -> Go + orq-agent
# build (best-effort) -> native-module guard -> chown -> version stamp -> public URL
# + unit -> restart -> health. If the new release never turns healthy, the previous
# release (the last successful deploy) is reset, rebuilt, restarted and
# health-checked, and the deploy still fails. Inputs via env:
#   SUDO        "" or "sudo" — prefix for privileged commands (git/pnpm/node/chown/systemctl)
#   BRANCH      branch to deploy (default main)
#   RESET_REF   ref to reset to (default origin/$BRANCH; rollback passes a sha)
#   DOMAIN      the target's public domain (optional): adds ORQUESTER_PUBLIC_URL=https://$DOMAIN
#               to /etc/orquester/daemon.env when it has none
#   ENV_FILE    for local testing only (default /etc/orquester/daemon.env)
#   REPO_DIR    for local testing only (default /opt/orquester)
#   NODE_BIN    for local testing only (default /usr/bin/node, the unit's interpreter)
#   HEALTH_URL  for local testing only (default http://127.0.0.1:47831/health)
#   HEALTH_WAIT seconds the health check retries for after a restart (default 600)
#   AUTO_REVERT 1 (default) rolls a release that fails its health check back; 0 leaves it
# Exit codes: 0 deployed; 1 failed before or without a revert; 3 the new release
# failed its health check and the previous one was restored (running, healthy);
# 4 the previous one failed to come back too (the daemon is DOWN).
set -euo pipefail
trap 'echo "[remote-update] FAILED at line $LINENO" >&2' ERR

SUDO="${SUDO:-}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/orquester}"
RESET_REF="${RESET_REF:-origin/$BRANCH}"
DOMAIN="${DOMAIN:-}"
ENV_FILE="${ENV_FILE:-/etc/orquester/daemon.env}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:47831/health}"
# A loaded host can take minutes to bring the daemon up — the first start after a large update
# compiles every new module (tsx's cache is cold); 3 min was seen on a busy host.
HEALTH_WAIT="${HEALTH_WAIT:-600}"
AUTO_REVERT="${AUTO_REVERT:-1}"
# Read by the daemon for GET /api/info when the tree has no .git (apps/daemon/src/build-info.ts).
STAMP_FILE=".orquester-version.json"

cd "$REPO_DIR"
old_head="$($SUDO git rev-parse HEAD)"
# Base the Caddyfile-drift check on the last SUCCESSFUL deploy, not the current
# checkout: a deploy that dies after `git reset` leaves the tree at the new HEAD,
# and on the retry old==new would silently skip the reconcile reminder. The same
# release is the one a failed health check rolls back to.
state_file="$REPO_DIR/.git/orq-last-deployed-head"
drift_base="$old_head"
if last_ok="$($SUDO cat "$state_file" 2>/dev/null)" \
   && $SUDO git rev-parse --verify --quiet "$last_ok^{commit}" >/dev/null 2>&1; then
  drift_base="$last_ok"
fi
previous="$drift_base"
$SUDO git fetch origin -q
$SUDO git rev-parse --verify --quiet "$RESET_REF^{commit}" >/dev/null \
  || { echo "[remote-update] ref not found: $RESET_REF" >&2; exit 1; }
$SUDO git reset --hard -q "$RESET_REF"
new_head="$($SUDO git rev-parse HEAD)"
echo "[remote-update] HEAD: ${old_head:0:7} -> ${new_head:0:7}"

tree_version() { # the checked-out package.json's version (no node: it may be the thing that is broken)
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n1
}

# Install, build and guard the checked-out tree. Every step checks its own status:
# the revert path calls this from an `if`, where `set -e` does not apply.
box_agent="skipped"
build_tree() {
  # CI=1: non-interactive (a pnpm-version-mismatch prompt would wedge the deploy).
  # </dev/null: pnpm must never read stdin.
  $SUDO env CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null || return 1
  $SUDO env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null || return 1
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
  if ! $SUDO env CI=1 "$NODE_BIN" scripts/ensure-node-native.mjs </dev/null; then
    echo "[remote-update] native modules do not load under $NODE_BIN $("$NODE_BIN" -v 2>/dev/null || echo '(unknown)')." >&2
    return 2
  fi
  $SUDO chown -R root:root "$REPO_DIR" || return 1
}

write_stamp() { # <commit>
  printf '{"commit":"%s","version":"%s","deployedAt":"%s"}\n' "$1" "$(tree_version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    | $SUDO tee "$REPO_DIR/$STAMP_FILE" >/dev/null
}

# The checked-out tree's host setup, run before each restart (the revert's too, so the unit
# matches the release it starts): the daemon's public origin from the target's domain (an existing
# value is kept), then the unit and the needrestart exclusion — a changed unit is reloaded here and
# applies at the restart; nothing else is restarted. Refs from before a helper existed skip it.
prepare_host() {
  if [ -f deploy/lib/ensure-public-url.sh ]; then
    $SUDO bash deploy/lib/ensure-public-url.sh "$ENV_FILE" "$DOMAIN" </dev/null || return 1
  fi
  if [ -f deploy/install-unit.sh ]; then
    $SUDO bash deploy/install-unit.sh </dev/null || return 1
  fi
}

# Restart and wait (bounded by HEALTH_WAIT) for /health and an active unit. The retries are
# quiet — one connection-refused line per second would bury the rest of the output — and a last
# plain request shows why the check failed.
restart_healthy() {
  $SUDO systemctl restart orquester || return 1
  curl -fsS --retry "$HEALTH_WAIT" --retry-delay 1 --retry-max-time "$HEALTH_WAIT" --retry-connrefused \
    --max-time 10 "$HEALTH_URL" 2>/dev/null \
    || curl -fsS --max-time 10 "$HEALTH_URL" || return 1
  echo
  [ "$(systemctl is-active orquester 2>/dev/null || true)" = "active" ]
}

build_rc=0
build_tree || build_rc=$?
if [ "$build_rc" -ne 0 ]; then
  if [ "$build_rc" -eq 2 ]; then
    echo "[remote-update] NOT restarting: the running daemon keeps its current process; fix the rebuild and re-deploy." >&2
  else
    echo "[remote-update] build failed — NOT restarting; the running daemon keeps its current process." >&2
  fi
  exit 1
fi

if ! $SUDO git diff --quiet "$drift_base" "$new_head" -- deploy/Caddyfile; then
  echo "[remote-update] NOTE: deploy/Caddyfile changed (${drift_base:0:7}..${new_head:0:7})."
  echo "[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain"
  echo "[remote-update]       substituted), then: ${SUDO:+$SUDO }systemctl reload caddy"
fi

write_stamp "$new_head"
prepare_host
if ! restart_healthy; then
  echo "[remote-update] ERROR: release ${new_head:0:7} did not report healthy within ${HEALTH_WAIT}s." >&2
  if [ "$AUTO_REVERT" != "1" ] || [ "$previous" = "$new_head" ]; then
    echo "[remote-update] No previous release to roll back to — the daemon runs ${new_head:0:7} and is NOT healthy." >&2
    echo "[remote-update] Inspect: ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
    exit 1
  fi
  echo "[remote-update] AUTO-REVERT: rolling back to the previous release ${previous:0:7}." >&2
  revert_ok=0
  if $SUDO git reset --hard -q "$previous" && build_tree && write_stamp "$previous" && prepare_host && restart_healthy; then
    revert_ok=1
  fi
  if [ "$revert_ok" -eq 1 ]; then
    echo "[remote-update] service=$(systemctl is-active orquester)"
    echo "[remote-update] version=$(tree_version) commit=$previous"
    echo "[remote-update] ROLLED BACK: ${new_head:0:7} failed its health check; ${previous:0:7} is running and healthy." >&2
    echo "[remote-update] The deploy FAILED. Inspect the failed start: ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
    exit 3
  fi
  echo "[remote-update] ROLLBACK FAILED: ${previous:0:7} did not come back healthy either — the daemon is NOT healthy (it may be down)." >&2
  echo "[remote-update] Act now: ${SUDO:+$SUDO }systemctl status orquester; ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
  exit 4
fi
printf '%s\n' "$new_head" | $SUDO tee "$state_file" >/dev/null
echo "[remote-update] service=$(systemctl is-active orquester)"
echo "[remote-update] version=$(tree_version) commit=$new_head"
echo "[remote-update] bundle=$(curl -s "${HEALTH_URL%/health}/" | grep -o 'index-[^.]*\.js' | head -n1)"
echo "[remote-update] box-agent=$box_agent"
echo "[remote-update] OK"
