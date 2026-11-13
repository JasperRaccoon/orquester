#!/usr/bin/env bash
# orq-release-layout: 1
# (The line above marks this script as layout-aware. An update hands over only to a release's
# remote-update.sh that has that exact line; an older release is deployed by this script itself.)
#
# Runs ON the VPS: delivered by ./deploy.sh via scp (never `bash -s`), or as root from
# orquester-update.service (self-update; no ssh session, SUDO unset). One directory per release
# (docs/superpowers/specs/2026-11-13-staged-release-updates-design.md):
#   $RELEASES_DIR/repo.git    the shared git dir; the update lock (orq-deploy.lock) and the last
#                             successful deploy (orq-last-deployed-head) live here
#   $RELEASES_DIR/<sha12>/    one release: a linked worktree of repo.git at that commit, complete once
#                             it has .orq-release-complete (written last, holding the full sha)
#   $REPO_DIR                 a symlink to the live release
#   $PREVIOUS_LINK            a symlink to the release that was live before it (may be absent)
# Update cycle: lock -> fetch -> the target release: a complete one is reused as is; otherwise it is
# built in a fresh worktree beside the live one (pnpm install -> SPA build -> Go + orq-agent
# (best-effort) -> voxl + gdu (best-effort) -> native-module guard -> chown -> completion marker)
# -> warm-up (best-effort) -> version stamp -> public URL + units -> switch the link -> restart ->
# health. Nothing the running daemon uses is touched before the switch, so a failed build changes
# nothing. If the new release never turns healthy, the link flips back to the previous release (no
# rebuild), which is restarted and health-checked, and the deploy still fails. After a healthy
# deploy of a layout-aware release, its update scripts go to $RELEASES_DIR/tooling (what self-update
# runs), and releases no longer needed are deleted (prune_releases). A plain checkout at $REPO_DIR (a
# real directory with .git/, from before releases) is converted on the way (see "Conversion").
# Inputs via env:
#   SUDO          "" or "sudo" — prefix for privileged commands (git/pnpm/node/chown/systemctl)
#   BRANCH        branch to deploy (default main)
#   RESET_REF     ref to deploy (default origin/$BRANCH; rollback passes a sha)
#   DOMAIN        the target's public domain (optional): adds ORQUESTER_PUBLIC_URL=https://$DOMAIN
#                 to /etc/orquester/daemon.env when it has none
#   HEALTH_WAIT   seconds the health check retries for after a restart (default 600)
#   AUTO_REVERT   1 (default) rolls a release that fails its health check back; 0 leaves it
#   RELEASE_MIN_FREE_MB  free space (MB) the releases volume must have before a build (default 4096)
#   WARM_TIMEOUT  seconds the warm-up may take before it is stopped (default 600)
#   ENV_FILE, REPO_DIR, RELEASES_DIR, PREVIOUS_LINK, NODE_BIN, HEALTH_URL, PROC_ROOT
#                 for local testing only (defaults /etc/orquester/daemon.env, /opt/orquester,
#                 /opt/orquester-releases, /opt/orquester-previous, /usr/bin/node,
#                 http://127.0.0.1:47831/health, /proc)
# Once the target's worktree exists (before its build), a target whose own layout-aware
# deploy/lib/remote-update.sh differs from this one runs the rest of the update with it (a copy in
# $TMPDIR, exec'd once), so a step a release adds runs on the update that delivers it. The
# handed-over run keeps this run's locks (fd 9, and fd 8 during a conversion), the live release's
# commit and the commit to deploy (ORQ_UPDATE_*; ORQ_UPDATE_LAYOUT=1 says the sender is
# layout-aware — a script from before releases hands over without it, after resetting the plain
# checkout in place).
# Exit codes: 0 deployed; 1 failed before or without a revert; 3 the new release
# failed its health check and the previous one was restored (running, healthy);
# 4 the previous one failed to come back too (the daemon is DOWN); 5 another update
# (./deploy.sh or the self-update unit) is running on this host — nothing was touched.
set -euo pipefail
trap 'echo "[remote-update] FAILED at line $LINENO" >&2' ERR

