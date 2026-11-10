#!/bin/sh
# Orquester desktop voxl runner (spec 2026-11-10 §5, R4.9). Runs as the `voxl`
# window of the desktop's tmux service session, which the daemon opens when the
# first voxl viewer connects (and closes a while after the last one left):
#
#   voxl-run.sh <dir> <voxl binary> <voxl argument>...
#
# The daemon wrote voxl's environment (DISPLAY, XAUTHORITY, XDG_RUNTIME_DIR and
# the per-desktop VOXL_PASSWORD) to `<dir>/voxl.env` (0600, single-quoted
# values): the password never appears in a process's argv or in a log. voxl's
# output goes to `<dir>/voxl.log` (the daemon waits there for its listen line),
# its exit status to `<dir>/voxl.exit`. voxl runs in this window's process
# group, so the daemon's SIGTERM to the group (and the session's teardown)
# reaches it; this shell only outlives it to record the status.

dir=$1
shift

atomic_write() {
  printf '%s\n' "$2" >"$1.tmp" && mv -f "$1.tmp" "$1"
}

# stdout and stderr go to the log; stdin stays on the pane's pty (tmux closes a
# window whose pty nobody holds open).
exec >>"$dir/voxl.log" 2>&1

# The tmux pane's own variables are not voxl's.
unset TMUX TMUX_PANE

if [ ! -r "$dir/voxl.env" ]; then
  echo "voxl environment file is missing"
  atomic_write "$dir/voxl.exit" 127
  exit 127
fi
set -a
. "$dir/voxl.env"
set +a

# A handler, not an ignore: an ignored signal would be ignored by voxl too.
trap ':' HUP INT TERM
"$@" </dev/null
code=$?
atomic_write "$dir/voxl.exit" "$code"
