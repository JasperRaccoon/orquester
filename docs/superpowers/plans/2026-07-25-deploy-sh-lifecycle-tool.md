# deploy.sh Lifecycle Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `deploy.sh` entry point (subcommands: deploy, provision, verify, rollback, logs, rotate-password) that lets a human without an AI agent run the whole Orquester VPS lifecycle, with every runbook gotcha enforced structurally.

**Architecture:** Local bash orchestrator (`deploy.sh` + `deploy/lib/common.sh`) reads a gitignored INI config (`deploy/targets.conf`) and executes committed payload scripts (`deploy/lib/remote-update.sh`, `deploy/lib/remote-provision.sh`) on each VPS by `scp`-ing them to a mktemp path and running `bash <file> </dev/null` — never `bash -s`. Spec: `docs/superpowers/specs/2026-07-25-deploy-sh-lifecycle-tool-design.md`.

**Tech Stack:** Pure bash + ssh/scp/git/curl. No new npm dependencies. Reuses `deploy/provision-devtools.sh` and `scripts/smoke-web.mjs`.

## Global Constraints

- **Bash 3.2 compatibility for `deploy.sh` and `common.sh`** (they run on the dev machine, possibly macOS): no `mapfile`, no associative arrays, no `${var,,}`. Payloads run on Ubuntu (bash 5) and may use `${var:0:7}`.
- `set -euo pipefail` in every script; payloads add an ERR trap printing the failing line.
- **Never pipe a script into remote `bash -s`** — payloads are scp'd then run with `</dev/null`.
- Every pnpm invocation: `CI=1` (install only) `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm … </dev/null`.
- **Never pipe a build through `| tail`/`| grep`** — builds run bare so `set -e` catches failures.
- Committed files use only placeholder values: `203.0.113.x` / `198.51.100.x` IPs, `orquester.example.com` domains. **Real IPs/domains/secrets appear only in gitignored files** (`deploy/targets.conf`, `DEPLOY_TO_VPS.md`) — and never in this plan's commits.
- Production model is fixed: repo at `/opt/orquester`, appdir `/var/lib/orquester`, daemon on `127.0.0.1:47831`, systemd unit `orquester`, Caddy on 443.
- Repo has **no test runner** (per AGENTS.md). Per the spec, each task verifies via: `bash -n`, `shellcheck` (only if installed — skip silently if not), and functional runs against fixtures/stubs with expected output. Steps below follow write → verify → commit rather than classic test-first, because the "tests" are executable checks of finished scripts.
- Commit to the **current branch** (`main`) as-is — AGENTS.md overrides the branch-first default.
- Scratchpad: use the session scratch dir for fixtures; `$SCRATCH` below means `/var/lib/orquester/tmp/claude-999/-var-lib-orquester-workspaces-jaspersito-orquester2/5979dddf-5c52-4d9d-9e39-73c49590dfdd/scratchpad`.

---

### Task 1: `deploy/lib/common.sh` + `deploy/targets.conf.example` + `.gitignore`

**Files:**
- Create: `deploy/lib/common.sh`
- Create: `deploy/targets.conf.example`
- Modify: `.gitignore` (after the `/DEPLOY_TO_VPS.md` block)

**Interfaces:**
- Consumes: nothing (foundation).
- Produces (used by Tasks 3–5):
  - `info msg…` / `ok msg…` / `warn msg…` / `die msg…` (die exits 1)
  - `list_targets <conf>` → prints one target name per line
  - `load_target <conf> <name>` → sets globals `T_HOST T_USER T_KEY T_SUDO T_DOMAIN T_REPO T_BRANCH T_SSH_OPTS` (dies on missing file/target/required keys, bad `sudo`, missing key file)
  - `build_ssh_args` → sets array `SSH_ARGS` from `T_*`
  - `remote_run <command-string>` → ssh to `$T_USER@$T_HOST`; honors `DRY_RUN=1` by printing instead
  - `run_payload <local-script> [KEY=VAL …]` → scp + `env … bash <tmp> </dev/null`; `RUN_AS_ROOT=1` env prefixes `sudo ` on `sudo=yes` targets; honors `DRY_RUN=1`; returns the payload's exit code

- [ ] **Step 1: Write `deploy/lib/common.sh`**

```bash
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
  ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" "${prefix}env $* bash '$rtmp' </dev/null" || rc=$?
  ssh "${SSH_ARGS[@]}" "$T_USER@$T_HOST" "rm -f '$rtmp'" || true
  return "$rc"
}
```

- [ ] **Step 2: Write `deploy/targets.conf.example`**

