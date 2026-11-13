# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
Use the repository-root `./deploy.sh` for provisioning and deployment commands.

- `orquester.service` → `/etc/systemd/system/orquester.service`
  - Runs the daemon via `node --import tsx` (the repo is `noEmit`; no dist build).
- `orquester-update.service`, `orquester-update.path` → `/etc/systemd/system/`: self-update from
  the UI (see "Self-update" below); installed by `install-unit.sh`.
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
- `install-voxl.sh` → installs the pinned voxl H.264 desktop streamer (see below); run as root.
- `install-gdu.sh` → installs the pinned gdu disk scanner for the Storage view (see below); run as root.
- `install-unit.sh` → installs `orquester.service` (with `systemctl daemon-reload` when it changed)
  and `/etc/needrestart/conf.d/orquester.conf` (`$nrconf{override_rc}{qr(^orquester\.service$)} = 0;`,
  checked with `perl -c` first), so needrestart never restarts the daemon after an apt upgrade, and
  `/etc/tmpfiles.d/orquester.conf` (from `orquester-tmpfiles.conf`): the daily
  `systemd-tmpfiles-clean` run deletes tsx transpile-cache entries under `/var/lib/orquester/tmp/tsx-*`
  that nothing has used for 2 days, since tsx lists that whole directory at every start. It also
  sets BBR congestion control and a 64 MB TCP send buffer limit, now and at boot
  (`/etc/sysctl.d/99-orquester.conf`, from `orquester-sysctl.conf`), because CUBIC and the default
  4 MB limit hold downloads to distant users to a few Mbit/s on lossy routes; if a host rejects them
  the file isn't installed and the deploy continues. Run as
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
the daemon. `./deploy.sh rollback <target> <sha>` runs the same cycle with that sha. One update runs
per checkout at a time (`flock` on `.git/orq-deploy.lock`, shared with self-update below): a second
one exits 5 without touching anything.
`deploy/lib/remote-update.test.mjs` (in `pnpm test`) drives the script against a throwaway checkout
with stubbed `systemctl`, `curl` and `pnpm`.

### Self-update

Settings → General → About offers **Update** when the daemon's commit is behind its origin's `main`
and its unit sets `ORQUESTER_SELF_UPDATE_STATUS`. The button makes the daemon create
`/var/lib/orquester/daemon/update-request` (content ignored); `orquester-update.path` sees it and
starts the root oneshot `orquester-update.service`, which removes the request, copies
`lib/self-update.sh` and `lib/remote-update.sh` to `/run/orquester-update/` and runs the same cycle
as `./deploy.sh deploy` on `main` (fetch, reset, install, build, restart, health check, automatic
revert; no browser smoke test). It runs outside the daemon's unit, so the restart doesn't stop it.
The wrapper records the run in `/var/lib/orquester-update/status.json` (root-owned, world-readable):
`running`, then `succeeded`, `reverted` (exit 3) or `failed`, with `from`, `startedAt`,
`finishedAt` and `exitCode` (`from` is the stamped commit the daemon runs). A run is limited to 2 h
(`TimeoutStartSec`); the daemon reports a `running` record older than 3 h as failed, and a request
nothing took for 5 minutes (the path unit is not active) as stalled — a new click replaces it. The
page reloads once the daemon is back on a new commit. Its output
is in `journalctl -u orquester-update`. `install-unit.sh` installs and enables the units, so an
existing VPS gets self-update after one more `./deploy.sh deploy`; `./deploy.sh verify` prints
`update-path=active`. `deploy/lib/self-update.test.mjs` drives the wrapper with a stub update script.

Rolling back to a build from before agent host generations is safe only while the daemon has never
switched agent hosts during an update. After a switch, first end the `orqsvc-agent-host-<N>` tmux
sessions, or wait until `<appdir>/daemon/agent-hosts.json` lists only a generation 0 primary. An
older daemon knows only generation 0, so it would lose track of the chats the other hosts run.

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

### Desktop tabs — voxl (H.264 video)

voxl ([tembo/voxl](https://github.com/tembo/voxl), the `voxl-server` crate) streams a desktop as
H.264 over a WebSocket; desktops use it when it is installed and fall back to RFB/noVNC when it is
not. `install-voxl.sh` (run as root by provision and every deploy, best-effort like `install-go.sh`)
installs voxl's runtime libraries (`libx264-164 libyuv0 libopus0 libpulse0`) and builds a
**pinned** voxl — currently **0.3.4** — once per version:

- build dependencies from apt: `ca-certificates build-essential pkg-config clang libclang-dev
  libx264-dev libyuv-dev libopus-dev libpulse-dev libxcb1-dev esbuild cargo-1.85 rustc-1.85`
  (Ubuntu 24.04's versioned Rust 1.85.1; voxl 0.3.4 with `--locked` needs rustc ≥ 1.85, the default
  apt rustc 1.75 is too old, so no rustup is involved);
- `cargo install voxl-server --version =0.3.4 --locked`, run as `nobody` (`VOXL_BUILD_USER`) in a
  temp dir under `/opt/orquester-tools/voxl/` — 4–9 minutes on a busy 16-core host;
- the stripped binary (6 MB) at `/opt/orquester-tools/voxl/0.3.4/voxl`, symlinked at
  `/usr/local/bin/voxl` (an existing non-symlink there is left alone).

With the pinned version installed it only checks the runtime libraries. A failure only warns
(`voxl=FAILED: …` at the end of the deploy output, `voxl=<version>` on success): the daemon still
restarts and desktops stream with RFB. The daemon looks for voxl at `ORQUESTER_VOXL_BIN`, then
`<appdir>/bin/voxl`, then the sessions' PATH, then `/usr/local/bin/voxl`; `GET /api/desktops/host`
reports it under `voxl`. It runs voxl per desktop only while someone watches it, on 127.0.0.1 with a
random per-desktop password, and copies the binary into Linux VMs for their desktops (the VM's GUI
installer adds the runtime libraries). To bump: set `VOXL_VERSION` (and `RUST_SERIES` when the new
release needs a newer rustc) in `install-voxl.sh`; the next deploy builds it.

voxl links x264, which is GPL-2.0, so the built binary is GPL: it is built on each host for that
host (and its VMs) and is not distributed.

### Host status → Storage — gdu (disk scanner)

The Storage view's treemap is built from scans by [gdu](https://github.com/dundee/gdu) (MIT).
`install-gdu.sh` (run as root by provision and every deploy, best-effort like `install-voxl.sh`)
downloads the official release tarball of a **pinned** gdu — currently **v5.39.0** —
(`gdu_linux_amd64_static.tgz` or `gdu_linux_arm64.tgz`; other architectures fail with a clear
message), verifies its sha256, checks that the binary reports the pinned version, and installs it at
`/opt/orquester-tools/gdu/v5.39.0/gdu` (root-owned, 0755), symlinked at `/usr/local/bin/gdu` (an
existing non-symlink there is left alone). It is a no-op when the pinned version is installed.

A failure only warns (`gdu=FAILED: …` at the end of the deploy output, `gdu=<version>` on success):
the daemon still restarts, and the Storage view shows that the scanner is not installed and how to
install it. The daemon looks for gdu at `<appdir>/bin/gdu`, then the sessions' PATH, then
`/usr/local/bin/gdu`. To bump: set `GDU_VERSION`, `GDU_SHA256_AMD64` and `GDU_SHA256_ARM64` in
`install-gdu.sh` from the `gdu_linux_amd64_static.tgz` / `gdu_linux_arm64.tgz` lines of the
release's `sha256sums.txt`; the next deploy installs it.

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
