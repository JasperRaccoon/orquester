# Remote VPS — Phase 0: Provisioning Runbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the existing daemon on a VPS behind a Caddy HTTPS reverse proxy with the current password auth, reachable from any browser and from the desktop app — with **zero application code changes**.

**Architecture:** Caddy listens on :443 (Let's Encrypt TLS) and reverse-proxies to the daemon bound on `127.0.0.1:47831`, which is run as an unprivileged `orquester` systemd service and also serves the prebuilt web SPA (same origin). The firewall exposes only SSH + 443. Reusable server-config templates are committed to the repo under `deploy/`.

**Tech Stack:** Ubuntu 22.04/24.04 LTS, systemd, Caddy 2 + Let's Encrypt, Node 20 LTS, pnpm, tmux, ufw.

## Global Constraints

- This phase changes **no application code**. Its only repo deliverable is the committed `deploy/` templates (Task 1); Tasks 2–6 are server operations verified with commands, not git commits.
- The daemon binds `127.0.0.1` only; **only Caddy is public**; `ufw` allows **22 + 443 only**.
- A domain is ready: replace `orquester.example.com` everywhere with your real (sub)domain, and create a DNS `A` record → VPS IP before Task 5.
- `ORQUESTER_HTTP_PASSWORD` must be a **32+ char random secret**. Never commit the real password — only `deploy/daemon.env.example` with a placeholder.
- `ORQUESTER_HTTP_USERNAME=mapacho` is set now but is **ignored until Phase 1** (current auth is password-only). Phase 0 login uses the password alone.
- The daemon runs as the unprivileged `orquester` user (home `/var/lib/orquester`); admin commands use `sudo`.

---

### Task 1: Commit reusable deploy templates to the repo

**Files:**
- Create: `deploy/orquester.service`
- Create: `deploy/Caddyfile`
- Create: `deploy/daemon.env.example`
- Create: `deploy/README.md`

**Interfaces:**
- Produces: version-controlled server-config templates referenced by Tasks 2–6.

- [ ] **Step 1: Create `deploy/orquester.service`**

```ini
[Unit]
Description=Orquester daemon
After=network-online.target
Wants=network-online.target

[Service]
User=orquester
Group=orquester
WorkingDirectory=/opt/orquester
EnvironmentFile=/etc/orquester/daemon.env
ExecStart=/usr/bin/node /opt/orquester/apps/daemon/dist/cli.js --appdir /var/lib/orquester
Restart=always
RestartSec=2
# CRITICAL (Phase 2): leaves the tmux server alive across daemon restarts.
KillMode=process
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/orquester
ProtectHome=true
# tmux socket lives under /var/lib/orquester, not /tmp:
PrivateTmp=false

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create `deploy/Caddyfile`**

```
# Replace orquester.example.com with your real (sub)domain.
orquester.example.com {
    reverse_proxy 127.0.0.1:47831       # WebSocket upgrade handled automatically
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"
        # Tune CSP to the SPA (xterm/codemirror use inline styles; WS needs wss:).
        Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        -Server
    }
}
```

- [ ] **Step 3: Create `deploy/daemon.env.example`**

```
ORQUESTER_HTTP_ENABLED=true
ORQUESTER_HTTP_HOST=127.0.0.1
ORQUESTER_HTTP_PORT=47831
# Generate with: openssl rand -base64 32
ORQUESTER_HTTP_PASSWORD=replace-with-a-32+char-random-secret
ORQUESTER_HTTP_USERNAME=mapacho
ORQUESTER_WEB_DIR=/opt/orquester/apps/web/dist
HOME=/var/lib/orquester
```

- [ ] **Step 4: Create `deploy/README.md`**

```markdown
# Deploy templates

Server-config templates for running the orquester daemon on a VPS behind Caddy.
See `docs/superpowers/specs/2026-06-19-remote-vps-deployment-design.md` (Phase 0)
and `docs/superpowers/plans/2026-06-19-remote-phase0-vps-provisioning.md`.

