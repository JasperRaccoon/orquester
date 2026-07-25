#!/usr/bin/env bash
# Shared helpers for ./deploy.sh. Sourced, not executed.
# Must stay bash 3.2 compatible (macOS dev machines): no mapfile, no assoc arrays.

# ---------- output ----------
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLD=""; C_RST=""
fi
info() { printf '%s[deploy]%s %s\n' "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '%s[deploy]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s[deploy] WARN:%s %s\n' "$C_YEL" "$C_RST" "$*" >&2; }
die()  { printf '%s[deploy] ERROR:%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }

# ---------- targets.conf (INI: [name] sections, key = value, # comments) ----------
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

list_targets() { # list_targets <conf>
  [ -f "$1" ] || die "no targets file at $1 — copy deploy/targets.conf.example to deploy/targets.conf and fill in your hosts"
  sed -n 's/^[[:space:]]*\[\([^]]*\)\][[:space:]]*$/\1/p' "$1"
}

# load_target <conf> <name>
# Sets: T_HOST T_USER T_KEY T_SUDO T_DOMAIN T_REPO T_BRANCH T_SSH_OPTS
load_target() {
  local conf="$1" name="$2" in=0 line key val
  T_HOST=""; T_USER=""; T_KEY=""; T_SUDO="no"; T_DOMAIN=""; T_REPO=""
  T_BRANCH="main"; T_SSH_OPTS=""
  [ -f "$conf" ] || die "no targets file at $conf — copy deploy/targets.conf.example to deploy/targets.conf and fill in your hosts"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="$(printf '%s' "$line" | sed -e 's/[[:space:]]#.*$//')"  # strip inline comments
    line="$(trim "$line")"
    [ -z "$line" ] && continue
    case "$line" in
      '#'*) continue ;;
      '['*']')
        if [ "$in" -eq 1 ]; then break; fi
        [ "$line" = "[$name]" ] && in=1
        continue ;;
    esac
    [ "$in" -eq 1 ] || continue
    case "$line" in
      *=*) ;;
      *) die "targets.conf [$name]: bad line '$line' (expected: key = value)" ;;
    esac
    key="$(trim "${line%%=*}")"
    val="$(trim "${line#*=}")"
    case "$key" in
      host)     T_HOST="$val" ;;
      user)     T_USER="$val" ;;
      key)      T_KEY="$val" ;;
      sudo)     T_SUDO="$val" ;;
      domain)   T_DOMAIN="$val" ;;
      repo)     T_REPO="$val" ;;
      branch)   T_BRANCH="$val" ;;
      ssh_opts) T_SSH_OPTS="$val" ;;
      *) warn "targets.conf [$name]: unknown key '$key' (ignored)" ;;
    esac
  done < "$conf"
  [ "$in" -eq 1 ] || die "unknown target '$name' (known: $(list_targets "$conf" | tr '\n' ' '))"
  [ -n "$T_HOST" ] || die "target '$name': missing required key 'host'"
  [ -n "$T_USER" ] || die "target '$name': missing required key 'user'"
  case "$T_SUDO" in yes|no) ;; *) die "target '$name': 'sudo' must be 'yes' or 'no' (got '$T_SUDO')" ;; esac
  # branch/domain/repo are interpolated into the remote command line — reject
  # anything that could split it or inject a second command.
  case "$T_BRANCH" in
    ""|*[!0-9A-Za-z._/-]*) die "target '$name': 'branch' must match [0-9A-Za-z._/-]+ (got '$T_BRANCH')" ;;
  esac
  case "$T_DOMAIN" in
    *[!0-9A-Za-z.-]*) die "target '$name': 'domain' must match [0-9A-Za-z.-]+ (got '$T_DOMAIN')" ;;
  esac
  case "$T_REPO" in
    *[!0-9A-Za-z._:/@+-]*) die "target '$name': 'repo' has unsupported characters (got '$T_REPO')" ;;
  esac
  if [ -n "$T_KEY" ]; then
    case "$T_KEY" in "~"*) T_KEY="$HOME${T_KEY#\~}" ;; esac
    [ -f "$T_KEY" ] || die "target '$name': ssh key not found: $T_KEY"
  fi
}

# ---------- ssh / payload execution ----------
build_ssh_args() { # fills global SSH_ARGS array from T_*
  SSH_ARGS=(-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
  if [ -n "$T_KEY" ]; then
    SSH_ARGS=("${SSH_ARGS[@]}" -i "$T_KEY" -o IdentitiesOnly=yes)
  fi
  if [ -n "$T_SSH_OPTS" ]; then
    # word-splitting is intentional: ssh_opts is a whitespace-separated flag list
    # shellcheck disable=SC2206
    SSH_ARGS=("${SSH_ARGS[@]}" $T_SSH_OPTS)
  fi
}

remote_run() { # remote_run <command-string>
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    info "DRY-RUN ssh $T_USER@$T_HOST: $1"
    return 0
  fi
  # SC2029: the caller composes the remote command string deliberately (values
  # it wants expanded locally are already interpolated; remote-side ones are
  # escaped as \$). Callers must validate anything user-supplied first.
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" "$1"
}

# run_payload <local-script> [KEY=VAL ...]
# Copies the script to a mktemp path on the host and runs it with stdin
# detached — NEVER `bash -s` (pnpm would eat the remaining script from stdin).
# Env values must not contain spaces. RUN_AS_ROOT=1 prefixes sudo on sudo=yes targets.
run_payload() {
  local payload="$1"; shift
  local prefix=""
  if [ "${RUN_AS_ROOT:-0}" -eq 1 ] && [ "$T_SUDO" = "yes" ]; then prefix="sudo "; fi
  if [ "${DRY_RUN:-0}" -eq 1 ]; then
    info "DRY-RUN scp $(basename "$payload") -> $T_USER@$T_HOST:<mktemp>"
    info "DRY-RUN ssh $T_USER@$T_HOST: ${prefix}env $* bash <mktemp> </dev/null"
    return 0
  fi
  local rtmp rc=0
  rtmp="$(ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" 'mktemp /tmp/orq-deploy.XXXXXX')" || return 1
  [ -n "$rtmp" ] || return 1
  scp -q "${SSH_ARGS[@]}" "$payload" "$T_USER@$T_HOST:$rtmp" || return 1
  # SC2029: $prefix/$*/$rtmp are meant to expand here, on the client side.
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" "${prefix}env $* bash '$rtmp' </dev/null" || rc=$?
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" "rm -f '$rtmp'" || true
  return "$rc"
}
