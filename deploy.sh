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

# preflight: refuse to deploy anything that isn't pushed. Under --dry-run,
# failures degrade to warnings so the command chain can still be inspected.
preflight_pushed() { # <branch>
  local branch="$1" msg="" head remote
  if [ -n "$(git -C "$here" status --porcelain)" ]; then
    msg="working tree is dirty — commit or stash first"
  else
    git -C "$here" fetch origin -q
    head="$(git -C "$here" rev-parse HEAD)"
    if ! remote="$(git -C "$here" rev-parse "origin/$branch" 2>/dev/null)"; then
      msg="origin/$branch not found — push first: git push origin $branch"
    elif [ "$head" != "$remote" ]; then
      msg="local HEAD is not origin/$branch — push first: git push origin $branch"
    fi
  fi
  [ -z "$msg" ] && return 0
  if [ "$DRY_RUN" -eq 1 ]; then warn "$msg (continuing: dry-run)"; return 0; fi
  warn "$msg"
  return 1
}

find_chrome() {
  if [ -n "${SMOKE_CHROME:-}" ]; then printf '%s' "$SMOKE_CHROME"; return 0; fi
  local c
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

smoke_test() { # uses T_DOMAIN; a smoke failure fails the target's deploy
  if [ -z "$T_DOMAIN" ]; then
    info "no domain configured — skipping browser smoke test"
    return 0
  fi
  local chrome
  if ! chrome="$(find_chrome)"; then
    warn "SKIPPED smoke test for https://$T_DOMAIN — no Chrome/Chromium found (set SMOKE_CHROME=/path/to/chrome)"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY-RUN local: SMOKE_CHROME=$chrome node scripts/smoke-web.mjs https://$T_DOMAIN"
    return 0
  fi
  info "smoke test: https://$T_DOMAIN"
  SMOKE_CHROME="$chrome" node "$here/scripts/smoke-web.mjs" "https://$T_DOMAIN"
}

cmd_deploy_target() {
  local name="$1" s
  load_target "$CONF" "$name"
  build_ssh_args
  s="$(sudo_word)"
  info "=== deploy $name ($T_USER@$T_HOST) ==="
  STEP="preflight";     preflight_pushed "$T_BRANCH" || return 1
  STEP="remote-update"; run_payload "$here/deploy/lib/remote-update.sh" "SUDO=$s" "BRANCH=$T_BRANCH" || return 1
  STEP="smoke-test";    smoke_test || return 1
  ok "$name deployed"
}

cmd_rollback() {
  local name="$1" sha="$2" s
  load_target "$CONF" "$name"
  build_ssh_args
  s="$(sudo_word)"
  info "=== rollback $name -> $sha ($T_USER@$T_HOST) ==="
  STEP="remote-update"; run_payload "$here/deploy/lib/remote-update.sh" "SUDO=$s" "BRANCH=$T_BRANCH" "RESET_REF=$sha" || return 1
  STEP="smoke-test";    smoke_test || return 1
  ok "$name rolled back to $sha"
}

cmd_rotate_password() {
  local name="$1" s
  load_target "$CONF" "$name"
  build_ssh_args
  s="$(sudo_word)"
  info "=== rotate-password $name ($T_USER@$T_HOST) ==="
  remote_run "set -e
new=\$(openssl rand -base64 32)
${s:+$s }sed -i \"s|^ORQUESTER_HTTP_PASSWORD=.*|ORQUESTER_HTTP_PASSWORD=\$new|\" /etc/orquester/daemon.env
${s:+$s }systemctl restart orquester
curl -fsS --retry 25 --retry-delay 1 --retry-connrefused http://127.0.0.1:47831/health; echo
echo '============================================================'
echo 'NEW PASSWORD (shown once — save it now):'
echo \"\$new\"
echo '============================================================'"
}

cmd_provision() {
  local name="$1"
  load_target "$CONF" "$name"
  build_ssh_args
  [ -n "$T_DOMAIN" ] || die "target '$name': provision requires 'domain' in targets.conf"
  [ -n "$T_REPO" ]   || die "target '$name': provision requires 'repo' in targets.conf"
  info "=== provision $name ($T_USER@$T_HOST, domain $T_DOMAIN) ==="
  info "prerequisite: a DNS A record for $T_DOMAIN must already point at $T_HOST"
  RUN_AS_ROOT=1 run_payload "$here/deploy/lib/remote-provision.sh" \
    "DOMAIN=$T_DOMAIN" "REPO=$T_REPO" "BRANCH=$T_BRANCH" || die "provision failed"
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  info "checking https://$T_DOMAIN/api/auth/info (TLS issuance can take a moment)"
  curl -fsS --retry 10 --retry-delay 3 "https://$T_DOMAIN/api/auth/info"; echo
  ok "$name provisioned"
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
    deploy) run_for_targets cmd_deploy_target "${1:-all}" ;;
    provision)
      [ $# -eq 1 ] || die "usage: ./deploy.sh provision <target>"
      cmd_provision "$1" ;;
    verify) run_for_targets cmd_verify_target "${1:-all}" ;;
    rollback)
      [ $# -eq 2 ] || die "usage: ./deploy.sh rollback <target> <sha>"
      cmd_rollback "$1" "$2" || die "rollback failed${STEP:+ (step: $STEP)}" ;;
    rotate-password)
      [ $# -eq 1 ] || die "usage: ./deploy.sh rotate-password <target>"
      cmd_rotate_password "$1" ;;
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