- `orquester.service` → `/etc/systemd/system/orquester.service`
- `daemon.env.example` → copy to `/etc/orquester/daemon.env` (chmod 600), fill the password
- `Caddyfile` → `/etc/caddy/Caddyfile` (set your real domain)

Never commit the real `daemon.env`.
```

- [ ] **Step 5: Confirm `deploy/` is not git-ignored, then commit**

Run: `git check-ignore deploy/daemon.env.example || echo "not ignored (good)"`
Expected: prints `not ignored (good)`.

```bash
git add deploy/orquester.service deploy/Caddyfile deploy/daemon.env.example deploy/README.md
git commit -m "chore(deploy): add VPS provisioning templates (systemd, Caddy, env)"
```

---

### Task 2: Provision the VPS (user, packages, known_hosts)

**Files:** none (server operations).

**Interfaces:**
- Produces: an `orquester` user, installed runtime + tools, seeded GitHub host key.

- [ ] **Step 1: Create the service user**

```bash
sudo useradd --system --create-home --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester
```

- [ ] **Step 2: Install runtime + tools**

```bash
sudo apt-get update
sudo apt-get install -y git openssh-client tmux ufw fail2ban python3 make g++ curl ca-certificates
# Node 20 LTS:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm
# Caddy (official repo):
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

- [ ] **Step 3: Seed GitHub host keys for the orquester user** (so a future `git push` never hangs on a host-authenticity prompt — needed in Phase 4, harmless now)

```bash
sudo -u orquester mkdir -p /var/lib/orquester/.ssh
sudo -u orquester sh -c 'chmod 700 /var/lib/orquester/.ssh'
sudo -u orquester sh -c 'ssh-keyscan github.com >> /var/lib/orquester/.ssh/known_hosts 2>/dev/null'
sudo -u orquester sh -c 'chmod 644 /var/lib/orquester/.ssh/known_hosts'
```

- [ ] **Step 4: Verify versions**

Run: `node -v && pnpm -v && tmux -V && caddy version && git --version`
Expected: Node v20.x, a pnpm version, tmux ≥ 3.2, a Caddy v2 version, git present.

---

### Task 3: Deploy + build the app on the VPS

**Files:** none (build on the server).

**Interfaces:**
- Consumes: the repo. Produces: `apps/daemon/dist/cli.js` and `apps/web/dist/index.html`.

- [ ] **Step 1: Clone the repo to `/opt/orquester`**

```bash
sudo mkdir -p /opt/orquester
sudo chown "$USER" /opt/orquester
git clone <your-repo-url> /opt/orquester
cd /opt/orquester
```

- [ ] **Step 2: Install + build**

```bash
cd /opt/orquester
pnpm install
pnpm build
```
Expected: install runs the `postinstall` node-pty fix; build completes with no errors.

- [ ] **Step 3: Verify the build outputs exist**

Run: `ls -1 /opt/orquester/apps/daemon/dist/cli.js /opt/orquester/apps/web/dist/index.html`
Expected: both paths print (no "No such file"). If `apps/daemon/dist/cli.js` is absent, run `pnpm --filter @orquester/daemon build` and re-check the daemon package's `dist` entry, then use that path in `deploy/orquester.service`.

- [ ] **Step 4: Let `orquester` read the code**

```bash
sudo chown -R orquester:orquester /opt/orquester
```

---

### Task 4: Configure + start the daemon (localhost only)

**Files:** none (server config from the Task 1 templates).

**Interfaces:**
- Produces: a running daemon on `127.0.0.1:47831` with HTTP auth required.

- [ ] **Step 1: Install daemon.env with a real password**

```bash
sudo mkdir -p /etc/orquester
sudo cp /opt/orquester/deploy/daemon.env.example /etc/orquester/daemon.env
# Put a strong random secret in place of the placeholder:
sudo sed -i "s|replace-with-a-32+char-random-secret|$(openssl rand -base64 32)|" /etc/orquester/daemon.env
sudo chown orquester:orquester /etc/orquester/daemon.env
sudo chmod 600 /etc/orquester/daemon.env
```

- [ ] **Step 2: Install the systemd unit + start**

