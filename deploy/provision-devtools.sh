#!/usr/bin/env bash
# Provision session dev tooling + scoped sudo on a VPS. Idempotent; run as root once per host:
#
#     [sudo] bash deploy/provision-devtools.sh
#
# First-time provisioning (see AGENTS.md) runs this, so a NEW VPS gets everything out of the box.
# Re-run it to catch up an EXISTING VPS. It does NOT restart the daemon — it prints the
# daemon-reload/restart reminder so you activate the loosened unit deliberately.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SERVICE_USER:-orquester}"

[ "$(id -u)" -eq 0 ] || { echo "provision-devtools: must run as root (use sudo)" >&2; exit 1; }

log() { printf '\n[provision-devtools] %s\n' "$*"; }

# 1. System build packages that cannot live in the appdir (dev headers, CMake, bsdtar, native
#    Python/venv). Covers common Rust `-sys`/CMake builds and Python native builds.
log "apt-get: system build dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  build-essential cmake pkg-config \
  libssl-dev zlib1g-dev libffi-dev \
  python3-venv python3-pip python3-dev \
  libarchive-tools

# 2. Scoped sudo drop-in — validate with visudo before installing so a typo can't lock out sudo.
log "install /etc/sudoers.d/orquester-pkg (validated, 0440 root:root)"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
sed "s/^orquester ALL=/$SERVICE_USER ALL=/" "$here/sudoers.d/orquester-pkg" > "$tmp"
visudo -cf "$tmp"
install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/orquester-pkg

# 3. User-space tools into the appdir, as the service user (-H => HOME=service user's home).
log "install user-space tools as $SERVICE_USER"
sudo -u "$SERVICE_USER" -H bash "$here/devtools-user.sh"

log "DONE. Activate the loosened systemd unit (NoNewPrivileges/ProtectSystem) with:"
echo "    systemctl daemon-reload && systemctl restart orquester"
log "Safe for live sessions: KillMode=process keeps the tmux server + sessions alive across restart."
