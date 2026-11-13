#!/usr/bin/env bash
# Install the pinned gdu, the disk scanner behind Settings → Host status → Storage (spec
# docs/superpowers/specs/2026-11-13-host-storage-treemap-design.md §1): the official release binary,
# verified against its pinned sha256, at /opt/orquester-tools/gdu/<version>/gdu, symlinked at
# /usr/local/bin/gdu. Idempotent: does nothing when the pinned version is already installed. Run as
# root:
#
#     [sudo] bash deploy/install-gdu.sh
#
# remote-provision.sh and remote-update.sh run it best-effort: a failure only warns, and the Storage
# view shows how to install the scanner. To bump: set GDU_VERSION and BOTH sha256 values from the
# release's sha256sums.txt (https://github.com/dundee/gdu/releases, the gdu_linux_amd64_static.tgz
# and gdu_linux_arm64.tgz entries).
set -euo pipefail

GDU_VERSION=v5.39.0
GDU_SHA256_AMD64=7e1036cba1696ecceda40ff79dacd43db9c157fa137ea5d50e4a198b047418a1
GDU_SHA256_ARM64=95900a16b9f9dad97f975b667644ddc073a1b377e95a0b4dfdf50045bf556ad0
TOOLS_ROOT=/opt/orquester-tools/gdu
GDU_DIR="$TOOLS_ROOT/$GDU_VERSION"
GDU_BIN="$GDU_DIR/gdu"
GDU_LINK=/usr/local/bin/gdu

log() { printf '[install-gdu] %s\n' "$*"; }
fail() { printf '[install-gdu] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"

case "$(uname -m)" in
  x86_64|amd64)  asset=gdu_linux_amd64_static.tgz; sha="$GDU_SHA256_AMD64" ;;
  aarch64|arm64) asset=gdu_linux_arm64.tgz; sha="$GDU_SHA256_ARM64" ;;
  *) fail "unsupported architecture $(uname -m) (gdu is installed for x86_64 and aarch64 only)" ;;
esac
# The tarball holds one file named after it: gdu_linux_amd64_static, gdu_linux_arm64.
member="${asset%.tgz}"

installed_version() { # <bin>: the version it prints ("Version:<tab> v5.39.0"), or nothing
  # A binary that does not run prints nothing: never a failure here (set -e, pipefail), so the
  # caller's `fail` says why.
  "$1" --version 2>/dev/null </dev/null | sed -n 's/^Version:[[:space:]]*\([^[:space:]]*\)$/\1/p' | head -n1 || true
}

if [ -x "$GDU_BIN" ] && [ "$(installed_version "$GDU_BIN")" = "$GDU_VERSION" ]; then
  log "gdu $GDU_VERSION already installed at $GDU_BIN"
else
  log "installing gdu $GDU_VERSION ($asset) -> $GDU_BIN"
  mkdir -p "$TOOLS_ROOT"
  # Work under TOOLS_ROOT (same filesystem) so the final step is a rename, never a half-written binary.
  work="$(mktemp -d "$TOOLS_ROOT/.install.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  tarball="$work/$asset"
  curl -fsSL --retry 3 -o "$tarball" "https://github.com/dundee/gdu/releases/download/$GDU_VERSION/$asset" \
    || fail "could not download $asset ($GDU_VERSION)"
  printf '%s  %s\n' "$sha" "$tarball" | sha256sum -c --quiet - \
    || fail "sha256 mismatch for $asset ($GDU_VERSION) — not installing"
  mkdir "$work/extract"
  tar -C "$work/extract" --no-same-owner -xzf "$tarball" "$member" \
    || fail "$asset has no $member — not installing"
  extracted="$work/extract/$member"
  if [ ! -f "$extracted" ] || [ -L "$extracted" ]; then
    fail "$member in $asset is not a regular file — not installing"
  fi
  chmod 0755 "$extracted"
  [ "$(installed_version "$extracted")" = "$GDU_VERSION" ] \
    || fail "the downloaded binary does not report gdu $GDU_VERSION — not installing"
  install -d -m 0755 -o root -g root "$GDU_DIR"
  install -m 0755 -o root -g root "$extracted" "$GDU_BIN.new"
  mv -f "$GDU_BIN.new" "$GDU_BIN"
fi

# Only manage the PATH symlink when it is absent or already ours; never clobber another gdu.
if [ ! -e "$GDU_LINK" ] && [ ! -L "$GDU_LINK" ]; then
  ln -s "$GDU_BIN" "$GDU_LINK"
elif [ -L "$GDU_LINK" ] && [[ "$(readlink "$GDU_LINK")" == "$TOOLS_ROOT/"* ]]; then
  ln -sfn "$GDU_BIN" "$GDU_LINK"
elif [ "$(readlink "$GDU_LINK" 2>/dev/null || true)" != "$GDU_BIN" ]; then
  log "WARNING: $GDU_LINK is not a symlink into $TOOLS_ROOT — leaving it (the daemon also finds gdu at <appdir>/bin/gdu)"
fi

version="$(installed_version "$GDU_BIN")"
[ "$version" = "$GDU_VERSION" ] || fail "$GDU_BIN does not run"
log "gdu $version at $GDU_BIN"
