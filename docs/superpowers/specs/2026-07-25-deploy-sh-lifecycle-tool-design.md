# deploy.sh — Orquester VPS lifecycle tool (design)

**Date:** 2026-07-25
**Status:** Approved design, pre-implementation

## Problem

Deploying Orquester to a VPS currently relies on an AI coding agent following the
prose runbook (`DEPLOY_TO_VPS.md` + AGENTS.md "Routine updates" / "First-time
provisioning"). The steps are SSH one-liners with several hard-won, easy-to-forget
gotchas (`CI=1`, `</dev/null` stdin detach, no pipes around the build, verify by
live bundle hash). A human without an AI agent has to copy-paste and adapt these
commands by hand. We want a script that encodes the whole lifecycle so anyone can
deploy with one command.

## Goals

- One entry point covering the full lifecycle: routine deploy, first-time
  provisioning, verification, rollback, logs, password rotation.
- Every documented gotcha becomes structurally impossible to hit, not something
  to remember.
- Multi-target: the same command works for N VPSes with per-host quirks
  (root vs sudo login, custom key, custom ssh options).
- No secrets in git or in the config file; the runbook pattern (gitignored real
  file + committed `.example`) is preserved.

## Non-goals

- No push automation: `deploy` refuses to run when local `main` isn't pushed;
  it never pushes for you.
- No CI/CD integration, no parallel-target deploys, no non-systemd targets.
- Not a general-purpose tool — it assumes the Orquester production model
  (`/opt/orquester`, appdir `/var/lib/orquester`, Caddy on 443, daemon on
  loopback `127.0.0.1:47831`).

## Architecture

**Orchestrator + remote payload scripts.** A local entry point runs on the dev
machine, reads a gitignored target config, and executes small committed payload
scripts on the VPS by copying them over first (never by piping into `bash -s`).

```
deploy.sh                        # entry point at repo root (orchestrator)
deploy/
  targets.conf.example           # committed template
  targets.conf                   # gitignored — real hosts
  lib/
    common.sh                    # config parser, ssh/scp helpers, output formatting
    remote-update.sh             # payload: routine update cycle (runs ON the VPS)
    remote-provision.sh          # payload: first-time setup (runs ON the VPS)
```

Dependency rule: `deploy.sh` sources `deploy/lib/common.sh`; payloads are
self-contained bash (they receive settings via environment variables set on the
remote invocation line, not by sourcing local files).

### Target config: `deploy/targets.conf`

INI-style, one section per host. Parsed by a ~20-line parser in `common.sh`
(section headers + `key = value`; `#` comments; whitespace-tolerant).

```ini
[vps-a]
host   = 203.0.113.10
user   = root
key    = ~/.ssh/id_ed25519_vps     # optional; omit to let ~/.ssh/config decide
sudo   = no                        # yes -> every remote command prefixed with sudo
domain = example.com               # optional; enables smoke test + provision's Caddy setup
repo   = git@github.com:you/orquester.git   # required by provision only
branch = main                      # optional, default main
ssh_opts = -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes  # optional extras
```

Required per target: `host`, `user`, `sudo`. Everything else optional with the
defaults above. `deploy/targets.conf` is added to `.gitignore`;
`targets.conf.example` is committed with placeholder values (`203.0.113.x`,
`example.com` — repo convention: never a real domain/IP/secret).

## Subcommands

### `./deploy.sh deploy [target|all]`

1. **Local preflight** (once): `git fetch origin`; refuse with a clear message if
   the working tree is dirty or `HEAD != origin/<branch>` ("push first — the
   VPSes pull from origin"). Never pushes automatically.
2. **Per target:** copy `remote-update.sh` to a `mktemp` path on the host, run it
   with stdin detached. The payload does:
   - record old HEAD, `git fetch` + `git reset --hard origin/<branch>`, print new HEAD
   - `CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null`
   - `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm --filter @orquester/web build </dev/null`
   - `chown -R root:root /opt/orquester`
   - if `deploy/Caddyfile` changed between old and new HEAD: print a loud
     reminder to reconcile `/etc/caddy/Caddyfile` + `systemctl reload caddy`
     (not auto-applied — the live file has the real domain substituted)
   - `systemctl restart orquester`
   - health check: `curl -fsS --retry 25 --retry-delay 1 --retry-connrefused
     http://127.0.0.1:47831/health`
3. **Verify from the outside:** fetch the live bundle hash
   (`curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js'` via ssh) and
   report it; `systemctl is-active orquester`.
4. **Smoke test:** if the target has `domain` and a local Chrome/Chromium is
   found (`SMOKE_CHROME` respected), run
   `node scripts/smoke-web.mjs https://<domain>`; otherwise print a loud SKIPPED
   warning. A smoke-test failure fails the deploy for that target.

### `./deploy.sh provision <target>`

First-time setup of a fresh Ubuntu VPS, mirroring AGENTS.md provisioning steps
1–7. Runs `remote-provision.sh` on the host (login must be root or full-sudo).
Steps, each idempotent so a half-failed run can be re-run:

1. Service user `orquester` (guarded `useradd`), home `/var/lib/orquester`.
2. apt deps (`git openssh-client tmux ufw python3 make g++ curl ca-certificates
   p7zip-full ripgrep`), Node 20 via NodeSource, `npm install -g pnpm`, Caddy
   from its official apt repo.
3. Clone `repo` into `/opt/orquester` (skip if present), checkout `branch`,
   `CI=1 pnpm install --frozen-lockfile </dev/null`, `pnpm build </dev/null`,
   `chown -R root:root /opt/orquester`.
4. `/etc/orquester/daemon.env` from `deploy/daemon.env.example` with an
   **on-VPS generated password** (`openssl rand -base64 32`), chmod 600, owned
   by `orquester`. If the file already exists it is left untouched (re-run safe).
   The generated password is printed exactly once at the end of provisioning —
   it is never stored on the dev machine or in the config.
5. systemd unit from `deploy/orquester.service`, then
   `bash deploy/provision-devtools.sh` (reused, not duplicated),
   `systemctl daemon-reload && systemctl enable --now orquester`, health curl.
6. Caddy: `deploy/Caddyfile` with `domain` substituted → `/etc/caddy/Caddyfile`,
   `systemctl reload caddy`. Requires `domain` in the target config; provision
   aborts early (before touching the host) if it's missing. DNS A record setup
   remains a documented manual prerequisite.
7. ufw: allow 22 + 443, enable.

Final output: the health check result, the HTTPS auth-info check
(`curl https://<domain>/api/auth/info`), and the one-time password block.

### `./deploy.sh verify [target|all]`

Read-only per target: HEAD sha, `/health`, `systemctl is-active`, live bundle
hash. This is the runbook's "verify both at a glance" as a command.

### `./deploy.sh rollback <target> <sha>`

Same as deploy's remote cycle but `git reset --hard <sha>` instead of
`origin/<branch>`, then install → build → restart → the same verification.
Local preflight (pushed check) is skipped — rollback targets an already-fetched
sha. If the sha isn't present on the remote, the payload fails loudly.

### `./deploy.sh logs <target> [-n N]`

`journalctl -u orquester -n N --no-pager` (default 50), sudo-aware.

### `./deploy.sh rotate-password <target>`

On the VPS: generate a new password (`openssl rand -base64 32`), patch
`ORQUESTER_HTTP_PASSWORD` in `/etc/orquester/daemon.env`, **delete the stale
`transports.http.passwordHash` from `<appdir>/daemon/daemon.json`**, restart the
daemon, health check, print the new password exactly once.

The hash deletion is not optional: `migrateHttpPassword()`
(`apps/daemon/src/index.ts`) hashes the env plaintext only `if (!http.passwordHash)`,
and an already-provisioned host always has one on disk — a restart alone would
silently keep the OLD password valid. For the same reason the command refuses to
run if `daemon.env` has no `ORQUESTER_HTTP_PASSWORD=` line (sed would be a no-op),
and it proves the rotation by comparing the bcrypt salt from the public
`/api/auth/info` before and after the restart, failing loudly *before* printing
anything if the salt did not change.

## Remote execution mechanics (gotchas encoded structurally)

- **Never `bash -s` / heredoc piping.** Payloads are `scp`'d to a `mktemp` path
  and run as `ssh host 'bash /tmp/xxx </dev/null'`; the temp file is removed
  after. pnpm physically cannot eat script lines from stdin.
- **pnpm invocations written once** inside the payloads, always as
  `CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm … </dev/null`.
- **No pipes around the build.** `set -euo pipefail` in every script; the build
  runs bare so a failed `vite build` aborts before `systemctl restart`.
- **sudo unified.** Payloads use a `$SUDO` variable (`""` or `"sudo"`) derived
  from the target's `sudo=` flag; one payload serves both host shapes. For
  `sudo=yes` targets the orchestrator assumes NOPASSWD sudo (documented).
- **Settings crossing the wire** (branch, sudo flag, flags like rollback sha)
  are passed as `KEY=value` assignments on the remote `bash` invocation line —
  payloads never depend on files other than themselves and the repo checkout.
- **Verification is by observed state** (health endpoint, live bundle hash,
  service active), never by eyeballing SSH output.

## Error handling

- `set -euo pipefail` + an ERR trap printing script name and line number, in the
  orchestrator and every payload.
- `deploy all` / `verify all` run targets **sequentially**; a failure on one is
  recorded, remaining targets still run, and a final summary table shows
  per-target OK/FAILED with the failing step. Exit code non-zero if any failed.
- Clear preflight errors: missing `targets.conf` (with "copy
  deploy/targets.conf.example" hint), unknown target name, missing required
  keys, key file not found, dirty tree, unpushed HEAD.
- `--dry-run` on `deploy`, `provision`, and `rollback`: prints every local and
  remote command (payload shown, not executed) so the script can be trusted
  before its first real run.

## Testing & acceptance

This repo has no test runner; verification is:

1. `bash -n` on all scripts + `shellcheck` if available on the dev machine.
2. `--dry-run` inspection of `deploy` and `provision` output.
3. Real acceptance: `./deploy.sh verify all` (read-only), then a real
   `./deploy.sh deploy <target>` against a production VPS, confirmed by health,
   bundle hash, and smoke test.
4. `provision` is best-effort until the next real fresh-VPS provisioning; its
   command sequence is reviewed against AGENTS.md steps 1–7 line by line.

## Documentation updates (part of this work)

- `DEPLOY_TO_VPS.md.example` slims to: how to fill `targets.conf`, `deploy.sh`
  usage, troubleshooting. The gotchas section is kept but reframed as an
  explanation of what the script already enforces. (The local gitignored
  `DEPLOY_TO_VPS.md` gets migrated the same way, keeping real host notes.)
- AGENTS.md "Routine updates" points at `./deploy.sh deploy`; "First-time
  provisioning" points at `./deploy.sh provision` and keeps the manual command
  sequence as a reference appendix (provision is the least battle-tested path).
- `.gitignore` gains `deploy/targets.conf`.
