#!/bin/sh
# Orquester desktop app runner (desktop spec §5.2). Runs as an `app-<appId>`
# window of the desktop's tmux service session:
#
#   app-run.sh <dir> <appId>
#
# The daemon wrote the app's whole environment, plus ORQ_APP_CWD and
# ORQ_APP_COMMAND, to `<dir>/apps/<appId>.env` (0600, single-quoted values):
# neither the command line nor any value ever appears in a process's argv. The
# app runs in its own process group (the pid this script records as `.pgid`),
# so stopping it never touches the host, and its exit status lands in `.exit`.

__orq_dir=$1
__orq_app=$2
__orq_base="$__orq_dir/apps/$__orq_app"

atomic_write() {
  printf '%s\n' "$2" >"$1.tmp" && mv -f "$1.tmp" "$1"
}

# The tmux pane's own variables are not the app's.
unset TMUX TMUX_PANE

if [ ! -r "$__orq_base.env" ]; then
  echo "app environment file is missing" >>"$__orq_base.log"
  atomic_write "$__orq_base.exit" 127
  exit 127
fi
set -a
. "$__orq_base.env"
set +a
rm -f "$__orq_base.env"

if ! cd "$ORQ_APP_CWD" 2>>"$__orq_base.log"; then
  atomic_write "$__orq_base.exit" 126
  exit 126
fi

# A background job of a non-interactive shell is not a group leader, so setsid
# does not fork: $! is the new session's (and process group's) leader. `nice`
# and `sh` exec in place. The command comes from the environment and is
# evaluated by that shell, so any shell command line works.
setsid nice -n 10 sh -c '__orq_c=$ORQ_APP_COMMAND; unset ORQ_APP_COMMAND ORQ_APP_CWD; eval "$__orq_c"' \
  >>"$__orq_base.log" 2>&1 </dev/null &
__orq_pid=$!
atomic_write "$__orq_base.pgid" "$__orq_pid"
wait "$__orq_pid"
__orq_code=$?
atomic_write "$__orq_base.exit" "$__orq_code"
