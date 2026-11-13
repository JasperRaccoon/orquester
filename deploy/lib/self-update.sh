#!/usr/bin/env bash
# Runs ON the VPS as root, from orquester-update.service (started by orquester-update.path when the
# daemon creates its update request). Runs a copy of remote-update.sh — the same cycle as
# `./deploy.sh deploy`: fetch, reset to origin/$BRANCH, install, build, restart, health check,
# automatic revert — and records the run in a status file the daemon reads back
# (ORQUESTER_SELF_UPDATE_STATUS; parsed by parseSelfUpdateRun in packages/api/src/self-update.ts):
#   {"state":"running","from":"<sha>|null","startedAt":"<ISO>"}
#   {"state":"succeeded|reverted|failed","from":…,"startedAt":…,"finishedAt":"<ISO>","exitCode":N}
# remote-update.sh's exit 0 is succeeded, 3 reverted (the previous release runs, healthy), anything
# else failed. Exits with remote-update.sh's code. Inputs via env:
#   REQUEST_FILE   the daemon's request file; removed first (the path unit watches it with
#                  PathExists=, and would start the update again while it exists). Content ignored.
#   STATUS_FILE    the status file; written atomically (a temp file in its own directory + mv)
#   UPDATE_SCRIPT  the remote-update.sh to run — a copy outside the checkout it rewrites
#   REPO_DIR       default /opt/orquester
#   BRANCH         default main
# Everything is inside main(), so bash has read the whole script before anything runs.

main() {
  set -euo pipefail
  : "${REQUEST_FILE:?}" "${STATUS_FILE:?}" "${UPDATE_SCRIPT:?}"
  local repo_dir="${REPO_DIR:-/opt/orquester}" branch="${BRANCH:-main}"
  local status_dir
  status_dir="$(dirname -- "$STATUS_FILE")"
  # Globals, not locals: the EXIT trap reads them.
  finished=0 rc=0

  # A symlink planted at the request path is only unlinked (rm never follows it).
  rm -f -- "$REQUEST_FILE"

  # The commit the daemon runs: the deploy's version stamp, which remote-update.sh writes only on
  # its way to a restart. The checkout's HEAD can be ahead of the daemon (a build that failed after
  # the reset leaves HEAD on the new commit and the old daemon running); it is the fallback for an
  # install no deploy has stamped yet.
  from="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' "$repo_dir/.orquester-version.json" 2>/dev/null | head -n1 || true)"
  [[ "$from" =~ ^[0-9a-f]{40}$ ]] || from="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"
  [[ "$from" =~ ^[0-9a-f]{40}$ ]] && from="\"$from\"" || from=null
  started_at="$(now)"

  # Whatever ends the wrapper early — an error here, or systemd stopping the unit (SIGTERM reaches
  # the whole cgroup; bash runs the trap once the update script has exited) — records `failed`
  # instead of leaving a `running` the daemon would wait on forever.
  trap 'rc=$?; [ "$finished" -eq 1 ] || write_status failed "$from" "$started_at" "$rc" || true' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT

  [ -d "$status_dir" ] || { mkdir -p -- "$status_dir" && chmod 0755 -- "$status_dir"; }
  write_status running "$from" "$started_at"
  echo "[self-update] updating ${branch} in ${repo_dir} (from ${from//\"/})"

  REPO_DIR="$repo_dir" BRANCH="$branch" bash "$UPDATE_SCRIPT" </dev/null || rc=$?

  local state=failed
  case "$rc" in
    0) state=succeeded ;;
    3) state=reverted ;;
  esac
  write_status "$state" "$from" "$started_at" "$rc"
  finished=1
  echo "[self-update] ${state} (remote-update.sh exit ${rc})"
  exit "$rc"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_status <state> <from JSON> <startedAt> [exitCode] — exitCode marks the run finished.
write_status() {
  local tmp json
  json="{\"state\":\"$1\",\"from\":$2,\"startedAt\":\"$3\""
  [ "$#" -lt 4 ] || json="$json,\"finishedAt\":\"$(now)\",\"exitCode\":$4"
  tmp="$(mktemp -- "$(dirname -- "$STATUS_FILE")/.status.XXXXXX")" || return 1
  if printf '%s}\n' "$json" > "$tmp" && chmod 0644 -- "$tmp" && mv -f -- "$tmp" "$STATUS_FILE"; then
    return 0
  fi
  rm -f -- "$tmp"
  echo "[self-update] ERROR: could not write $STATUS_FILE" >&2
  return 1
}

main "$@"