SUDO="${SUDO:-}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/orquester}"
RELEASES_DIR="$(readlink -m -- "${RELEASES_DIR:-/opt/orquester-releases}")"
PREVIOUS_LINK="${PREVIOUS_LINK:-/opt/orquester-previous}"
RESET_REF="${RESET_REF:-origin/$BRANCH}"
DOMAIN="${DOMAIN:-}"
ENV_FILE="${ENV_FILE:-/etc/orquester/daemon.env}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:47831/health}"
# A loaded host can take minutes to bring the daemon up — the first start after a large update
# compiles every new module (tsx's cache is cold); 3 min was seen on a busy host.
HEALTH_WAIT="${HEALTH_WAIT:-600}"
AUTO_REVERT="${AUTO_REVERT:-1}"
PROC_ROOT="${PROC_ROOT:-/proc}"
# A release's own files are ~100 MB plus node_modules (1.6 GB as counted by du, mostly hard links
# into the pnpm store); the margin also keeps room for the daemon's own data on the same volume.
RELEASE_MIN_FREE_MB="${RELEASE_MIN_FREE_MB:-4096}"
WARM_TIMEOUT="${WARM_TIMEOUT:-600}"
SHARED_GIT="$RELEASES_DIR/repo.git"
LAYOUT_MARKER='# orq-release-layout: 1'
COMPLETE_FILE=".orq-release-complete"
# Read by the daemon for GET /api/info when the tree has no .git (apps/daemon/src/build-info.ts).
STAMP_FILE=".orquester-version.json"

say() { echo "[remote-update] $*"; }
warn() { echo "[remote-update] $*" >&2; }
g() { $SUDO git --git-dir="$SHARED_GIT" "$@"; }

is_plain_checkout() { [ -d "$REPO_DIR" ] && [ ! -L "$REPO_DIR" ] && [ -d "$REPO_DIR/.git" ]; }
is_complete() { [ "$($SUDO cat -- "$1/$COMPLETE_FILE" 2>/dev/null || true)" = "$2" ]; } # <dir> <sha>
is_layout_aware() { [ -f "$1/deploy/lib/remote-update.sh" ] && grep -qxF -- "$LAYOUT_MARKER" "$1/deploy/lib/remote-update.sh"; }
release_id_ok() { [[ "$1" =~ ^[0-9a-f]{12}$ ]]; }

mark_complete() { # <dir> <sha>: written last, atomically
  printf '%s\n' "$2" | $SUDO tee "$1/$COMPLETE_FILE.tmp" >/dev/null \
    && $SUDO mv -f -- "$1/$COMPLETE_FILE.tmp" "$1/$COMPLETE_FILE"
}

link_to() { # <link> <target>: atomic replacement (a temp link renamed over the old one)
  $SUDO ln -sfn -- "$2" "$1.orq-new" && $SUDO mv -T -- "$1.orq-new" "$1"
}

stamp_commit_of() { # <dir>: the commit in its version stamp, or nothing
  sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$1/$STAMP_FILE" 2>/dev/null | head -n1 || true
}

tree_version() { # <dir>: its package.json's version (no node: it may be the thing that is broken)
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -n1
}

# check_disk <extra KB>: refuse (exit 1, nothing changed) when the releases volume has less than
# RELEASE_MIN_FREE_MB plus that free.
check_disk() {
  local at="$RELEASES_DIR" avail need
  while [ ! -d "$at" ]; do at="$(dirname -- "$at")"; done
  avail="$(df -Pk -- "$at" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)"
  if ! [[ "$avail" =~ ^[0-9]+$ ]]; then
    warn "WARNING: could not read the free space on $at; building anyway."
    return 0
  fi
  need=$((RELEASE_MIN_FREE_MB * 1024 + $1))
  if [ "$avail" -lt "$need" ]; then
    warn "not enough disk space for a new release: $((avail / 1024)) MB free on $at, $((need / 1024)) MB needed (RELEASE_MIN_FREE_MB=$RELEASE_MIN_FREE_MB)."
    warn "Nothing was changed; the running daemon keeps its release. Free space there (old releases in $RELEASES_DIR that no process uses can go) and deploy again."
    exit 1
  fi
}

# take_lock <lock file> <fd 8|9>: an flock held through that descriptor until this script exits.
# The lock files live in root-owned git dirs (no one else can plant a file there); they are opened
# read-only (0644 whatever the umask), which is enough for flock, so a non-root deploy user
# (SUDO=sudo) can hold them too. Returns 1 when it cannot (no flock — not Linux — or a file the
# deploy user cannot read): the update then runs unlocked with a warning rather than not at all.
# Exits 5 when another update holds it. Commands that may leave a process behind (git's detached
# auto-gc, the warm-up) get fds 8 and 9 closed.
take_lock() {
  command -v flock >/dev/null 2>&1 || return 1
  [ -e "$1" ] || $SUDO install -m 0644 /dev/null "$1" 2>/dev/null || true
  [ -r "$1" ] || $SUDO chmod 0644 "$1" 2>/dev/null || true
  if [ "$2" = 8 ]; then
    { exec 8<"$1"; } 2>/dev/null || return 1
  else
    { exec 9<"$1"; } 2>/dev/null || return 1
  fi
  flock -n "$2" && return 0
  warn "another update is running on $REPO_DIR (./deploy.sh or the self-update unit) — try again when it ends."
  exit 5
}

