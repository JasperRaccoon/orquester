#!/usr/bin/env bash
# Install the pinned voxl, the optional H.264 streamer desktop tabs use when they can (spec
# docs/superpowers/specs/2026-11-10-desktop-agents-touch-voxl-design.md §5): its runtime libraries
# from apt, and the `voxl-server` crate built once per pinned version into
# /opt/orquester-tools/voxl/<version>/voxl (stripped), symlinked at /usr/local/bin/voxl. Idempotent:
# with the pinned version installed it only checks the runtime libraries. Run as root:
#
#     [sudo] bash deploy/install-voxl.sh
#
# remote-provision.sh and remote-update.sh run it best-effort: a failure only warns, and desktops
# stream with RFB/noVNC. To bump: set VOXL_VERSION (and RUST_SERIES if the new release needs a newer
# rustc); the next deploy builds it. voxl links x264 (GPL-2.0), so the binary is GPL: it is built on
# and used by this host only, never distributed.
set -euo pipefail

VOXL_VERSION=0.3.4
# Ubuntu's versioned toolchain (noble: cargo-1.85/rustc-1.85 = 1.85.1). voxl 0.3.4 with --locked needs
# rustc >= 1.85 (zeroize 1.9.1 uses edition 2024); the default apt rustc (1.75) is too old.
RUST_SERIES=1.85
TOOLS_ROOT=/opt/orquester-tools/voxl
VOXL_DIR="$TOOLS_ROOT/$VOXL_VERSION"
VOXL_BIN="$VOXL_DIR/voxl"
VOXL_LINK=/usr/local/bin/voxl
# The build runs unprivileged (a crate's build script is code): this account, with its own temp dir.
BUILD_USER="${VOXL_BUILD_USER:-nobody}"

# The binary's direct NEEDED libraries (beside libc/libm/libgcc_s).
RUNTIME_PACKAGES=(libx264-164 libyuv0 libopus0 libpulse0)
BUILD_PACKAGES=(
  ca-certificates build-essential pkg-config clang libclang-dev
  libx264-dev libyuv-dev libopus-dev libpulse-dev libxcb1-dev esbuild
  "cargo-$RUST_SERIES" "rustc-$RUST_SERIES"
)

log() { printf '[install-voxl] %s\n' "$*"; }
fail() { printf '[install-voxl] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"
command -v apt-get >/dev/null 2>&1 || fail "apt-get not found (Ubuntu/Debian only)"
id "$BUILD_USER" >/dev/null 2>&1 || fail "user $BUILD_USER does not exist (set VOXL_BUILD_USER)"
export DEBIAN_FRONTEND=noninteractive

missing_packages() {
  local pkg
  for pkg in "$@"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || printf '%s\n' "$pkg"
  done
}

# Quiet unless it fails (then its output's tail); refreshes the package lists once on a failure.
apt_install() {
  local out
  out="$(mktemp)"
  if ! apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=600 "$@" >"$out" 2>&1; then
    apt-get update -qq -o DPkg::Lock::Timeout=600 >/dev/null 2>&1 || true
    if ! apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=600 "$@" >"$out" 2>&1; then
      tail -n 15 "$out" >&2
      rm -f "$out"
      return 1
    fi
  fi
  rm -f "$out"
}

installed_version() { # <bin>: the version it prints (run unprivileged), or nothing
  # A binary that does not run prints nothing: never a failure here (set -e, pipefail), so the
  # caller's `fail` says why.
  runuser -u "$BUILD_USER" -- "$1" --version 2>/dev/null </dev/null | sed -n 's/^voxl \([^[:space:]]*\)$/\1/p' | head -n1 || true
}

mapfile -t need < <(missing_packages "${RUNTIME_PACKAGES[@]}")
if [ "${#need[@]}" -gt 0 ]; then
  log "runtime libraries: ${need[*]}"
  apt_install "${need[@]}" || fail "could not install the runtime libraries (${need[*]})"
fi

if [ -x "$VOXL_BIN" ] && [ "$(installed_version "$VOXL_BIN")" = "$VOXL_VERSION" ]; then
  log "voxl $VOXL_VERSION already installed at $VOXL_BIN"
else
  mapfile -t need < <(missing_packages "${BUILD_PACKAGES[@]}")
  if [ "${#need[@]}" -gt 0 ]; then
    log "build dependencies: ${need[*]}"
    apt_install "${need[@]}" || fail "could not install the build dependencies (${need[*]})"
  fi
  rust_bin="/usr/lib/rust-$RUST_SERIES/bin"
  [ -x "$rust_bin/cargo" ] || fail "$rust_bin/cargo not found after installing cargo-$RUST_SERIES"

  mkdir -p "$TOOLS_ROOT"
  work="$(mktemp -d "$TOOLS_ROOT/.build.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  chmod 0755 "$work"
  mkdir "$work/build"
  chown "$BUILD_USER" "$work/build"
  log "building voxl-server $VOXL_VERSION (rustc $("$rust_bin/rustc" --version | cut -d' ' -f2)); the first build takes several minutes"
  started=$SECONDS
  # crates.io's index checksums every crate; --locked builds the published Cargo.lock as is.
  if ! runuser -u "$BUILD_USER" -- env -i \
      PATH="$rust_bin:/usr/local/bin:/usr/bin:/bin" HOME="$work/build" LANG=C.UTF-8 \
      CARGO_HOME="$work/build/cargo-home" CARGO_TARGET_DIR="$work/build/target" \
      nice -n 10 "$rust_bin/cargo" install voxl-server --version "=$VOXL_VERSION" --locked \
        --root "$work/build/root" --quiet </dev/null >"$work/build.log" 2>&1; then
    tail -n 25 "$work/build.log" >&2
    fail "cargo install voxl-server $VOXL_VERSION failed"
  fi
  built="$work/build/root/bin/voxl"
  [ "$(installed_version "$built")" = "$VOXL_VERSION" ] || fail "the built binary does not report voxl $VOXL_VERSION"
  install -d -m 0755 "$VOXL_DIR"
  # Stripped: 38 MB → 6 MB (the release profile keeps debug info), and VMs get a copy of it.
  install -m 0755 -s "$built" "$VOXL_BIN.new"
  mv -f "$VOXL_BIN.new" "$VOXL_BIN"
  log "built in $((SECONDS - started)) s"
fi

# Only manage the PATH symlink when it is absent or already ours; never clobber another voxl.
if [ ! -e "$VOXL_LINK" ] && [ ! -L "$VOXL_LINK" ]; then
  ln -s "$VOXL_BIN" "$VOXL_LINK"
elif [ -L "$VOXL_LINK" ] && [[ "$(readlink "$VOXL_LINK")" == "$TOOLS_ROOT/"* ]]; then
  ln -sfn "$VOXL_BIN" "$VOXL_LINK"
elif [ "$(readlink "$VOXL_LINK" 2>/dev/null || true)" != "$VOXL_BIN" ]; then
  log "WARNING: $VOXL_LINK is not a symlink into $TOOLS_ROOT — leaving it (set ORQUESTER_VOXL_BIN=$VOXL_BIN for the daemon)"
fi

version="$(installed_version "$VOXL_BIN")"
[ "$version" = "$VOXL_VERSION" ] || fail "$VOXL_BIN does not run (missing libraries?)"
log "voxl $version at $VOXL_BIN"