```ini
# Copy to deploy/targets.conf (GITIGNORED — real hosts live only there) and
# fill in your VPSes. One [section] per host; used by ./deploy.sh.
#
# Keys:
#   host      (required) IP or hostname
#   user      (required) ssh login user
#   sudo      yes|no (default no) — yes: remote commands run under NOPASSWD sudo
#   key       optional ssh identity file (adds -i <key> -o IdentitiesOnly=yes);
#             omit to let ~/.ssh/config decide
#   domain    optional; enables the post-deploy browser smoke test and is
#             required by `provision` (Caddy vhost)
#   repo      git URL; required by `provision` only
#   branch    default main
#   ssh_opts  extra ssh flags, whitespace-separated
#
# No value may contain spaces, except ssh_opts.

[vps-a]
host   = 203.0.113.10
user   = root
key    = ~/.ssh/id_ed25519_vps
sudo   = no
domain = orquester.example.com
repo   = git@github.com:you/orquester.git

[vps-b]
host   = 203.0.113.20
user   = ubuntu
key    = ~/.ssh/orq_deploy
sudo   = yes
domain = orquester.example.net
repo   = git@github.com:you/orquester.git
```

- [ ] **Step 3: Add `deploy/targets.conf` to `.gitignore`**

In `.gitignore`, extend the existing runbook block:

```
# Local deploy runbook (real hosts/logins/keys). The .example template IS committed.
/DEPLOY_TO_VPS.md
```

becomes:

```
# Local deploy runbook + deploy targets (real hosts/logins/keys).
# The .example templates ARE committed.
/DEPLOY_TO_VPS.md
/deploy/targets.conf
```

- [ ] **Step 4: Syntax check**

Run: `bash -n deploy/lib/common.sh && { command -v shellcheck >/dev/null && shellcheck deploy/lib/common.sh || echo "shellcheck not installed — skipped"; }`
Expected: no output from `bash -n`; shellcheck clean or the skip message.

- [ ] **Step 5: Functional check of the parser and helpers**

Write a fixture and exercise every path:

```bash
mkdir -p "$SCRATCH"
cat > "$SCRATCH/targets-test.conf" <<'EOF'
# fixture — placeholder IPs only
[stub]
host = 198.51.100.7
user = root
sudo = no

[stub2]
host     = 198.51.100.8   # inline comment
user     = ubuntu
sudo     = yes
domain   = stub.example.com
repo     = git@github.com:you/orquester.git
branch   = main
ssh_opts = -o BatchMode=yes
EOF

bash -c '
set -euo pipefail
. deploy/lib/common.sh
conf="'"$SCRATCH"'/targets-test.conf"
echo "targets: $(list_targets "$conf" | tr "\n" " ")"
load_target "$conf" stub2
echo "host=$T_HOST user=$T_USER sudo=$T_SUDO domain=$T_DOMAIN branch=$T_BRANCH opts=$T_SSH_OPTS"
build_ssh_args
echo "ssh_args=${SSH_ARGS[*]}"
DRY_RUN=1 remote_run "echo hi"
DRY_RUN=1 RUN_AS_ROOT=1 run_payload deploy/lib/common.sh "FOO=bar"
'
```

Expected output (exactly these values):

```
targets: stub stub2
host=198.51.100.8 user=ubuntu sudo=yes domain=stub.example.com branch=main opts=-o BatchMode=yes
ssh_args=-o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o BatchMode=yes
[deploy] DRY-RUN ssh ubuntu@198.51.100.8: echo hi
[deploy] DRY-RUN scp common.sh -> ubuntu@198.51.100.8:<mktemp>
[deploy] DRY-RUN ssh ubuntu@198.51.100.8: sudo env FOO=bar bash <mktemp> </dev/null
```

