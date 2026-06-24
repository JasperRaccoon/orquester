# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
See `docs/superpowers/specs/2026-06-19-remote-vps-deployment-design.md` (Phase 0)
and `docs/superpowers/plans/2026-06-19-remote-phase0-vps-provisioning.md`.

- `orquester.service` → `/etc/systemd/system/orquester.service`
  - Runs the daemon via `node --import tsx` (the repo is `noEmit`; no dist build).
- `daemon.env.example` → copy to `/etc/orquester/daemon.env` (chmod 600), fill the password.
- `Caddyfile` → `/etc/caddy/Caddyfile` (set your real domain or a sslip.io host).

Install `p7zip-full` (or `libarchive-tools` for `bsdtar`) for archive previews — optional; without
either on PATH, archives degrade to a download card.

Never commit the real `daemon.env`.
