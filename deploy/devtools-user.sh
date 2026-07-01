#!/usr/bin/env bash
# Install user-space dev tools into the appdir ($HOME). No root required; the tools land in
# ~/.local/bin and ~/.cargo/bin, which are on session PATH, so every session inherits them.
# Idempotent and safe to re-run — from provisioning (via provision-devtools.sh) or directly
# from a session:  bash deploy/devtools-user.sh
set -euo pipefail

# Make the appdir toolchain resolvable regardless of how we were invoked (e.g. `sudo -u orquester`
# starts with a minimal PATH that omits ~/.cargo/bin).
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

log() { printf '\n[devtools-user] %s\n' "$*"; }

# uv (Astral): one tool for the whole Python story — `uv venv`, `uv pip`, `uv tool install <x>`
# (a pipx replacement, e.g. semgrep), and managed Python. Removes the ensurepip/pip/pipx/venv wall.
# INSTALLER_NO_MODIFY_PATH: don't rewrite shell profiles — ~/.local/bin is already on session PATH.
if command -v uv >/dev/null 2>&1; then
  log "uv already present: $(command -v uv)"
else
  log "installing uv -> ~/.local/bin"
  curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 sh
fi

# cargo-audit: needs cargo (not part of base provisioning) and possibly the Part-2 system deps
# (pkg-config, libssl-dev). Best-effort: never fail provisioning over a slow/absent Rust toolchain.
if command -v cargo-audit >/dev/null 2>&1; then
  log "cargo-audit already present: $(command -v cargo-audit)"
elif command -v cargo >/dev/null 2>&1; then
  log "installing cargo-audit via cargo install (compiles; may take a few minutes)"
  cargo install --locked cargo-audit || log "cargo-audit install failed (non-fatal); re-run later"
else
  log "cargo not found (no Rust toolchain); skipping cargo-audit"
fi

log "done."
