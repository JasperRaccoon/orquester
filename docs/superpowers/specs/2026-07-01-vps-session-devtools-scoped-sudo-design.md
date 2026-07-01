# VPS session dev-tooling + scoped sudo — design

- **Date:** 2026-07-01
- **Status:** Proposed — awaiting user approval (design chosen: *scoped sudo for package installs*)
- **Scope:** VPS deployment (`deploy/` + provisioning docs). No changes to daemon/app code.

## Problem

Agent/terminal sessions on the VPSes constantly hit two walls:

1. **Missing build tooling.** Confirmed absent from a live session (`orquester` user):
   `cmake`, `pkg-config`, `pip`/`pip3`/`pipx`/`uv`, `cargo-audit`, `bsdtar`; and `ensurepip`
   is broken, so `python3 -m venv` can't bootstrap pip. Present: `gcc/g++/make`, `cargo`,
   `node/npm/pnpm`, `git`, `curl`, `7z`, `zip`.
2. **`sudo` is unavailable** — and not merely password-gated. The live error is
   *"the 'no new privileges' flag is set, which prevents sudo from running as root."*

### Root causes

- The daemon runs as the unprivileged `orquester` user under a hardened systemd unit
  (`deploy/orquester.service`). Two directives block privilege/writes for the daemon **and every
  session it spawns**:
  - `NoNewPrivileges=true` — kernel `PR_SET_NO_NEW_PRIVS`; makes setuid elevation impossible for
    the whole process subtree. **No sudoers entry can override this** until it is removed and the
    daemon restarted.
  - `ProtectSystem=strict` — mounts the filesystem read-only (except `/dev`, `/proc`, `/sys`, and
    `ReadWritePaths=/var/lib/orquester`). So even *with* sudo, an in-session `apt install` fails on
    a read-only `/usr`.
- The provisioning apt line installs runtime deps only, not a dev toolchain.

Every failure in the motivating report (ensurepip, cargo-audit, cmake, semgrep installer) is a
**missing-tool** problem, not a needs-root-at-runtime problem — so most pain is fixed with zero
hardening loss. Runtime `sudo` is a separate, larger ask that the user explicitly opted into.

## Decision

Implement **tier 2 — scoped sudo for package installs**, in four parts:

1. Pre-install user-space tools into the appdir (no root, inherited by all sessions).
2. Add system build packages to provisioning (root, one-shot apt).
3. Grant the `orquester` user passwordless sudo **limited to package managers**, and minimally
   loosen the two blocking systemd directives.
4. Bake it all into `deploy/` + the runbooks so re-provisioning keeps it.

### ⚠️ Security caveat (explicitly accepted)

Scoping sudo to `apt-get`/`apt`/`dpkg` is a **convenience/intent boundary, not a security
boundary**. Anything that can run these as root can trivially become full root (package maintainer
scripts run as root; `apt-get -o …::Pre-Invoke=…` hooks; `dpkg -i ./x.deb`). Against the actual
threat model — public HTTPS + single password; a leaked password lets an attacker open a session —
**tier-2 exposure ≈ tier-3 (full root)**. It buys: protection from *accidental* root fat-fingering,
a documented allow-list, and trivial tighten/removal later. The standing mitigations are unchanged:
keep the password secret, keep the stack patched, loopback + Caddy + ufw + throttle stay intact.

## Design

### Part 1 — User-space tools (no root; immediate; per-appdir)

Installed under `$HOME=/var/lib/orquester` (writable; on session `PATH` via `~/.local/bin`,
`~/.cargo/bin`). Idempotent script `deploy/devtools-user.sh`:

- **`uv`** (Astral) via `curl -LsSf https://astral.sh/uv/install.sh | sh` → `~/.local/bin`.
  One tool that resolves the entire Python pain: `uv venv`, `uv pip`, `uv tool install <x>`
  (pipx replacement), and managed Python — no system `ensurepip`/`python3-venv` needed. Also
  unblocks semgrep (`uv tool install semgrep`).
- **`cargo-audit`** via `cargo install --locked cargo-audit` (compiles with the present `cargo`).
  Depends on the Part-2 system deps (`pkg-config`, `libssl-dev`) if a transitive crate needs
  OpenSSL — so run Part 2 first, or accept it may need them.

Deliberately **not** installed (YAGNI — not in the motivating workflows): `go`, extra language
runtimes, random CLIs. Add later on demand.

### Part 2 — System build packages (root; provisioning apt)

`sudo apt-get install -y` a curated dev-header set that cannot live in the appdir:

```
build-essential cmake pkg-config \
libssl-dev zlib1g-dev libffi-dev \
python3-venv python3-pip python3-dev \
libarchive-tools
```

Covers the common Rust `-sys`/CMake builds (`cmake`, `pkg-config`, `libssl-dev`), Python native
builds, native `ensurepip`/venv (complements `uv`), and `bsdtar` (Orquester's own archive-preview
and folder-zip features want it — see `deploy/README.md`).

### Part 3 — Scoped sudo (tier-2 core)

