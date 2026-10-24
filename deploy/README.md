# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
Use the repository-root `./deploy.sh` for provisioning and deployment commands.

- `orquester.service` → `/etc/systemd/system/orquester.service`
  - Runs the daemon via `node --import tsx` (the repo is `noEmit`; no dist build).
- `daemon.env.example` → copy to `/etc/orquester/daemon.env` (chmod 600), fill the password.
  `ORQUESTER_PUBLIC_URL=https://<domain>` is the daemon's public origin: Ephemeral AI VMs use it as
  the default Public URL, and macOS boxes (GitHub Actions runners, outside any tailnet) always dial
  it. `./deploy.sh provision` and `./deploy.sh deploy`/`rollback` add it from the target's `domain`
  (`lib/ensure-public-url.sh`) when the file has no `ORQUESTER_PUBLIC_URL=` line; an existing value
  is never changed, and the file stays 0600. Restart the daemon after editing it by hand.
- `opencode.env.example` → optional per-launcher proxy env; copy to
  `/var/lib/orquester/daemon/env/opencode.env` (chmod 600) to affect only OpenCode sessions.
- `Caddyfile` → `/etc/caddy/Caddyfile` (set your real domain or a sslip.io host).
- `provision-devtools.sh` → run once per VPS as root: installs system build deps, the scoped-sudo
  drop-in (`sudoers.d/orquester-pkg`), and user-space tools (`devtools-user.sh`: `uv`, `cargo-audit`).
  First-time provisioning runs it, so any **new** VPS gets session dev tooling + scoped sudo out of
  the box. Idempotent — re-run to catch up an **existing** VPS, then `systemctl daemon-reload && systemctl restart orquester`.
- `install-go.sh` → installs the pinned Go toolchain that builds `orq-agent` (see below); run as root.
- `install-unit.sh` → installs `orquester.service` (with `systemctl daemon-reload` when it changed)
  and `/etc/needrestart/conf.d/orquester.conf` (`$nrconf{override_rc}{qr(^orquester\.service$)} = 0;`,
  checked with `perl -c` first), so needrestart never restarts the daemon after an apt upgrade, and
  `/etc/tmpfiles.d/orquester.conf` (from `orquester-tmpfiles.conf`): the daily
  `systemd-tmpfiles-clean` run deletes tsx transpile-cache entries under `/var/lib/orquester/tmp/tsx-*`
  that nothing has used for 2 days, since tsx lists that whole directory at every start. Run as
  root from the checkout; idempotent; it never restarts anything itself. Provisioning and every
  deploy run it before their own (re)start, so a changed unit — e.g. `OOMPolicy=continue`, which keeps
  one OOM-killed agent process from stopping the whole unit — applies at the deploy's restart.
- `devtools-user.sh` → user-space tool installer (no root); also runnable from a session to refresh
  `uv`/`cargo-audit` in the appdir.
- `sudoers.d/orquester-pkg` → scoped passwordless sudo (`apt`/`apt-get`/`dpkg`) for the service user.
  These package-management commands effectively grant root access.
- `targets.conf.example` → copy to `deploy/targets.conf` (**gitignored** — real hosts, never committed)
  and fill in one `[name]` section per VPS.
- `lib/` → helpers for the repo-root `./deploy.sh` (deploy / provision / verify / rollback / logs /
  rotate-password): `common.sh` (targets.conf parser, ssh/scp helpers, output) plus the payloads
  `remote-update.sh` and `remote-provision.sh`, which are `scp`'d to the VPS and run there.

`./deploy.sh provision <target>` installs the templates above onto a fresh VPS; the rest of this
file documents what those templates are for.

### Deploy health check and automatic revert

`remote-update.sh` restarts the daemon and then waits up to 10 minutes (`HEALTH_WAIT`, 600 s) for
`/health` and an active unit. If the new release never gets there, it resets the tree to the last
successful deploy (`.git/orq-last-deployed-head`), rebuilds it, restarts it and checks it the same
way. The deploy fails either way: exit 3 means the previous release is back and healthy (the summary
says `AUTO-REVERTED`), exit 4 means it did not come back either and the daemon needs attention now
(`./deploy.sh logs <target>`). A build or native-module failure before the restart never restarts
the daemon. `./deploy.sh rollback <target> <sha>` runs the same cycle with that sha.
`deploy/lib/remote-update.test.mjs` (in `pnpm test`) drives the script against a throwaway checkout
with stubbed `systemctl`, `curl` and `pnpm`.