# ---------- Conversion of a plain checkout ----------
# A plain checkout at $REPO_DIR becomes the release of its HEAD without a rebuild. Every step is
# idempotent, and each partial state is told apart from the filesystem when a run is interrupted:
#   1. (under the checkout's own lock, .git/orq-deploy.lock, which updaters from before releases
#      take) copy its .git to repo.git.tmp, make it bare, rename it to repo.git. A leftover
#      repo.git.tmp is a copy that never finished: it is deleted and the copy redone. Then the
#      shared lock in repo.git is taken as well; both are held to the end.
#   2. Each run while $REPO_DIR is still a plain checkout: carry orq-last-deployed-head over from its
#      .git (an old-style updater may have written it since), make sure repo.git has its HEAD
#      commit, register it in repo.git as the linked worktree $RELEASES_DIR/<sha12> (locked, so no
#      prune drops it while that path does not exist yet) and write its completion marker — unless
#      its version stamp names another commit (an in-place update stopped after its reset: then
#      the tree is not a complete build of HEAD and is rebuilt in place if it is deployed again).
#   3. Fetch, build the target in its own worktree — the plain checkout and the daemon stay as they
#      are — and hand over to the target's script if it is layout-aware.
#   4. At the switch, back to back right before the restart: a temp link to the target, `mv
#      $REPO_DIR $RELEASES_DIR/<sha12>`, the temp link renamed to $REPO_DIR. A run that finds
#      $REPO_DIR missing was interrupted between the two renames: it links the release that still
#      has its own .git directory back first.
#   5. De-git that release (degit_release): .git -> .git-pre-layout, the worktree record refreshed
#      (index included), a .git file naming it, the lock dropped, .git-pre-layout deleted. Any run
#      that finds a release with a .git directory or a .git-pre-layout finishes this first.

convert_git_dir() {
  local tmp="$SHARED_GIT.tmp" need_kb
  need_kb="$($SUDO du -sk -- "$REPO_DIR/.git" | awk '{ print $1 }')"
  check_disk "$need_kb"
  say "converting $REPO_DIR to releases: its git dir becomes $SHARED_GIT"
  $SUDO mkdir -p -- "$RELEASES_DIR"
  $SUDO rm -rf -- "$tmp"
  $SUDO cp -a -- "$REPO_DIR/.git" "$tmp"
  $SUDO git --git-dir="$tmp" config --bool core.bare true
  $SUDO rm -f -- "$tmp/index"
  $SUDO mv -T -- "$tmp" "$SHARED_GIT"
}

register_worktree() { # <release dir> <sha> [index]: repo.git's record of a linked worktree there
  local adm
  adm="$SHARED_GIT/worktrees/$(basename -- "$1")"
  $SUDO mkdir -p -- "$adm"
  printf '%s\n' "$2" | $SUDO tee "$adm/HEAD" >/dev/null
  printf '../..\n' | $SUDO tee "$adm/commondir" >/dev/null
  printf '%s\n' "$1/.git" | $SUDO tee "$adm/gitdir" >/dev/null
  if [ -n "${3:-}" ] && $SUDO test -f "$3"; then $SUDO cp -- "$3" "$adm/index"; fi
}

prepare_conversion() { # sets conv_sha, conv_id
  local stamped
  conv_sha="$($SUDO git -C "$REPO_DIR" rev-parse HEAD)"
  conv_id="${conv_sha:0:12}"
  if $SUDO test -f "$REPO_DIR/.git/orq-last-deployed-head"; then
    $SUDO cp -- "$REPO_DIR/.git/orq-last-deployed-head" "$SHARED_GIT/orq-last-deployed-head"
  fi
  g cat-file -e "$conv_sha^{commit}" 2>/dev/null || g fetch -q "$REPO_DIR" HEAD 9<&- 8<&-
  register_worktree "$RELEASES_DIR/$conv_id" "$conv_sha" "$REPO_DIR/.git/index"
  printf 'being converted from the plain checkout %s\n' "$REPO_DIR" | $SUDO tee "$SHARED_GIT/worktrees/$conv_id/locked" >/dev/null
  if ! is_complete "$REPO_DIR" "$conv_sha"; then
    stamped="$(stamp_commit_of "$REPO_DIR")"
    if [ ! -f "$REPO_DIR/$STAMP_FILE" ] || [ "$stamped" = "$conv_sha" ]; then
      mark_complete "$REPO_DIR" "$conv_sha"
    else
      warn "WARNING: $REPO_DIR is at ${conv_sha:0:7} but was last deployed as ${stamped:0:7} (an in-place update stopped after its reset):"
      warn "         it is not taken as a complete release, and is rebuilt in place if ${conv_sha:0:7} is deployed."
    fi
  fi
}