**`deploy/orquester.service` — two directives change (everything else stays):**

```diff
-NoNewPrivileges=true
-ProtectSystem=strict
-ReadWritePaths=/var/lib/orquester
+# Sessions run package managers via scoped sudo (see /etc/sudoers.d/orquester-pkg);
+# NNP would block setuid elevation for the whole subtree, so it must be off.
+NoNewPrivileges=false
+# Loosened from `strict` so scoped `sudo apt` can write /usr,/etc,/var. Kept as `strict`
+# with explicit carve-outs (NOT `off`) so /opt (the daemon code), /boot, /root, /home stay
+# read-only even to a root session. DAC still gates: the unprivileged daemon (uid 999) cannot
+# write these paths; only root-via-sudo-apt can. Three layers: mount-rw + DAC + scoped sudo.
+ProtectSystem=strict
+ReadWritePaths=/var/lib/orquester /usr /etc /var /run /tmp
```

`ProtectHome=true`, `KillMode=process`, `Restart=always`, etc. are **unchanged**.

> Fallback: if some maintainer script writes an uncovered path and apt errors on a read-only FS,
> set `ProtectSystem=off` (simplest, most permissive) instead of chasing carve-outs. Documented in
> the runbook.

**New `deploy/sudoers.d/orquester-pkg`** → `/etc/sudoers.d/orquester-pkg`, `root:root`, mode
`0440`, validated with `visudo -cf` before install:

```
# Scoped passwordless sudo for the orquester service user: package management only.
# SECURITY NOTE: convenience/intent boundary, NOT a hard boundary — apt/dpkg run
# maintainer scripts as root, so this is ~equivalent to full root. See design doc.
orquester ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/dpkg
```

### Part 4 — Out-of-the-box provisioning + docs (the primary durability requirement)

**A newly deployed VPS must get all of the above automatically** — the config is not a one-off
manual apply. So the first-time-provisioning flow is the source of truth, and existing VPSes catch
up by re-running the same idempotent script.

- **New `deploy/provision-devtools.sh`** (run as root, idempotent): `apt-get install` the Part-2
  set → install + `visudo`-validate the sudoers drop-in → run `deploy/devtools-user.sh` as the
  service user (`sudo -u <user> -H`). It does **not** restart the daemon — it prints the
  `daemon-reload` + `restart` reminder for the operator to run deliberately.
- **`AGENTS.md` → First-time provisioning step 5** runs `sudo bash deploy/provision-devtools.sh`
  right after copying the (already-loosened) unit and before `enable --now`, so a fresh VPS boots
  with dev tooling + scoped sudo in place. Plus a short *"Session dev tooling & scoped sudo"* note,
  a `daemon-reload`-on-unit-change reminder in Routine updates, and the ≈root caveat in Security posture.
- **`DEPLOY_TO_VPS.md`** (gitignored runbook): a *"One-time: session dev tooling + scoped sudo"*
  catch-up section for the existing VPSes.
- **`deploy/README.md` + `deploy/sudoers.d/orquester-pkg`**: the new files, documented.

## Applying it — new VPS (automatic) vs existing VPS (one-time catch-up)

Privileged steps need root + a daemon restart; done by the operator, **not** an in-session agent.
Real hosts/logins live only in the gitignored `DEPLOY_TO_VPS.md`.

- **New VPS:** nothing extra — `provision-devtools.sh` is wired into first-time provisioning
  (AGENTS.md step 5) and the loosened unit ships in `deploy/orquester.service` via `git`, so the
  host comes up correct out of the box.
- **Existing VPS (catch-up, once):** after `git push` + the normal deploy, run
  `[sudo] bash deploy/provision-devtools.sh`, then `[sudo] systemctl daemon-reload` and
  `[sudo] systemctl restart orquester`. `KillMode=process` keeps live sessions alive across it.

**The restart is safe for live sessions:** `KillMode=process` signals only the node process, so the
tmux server + all sessions (including the agent running this) survive and the daemon reattaches.

## Verification

From a fresh session after apply:

```sh
sudo -n apt-get --version >/dev/null && echo "scoped sudo: OK"
for t in uv cmake pkg-config cargo-audit bsdtar; do command -v $t || echo "$t MISSING"; done
python3 -m venv /tmp/_v && echo "venv OK" && rm -rf /tmp/_v      # or: uv venv /tmp/_v
```

## Rollback

- Remove `/etc/sudoers.d/orquester-pkg`; revert `deploy/orquester.service` to
  `NoNewPrivileges=true` / `ProtectSystem=strict` / `ReadWritePaths=/var/lib/orquester`;
  `daemon-reload` + `restart`. User-space tools can stay (harmless) or be removed from the appdir.

## Explicitly out of scope (YAGNI)

- Full/blanket passwordless sudo (tier 3) and `ProtectSystem=off` as the default.
- A hardened sudo wrapper that blocks apt escalation tricks — rejected: high complexity, marginal
  gain given the caveat is accepted; scoped-apt is already ≈root.
- Installing language runtimes/tools beyond the motivating Python+Rust needs.
```
