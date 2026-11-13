#!/usr/bin/env bash
# Install the daemon's systemd units and its needrestart exclusion from this checkout. Idempotent:
# a file already up to date is left alone, and one `systemctl daemon-reload` runs only when a unit
# changed. It never starts, stops or restarts the daemon or the update service — the caller's own
# restart picks the daemon's unit up; it only enables and starts the self-update path unit. Run as
# root from the checkout root:
#
#     [sudo] bash deploy/install-unit.sh
#
# remote-provision.sh and remote-update.sh run it before they (re)start orquester.
#
# - /etc/systemd/system/orquester.service ← deploy/orquester.service (OOMPolicy=continue: one
#   OOM-killed agent process must not stop the whole unit).
# - /etc/systemd/system/orquester-update.{service,path} ← deploy/orquester-update.{service,path}:
#   self-update. The path unit (enabled and started here) starts the root oneshot service when the
#   daemon creates /var/lib/orquester/daemon/update-request; the service runs deploy/lib/self-update.sh.
#   Refs without them (old rollbacks) leave installed ones in place.
# - /etc/needrestart/conf.d/orquester.conf: needrestart (Ubuntu's apt hook) must never restart
#   orquester.service after a library upgrade — an unattended upgrade would otherwise restart the
#   daemon behind the deploy's drain. Validated with `perl -c` before it is moved into place.
# - /etc/tmpfiles.d/orquester.conf ← deploy/orquester-tmpfiles.conf: the daily
#   systemd-tmpfiles-clean run ages out tsx transpile-cache entries under the service's TMPDIR.
# - /etc/sysctl.d/99-orquester.conf ← deploy/orquester-sysctl.conf: BBR congestion control and a
#   larger TCP send buffer limit, set now and at every boot. Nothing needs a restart.
set -euo pipefail

UNIT_SRC=deploy/orquester.service
UNIT_DST=/etc/systemd/system/orquester.service
UPDATE_SERVICE_SRC=deploy/orquester-update.service
UPDATE_SERVICE_DST=/etc/systemd/system/orquester-update.service
UPDATE_PATH_SRC=deploy/orquester-update.path
UPDATE_PATH_DST=/etc/systemd/system/orquester-update.path
NEEDRESTART_DIR=/etc/needrestart/conf.d
NEEDRESTART_DST="$NEEDRESTART_DIR/orquester.conf"
TMPFILES_SRC=deploy/orquester-tmpfiles.conf
TMPFILES_DST=/etc/tmpfiles.d/orquester.conf
SYSCTL_SRC=deploy/orquester-sysctl.conf
SYSCTL_DST=/etc/sysctl.d/99-orquester.conf

log() { printf '[install-unit] %s\n' "$*"; }
fail() { printf '[install-unit] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"
[ -f "$UNIT_SRC" ] || fail "run from the checkout root ($UNIT_SRC not found)"

units_changed=0
install_unit() { # <src> <dst>
  if [ -f "$2" ] && cmp -s "$1" "$2"; then
    log "$(basename "$2") already up to date"
  else
    install -m 0644 "$1" "$2"
    units_changed=1
    log "$(basename "$2") installed"
  fi
}
install_unit "$UNIT_SRC" "$UNIT_DST"
self_update=0
if [ -f "$UPDATE_SERVICE_SRC" ] && [ -f "$UPDATE_PATH_SRC" ]; then
  install_unit "$UPDATE_SERVICE_SRC" "$UPDATE_SERVICE_DST"
  install_unit "$UPDATE_PATH_SRC" "$UPDATE_PATH_DST"
  self_update=1
fi
if [ "$units_changed" -eq 1 ]; then
  systemctl daemon-reload
  log "systemd reloaded (a changed orquester.service applies at the next start of orquester)"
fi
# Idempotent; the update service itself is only ever started by the path unit. Self-update is
# optional, so a failure here warns instead of failing the deploy.
if [ "$self_update" -eq 1 ]; then
  if systemctl enable --now orquester-update.path; then
    log "self-update path unit enabled and active"
  else
    log "WARNING: could not enable orquester-update.path; self-update will not start"
  fi
fi

conf="$(mktemp)"
trap 'rm -f "$conf"' EXIT
cat > "$conf" <<'EOF'
# Installed by deploy/install-unit.sh: never restart the Orquester daemon from needrestart.
$nrconf{override_rc}{qr(^orquester\.service$)} = 0;
EOF
perl -c "$conf" >/dev/null 2>&1 || fail "the needrestart exclusion does not compile (perl -c)"
if [ -f "$NEEDRESTART_DST" ] && cmp -s "$conf" "$NEEDRESTART_DST"; then
  log "needrestart exclusion already up to date"
else
  mkdir -p "$NEEDRESTART_DIR"
  install -m 0644 "$conf" "$NEEDRESTART_DST"
  log "needrestart exclusion installed: $NEEDRESTART_DST"
fi

# Refs from before the rule existed (old rollbacks) leave an installed one in place.
if [ -f "$TMPFILES_SRC" ]; then
  if [ -f "$TMPFILES_DST" ] && cmp -s "$TMPFILES_SRC" "$TMPFILES_DST"; then
    log "tmpfiles rule already up to date"
  else
    mkdir -p "$(dirname "$TMPFILES_DST")"
    install -m 0644 "$TMPFILES_SRC" "$TMPFILES_DST"
    log "tmpfiles rule installed: $TMPFILES_DST (applied by the daily systemd-tmpfiles-clean run)"
  fi
fi

# A kernel or container that can't set it keeps its own default: slower long-distance transfers are
# no reason to fail a deploy, so the file is installed only once the setting has been accepted.
if [ -f "$SYSCTL_SRC" ]; then
  if ! sysctl -q -p "$SYSCTL_SRC" >/dev/null 2>&1; then
    log "this host did not accept $SYSCTL_SRC; not installing it"
  elif [ -f "$SYSCTL_DST" ] && cmp -s "$SYSCTL_SRC" "$SYSCTL_DST"; then
    log "sysctl settings already up to date"
  else
    install -m 0644 "$SYSCTL_SRC" "$SYSCTL_DST"
    log "sysctl settings installed: $SYSCTL_DST"
  fi
fi