degit_release() { # <release dir>: its own .git directory -> a link to the shared one (step 5)
  local dir="$1" old="$1/.git-pre-layout" id sha
  id="$(basename -- "$dir")"
  if [ -d "$dir/.git" ] && [ ! -L "$dir/.git" ]; then
    $SUDO mv -T -- "$dir/.git" "$old"
  fi
  if [ ! -e "$dir/.git" ]; then
    sha="$($SUDO git --git-dir="$old" rev-parse HEAD)"
    register_worktree "$dir" "$sha" "$old/index"
    printf 'gitdir: %s\n' "$SHARED_GIT/worktrees/$id" | $SUDO tee "$dir/.git.tmp" >/dev/null
    $SUDO mv -T -- "$dir/.git.tmp" "$dir/.git"
  fi
  $SUDO rm -f -- "$SHARED_GIT/worktrees/$id/locked"
  $SUDO rm -rf -- "$old"
  say "converted: $dir is a release of $SHARED_GIT"
}

finish_conversions() { # step 5 for any release an interrupted run left with its own git dir
  local d
  for d in "$RELEASES_DIR"/*; do
    release_id_ok "${d##*/}" || continue
    if { [ -d "$d/.git" ] && [ ! -L "$d/.git" ]; } || [ -d "$d/.git-pre-layout" ]; then degit_release "$d"; fi
  done
}

relink_missing_repo_dir() { # step 4 interrupted between its two renames
  local d
  if [ -e "$REPO_DIR" ] || [ -L "$REPO_DIR" ]; then return 0; fi
  for d in "$RELEASES_DIR"/*; do
    release_id_ok "${d##*/}" || continue
    if { [ -d "$d/.git" ] && [ ! -L "$d/.git" ]; } || [ -d "$d/.git-pre-layout" ]; then
      warn "$REPO_DIR is missing (a conversion stopped mid-switch): linking it to $d, the release that was live."
      link_to "$REPO_DIR" "$d"
      return 0
    fi
  done
  warn "$REPO_DIR does not exist and no release in $RELEASES_DIR was being converted — nothing to update."
  exit 1
}

# ---------- Locks ----------
cd /
handed_over="${ORQ_UPDATE_HANDOFF:-}"
# The copy is unlinked now; bash keeps reading it through its open descriptor.
[ -z "$handed_over" ] || rm -f -- "$handed_over"
from_layout_script=0
[ -z "$handed_over" ] || [ "${ORQ_UPDATE_LAYOUT:-}" != 1 ] || from_layout_script=1
lock_held=0
if [ "$from_layout_script" -eq 1 ]; then
  # Handed over by a layout-aware script: its locks came with the exec (the shared one on fd 9).
  lock_held="${ORQ_UPDATE_LOCK_HELD:-0}"
else
  old_lock=0
  if [ -n "$handed_over" ] && [ "${ORQ_UPDATE_LOCK_HELD:-0}" = 1 ] && { exec 8<&9 9<&-; } 2>/dev/null; then
    # Handed over by a script from before releases: its lock — the plain checkout's — came on fd 9.
    old_lock=1
  fi
  if is_plain_checkout; then
    [ "$old_lock" -eq 1 ] || take_lock "$REPO_DIR/.git/orq-deploy.lock" 8 || true
    [ -d "$SHARED_GIT" ] || convert_git_dir
  fi
  if [ ! -d "$SHARED_GIT" ]; then
    warn "$REPO_DIR is neither a plain checkout nor a link into $RELEASES_DIR (no $SHARED_GIT) — nothing to update."
    exit 1
  fi
  if take_lock "$SHARED_GIT/orq-deploy.lock" 9; then lock_held=1; fi
fi
[ "$lock_held" -eq 1 ] || echo "[remote-update] WARNING: running without the update lock (no flock, or $SHARED_GIT/orq-deploy.lock unreadable)." >&2

# ---------- The live release ----------
relink_missing_repo_dir
if [ -n "$handed_over" ] && [ "$from_layout_script" -eq 0 ] && [ -n "${ORQ_UPDATE_OLD_HEAD:-}" ]; then
  # A script from before releases reset the live tree in place to the target before it handed over.
  # Its build products still belong to the commit it was at: put that back, build the target beside it.
  if is_plain_checkout; then reset_dir="$REPO_DIR"; else reset_dir="$(readlink -f -- "$REPO_DIR")"; fi
  if [ "$($SUDO git -C "$reset_dir" rev-parse HEAD)" != "$ORQ_UPDATE_OLD_HEAD" ] \
     && $SUDO git -C "$reset_dir" rev-parse --verify --quiet "$ORQ_UPDATE_OLD_HEAD^{commit}" >/dev/null; then
    say "the live tree was reset in place by the previous script; restoring ${ORQ_UPDATE_OLD_HEAD:0:7} there."
    $SUDO git -C "$reset_dir" reset --hard -q "$ORQ_UPDATE_OLD_HEAD"
  fi
fi
converting=0
conv_sha=""
conv_id=""
if is_plain_checkout; then
  converting=1
  prepare_conversion
  live_dir="$REPO_DIR"
  live_sha="$conv_sha"
