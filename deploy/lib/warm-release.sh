#!/usr/bin/env bash
# Warms the daemon's tsx transform cache for a release before it goes live, so the restart after
# the switch reads transpiled modules from the cache instead of transpiling ~900 files.
#
#   bash deploy/lib/warm-release.sh <release-dir>
#
# remote-update.sh runs it as root from inside the new release; a non-zero exit is a warning only.
# Exits 124 when WARM_TIMEOUT stopped the warm-up, 1 on any other failure.
# It loads (never runs) the module graphs of the daemon and the agent host through tsx as the
# daemon user, with the unit's TMPDIR and node, from the release's real path: tsx keys each cache
# entry on the file's absolute path, its source, the node version, the tsconfig found from cwd and
# the tsx/esbuild versions, so entries written for another path or node are never hit.
# Only $TMPDIR/tsx-<uid> is written. Re-running it adds nothing.
#
# Environment (defaults match deploy/orquester.service):
#   DAEMON_USER     the unit's User=                 (orquester)
#   DAEMON_TMPDIR   the unit's TMPDIR                (/var/lib/orquester/tmp)
#   NODE_BIN        the unit's node                  (/usr/bin/node, else node on PATH)
#   WARM_TIMEOUT    seconds before giving up         (600; remote-update.sh passes on the
#                                                     operator's value, or none: this is the default)
# Run as root, or directly as DAEMON_USER (manual runs and tests: DAEMON_USER=$(id -un)).
set -euo pipefail

fail() { printf '[warm-release] ERROR: %s\n' "$*" >&2; exit 1; }

[ $# -eq 1 ] || fail "usage: warm-release.sh <release-dir>"
release="$(cd "$1" 2>/dev/null && pwd -P)" || fail "no release directory at $1"
user="${DAEMON_USER:-orquester}"
tmp="${DAEMON_TMPDIR:-/var/lib/orquester/tmp}"
timeout_s="${WARM_TIMEOUT:-600}"
if [ -n "${NODE_BIN:-}" ]; then
  node="$NODE_BIN"
elif [ -x /usr/bin/node ]; then
  node=/usr/bin/node
else
  node="$(command -v node)" || fail "node not found"
fi

# The daemon's entry (ExecStart) and the agent host's (agent-chat/supervisor.ts AGENT_HOST_MAIN).
entries=(apps/daemon/src/cli.ts apps/daemon/src/agent-host/main.ts)
helper=deploy/lib/warm-release.mjs
for file in "${entries[@]}" "$helper" node_modules/tsx/package.json; do
  [ -f "$release/$file" ] || fail "$release/$file is missing"
done

if [ "$(id -un)" = "$user" ]; then
  as_user=()
elif [ "$(id -u)" -eq 0 ]; then
  id -u "$user" >/dev/null 2>&1 || fail "no user $user"
  as_user=(runuser -u "$user" --)
else
  fail "run as root or as $user (DAEMON_USER)"
fi

cd "$release"
"${as_user[@]}" mkdir -p "$tmp" || fail "cannot create $tmp as $user"
# A clean environment, as the unit and the agent host get: tsx also keys on NODE_OPTIONS-style
# inspector/coverage flags, and root's own NODE_OPTIONS or TSX_* must not leak in.
status=0
"${as_user[@]}" timeout "$timeout_s" env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  TMPDIR="$tmp" \
  "$node" --import tsx "$helper" "${entries[@]}" || status=$?
[ "$status" -eq 0 ] && exit 0
if [ "$status" -eq 124 ]; then
  printf '[warm-release] ERROR: timed out after %ss\n' "$timeout_s" >&2
  exit 124
fi
fail "warming $release failed (exit $status)"