```bash
sudo cp /opt/orquester/deploy/orquester.service /etc/systemd/system/orquester.service
sudo systemctl daemon-reload
sudo systemctl enable --now orquester
```

- [ ] **Step 3: Verify the daemon is healthy on localhost**

Run: `sudo systemctl is-active orquester && curl -fsS http://127.0.0.1:47831/health`
Expected: `active`, then a JSON health body with `"ok":true` and `"transports"` including `"http"`. If it failed, `sudo journalctl -u orquester -n 50 --no-pager`.

- [ ] **Step 4: Verify auth is required and a session works over localhost**

```bash
curl -fsS http://127.0.0.1:47831/api/auth/info        # expect authRequired:true + a salt
TOKEN=$(sudo python3 -c "import json;print(json.load(open('/var/lib/orquester/daemon/daemon.json'))['transports']['http']['passwordHash'])")
curl -sS -o /dev/null -w "no-auth=%{http_code}\n" http://127.0.0.1:47831/api/workspaces          # expect 401
curl -sS -o /dev/null -w "auth=%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47831/api/workspaces  # expect 200
```
Expected: `authRequired:true`; `no-auth=401`; `auth=200`. (In Phase 0 the bearer is the bare `passwordHash`; Phase 1 changes it to `base64("mapacho:"+hash)`.)

---

### Task 5: Caddy + DNS + TLS

**Files:** none (server config).

**Interfaces:**
- Consumes: a DNS `A` record. Produces: public HTTPS at your domain → the daemon.

- [ ] **Step 1: Point DNS at the VPS** — create an `A` record `orquester.example.com → <VPS IP>` at your DNS provider, then confirm it resolves:

Run: `dig +short orquester.example.com`
Expected: prints your VPS IP. (Wait for propagation before continuing.)

- [ ] **Step 2: Install the Caddyfile with your real domain**

```bash
sudo cp /opt/orquester/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i "s|orquester.example.com|orquester.yourdomain.com|" /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

- [ ] **Step 3: Verify TLS + same-origin SPA + API over HTTPS**

```bash
curl -fsS https://orquester.yourdomain.com/api/auth/info        # expect authRequired:true + salt, valid cert
curl -fsS -o /dev/null -w "spa=%{http_code}\n" https://orquester.yourdomain.com/   # expect spa=200 (index.html)
```
Expected: a valid (non-self-signed) cert, `authRequired:true`, `spa=200`. If the cert fails, `sudo journalctl -u caddy -n 50 --no-pager` (usually DNS not yet propagated or port 80/443 blocked).

---

### Task 6: Firewall + end-to-end verification

**Files:** none.

**Interfaces:**
- Produces: a locked-down, browser- and desktop-reachable deployment.

- [ ] **Step 1: Enable the firewall (SSH + HTTPS only)**

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status
```
Expected: only 22 and 443 allowed.

- [ ] **Step 2: Confirm the daemon port is NOT publicly reachable** — from a *different* machine:

Run: `curl -m 5 -sS http://<VPS IP>:47831/health; echo "exit=$?"`
Expected: connection refused/timeout (non-zero exit) — 47831 is not exposed.

- [ ] **Step 3: Browser end-to-end** — open `https://orquester.yourdomain.com` in a browser, enter the password (the value you put in `daemon.env`), create a shell session, type a command, and confirm output streams. Expected: terminal works over HTTPS/WSS.

- [ ] **Step 4: Desktop end-to-end** — in the desktop app's Server Switcher, "Add server…" → URL `https://orquester.yourdomain.com`, enter the password, set it active. Confirm workspaces/sessions load and a terminal runs. Expected: the desktop app drives the remote daemon.

---

## Notes for the implementer

- After Phase 1 lands and is redeployed, the login also requires the username `mapacho`, and curl bearers become `base64("mapacho:"+passwordHash)` (e.g. `TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 -w0)`).
- Redeploy after code phases: `cd /opt/orquester && git pull && pnpm install && pnpm build && sudo systemctl restart orquester` (Caddy unaffected; with Phase 2's `KillMode=process`, tmux-backed sessions survive the restart).
- Keep the box patched: `sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`.