(Note: stub2 has no `key`, so no `-i` in ssh_args — key files don't exist in fixtures.)

Then the error paths (each must print a `[deploy] ERROR:` line and exit 1):

```bash
bash -c '. deploy/lib/common.sh; load_target /nonexistent stub' ; echo "exit=$?"
bash -c '. deploy/lib/common.sh; load_target "'"$SCRATCH"'/targets-test.conf" nope' ; echo "exit=$?"
```

Expected: `no targets file at /nonexistent — copy deploy/targets.conf.example…` then `exit=1`; `unknown target 'nope' (known: stub stub2 )` then `exit=1`.

- [ ] **Step 6: Confirm gitignore works**

Run: `touch deploy/targets.conf && git status --porcelain -- deploy/targets.conf; rm deploy/targets.conf`
Expected: empty output (the file is ignored).

- [ ] **Step 7: Commit**

```bash
git add deploy/lib/common.sh deploy/targets.conf.example .gitignore
git commit -m "feat(deploy): shared helpers, targets.conf format, gitignore entry"
```

---

### Task 2: `deploy/lib/remote-update.sh` payload

**Files:**
- Create: `deploy/lib/remote-update.sh`

**Interfaces:**
- Consumes: nothing from other tasks (self-contained payload; delivered by `run_payload`).
- Produces: a script runnable as `env SUDO=<""|sudo> BRANCH=<b> [RESET_REF=<sha>] [REPO_DIR=<dir>] bash remote-update.sh </dev/null` on the VPS. Task 4 invokes it with `SUDO=…`, `BRANCH=…` (deploy) and additionally `RESET_REF=…` (rollback). `REPO_DIR` exists only for local testing; the orchestrator never passes it. Prints `[remote-update] OK` on success; nonzero exit on any failure.

- [ ] **Step 1: Write `deploy/lib/remote-update.sh`**

```bash
#!/usr/bin/env bash
# Runs ON the VPS (delivered by ./deploy.sh via scp — never `bash -s`).
# Routine update cycle: fetch/reset -> pnpm install -> SPA build -> chown ->
# restart -> health. Inputs via env:
#   SUDO       "" or "sudo" — prefix for privileged commands (git/pnpm/chown/systemctl)
#   BRANCH     branch to deploy (default main)
#   RESET_REF  ref to reset to (default origin/$BRANCH; rollback passes a sha)
#   REPO_DIR   for local testing only (default /opt/orquester)
set -euo pipefail
trap 'echo "[remote-update] FAILED at line $LINENO" >&2' ERR

SUDO="${SUDO:-}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/orquester}"
RESET_REF="${RESET_REF:-origin/$BRANCH}"

cd "$REPO_DIR"
old_head="$($SUDO git rev-parse HEAD)"
$SUDO git fetch origin -q
$SUDO git rev-parse --verify --quiet "$RESET_REF^{commit}" >/dev/null \
  || { echo "[remote-update] ref not found: $RESET_REF" >&2; exit 1; }
$SUDO git reset --hard -q "$RESET_REF"
new_head="$($SUDO git rev-parse HEAD)"
echo "[remote-update] HEAD: ${old_head:0:7} -> ${new_head:0:7}"

# CI=1: non-interactive (a pnpm-version-mismatch prompt would wedge the deploy).
# </dev/null: pnpm must never read stdin. Build runs bare: set -e catches failures.
$SUDO env CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null
$SUDO env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null
$SUDO chown -R root:root "$REPO_DIR"

if ! $SUDO git diff --quiet "$old_head" "$new_head" -- deploy/Caddyfile; then
  echo "[remote-update] NOTE: deploy/Caddyfile changed (${old_head:0:7}..${new_head:0:7})."
  echo "[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain"
  echo "[remote-update]       substituted), then: ${SUDO:+$SUDO }systemctl reload caddy"
fi

$SUDO systemctl restart orquester
curl -fsS --retry 25 --retry-delay 1 --retry-connrefused http://127.0.0.1:47831/health; echo
echo "[remote-update] service=$(systemctl is-active orquester)"
echo "[remote-update] bundle=$(curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js' | head -n1)"
echo "[remote-update] OK"
```

- [ ] **Step 2: Syntax check**

Run: `bash -n deploy/lib/remote-update.sh && { command -v shellcheck >/dev/null && shellcheck deploy/lib/remote-update.sh || echo "shellcheck skipped"; }`
Expected: clean (shellcheck will not flag `$SUDO` unquoted expansion at severity error; if it warns SC2086 on `$SUDO`, add `# shellcheck disable=SC2086` once at the top with a comment "SUDO is an intentional empty-or-sudo prefix").

- [ ] **Step 3: Functional check with a stubbed VPS environment**

Build a fake repo with an origin, plus PATH stubs for `pnpm`/`systemctl`/`curl`/`chown`, then run the payload for real (SUDO empty → every command resolves through the stub PATH):

```bash
S="$SCRATCH/remote-update-test"
rm -rf "$S" && mkdir -p "$S/bin"

cat > "$S/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "stub-pnpm $*"
EOF
cat > "$S/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "is-active" ]; then echo active; else echo "stub-systemctl $*"; fi
EOF
cat > "$S/bin/curl" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *health*) printf '{"ok":true}' ;;
  *)        printf 'src="/assets/index-stub123.js"' ;;
esac
EOF
cat > "$S/bin/chown" <<'EOF'
#!/usr/bin/env bash
echo "stub-chown $*"
EOF
chmod +x "$S/bin/"*

git init -q --bare -b main "$S/origin.git"
git clone -q "$S/origin.git" "$S/repo"
git -C "$S/repo" config user.email t@t && git -C "$S/repo" config user.name t
mkdir -p "$S/repo/deploy"
echo v1 > "$S/repo/deploy/Caddyfile"
git -C "$S/repo" add -A && git -C "$S/repo" commit -qm c1 && git -C "$S/repo" push -q origin main
echo v2 > "$S/repo/deploy/Caddyfile"
git -C "$S/repo" add -A && git -C "$S/repo" commit -qm c2 && git -C "$S/repo" push -q origin main
git -C "$S/repo" reset --hard -q HEAD~1   # local checkout now behind origin (like a VPS pre-deploy)

PATH="$S/bin:$PATH" SUDO= BRANCH=main REPO_DIR="$S/repo" bash deploy/lib/remote-update.sh
echo "exit=$?"
```

Expected output (shas abbreviated):

```
[remote-update] HEAD: <c1sha> -> <c2sha>
stub-pnpm install --frozen-lockfile
stub-pnpm --filter @orquester/web build
stub-chown -R root:root <S>/repo
[remote-update] NOTE: deploy/Caddyfile changed (<c1sha>..<c2sha>).
[remote-update]       Reconcile /etc/caddy/Caddyfile by hand (it has the real domain
[remote-update]       substituted), then: systemctl reload caddy
stub-systemctl restart orquester
{"ok":true}
[remote-update] service=active
[remote-update] bundle=index-stub123.js
[remote-update] OK
exit=0
```

Also check the bad-ref path:

```bash
PATH="$S/bin:$PATH" SUDO= REPO_DIR="$S/repo" RESET_REF=deadbeef bash deploy/lib/remote-update.sh; echo "exit=$?"
```

Expected: `[remote-update] ref not found: deadbeef`, `exit=1`. (No ERR-trap line:
the failing `git rev-parse` is the left side of an `||` list, which is exempt from
errexit/ERR, and the explicit `exit 1` is not a failing command either.)

- [ ] **Step 4: Commit**

```bash
git add deploy/lib/remote-update.sh
git commit -m "feat(deploy): remote-update payload (routine update cycle)"
```

---

### Task 3: `deploy.sh` skeleton — dispatch, `--dry-run`, `verify`, `logs`

**Files:**
- Create: `deploy.sh` (repo root, executable)

**Interfaces:**
- Consumes: everything `common.sh` produces (Task 1).
- Produces (extended in Tasks 4–5):
  - CLI: `./deploy.sh [--dry-run|-n] <command> [args]`
  - `CONF` honors `ORQ_TARGETS_CONF` env override (for fixture testing)
  - `sudo_word` → prints `sudo` or nothing for the current target
  - `run_for_targets <fn> <selector>` → runs `<fn> <target>` per target (selector `all` = every section), continues on failure, prints a summary, exit 1 if any failed; `<fn>` reports its failing stage by setting the global `STEP`
  - `cmd_verify_target <name>`, `cmd_logs <name> <n>`

- [ ] **Step 1: Write `deploy.sh`**

```bash
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
```

- [ ] **Step 2: Make it executable + syntax check**

Run: `chmod +x deploy.sh && bash -n deploy.sh && { command -v shellcheck >/dev/null && shellcheck -x deploy.sh || echo "shellcheck skipped"; }`
Expected: clean. (`-x` lets shellcheck follow the sourced common.sh.)

- [ ] **Step 3: Functional checks (fixture + dry-run; no real ssh happens)**

Reuse `$SCRATCH/targets-test.conf` from Task 1 Step 5 (recreate it if the scratchpad was cleared).

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run verify stub
echo "exit=$?"
```

Expected: `=== verify stub (root@198.51.100.7) ===`, one `DRY-RUN ssh root@198.51.100.7: set -e …` block (the multiline verify command, with `git -C /opt/orquester` **not** prefixed by sudo), then `=== summary ===` and `  stub: OK`, `exit=0`.

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run verify all; echo "exit=$?"
```

Expected: verify blocks for `stub` then `stub2` (stub2's remote command starts with `sudo git -C …`), summary lists both OK, `exit=0`.

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run logs stub2 -n 10
```

Expected: `DRY-RUN ssh ubuntu@198.51.100.8: sudo journalctl -u orquester -n 10 --no-pager`.

Error paths:

```bash
./deploy.sh; echo "exit=$?"                       # → usage, exit=2
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh bogus; echo "exit=$?"   # → usage + ERROR unknown command, exit=1
ORQ_TARGETS_CONF=/nonexistent ./deploy.sh verify stub; echo "exit=$?"             # → ERROR no targets file…, exit=1
```

- [ ] **Step 4: Commit**

```bash
git add deploy.sh
git commit -m "feat(deploy): deploy.sh skeleton — dispatch, dry-run, verify, logs"
```

---

### Task 4: `deploy`, `rollback`, `rotate-password`, smoke test, summary

**Files:**
- Modify: `deploy.sh`

**Interfaces:**
- Consumes: `run_payload` (Task 1), `deploy/lib/remote-update.sh` (Task 2), `run_for_targets`/`sudo_word`/`STEP` (Task 3), `scripts/smoke-web.mjs` (existing; usage `SMOKE_CHROME=<path> node scripts/smoke-web.mjs https://<domain>`, exit 0 = pass).
- Produces: working `./deploy.sh deploy [target|all]`, `rollback <target> <sha>`, `rotate-password <target>`. `preflight_pushed <branch>` and `smoke_test` are internal.

- [ ] **Step 1: Add the deploy/rollback/rotate functions**

Insert after `sudo_word()` in `deploy.sh`:

```bash
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
```

(Why `|` as the sed delimiter: the base64 alphabet is `A-Za-z0-9+/=` — it can contain `/` but never `|` or `&`, so the replacement is injection-safe.)

> **Review round 1 correction (applied):** the `cmd_rotate_password` body above is
> **not** sufficient — the daemon re-hashes `ORQUESTER_HTTP_PASSWORD` only when
> `daemon.json` has no `passwordHash`, so a restart alone leaves the old password
> valid. The shipped version additionally requires the `ORQUESTER_HTTP_PASSWORD=`
> line to exist, deletes `transports.http.passwordHash` from
> `/var/lib/orquester/daemon/daemon.json`, and verifies the salt from
> `/api/auth/info` changed across the restart before printing the new password.
> See the spec's `rotate-password` section.

- [ ] **Step 2: Wire the new commands into `main`'s case**

Replace the line `    verify) run_for_targets cmd_verify_target "${1:-all}" ;;` with:

```bash
    deploy) run_for_targets cmd_deploy_target "${1:-all}" ;;
    verify) run_for_targets cmd_verify_target "${1:-all}" ;;
    rollback)
      [ $# -eq 2 ] || die "usage: ./deploy.sh rollback <target> <sha>"
      cmd_rollback "$1" "$2" || die "rollback failed${STEP:+ (step: $STEP)}" ;;
    rotate-password)
      [ $# -eq 1 ] || die "usage: ./deploy.sh rotate-password <target>"
      cmd_rotate_password "$1" ;;
```

- [ ] **Step 3: Syntax check**

Run: `bash -n deploy.sh && { command -v shellcheck >/dev/null && shellcheck -x deploy.sh || echo "shellcheck skipped"; }`
Expected: clean.

- [ ] **Step 4: Functional checks (dry-run, fixture targets)**

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run deploy all; echo "exit=$?"
```

Expected, per target:
- `=== deploy stub (root@198.51.100.7) ===`
- a `WARN … (continuing: dry-run)` line if the local tree is dirty/unpushed (normal mid-implementation), otherwise nothing from preflight
- `DRY-RUN scp remote-update.sh -> root@198.51.100.7:<mktemp>` and `DRY-RUN ssh root@198.51.100.7: env SUDO= BRANCH=main bash <mktemp> </dev/null` (for stub2: `… env SUDO=sudo BRANCH=main …` — **no** `sudo` prefix before `env`, because remote-update self-sudos per command)
- stub: `no domain configured — skipping browser smoke test`; stub2: either the `DRY-RUN local: … smoke-web.mjs https://stub.example.com` line (Chrome found) or the `SKIPPED smoke test` warning (no Chrome)
- summary `stub: OK`, `stub2: OK`, `exit=0`.

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run rollback stub2 abc1234
```

Expected: DRY-RUN payload line containing `SUDO=sudo BRANCH=main RESET_REF=abc1234`.

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run rotate-password stub2
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh rollback stub; echo "exit=$?"
```

Expected: first prints a `DRY-RUN ssh ubuntu@…` block containing `sudo sed -i` and `NEW PASSWORD`; second dies with `usage: ./deploy.sh rollback <target> <sha>`, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add deploy.sh
git commit -m "feat(deploy): deploy, rollback, rotate-password + smoke test and summary"
```

---

### Task 5: `deploy/lib/remote-provision.sh` + `provision` subcommand

**Files:**
- Create: `deploy/lib/remote-provision.sh`
- Modify: `deploy.sh`

**Interfaces:**
- Consumes: `run_payload` with `RUN_AS_ROOT=1` (Task 1); existing `deploy/orquester.service`, `deploy/daemon.env.example` (placeholder `replace-with-a-32+char-random-secret`, default username `mapacho`), `deploy/Caddyfile` (placeholder vhost `orquester.example.com`), `deploy/provision-devtools.sh` (idempotent, must run as root).
- Produces: `./deploy.sh provision <target>`; payload runnable as `env DOMAIN=<d> REPO=<url> BRANCH=<b> bash remote-provision.sh </dev/null` as root.

- [ ] **Step 1: Write `deploy/lib/remote-provision.sh`**

```bash
#!/usr/bin/env bash
# Runs ON a fresh Ubuntu VPS as root (delivered by ./deploy.sh provision).
# Mirrors AGENTS.md "First-time provisioning" steps 1-7. Idempotent: safe to
# re-run after a partial failure. Inputs via env:
#   DOMAIN  (required) public domain — DNS A record must already point here
#   REPO    (required) git clone URL
#   BRANCH  default main
set -euo pipefail
trap 'echo "[provision] FAILED at line $LINENO" >&2' ERR

[ "$(id -u)" -eq 0 ] || { echo "[provision] must run as root" >&2; exit 1; }
: "${DOMAIN:?DOMAIN is required}"
: "${REPO:?REPO is required}"
BRANCH="${BRANCH:-main}"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n[provision] %s\n' "$*"; }

log "1/7 service user"
id orquester >/dev/null 2>&1 || useradd --system --create-home \
  --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester

log "2/7 packages: apt deps, Node 20, pnpm, Caddy"
apt-get update -qq
apt-get install -y git openssh-client tmux ufw python3 make g++ curl \
  ca-certificates p7zip-full ripgrep gnupg
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
fi

log "3/7 repo checkout + install + build"
if [ ! -d /opt/orquester/.git ]; then
  mkdir -p /opt/orquester
  git clone "$REPO" /opt/orquester
fi
cd /opt/orquester
git fetch origin -q
git checkout -q "$BRANCH"
git reset --hard -q "origin/$BRANCH"
CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null
chown -R root:root /opt/orquester

log "4/7 /etc/orquester/daemon.env"
GENERATED_PASSWORD=""
if [ ! -f /etc/orquester/daemon.env ]; then
  mkdir -p /etc/orquester
  GENERATED_PASSWORD="$(openssl rand -base64 32)"
  # base64 alphabet never contains '|' or '&' -> safe as sed replacement
  sed "s|replace-with-a-32+char-random-secret|$GENERATED_PASSWORD|" \
    deploy/daemon.env.example > /etc/orquester/daemon.env
  chown orquester:orquester /etc/orquester/daemon.env
  chmod 600 /etc/orquester/daemon.env
else
  log "daemon.env already exists — leaving it untouched"
fi

log "5/7 systemd unit + session devtools + start"
cp deploy/orquester.service /etc/systemd/system/orquester.service
bash deploy/provision-devtools.sh </dev/null
systemctl daemon-reload
systemctl enable --now orquester
systemctl restart orquester
curl -fsS --retry 30 --retry-delay 1 --retry-connrefused http://127.0.0.1:47831/health; echo

log "6/7 Caddy vhost for $DOMAIN"
sed "s|orquester.example.com|$DOMAIN|" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

log "7/7 firewall: allow 22 + 443 only"
ufw allow 22/tcp
ufw allow 443/tcp
ufw --force enable

log "DONE — https://$DOMAIN"
if [ -n "$GENERATED_PASSWORD" ]; then
  echo '=============================================================='
  echo ' HTTP password (username from daemon.env, default: mapacho):'
  echo "   $GENERATED_PASSWORD"
  echo ' Shown ONCE — save it in your password manager now.'
  echo '=============================================================='
fi
```

- [ ] **Step 2: Add `cmd_provision` to `deploy.sh`**

Insert after `cmd_rotate_password` (before `main`):

```bash
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
```

And add to `main`'s case (after the `deploy)` line):

```bash
    provision)
      [ $# -eq 1 ] || die "usage: ./deploy.sh provision <target>"
      cmd_provision "$1" ;;
```

- [ ] **Step 3: Syntax check**

Run: `bash -n deploy.sh deploy/lib/remote-provision.sh && { command -v shellcheck >/dev/null && shellcheck -x deploy.sh deploy/lib/remote-provision.sh || echo "shellcheck skipped"; }`
Expected: clean.

- [ ] **Step 4: Functional checks (dry-run + validation paths; provisioning itself cannot run locally)**

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run provision stub2
```

Expected: the two `=== provision …` / prerequisite lines, then `DRY-RUN scp remote-provision.sh -> ubuntu@198.51.100.8:<mktemp>` and `DRY-RUN ssh ubuntu@198.51.100.8: sudo env DOMAIN=stub.example.com REPO=git@github.com:you/orquester.git BRANCH=main bash <mktemp> </dev/null` (note the `sudo ` prefix — provision runs as root), exit 0, **no** curl attempt.

```bash
ORQ_TARGETS_CONF="$SCRATCH/targets-test.conf" ./deploy.sh --dry-run provision stub; echo "exit=$?"
```

Expected: `ERROR: target 'stub': provision requires 'domain' in targets.conf`, `exit=1`.

Payload input validation (runs locally, exits before touching the system — the root check fires only after env validation, and we run as non-root):

```bash
DOMAIN= REPO=x bash deploy/lib/remote-provision.sh; echo "exit=$?"
```

Expected: `DOMAIN: DOMAIN is required` (bash `:?` message) with nonzero exit. Then:

```bash
DOMAIN=d.example.com REPO=x bash deploy/lib/remote-provision.sh; echo "exit=$?"
```

Expected: `[provision] must run as root`, `exit=1`. (We are not root in this workspace, so nothing is touched.)

- [ ] **Step 5: Review payload against AGENTS.md provisioning steps 1–7 line by line**

Open AGENTS.md "First-time provisioning" and confirm each numbered step has a counterpart in the payload (user, tools+node+pnpm+caddy, clone+install+build+chown, daemon.env secrets, unit+provision-devtools+enable+health, Caddyfile+reload, ufw). This is the spec's stated acceptance for provision (best-effort until the next real fresh-VPS run). Note the one intentional difference: the payload builds with `pnpm --filter @orquester/web build` (the daemon serves only the SPA; the desktop app is useless on a VPS).

- [ ] **Step 6: Commit**

```bash
git add deploy.sh deploy/lib/remote-provision.sh
git commit -m "feat(deploy): provision subcommand + remote-provision payload"
```

---

### Task 6: Documentation — slim runbook template + AGENTS.md pointers

**Files:**
- Rewrite: `DEPLOY_TO_VPS.md.example`
- Modify: `AGENTS.md` (three edits)

**Interfaces:**
- Consumes: the CLI shape from Tasks 3–5 (exact subcommand names/flags).
- Produces: docs only.

- [ ] **Step 1: Rewrite `DEPLOY_TO_VPS.md.example`** with this full content:

```markdown
# Deploy to VPS — runbook (TEMPLATE)

> **Copy this to `DEPLOY_TO_VPS.md` and record anything machine-specific.** The
> real file is **gitignored** — never commit it. Host definitions live in
> `deploy/targets.conf` (also gitignored): copy `deploy/targets.conf.example`
> and fill in real hosts/keys. Private SSH keys live in `~/.ssh/`, not here.

All lifecycle operations go through **`./deploy.sh`** (run from the repo root on
your dev machine). Each VPS runs the daemon as a hardened systemd service from
`/opt/orquester` (appdir `/var/lib/orquester`) behind Caddy on 443; the daemon
listens on loopback `127.0.0.1:47831`.

## TL;DR

```sh
git push origin main          # the VPSes pull from origin — push first
./deploy.sh deploy all        # update + restart + verify every target
```

`deploy` refuses to run if your tree is dirty or local HEAD isn't pushed.

## Commands

| Command | What it does |
|---|---|
| `./deploy.sh deploy [target\|all]` | fetch/reset to `origin/<branch>`, `pnpm install`, SPA build, chown, restart, health check, live bundle hash — then the browser smoke test (`scripts/smoke-web.mjs`) if the target has a `domain` and a local Chrome exists. |
| `./deploy.sh provision <target>` | first-time setup of a fresh Ubuntu VPS (user, Node 20, pnpm, Caddy, clone, daemon.env with a generated password shown **once**, systemd, devtools, ufw). Needs `domain` + `repo` in targets.conf and the DNS A record already pointing at the host. |
| `./deploy.sh verify [target\|all]` | read-only: HEAD, `/health`, service state, bundle hash. |
| `./deploy.sh rollback <target> <sha>` | reset to `<sha>`, rebuild, restart, verify. |
| `./deploy.sh logs <target> [-n N]` | tail the daemon journal. |
| `./deploy.sh rotate-password <target>` | new HTTP password, installed + shown once. |

Add `--dry-run` (first argument) to print every local and remote command
without executing anything.

## Per-host notes (record yours here)

- Whether the host needs `ssh_opts` quirks (rotating host key → `-o
  StrictHostKeyChecking=accept-new`, forced identity → key= entry, …).
- Anything nonstandard about the box (custom port, jump host, etc.).

## Gotchas the script already enforces (don't work around them)

- **Push first** — deploy refuses on dirty tree / unpushed HEAD; the VPSes only
  see `origin/<branch>`.
- **`CI=1 pnpm install --frozen-lockfile`** — non-interactive; a pnpm version
  mismatch prompt would silently wedge a non-TTY deploy.
- **`</dev/null` on every pnpm call, payloads scp'd (never `bash -s`)** — pnpm
  reads stdin and would eat the rest of a piped script.
- **No pipes around the build** — a piped `vite build` failure would be masked
  and a stale/broken `dist` restarted into.
- **Verification is observed state** — health endpoint + live bundle hash, not
  SSH output. After a web change, hard-reload the browser (Cmd/Ctrl+Shift+R).
- **Caddy** — if `deploy/Caddyfile` changed, the deploy prints a reminder to
  reconcile `/etc/caddy/Caddyfile` by hand (it has your real domain in it).

## Troubleshooting

- `./deploy.sh logs <target> -n 100` (journalctl) · `systemctl status orquester` on the host.
- Bad deploy? `./deploy.sh rollback <target> <good-sha>`.
- Password leaked? `./deploy.sh rotate-password <target>`.
- One-time devtools/scoped-sudo catch-up for older hosts: run
  `deploy/provision-devtools.sh` on the host, then
  `systemctl daemon-reload && systemctl restart orquester` (new VPSes get it
  via `provision`).
```

- [ ] **Step 2: AGENTS.md edit 1 — runbook pointer paragraph**

Old string:

```
> **Before deploying, check for a local `DEPLOY_TO_VPS.md` at the repo root.** It's a
> **gitignored**, per-machine runbook that records the actual VPS targets (host, SSH login,
> key, sudo) and copy-paste deploy commands for this checkout — the fastest way to know
> *where* and *how* to deploy. If it's missing, copy `DEPLOY_TO_VPS.md.example` to
> `DEPLOY_TO_VPS.md` and fill in real values (which stay off git). The generic procedure is in
> **Routine updates** below.
```

New string:

```
> **Deploys go through `./deploy.sh`** (deploy / provision / verify / rollback / logs /
> rotate-password). Real host definitions live in the **gitignored** `deploy/targets.conf`
> (copy `deploy/targets.conf.example`); machine-specific notes live in the gitignored
> `DEPLOY_TO_VPS.md` (copy `DEPLOY_TO_VPS.md.example`). Check both before deploying. The
> manual command sequences below remain as reference/fallback for what the script runs.
```

- [ ] **Step 3: AGENTS.md edit 2 — First-time provisioning pointer**

Old string:

```
### First-time provisioning

```bash
```

New string:

```
### First-time provisioning

> **Preferred: `./deploy.sh provision <target>`** — runs this sequence on a fresh Ubuntu
> VPS (needs `domain` + `repo` in `deploy/targets.conf`; generates the HTTP password on the
> VPS and prints it once). The manual sequence below is the reference.

```bash
```

- [ ] **Step 4: AGENTS.md edit 3 — Routine updates pointer**

Old string:

```
### Routine updates

```bash
```

New string:

```
### Routine updates

> **Preferred: `./deploy.sh deploy all`** — runs exactly this sequence per target, plus
> bundle-hash verification and the browser smoke test, with the CI=1 / stdin-detach /
> no-pipes gotchas enforced structurally. The manual sequence below is the reference.

```bash
```

- [ ] **Step 5: Verify docs consistency**

Run: `grep -n "deploy.sh" AGENTS.md DEPLOY_TO_VPS.md.example | head -20` and re-read the three edited AGENTS.md spots in context.
Expected: pointers present; no contradictions with the surrounding text (the manual blocks still stand as reference).

- [ ] **Step 6: Commit**

```bash
git add DEPLOY_TO_VPS.md.example AGENTS.md
git commit -m "docs(deploy): runbook template + AGENTS.md point at deploy.sh"
```

---

### Task 7: Local migration + full lint + read-only acceptance

**Files:**
- Create (gitignored, real values): `deploy/targets.conf`
- Rewrite (gitignored, real values): `DEPLOY_TO_VPS.md`
- No commits of these files — verify git ignores them.

**Interfaces:**
- Consumes: the whole tool (Tasks 1–6) and the current local `DEPLOY_TO_VPS.md` (source of the real host values).

- [ ] **Step 1: Write the real `deploy/targets.conf`**

Translate the **Targets** table + notes of the existing local `DEPLOY_TO_VPS.md` into `deploy/targets.conf` (real IPs/users/keys — this file is gitignored; do NOT copy real values into any committed file or commit message). Mapping: vps-a → `user root`, its `~/.ssh/…vps` key, `sudo no`; vps-b → its login user + `~/.ssh/orq_deploy` key, `sudo yes`, `ssh_opts = -o StrictHostKeyChecking=accept-new`. Neither host has a domain today, so omit `domain` (smoke test will be skipped) and omit `repo` until provision is needed.

- [ ] **Step 2: Confirm it is ignored**

Run: `git status --porcelain -- deploy/targets.conf DEPLOY_TO_VPS.md`
Expected: empty output.

- [ ] **Step 3: Rewrite the local `DEPLOY_TO_VPS.md`**

Copy the new `DEPLOY_TO_VPS.md.example` structure and fill the "Per-host notes" section with the real quirks currently documented (vps-a's `~/.ssh/config` entry and explicit `root@`; vps-b's rotated host key + NOPASSWD sudo). Keep any still-relevant notes (e.g. the one-time devtools catch-up section) — this file is the human memory of the fleet.

- [ ] **Step 4: Full lint pass**

Run: `bash -n deploy.sh deploy/lib/common.sh deploy/lib/remote-update.sh deploy/lib/remote-provision.sh && { command -v shellcheck >/dev/null && shellcheck -x deploy.sh deploy/lib/*.sh || echo "shellcheck skipped"; }`
Expected: clean.

- [ ] **Step 5: Read-only acceptance against the real fleet**

Run: `./deploy.sh verify all`
Expected per target: `HEAD=<7-char sha>` (matching `origin/main`'s sha), `{"ok":true}`, `service=active`, `bundle=index-<hash>.js`, then a summary with both targets `OK` and exit 0. This makes real SSH connections but only reads state.

- [ ] **Step 6: Also sanity-check `logs`**

Run: `./deploy.sh logs <first-target-name> -n 5`
Expected: the last 5 daemon journal lines.

- [ ] **Step 7: Final `pnpm check` + stop**

Run: `pnpm check`
Expected: clean (nothing TS-related changed, but it's the repo's pre-commit gate).

**A real `./deploy.sh deploy` is deliberately NOT part of this plan** — it restarts the production daemon. Offer it to the user as the final acceptance step and run it only on their say-so.
