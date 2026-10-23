#!/usr/bin/env bash
# Install the daemon's systemd unit and its needrestart exclusion from this checkout. Idempotent:
# a file already up to date is left alone, and `systemctl daemon-reload` runs only when the unit
# changed. It never starts, stops or restarts anything — the caller's own restart picks the unit
# up. Run as root from the checkout root:
#
#     [sudo] bash deploy/install-unit.sh
#
# remote-provision.sh and remote-update.sh run it before they (re)start orquester.
#
# - /etc/systemd/system/orquester.service ← deploy/orquester.service (OOMPolicy=continue: one
#   OOM-killed agent process must not stop the whole unit).
# - /etc/needrestart/conf.d/orquester.conf: needrestart (Ubuntu's apt hook) must never restart
#   orquester.service after a library upgrade — an unattended upgrade would otherwise restart the
#   daemon behind the deploy's drain. Validated with `perl -c` before it is moved into place.
# - /etc/tmpfiles.d/orquester.conf ← deploy/orquester-tmpfiles.conf: the daily
#   systemd-tmpfiles-clean run ages out tsx transpile-cache entries under the service's TMPDIR.
set -euo pipefail

UNIT_SRC=deploy/orquester.service
UNIT_DST=/etc/systemd/system/orquester.service
NEEDRESTART_DIR=/etc/needrestart/conf.d
NEEDRESTART_DST="$NEEDRESTART_DIR/orquester.conf"
TMPFILES_SRC=deploy/orquester-tmpfiles.conf
TMPFILES_DST=/etc/tmpfiles.d/orquester.conf

log() { printf '[install-unit] %s\n' "$*"; }
fail() { printf '[install-unit] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"
[ -f "$UNIT_SRC" ] || fail "run from the checkout root ($UNIT_SRC not found)"

if [ -f "$UNIT_DST" ] && cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  log "unit already up to date"
else
  install -m 0644 "$UNIT_SRC" "$UNIT_DST"
  systemctl daemon-reload
  log "unit installed; systemd reloaded (applies at the next start of orquester)"
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
