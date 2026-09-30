# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
Use the repository-root `./deploy.sh` for provisioning and deployment commands.

- `orquester.service` → `/etc/systemd/system/orquester.service`
  - Runs the daemon via `node --import tsx` (the repo is `noEmit`; no dist build).
- `daemon.env.example` → copy to `/etc/orquester/daemon.env` (chmod 600), fill the password.
- `opencode.env.example` → optional per-launcher proxy env; copy to
  `/var/lib/orquester/daemon/env/opencode.env` (chmod 600) to affect only OpenCode sessions.
- `Caddyfile` → `/etc/caddy/Caddyfile` (set your real domain or a sslip.io host).
- `provision-devtools.sh` → run once per VPS as root: installs system build deps, the scoped-sudo
  drop-in (`sudoers.d/orquester-pkg`), and user-space tools (`devtools-user.sh`: `uv`, `cargo-audit`).
  First-time provisioning runs it, so any **new** VPS gets session dev tooling + scoped sudo out of
  the box. Idempotent — re-run to catch up an **existing** VPS, then `systemctl daemon-reload && systemctl restart orquester`.
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

Never commit the real `daemon.env`.