else
  finish_conversions
  live_dir="$(readlink -f -- "$REPO_DIR")"
  live_sha="$($SUDO git -C "$live_dir" rev-parse HEAD)"
fi
prev_link_before="$(readlink -- "$PREVIOUS_LINK" 2>/dev/null || true)"
prev_dir_before="$(readlink -f -- "$PREVIOUS_LINK" 2>/dev/null || true)"
old_head="${ORQ_UPDATE_OLD_HEAD:-$live_sha}"

# Base the Caddyfile-drift check on the last SUCCESSFUL deploy, not the live release: a deploy that
# failed after the switch leaves another release live, and on the retry old==new would silently
# skip the reconcile reminder. The same release is the one a failed health check rolls back to.
state_file="$SHARED_GIT/orq-last-deployed-head"
drift_base="$old_head"
last_ok=""
if last_ok="$($SUDO cat "$state_file" 2>/dev/null)" \
   && g rev-parse --verify --quiet "$last_ok^{commit}" >/dev/null 2>&1; then
  drift_base="$last_ok"
else
  last_ok=""
fi

# ---------- The target release ----------
# `git clone --bare` sets no fetch refspec; origin/<branch> must resolve.
g config --get remote.origin.fetch >/dev/null || g config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
g fetch origin -q 9<&- 8<&-
new_head="$(g rev-parse --verify --quiet "$RESET_REF^{commit}")" \
  || { echo "[remote-update] ref not found: $RESET_REF" >&2; exit 1; }
if [ "$converting" -eq 1 ] && [ "${new_head:0:12}" = "$conv_id" ]; then
  target_dir="$REPO_DIR"
else
  target_dir="$RELEASES_DIR/${new_head:0:12}"
fi
say "HEAD: ${old_head:0:7} -> ${new_head:0:7}"

reused=0 # a complete release: no build
fresh=0  # a worktree created for this update: deleted again if its build fails
if is_complete "$target_dir" "$new_head"; then
  reused=1
  say "release $target_dir is already built — switching to it without a rebuild."
elif [ "$target_dir" = "$live_dir" ] || [ "$target_dir" = "$prev_dir_before" ]; then
  # Never delete the release that runs (or the previous one) to rebuild it.
  warn "WARNING: $target_dir was never completely built; building it in place."
elif [ "$from_layout_script" -eq 1 ] && [ "$($SUDO git -C "$target_dir" rev-parse HEAD 2>/dev/null)" = "$new_head" ]; then
  fresh=1 # created by the script that handed over, just before
else
  check_disk 0
  $SUDO rm -rf -- "$target_dir" # left by an interrupted or failed build
  g worktree add -q -f --detach "$target_dir" "$new_head" 9<&- 8<&-
  fresh=1
fi

if [ -z "$handed_over" ] && [ -f "$target_dir/deploy/lib/remote-update.sh" ] \
   && ! cmp -s -- "${BASH_SOURCE[0]}" "$target_dir/deploy/lib/remote-update.sh"; then
  if is_layout_aware "$target_dir"; then
    handoff="$(mktemp "${TMPDIR:-/tmp}/orq-remote-update.XXXXXX")"
    cat -- "$target_dir/deploy/lib/remote-update.sh" > "$handoff"
    say "${new_head:0:7} has its own remote-update.sh — continuing with it."
    exec env ORQ_UPDATE_HANDOFF="$handoff" ORQ_UPDATE_LAYOUT=1 ORQ_UPDATE_OLD_HEAD="$old_head" \
      ORQ_UPDATE_LOCK_HELD="$lock_held" RESET_REF="$new_head" bash "$handoff"
  fi
  say "${new_head:0:7}'s remote-update.sh predates releases — this script deploys it."
fi

