#!/usr/bin/env bash
# Orquester VPS lifecycle tool: deploy, provision, verify, rollback, logs,
# rotate-password. Targets: deploy/targets.conf (gitignored — copy
# deploy/targets.conf.example). Design:
# docs/superpowers/specs/2026-07-25-deploy-sh-lifecycle-tool-design.md
set -euo pipefail
trap 'printf "[deploy] failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib/common.sh
. "$here/deploy/lib/common.sh"

CONF="${ORQ_TARGETS_CONF:-$here/deploy/targets.conf}"
DRY_RUN=0
STEP=""

usage() {
  cat <<'EOF'
usage: ./deploy.sh [--dry-run|-n] <command> [args]

commands:
  deploy [target|all]        update + restart + verify each target (default: all)
  provision <target>         first-time setup of a fresh Ubuntu VPS
  verify [target|all]        read-only: HEAD, health, service, bundle hash
  rollback <target> <sha>    reset the target to <sha>, rebuild, restart, verify
  logs <target> [-n N]       tail the daemon journal (default 50 lines)
  rotate-password <target>   generate + install a new HTTP password (shown once)

targets: deploy/targets.conf — copy deploy/targets.conf.example and fill it in.
EOF
}

sudo_word() { # prints "sudo" (or nothing) for the current target
  if [ "$T_SUDO" = "yes" ]; then printf 'sudo'; fi
}

# run_for_targets <fn> <selector>: per-target, continue on failure, summarize.
run_for_targets() {
  local fn="$1" sel="$2" t rc=0 names results=""
  if [ "$sel" = "all" ]; then
    names="$(list_targets "$CONF")"
    [ -n "$names" ] || die "no targets defined in $CONF"
  else
    names="$sel"
  fi
  for t in $names; do
    STEP=""
    if "$fn" "$t"; then
      results="${results}  $t: OK\n"
    else
      results="${results}  $t: FAILED${STEP:+ (step: $STEP)}\n"
      rc=1
    fi
  done
  info "=== summary ==="
  printf '%b' "$results"
  return "$rc"
}

cmd_verify_target() {
  local name="$1" s
  load_target "$CONF" "$name"
  build_ssh_args
  s="$(sudo_word)"
  info "=== verify $name ($T_USER@$T_HOST) ==="
  STEP="verify"
  remote_run "set -e
echo \"HEAD=\$(${s:+$s }git -C /opt/orquester rev-parse --short HEAD)\"
curl -fsS http://127.0.0.1:47831/health; echo
echo \"service=\$(systemctl is-active orquester)\"
echo \"bundle=\$(curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js' | head -n1)\""
}

cmd_logs() {
  local name="$1" n="$2" s
  load_target "$CONF" "$name"
  build_ssh_args
  s="$(sudo_word)"
  remote_run "${s:+$s }journalctl -u orquester -n $n --no-pager"
}

main() {
  local cmd target n
  if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-n" ]; then DRY_RUN=1; shift; fi
  if [ $# -eq 0 ]; then usage; exit 2; fi
  cmd="$1"; shift
  case "$cmd" in
    verify) run_for_targets cmd_verify_target "${1:-all}" ;;
    logs)
      [ $# -ge 1 ] || die "usage: ./deploy.sh logs <target> [-n N]"
      target="$1"; shift
      n=50
      if [ "${1:-}" = "-n" ]; then
        n="${2:-}"; [ -n "$n" ] || die "logs: -n needs a number"
      fi
      cmd_logs "$target" "$n" ;;
    -h|--help|help) usage ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
