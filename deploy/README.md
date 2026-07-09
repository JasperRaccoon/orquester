# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
See `docs/superpowers/specs/2026-06-19-remote-vps-deployment-design.md` (Phase 0)
and `docs/superpowers/plans/2026-06-19-remote-phase0-vps-provisioning.md`.

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
  ≈root — see `docs/superpowers/specs/2026-07-01-vps-session-devtools-scoped-sudo-design.md`.

Archive previews want `p7zip-full` or `libarchive-tools` (`bsdtar`) on PATH; `provision-devtools.sh`
installs `libarchive-tools`. Without either, archives degrade to a download card.

Never commit the real `daemon.env`.