# Install, build and guard the release in the current directory. Every step checks its own
# status (the caller runs this from an `if`-like context, where `set -e` does not apply).
box_agent="reused"
voxl="reused"
gdu="reused"
build_tree() { # <release dir>
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
  # voxl, the optional H.264 desktop streamer: runtime libraries plus the pinned build (once per
  # version; a no-op afterwards). Best-effort — a failure warns and desktops stream with RFB.
  # Refs without the script (old rollbacks) skip this.
  voxl="skipped"
  if [ -f deploy/install-voxl.sh ]; then
    voxl_log="$(mktemp)"
    if $SUDO bash deploy/install-voxl.sh </dev/null 2>&1 | tee "$voxl_log"; then
      voxl="$(sed -n 's/^\[install-voxl\] voxl \([^ ]*\) at .*/\1/p' "$voxl_log" | tail -n1)"
      [ -n "$voxl" ] || voxl="ok"
    else
      voxl="FAILED: $(sed -n 's/^\[install-voxl\] ERROR: //p' "$voxl_log" | tail -n1)"
      [ "$voxl" != "FAILED: " ] || voxl="FAILED: deploy/install-voxl.sh"
      echo "[remote-update] WARNING: voxl not installed — $voxl (see output above)." >&2
      echo "[remote-update]          Continuing: desktops stream with RFB/noVNC until it is." >&2
    fi
    rm -f "$voxl_log"
  fi
  # gdu, the Storage view's disk scanner: the pinned release binary (a no-op once installed).
  # Best-effort — a failure warns and the Storage view shows how to install it. Refs without the
  # script (old rollbacks) skip this.
  gdu="skipped"
  if [ -f deploy/install-gdu.sh ]; then
    gdu_log="$(mktemp)"
    if $SUDO bash deploy/install-gdu.sh </dev/null 2>&1 | tee "$gdu_log"; then
      gdu="$(sed -n 's/^\[install-gdu\] gdu \([^ ]*\) at .*/\1/p' "$gdu_log" | tail -n1)"
      [ -n "$gdu" ] || gdu="ok"
    else
      gdu="FAILED: $(sed -n 's/^\[install-gdu\] ERROR: //p' "$gdu_log" | tail -n1)"
      [ "$gdu" != "FAILED: " ] || gdu="FAILED: deploy/install-gdu.sh"
      echo "[remote-update] WARNING: gdu not installed — $gdu (see output above)." >&2
      echo "[remote-update]          Continuing: the Storage view shows an install hint until it is." >&2
    fi
    rm -f "$gdu_log"
  fi
  # The daemon loads better-sqlite3 and node-pty under /usr/bin/node (the unit's
  # ExecStart interpreter): prove they load there, rebuilding any that don't,
  # BEFORE the switch, so a deploy never restarts into a daemon that cannot start.
  if ! $SUDO env CI=1 "$NODE_BIN" scripts/ensure-node-native.mjs </dev/null; then
    echo "[remote-update] native modules do not load under $NODE_BIN $("$NODE_BIN" -v 2>/dev/null || echo '(unknown)')." >&2
    return 2
  fi
  $SUDO chown -R root:root "$1" || return 1
}

if [ "$reused" -eq 0 ]; then
  build_rc=0
  cd "$target_dir"
  build_tree "$target_dir" || build_rc=$?
  cd /
  if [ "$build_rc" -ne 0 ]; then
    if [ "$fresh" -eq 1 ]; then
      $SUDO rm -rf -- "$target_dir"
      warn "build failed — NOT switching: the running daemon and $REPO_DIR are untouched; the incomplete $target_dir is deleted."
    else
      warn "build failed — NOT restarting; the running daemon keeps its current process."
    fi
    [ "$build_rc" -ne 2 ] || warn "Fix the native-module rebuild and re-deploy."
    exit 1
  fi
  mark_complete "$target_dir" "$new_head"
fi

if ! g diff --quiet "$drift_base" "$new_head" -- deploy/Caddyfile; then
  echo "[remote-update] NOTE: deploy/Caddyfile changed (${drift_base:0:7}..${new_head:0:7})."
  echo "[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain"
  echo "[remote-update]       substituted), then: ${SUDO:+$SUDO }systemctl reload caddy"
fi

# Fill the daemon's transpile cache for the release before the switch, so the restart doesn't
# start cold (the script drops to the daemon user itself). Best-effort, bounded by WARM_TIMEOUT.
warm="skipped"
warm_release() { # <release dir>
  local rc=0 limit=()
  [ -f "$1/deploy/lib/warm-release.sh" ] || return 0
  if command -v timeout >/dev/null 2>&1; then limit=(timeout "$WARM_TIMEOUT"); fi
  (cd "$1" && $SUDO "${limit[@]}" bash deploy/lib/warm-release.sh "$1" </dev/null 9<&- 8<&-) || rc=$?
  if [ "$rc" -eq 0 ]; then
    warm="ok"
  else
    warm="FAILED: deploy/lib/warm-release.sh exited $rc"
    [ "$rc" -ne 124 ] || warm="FAILED: deploy/lib/warm-release.sh timed out after ${WARM_TIMEOUT}s"
    warn "WARNING: warm-up $warm — continuing; the first start compiles what it needs."
  fi
}

write_stamp() { # <release dir> <commit>
  printf '{"commit":"%s","version":"%s","deployedAt":"%s"}\n' "$2" "$(tree_version "$1")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    | $SUDO tee "$1/$STAMP_FILE" >/dev/null
}

