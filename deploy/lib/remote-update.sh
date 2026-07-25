#!/usr/bin/env bash
# Runs ON the VPS (delivered by ./deploy.sh via scp — never `bash -s`).
# Routine update cycle: fetch/reset -> pnpm install -> SPA build -> chown ->
# restart -> health. Inputs via env:
#   SUDO       "" or "sudo" — prefix for privileged commands (git/pnpm/chown/systemctl)
#   BRANCH     branch to deploy (default main)
#   RESET_REF  ref to reset to (default origin/$BRANCH; rollback passes a sha)
#   REPO_DIR   for local testing only (default /opt/orquester)
set -euo pipefail
trap 'echo "[remote-update] FAILED at line $LINENO" >&2' ERR

SUDO="${SUDO:-}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/orquester}"
RESET_REF="${RESET_REF:-origin/$BRANCH}"

cd "$REPO_DIR"
old_head="$($SUDO git rev-parse HEAD)"
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
$SUDO chown -R root:root "$REPO_DIR"

if ! $SUDO git diff --quiet "$old_head" "$new_head" -- deploy/Caddyfile; then
  echo "[remote-update] NOTE: deploy/Caddyfile changed (${old_head:0:7}..${new_head:0:7})."
  echo "[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain"
  echo "[remote-update]       substituted), then: ${SUDO:+$SUDO }systemctl reload caddy"
fi

$SUDO systemctl restart orquester
curl -fsS --retry 25 --retry-delay 1 --retry-connrefused http://127.0.0.1:47831/health; echo
echo "[remote-update] service=$(systemctl is-active orquester)"
echo "[remote-update] bundle=$(curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js' | head -n1)"
echo "[remote-update] OK"