Each deploy writes `/opt/orquester/.orquester-version.json` (`commit`, `version`, `deployedAt`;
gitignored) before the restart. The daemon reads its version and commit once at boot, from git or
from this stamp when `.git` is missing, and reports them in the authenticated `GET /api/info`
(Settings → General → About shows them); the deploy output prints `version=… commit=…`.

Native modules: the daemon loads `better-sqlite3` and `node-pty` under the host's Node. After the
install and SPA build, `remote-update.sh` and `remote-provision.sh` run
`scripts/ensure-node-native.mjs`, which loads each one in a child `node`, runs `pnpm rebuild` for
any that fail (a Node upgrade, or binaries rebuilt for Electron), and fails the deploy *before* the
service (re)starts if they still do not load. Run it by hand from the repo root the same way:
`node scripts/ensure-node-native.mjs`.

### orq-agent (boxes) — Go toolchain

`orq-agent` (`apps/box-agent`) is written in Go; building it needs Go ≥ the `go` line in
`apps/box-agent/go.mod`. `install-go.sh` (run as root by provision and every deploy) installs a
**pinned** Go — currently **1.27.3** — into `/usr/local/go`, verifying the tarball's sha256, plus a
`/usr/local/go/bin/go` symlink at `/usr/local/bin/go` (an existing non-symlink there is left alone).
It is a no-op when the pinned version is already installed. After `pnpm install`, provision and
deploy run `pnpm --filter @orquester/box-agent build` with `GO=/usr/local/go/bin/go
GOTOOLCHAIN=local`, which writes `apps/box-agent/dist/manifest.json`. `orquester.service` sets
`GO=/usr/local/go/bin/go` so the daemon can build on demand into the appdir when there is no dist
(existing units without that line still find Go through the `/usr/local/bin/go` symlink on PATH).

A Go install or build failure only warns (`box-agent=FAILED…` at the end of the deploy output):
`apps/box-agent/dist` is removed so no stale agent is served, the daemon still restarts, and boxes
fall back to an on-demand build, or report orq-agent builds unavailable when Go is missing.
`./deploy.sh verify` prints the prebuilt `box-agent` version and the `go` version.

To bump Go: set `GO_VERSION`, `GO_SHA256_AMD64` and `GO_SHA256_ARM64` in `install-go.sh` from the
`linux-amd64` / `linux-arm64` archive entries of `https://go.dev/dl/?mode=json`; the next deploy
installs it.

Archive previews want `p7zip-full` or `libarchive-tools` (`bsdtar`) on PATH; `provision-devtools.sh`
installs `libarchive-tools`. Without either, archives degrade to a download card.

### Browser tabs (Design Mode) — host Chromium

Browser tabs need a chromium/chrome binary on the daemon host. On Ubuntu,
**do not** `apt install chromium` (it's a snap — confined, breaks under the
service's systemd hardening). Install Google Chrome's .deb instead:

    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y ./google-chrome-stable_current_amd64.deb

The daemon detects it through the registry probe; no config needed. Profiles
(cookies) live under /var/lib/orquester/daemon/browser-profiles (0700).
If Chromium can't sandbox on the host, the daemon retries with --no-sandbox
and the UI shows a shield warning on the tab.

### Desktop tabs — host packages and CSP

Desktop tabs (Linux GUI apps on a virtual display, with audio) need
`tigervnc-standalone-server openbox pulseaudio pulseaudio-utils dbus-x11
libgl1-mesa-dri ffmpeg` on the daemon host and a tmux ≥ 3.2. `remote-provision.sh`
installs them; on an existing VPS, install them with `apt-get` (idempotent). Without
PulseAudio or ffmpeg, desktops still run, without sound. `GET /api/desktops/host`
(and the MCP's `desktop_host_status`) reports what is missing.

The audio decoder's WebAssembly fallback needs `'wasm-unsafe-eval'` in the `@app`
block's `script-src` (it allows compiling WebAssembly only, not JS `eval`). The
template `Caddyfile` has it; when deploying, make the same change in the live
`/etc/caddy/Caddyfile` and `systemctl reload caddy`.

### Agent visuals — Caddy carve-out

An agent can publish an HTML page that renders inline in its chat thread. The
web client frames it from `/api/agent-visuals/*` (a signed, short-lived URL),
which needs its own `header @visuals` block: the daemon's sandbox CSP plus
`frame-ancestors 'self'` and no `X-Frame-Options: DENY`, and that path excluded
from `@app`. The template `Caddyfile` has both; when deploying, reconcile the
live `/etc/caddy/Caddyfile` with it and `systemctl reload caddy`, or inline
pages show as blocked frames on the web (the desktop app is unaffected).

Never commit the real `daemon.env`.