# A release's host setup, run before each restart (the revert's too, so the unit matches the
# release it starts): the daemon's public origin from the target's domain (an existing value is
# kept) and the web fallback to the previous release, then the units and the needrestart
# exclusion — a changed unit is reloaded here and applies at the restart; nothing else is
# restarted. The env-file helpers run from any release that has them (they only add missing
# lines). The units come only from a layout-aware release: one from before releases would install
# an update unit whose updates reset the live release in place, so its units are left as they are.
prepare_host() { # <release dir>
  if [ -f "$1/deploy/lib/ensure-public-url.sh" ]; then
    (cd "$1" && $SUDO bash deploy/lib/ensure-public-url.sh "$ENV_FILE" "$DOMAIN" </dev/null) || return 1
  fi
  if [ -f "$1/deploy/lib/ensure-web-fallback.sh" ]; then
    (cd "$1" && $SUDO bash deploy/lib/ensure-web-fallback.sh "$ENV_FILE" </dev/null) || return 1
  fi
  if [ -f "$1/deploy/install-unit.sh" ]; then
    if is_layout_aware "$1"; then
      (cd "$1" && $SUDO bash deploy/install-unit.sh </dev/null) || return 1
    else
      say "$(basename -- "$1") predates releases: keeping the installed units."
    fi
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

# The ids of releases a running process uses: its cwd, executable, command line or mapped files
# under the releases dir. Self-contained: it runs through `$SUDO bash -c` to see every process.
scan_in_use() { # <proc root> <releases dir>
  local p
  for p in "$1"/[0-9]*; do
    readlink -- "$p/cwd" 2>/dev/null || true
    readlink -- "$p/exe" 2>/dev/null || true
    tr '\0' '\n' 2>/dev/null <"$p/cmdline" || true
    echo
    cat -- "$p/maps" 2>/dev/null || true
  done | awk -v pre="$2/" '{
    s = $0
    while ((i = index(s, pre)) > 0) {
      s = substr(s, i + length(pre))
      id = substr(s, 1, 12)
      c = substr(s, 13, 1)
      if (length(id) == 12 && id ~ /^[0-9a-f]+$/ && (c == "" || c == "/" || c ~ /[[:space:]]/)) print id
    }
  }' | sort -u
}

# After a healthy deploy: keep the live release, the previous one, one more (the one that went live
# most recently of the rest) and every release a running process still uses — the agent host
# outlives daemon restarts and loads files from its own release on demand. Delete the rest.
prune_releases() {
  local live prev d id one_more in_use kept=0 pinned="" candidates=()
  live="$(readlink -f -- "$REPO_DIR")"
  prev="$(readlink -f -- "$PREVIOUS_LINK" 2>/dev/null || true)"
  [ -z "$prev" ] || [ "$prev" = "$live" ] || kept=1
  for d in "$RELEASES_DIR"/*; do
    if release_id_ok "${d##*/}" && [ -d "$d" ] && [ ! -L "$d" ] && [ "$d" != "$live" ] && [ "$d" != "$prev" ]; then
      candidates+=("$d")
    fi
  done
  [ "${#candidates[@]}" -gt 0 ] || return 0
  one_more="$($SUDO find "${candidates[@]}" -maxdepth 1 -name "$COMPLETE_FILE" -printf '%T@ %h\n' 2>/dev/null \
    | sort -rn | head -n1 | cut -d' ' -f2- || true)"
  if [ "$PROC_ROOT" = /proc ] && [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
    warn "WARNING: not pruning releases: only root can tell which ones running processes use."
    return 0
  fi
  if ! in_use="$($SUDO bash -c "$(declare -f scan_in_use); scan_in_use \"\$1\" \"\$2\"" scan "$PROC_ROOT" "$RELEASES_DIR")"; then
    warn "WARNING: not pruning releases: could not scan $PROC_ROOT for the ones in use."
    return 0
  fi
  for d in "${candidates[@]}"; do
    id="${d##*/}"
    if grep -qxF -- "$id" <<<"$in_use"; then
      kept=$((kept + 1))
      pinned="$pinned $id"
      say "keeping release $id: a running process uses it."
    elif [ "$d" = "$one_more" ]; then
      kept=$((kept + 1))
    else
      $SUDO rm -rf -- "$d"
      say "pruned release $id"
    fi
  done
  kept=$((kept + 1))
  if [ "$kept" -gt 5 ]; then
    warn "WARNING: $kept releases kept in $RELEASES_DIR (in use:$pinned) — they are deleted once no process uses them; watch the disk space."
  fi
  g worktree prune 9<&- 8<&-
}

# ---------- Switch ----------
warm_release "$target_dir"
write_stamp "$target_dir" "$new_head"
prepare_host "$target_dir" || { warn "host setup failed — NOT switching; the running daemon is untouched."; exit 1; }
if [ "$converting" -eq 1 ]; then
  # Step 4 of the conversion: the plain checkout moves into the releases dir and $REPO_DIR becomes
  # the link, back to back. The running daemon keeps its open files and loaded modules.
  conv_dir="$RELEASES_DIR/$conv_id"
  [ "$target_dir" != "$REPO_DIR" ] || target_dir="$conv_dir"
  $SUDO ln -sfn -- "$target_dir" "$REPO_DIR.orq-new"
  $SUDO mv -T -- "$REPO_DIR" "$conv_dir"
  $SUDO mv -T -- "$REPO_DIR.orq-new" "$REPO_DIR"
  live_dir="$conv_dir"
  converting=0
  degit_release "$conv_dir"
