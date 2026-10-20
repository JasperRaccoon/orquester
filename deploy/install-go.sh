#!/usr/bin/env bash
# Install the pinned Go toolchain that builds orq-agent (apps/box-agent) into /usr/local/go,
# plus a /usr/local/bin/go symlink so `go` on PATH resolves to it. Idempotent: does nothing
# when the pinned version is already installed. Run as root:
#
#     [sudo] bash deploy/install-go.sh
#
# remote-provision.sh and remote-update.sh run it before building apps/box-agent.
# To bump: set GO_VERSION and BOTH sha256 values from https://go.dev/dl/?mode=json (the
# linux-amd64 and linux-arm64 "archive" entries). apps/box-agent/go.mod's `go` line is the floor.
set -euo pipefail

GO_VERSION=1.27.3
GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
GO_ROOT=/usr/local/go
GO_LINK=/usr/local/bin/go

log() { printf '[install-go] %s\n' "$*"; }
fail() { printf '[install-go] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root (use sudo)"

case "$(uname -m)" in
  x86_64|amd64)  arch=amd64; sha="$GO_SHA256_AMD64" ;;
  aarch64|arm64) arch=arm64; sha="$GO_SHA256_ARM64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

current="$(head -n1 "$GO_ROOT/VERSION" 2>/dev/null || true)"
if [ "$current" = "go$GO_VERSION" ] && [ -x "$GO_ROOT/bin/go" ]; then
  log "go$GO_VERSION already installed at $GO_ROOT"
else
  log "installing go$GO_VERSION (linux-$arch) -> $GO_ROOT${current:+ (replacing $current)}"
  # Work next to GO_ROOT (same filesystem) so the final swap is two renames, never a
  # half-extracted GOROOT that a concurrent on-demand daemon build could pick up.
  work="$(mktemp -d /usr/local/.go-install.XXXXXX)"
  trap 'rm -rf "$work"' EXIT
  tarball="$work/go.tar.gz"
  curl -fsSL --retry 3 -o "$tarball" "https://go.dev/dl/go$GO_VERSION.linux-$arch.tar.gz"
  printf '%s  %s\n' "$sha" "$tarball" | sha256sum -c --quiet - \
    || fail "sha256 mismatch for go$GO_VERSION.linux-$arch.tar.gz — not installing"
  tar -C "$work" -xzf "$tarball"
  [ "$(head -n1 "$work/go/VERSION" 2>/dev/null)" = "go$GO_VERSION" ] \
    || fail "extracted tree is not go$GO_VERSION — not installing"
  if [ -e "$GO_ROOT" ]; then mv "$GO_ROOT" "$work/go.old"; fi
  if ! mv "$work/go" "$GO_ROOT"; then
    if [ -e "$work/go.old" ]; then mv "$work/go.old" "$GO_ROOT"; fi
    fail "could not move the new toolchain into $GO_ROOT"
  fi
fi

# Only manage the PATH symlink when it is absent or already ours; never clobber another Go.
if [ ! -e "$GO_LINK" ] && [ ! -L "$GO_LINK" ]; then
  ln -s "$GO_ROOT/bin/go" "$GO_LINK"
elif [ "$(readlink "$GO_LINK" 2>/dev/null || true)" != "$GO_ROOT/bin/go" ]; then
  log "WARNING: $GO_LINK is not a symlink to $GO_ROOT/bin/go — leaving it (the service uses GO=$GO_ROOT/bin/go)"
fi

log "$("$GO_ROOT/bin/go" version)"
