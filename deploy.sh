#!/usr/bin/env bash
# Orquester VPS lifecycle tool: deploy, provision, verify, rollback, logs,
# rotate-password. Targets: deploy/targets.conf (gitignored — copy
# deploy/targets.conf.example). Design:
# docs/superpowers/specs/2026-07-25-deploy-sh-lifecycle-tool-design.md
# -E: without errtrace bash does not inherit the ERR trap into functions, and
# everything below runs inside main()/cmd_* — the trap would be dead code.
set -Eeuo pipefail
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

# Anything that ends up inside a remote command string must be validated first —
# an unchecked argument is arbitrary code execution on the VPS.
require_safe_ref() { # <value> <what>
  case "$1" in
    ""|*[!0-9A-Za-z._/-]*) die "$2 must match [0-9A-Za-z._/-]+ (got '$1')" ;;
  esac
}
require_number() { # <value> <what>
  case "$1" in
    ""|*[!0-9]*) die "$2 must be a number (got '$1')" ;;
  esac
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
  require_safe_ref "$sha" "rollback ref"
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
  # The daemon hashes ORQUESTER_HTTP_PASSWORD only when daemon.json has no
  # passwordHash yet (migrateHttpPassword, apps/daemon/src/index.ts) — a restart
  # alone leaves the OLD password valid. So: patch daemon.env, delete the stale
  # hash, restart, then PROVE the rotation by comparing /api/auth/info's salt
  # (the hash prefix) across the restart before printing anything.
  remote_run "set -e
env_file=/etc/orquester/daemon.env
cfg=/var/lib/orquester/daemon/daemon.json
salt() { curl -fsS --retry 5 --retry-delay 1 http://127.0.0.1:47831/api/auth/info | sed -n 's/.*\"salt\":\"\([^\"]*\)\".*/\1/p'; }
${s:+$s }grep -q '^ORQUESTER_HTTP_PASSWORD=' \"\$env_file\" || { echo \"rotate-password: no ORQUESTER_HTTP_PASSWORD= line in \$env_file — nothing rotated\" >&2; exit 1; }
before=\$(salt || true)
new=\$(openssl rand -base64 32)
${s:+$s }sed -i \"s|^ORQUESTER_HTTP_PASSWORD=.*|ORQUESTER_HTTP_PASSWORD=\$new|\" \"\$env_file\"
# From here the new password exists only on this box. If anything below aborts
# (restart fails, /health never comes up) \`set -e\` would exit silently and the
# operator would never see it — always leave the recovery hint behind.
trap 'echo \"rotate-password: FAILED after the new password was written — the daemon may be down (${s:+$s }systemctl status orquester).\" >&2; echo \"rotate-password: read the installed value with: ${s:+$s }grep ORQUESTER_HTTP_PASSWORD \$env_file\" >&2' ERR
if ${s:+$s }test -f \"\$cfg\"; then
  ${s:+$s }node -e \"const fs=require('fs'),f=process.argv[1],c=JSON.parse(fs.readFileSync(f,'utf8'));if(c.transports&&c.transports.http)delete c.transports.http.passwordHash;fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')\" \"\$cfg\"
fi
${s:+$s }systemctl restart orquester
curl -fsS --retry 25 --retry-delay 1 --retry-connrefused http://127.0.0.1:47831/health; echo
after=\$(salt || true)
if [ \"\$after\" = \"\$before\" ] && [ -n \"\$after\" ]; then
  echo 'rotate-password: FAILED — the stored hash did not change, the OLD password is still valid' >&2
  echo \"rotate-password: read the installed value with: ${s:+$s }grep ORQUESTER_HTTP_PASSWORD \$env_file\" >&2
  exit 1
fi
if [ -z \"\$after\" ]; then
  # The health check passed, so the daemon is up and has already re-hashed the
  # NEW password — it is live even though the salt fetch came back empty. Never
  # swallow it here or the operator is locked out of a password only the VPS knows.
  echo 'rotate-password: WARNING — could not read /api/auth/info to confirm the rotation.' >&2
  echo 'The new password below is most likely already ACTIVE. Verify by logging in.' >&2
  echo \"If it is not, read the installed value with: ${s:+$s }grep ORQUESTER_HTTP_PASSWORD \$env_file\" >&2
  echo '============================================================'
  echo 'NEW PASSWORD (shown once — save it now):'
  echo \"\$new\"
  echo '============================================================'
  exit 1
fi
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
# Each target runs in a SUBSHELL so a config-level `die` (missing key, bad ssh
# key path) kills only that target instead of the whole run; the subshell's EXIT
# trap hands STEP back through a temp file, since it can't set the parent's var.
run_for_targets() {
  local fn="$1" sel="$2" t rc=0 names results=""
  # Same actionable message as load_target's: the `all` selector (the default for
  # deploy/verify) must not fall through to a raw sed error on a first run.
  [ -f "$CONF" ] || die "no targets file at $CONF — copy deploy/targets.conf.example to deploy/targets.conf and fill in your hosts"
  if [ "$sel" = "all" ]; then
    names="$(list_targets "$CONF")"
    [ -n "$names" ] || die "no targets defined in $CONF"
  else
    names="$sel"
  fi
  STEPFILE="$(mktemp "${TMPDIR:-/tmp}/orq-deploy-step.XXXXXX")"
  for t in $names; do
    STEP=""
    : > "$STEPFILE"
    if ( trap 'printf "%s" "$STEP" > "$STEPFILE"' EXIT; "$fn" "$t" ); then
      results="${results}  $t: OK\n"
    else
      STEP="$(cat "$STEPFILE")"
      results="${results}  $t: FAILED${STEP:+ (step: $STEP)}\n"
      rc=1
    fi
  done
  rm -f "$STEPFILE"
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
    # `|| exit 1`: a recorded per-target failure is an expected outcome, not a
    # crash — keep the ERR trap's "failed at <line>" noise out of the summary.
    deploy) run_for_targets cmd_deploy_target "${1:-all}" || exit 1 ;;
    provision)
      [ $# -eq 1 ] || die "usage: ./deploy.sh provision <target>"
      cmd_provision "$1" ;;
    verify) run_for_targets cmd_verify_target "${1:-all}" || exit 1 ;;
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
        n="${2:-}"; require_number "$n" "logs: -n"
      fi
      cmd_logs "$target" "$n" ;;
    -h|--help|help) usage ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"