elif [ "$target_dir" != "$live_dir" ]; then
  link_to "$REPO_DIR" "$target_dir"
fi
if [ "$target_dir" != "$live_dir" ]; then
  link_to "$PREVIOUS_LINK" "$live_dir"
fi
# Its marker's mtime: when the release went live last (prune_releases keeps the latest one).
$SUDO touch -- "$target_dir/$COMPLETE_FILE"
say "switched: $target_dir is live; restarting."

if ! restart_healthy; then
  echo "[remote-update] ERROR: release ${new_head:0:7} did not report healthy within ${HEALTH_WAIT}s." >&2
  # Back to the last successful deploy when it is still on disk, else to the release that was live.
  revert_dir=""
  if [ "$AUTO_REVERT" = "1" ]; then
    if [ -n "$last_ok" ] && [ "$RELEASES_DIR/${last_ok:0:12}" != "$target_dir" ] \
       && is_complete "$RELEASES_DIR/${last_ok:0:12}" "$last_ok"; then
      revert_dir="$RELEASES_DIR/${last_ok:0:12}"
    elif [ "$live_dir" != "$target_dir" ]; then
      revert_dir="$live_dir"
    fi
  fi
  if [ -z "$revert_dir" ]; then
    echo "[remote-update] No previous release to roll back to — the daemon runs ${new_head:0:7} and is NOT healthy." >&2
    echo "[remote-update] Inspect: ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
    exit 1
  fi
  revert_sha="$($SUDO git -C "$revert_dir" rev-parse HEAD)"
  echo "[remote-update] AUTO-REVERT: rolling back to the previous release ${revert_sha:0:7} ($revert_dir)." >&2
  restore_previous_link() {
    if [ -n "$prev_link_before" ]; then link_to "$PREVIOUS_LINK" "$prev_link_before"; else $SUDO rm -f -- "$PREVIOUS_LINK"; fi
  }
  revert_ok=0
  if link_to "$REPO_DIR" "$revert_dir" && restore_previous_link && write_stamp "$revert_dir" "$revert_sha" \
     && prepare_host "$revert_dir" && restart_healthy; then
    revert_ok=1
  fi
  if [ "$revert_ok" -eq 1 ]; then
    echo "[remote-update] service=$(systemctl is-active orquester)"
    echo "[remote-update] version=$(tree_version "$revert_dir") commit=$revert_sha"
    echo "[remote-update] release=$revert_dir"
    echo "[remote-update] ROLLED BACK: ${new_head:0:7} failed its health check; ${revert_sha:0:7} is running and healthy." >&2
    echo "[remote-update] The deploy FAILED. Inspect the failed start: ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
    exit 3
  fi
  echo "[remote-update] ROLLBACK FAILED: ${revert_sha:0:7} did not come back healthy either — the daemon is NOT healthy (it may be down)." >&2
  echo "[remote-update] Act now: ${SUDO:+$SUDO }systemctl status orquester; ${SUDO:+$SUDO }journalctl -u orquester -n 200" >&2
  exit 4
fi
printf '%s\n' "$new_head" | $SUDO tee "$state_file" >/dev/null
# The update scripts self-update runs (orquester-update.service copies them from here when it
# exists): those of the last healthy layout-aware release, so a rollback to a release from before
# releases — or a flip back — keeps layout-aware tooling. Each is replaced atomically.
if is_layout_aware "$target_dir"; then
  tooling="$RELEASES_DIR/tooling"
  for f in remote-update.sh self-update.sh; do
    [ -f "$target_dir/deploy/lib/$f" ] || continue
    if ! { $SUDO install -d -m 0755 -- "$tooling" \
           && $SUDO install -m 0644 -- "$target_dir/deploy/lib/$f" "$tooling/.$f.tmp" \
           && $SUDO mv -f -- "$tooling/.$f.tmp" "$tooling/$f"; }; then
      warn "WARNING: could not install $f into $tooling — self-update keeps the copy it has."
    fi
  done
fi
prune_releases
echo "[remote-update] service=$(systemctl is-active orquester)"
echo "[remote-update] version=$(tree_version "$target_dir") commit=$new_head"
echo "[remote-update] bundle=$(curl -s "${HEALTH_URL%/health}/" | grep -o 'index-[^.]*\.js' | head -n1)"
echo "[remote-update] box-agent=$box_agent"
echo "[remote-update] voxl=$voxl"
echo "[remote-update] gdu=$gdu"
echo "[remote-update] release=$target_dir"
echo "[remote-update] warm=$warm"
echo "[remote-update] OK"
