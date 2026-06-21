# Remote VPS deployment — design

Date: 2026-06-19
Status: Draft (awaiting review)

## Summary

Run the **orquester daemon on a remote VPS** so terminals, the file browser, and
the tool registry all execute there, with the user's projects living under the
daemon's workspaces dir on the VPS. The **browser** and **Electron desktop app**
become thin remote clients that reach the daemon over the public internet via
**HTTPS only**, fronted by a self-hosted **Caddy** reverse proxy (Let's Encrypt
TLS) on a real domain. Access is gated by a **username + password** credential
(`mapacho` + a strong secret), checked in constant time with no username
enumeration. Terminal **sessions survive daemon restarts and VPS reboots** via a
tmux-backed session manager. Single user only.

On top of the remote deployment, this spec also adds two workspace features that
the remote dev-box makes valuable: **per-workspace GitHub/git accounts** (bind a
git identity + SSH key to each workspace so terminals automatically commit/push
as the right account) and **deleting workspaces and projects from the sidebar**.
Both rest on a new lightweight **workspace metadata store** the codebase lacks
today.

This is effectively a private, self-hosted Coder/Gitpod for one person.

The codebase already has ~70% of the remote plumbing (HTTP transport, bcrypt
bearer auth, WebSocket multiplexing, a `ServerSwitcher` + `remotes.json`, a web
client that reads `window.location.origin`). This design is mostly **deploy +
harden + add username + add persistence + add workspace metadata/accounts/delete**,
not a from-scratch remote build.

## Goals

- Daemon runs on a VPS; terminals/files/registry execute on the VPS.
- Reach it from any browser and from the desktop app over public HTTPS.
- "Only me" enforced by TLS + a `mapacho`/password credential, hardened against
  brute force and username enumeration.
- Daemon never directly exposed: bound to `127.0.0.1`, only Caddy is public.
- Terminal sessions persist across daemon restart / VPS reboot (tmux-backed).
- Desktop app keeps its bundled local daemon **and** gains the VPS as a
  selectable remote (set as the default connection).
- Connect multiple GitHub accounts and **bind one (immutably) to each workspace**,
  so every repo in that workspace — present and future — uses the right git
  identity and SSH key automatically, with standard clone URLs.
- The git-account mechanism works on **both a macOS local daemon (bundled with the
  desktop app) and the Linux VPS daemon** (Windows deferred).
- Delete workspaces and projects from the sidebar (cascading to disk, live
  sessions, and metadata) with destructive-action confirmation.
- A concrete, reproducible VPS runbook ("what to set up and how").

## Non-goals

- **Multi-user / multi-tenant.** One credential, one workspaces root. No per-user
  isolation, OAuth/SSO, RBAC, or distributed multi-daemon coordination.
- **VPN / SSH-tunnel exposure.** Public HTTPS was the chosen exposure model.
- **mTLS client certificates** (a stronger "only my devices" guarantee) — noted
  as optional future hardening (Phase 5), not built here.
- **Refactoring the desktop into a pure thin client.** It keeps its local daemon;
  the VPS is added as a remote (minimal change).
- **Changing a workspace's git account after creation.** The binding is immutable;
  to re-account a workspace, delete and recreate it (now possible via the delete
  feature).
- **Persisting the GitHub PAT.** The token is used transiently to upload the SSH
  key + read the account identity, then discarded. Only the SSH private key is
  stored server-side.
- **Repo browsing / clone helpers / GitHub beyond key+identity.** Single host
  (`github.com`) for v1; the data model stays generic enough to extend later.
- **Windows daemon git-account support.** The mechanism targets macOS + Linux
  daemons; Windows differs on path format and key-file ACL permissions — deferred.
- **A test framework.** The repo has only `build` / `typecheck` / `check`;
  verification stays manual + `pnpm check` (matches existing specs).

## Current state (as built)

What already supports remote access:

- **HTTP transport** in `apps/daemon/src/index.ts` (`createServer(...,
  { authRequired: true, mode: "remote", serveWeb })`), opt-in via
  `transports.http.enabled`, host/port configurable. Defaults
  `DEFAULT_HTTP_HOST = 127.0.0.1`, `DEFAULT_HTTP_PORT = 47831`
  (`packages/config/src/index.ts`). Hot-reloadable (`reloadHttp()`).
- **Password auth**: public `GET /api/auth/info` returns `{ authRequired, salt }`;
  client derives `bcrypt.hashSync(password, salt)` (`packages/ui/src/lib/auth.ts`
  `deriveAuthHash`) and sends `Authorization: Bearer <hash>`. Server compares to
  `transports.http.passwordHash` with constant-time `safeEqual` (`timingSafeEqual`).
- **WebSocket multiplexing** at `/ws?token=<hash>` (`ws-session-channel.ts`), one
  socket for all terminals, exponential-backoff reconnect + buffer replay.
- **Remote management UI**: `ServerSwitcher.tsx` + `store.addRemote` +
  `remotes.json` (`remoteConnectionSchema` in `packages/config`).
- **Web client** reads `VITE_ORQUESTER_API_URL ?? window.location.origin`.
- **Desktop** starts the daemon in-process (`startIntegratedDaemon` in
  `apps/desktop/src/main.ts`) over a unix socket via an Electron IPC bridge.

What is missing / unsafe for a public deploy, and for the new features:

- **No TLS** in the daemon (plain HTTP) → must be fronted by Caddy.
- **WS token in query string** → encrypted on the wire by TLS, but can land in logs.
- **No login throttling / brute-force protection.**
- **Unsandboxed `/api/fs/*`** — any path the daemon user can read/write.
- **Single static secret**, no username, no expiry/rotation.
- **Sessions are in-memory** (`SessionManager.sessions` Map; PTY spawned directly
  in `sessions.ts:create`; 256 KB output ring `MAX_BUFFER`) → die on daemon restart.
- **Workspaces/projects are pure directories with ZERO metadata.** Existence =
  filesystem listing of `workspacesDir` (`listDirectories`/`listWorkspaces`,
  `index.ts:811-844`); create = `mkdir` only (`index.ts:379-414`); no templating.
  There is **no per-workspace store**, and **no DELETE endpoints** for workspaces
  or projects (the only `DELETE` is `/api/sessions/:id`, `index.ts:573-579`).
- **No git/ssh code anywhere** in the daemon (clean slate). Sessions spawn with
  `env: { ...process.env }` and **no `HOME` override** (`sessions.ts:49-55`),
  `cwd = req.cwd || req.projectPath || homedir()` (`sessions.ts:41`) — so `git`
  inside a terminal already reads the daemon user's `~/.gitconfig` and `~/.ssh`.
- **`.stage/daemon/daemon.json` binds `0.0.0.0`** — LAN-dev only, must not reach prod.

## Architecture (target)

```
  Your devices                  Internet              VPS (Ubuntu LTS)
┌───────────────┐                              ┌───────────────────────────────────────────┐
│ Browser (any) │                              │  Caddy :443  — Let's Encrypt TLS, HSTS      │
│ Electron app  │ ── HTTPS / WSS ────────────▶ │   reverse_proxy → 127.0.0.1:47831           │
│ Phone browser │   orquester.example.com      │        │                                    │
└───────────────┘                              │        ▼                                     │
                                               │  orquester daemon (systemd, user=orquester) │
                                               │   • binds 127.0.0.1:47831 ONLY              │
                                               │   • username+password bearer + throttle     │
                                               │   • serves web SPA (same origin)            │
                                               │        │ spawn / attach                     │
                                               │        ▼                                     │
                                               │  tmux server  (-S /var/lib/orquester/tmux.sock)
                                               │   • orq-<id> sessions survive restarts      │
                                               │        │                                     │
                                               │        ▼                                     │
                                               │  /var/lib/orquester/workspaces/<ws>/<proj>  │
                                               │   • git identity via ~/.gitconfig includeIf │
                                               │   • per-account keys in daemon/keys/ (0700) │
                                               │  ufw: allow 22 + 443 only                   │
                                               └───────────────────────────────────────────┘
```

Single origin: Caddy → daemon serves **both** the web SPA (via `ORQUESTER_WEB_DIR`)
and the API/WebSocket. No CORS, no separate web host.

## Phase 0 — VPS provisioning (runbook; no app code changes)

Delivers encrypted, password-gated remote access (browser + desktop) with the
existing password-only auth.

### 0.1 Server, user, packages

- Ubuntu 22.04/24.04 LTS VPS with a public IP.
- Dedicated non-root system user `orquester`, home `/var/lib/orquester` (so
  `~/.gitconfig` and `~/.ssh` are under the daemon's control).
- Install: `tmux`, `caddy`, `ufw`, `git`, `openssh-client`, `fail2ban` (optional),
  Node 20 LTS, `pnpm`, and `node-pty` build deps (`python3`, `make`, `g++`).
- Seed GitHub host keys for the `orquester` user so the first `git push` never
  hangs on a host-authenticity prompt:
  `ssh-keyscan github.com >> /var/lib/orquester/.ssh/known_hosts` (file `0644`,
  dir `0700`). (Phase 4 also sets `StrictHostKeyChecking=accept-new` as a belt.)

### 0.2 Deploy the app

- Clone the repo to `/opt/orquester` (readable by `orquester`).
- `pnpm install` (runs `postinstall` → `fix-node-pty-perms.mjs`).
- `pnpm build` (daemon + web SPA + shared packages; desktop build is skippable).
- Web SPA built **without** `VITE_ORQUESTER_API_URL` → uses `window.location.origin`.

### 0.3 daemon.env (`/etc/orquester/daemon.env`, `chmod 600`, owned by `orquester`)

```
ORQUESTER_HTTP_ENABLED=true
ORQUESTER_HTTP_HOST=127.0.0.1          # localhost ONLY — Caddy is the public face
ORQUESTER_HTTP_PORT=47831
ORQUESTER_HTTP_PASSWORD=<32+ char random secret>   # hashed to bcrypt on first load
ORQUESTER_HTTP_USERNAME=mapacho        # consumed in Phase 1; harmless earlier
ORQUESTER_WEB_DIR=/opt/orquester/apps/web/dist
HOME=/var/lib/orquester                # pin HOME so git/ssh resolve under the daemon user
```

### 0.4 systemd unit (`/etc/systemd/system/orquester.service`)

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
KillMode=process            # CRITICAL: leaves the tmux server alive across daemon restarts
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/orquester
ProtectHome=true
PrivateTmp=false            # tmux socket lives under /var/lib/orquester, not /tmp

[Install]
WantedBy=multi-user.target
```

`KillMode=process` is load-bearing for Phase 2 (see §2.7). The appdir
`/var/lib/orquester` holds `daemon/` (config, logs, `tmux.sock`, `sessions.json`,
`accounts.json`, `workspaces.json`, `keys/`) and `workspaces/`.

### 0.5 Caddy (`/etc/caddy/Caddyfile`)

```
orquester.example.com {
    reverse_proxy 127.0.0.1:47831       # WebSocket upgrade handled automatically
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"
        # CSP must be tuned to the SPA (xterm/codemirror use inline styles; WS needs wss:)
        Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        -Server
    }
    # Optional: Caddy-level rate limit as a coarse pre-daemon brake (plugin or layer4).
}
```

### 0.6 DNS + firewall + start

- DNS `A` record: `orquester.example.com → <VPS IP>`. Caddy auto-provisions TLS.
- `ufw allow 22`, `ufw allow 443`, `ufw enable`. Port 47831 never opened.
- `systemctl enable --now caddy orquester`.

### 0.7 Verify

- `https://orquester.example.com` loads, prompts for the password, runs a session.
- From the desktop Server Switcher, add the VPS, enter the password, set active.

## Phase 1 — Daemon hardening, username auth, client changes

### 1.1 Config schema — `packages/config/src/index.ts`

- `daemonConfigSchema.transports.http`: add `username: string` (default `"mapacho"`,
  overridable via `ORQUESTER_HTTP_USERNAME`), stored trim+lowercased.
- Add `fsRoot?: string` (default = `workspacesDir`); see §1.6.

### 1.2 Auth credential format

Credential = `base64("<username>:<bcryptHash>")` (HTTP `Authorization: Bearer …`
and WS `?token=…`), mirroring HTTP Basic with the derived hash standing in for the
raw password. The raw password never leaves the client.

### 1.3 `/api/auth/info` — `apps/daemon/src/index.ts` + `packages/api`

- Response gains `requiresUsername: boolean` (UI hint only). **The username is
  never echoed by any endpoint.** `salt`/`authRequired` unchanged.

### 1.4 Auth hook — HTTP `onRequest` + `/ws` handshake (`apps/daemon/src/index.ts`)

```
const { user, hash } = decodeCredential(token)          // base64 → split first ":"
const userOk = timingSafeEqual(sha256(normalize(user)), sha256(expectedUsername))
const passOk = timingSafeEqual(sha256(hash),            sha256(expectedHash))
const authorized = userOk && passOk                      // BOTH computed; no early return
if (!authorized) return 401  // identical body + timing for every failure mode
```

`sha256`-then-`timingSafeEqual` → fixed-length, constant-time; wrong-username,
wrong-length, and wrong-password are indistinguishable (no enumeration).
`normalize` = `trim().toLowerCase()`. The unix-socket `mode:"local"` path stays
unauthenticated (not network-exposed).

### 1.5 Login throttle + proxy trust + log redaction

- **Throttle**: in-daemon per-IP failed-attempt counter with escalating lockout,
  keyed on Caddy's `X-Forwarded-For` (trust proxy for IP only, never for auth).
- **Log redaction**: strip the `token` query param from request logs.
- **Bind localhost**: prod `host = 127.0.0.1`; `.stage`'s `0.0.0.0` is LAN-dev only.

### 1.6 FS sandbox — `/api/fs/*`

- Resolve to realpath; reject anything outside `fsRoot` (default = workspaces dir).
- **Documented caveat:** a terminal is a real shell and can `cd` anywhere; the
  sandbox constrains only the file-browser API.

### 1.7 Client changes

- `lib/auth.ts`: `buildCredential(username, hash)`; persist `username` (plain)
  alongside the per-endpoint hash in `localStorage`.
- `components/auth/AuthModal.tsx`: add a **username** field above password.
- `store/app.ts`: `submitPassword` → `submitCredentials(username, password)`;
  `establish` reads `requiresUsername`.
- `transporters/http-transporter.ts` + `ws-session-channel.ts`: carry the combined
  credential.

### 1.8 Desktop default remote — `apps/desktop`

- Keep the bundled local daemon; seed a default remote
  (`https://orquester.example.com`) into `remotes.json`, optionally active.

### 1.9 Max hardening (password-only posture — decided)

The user reviewed mTLS / VPN / TOTP and chose **username + password only**, so the
following compensating hardening is **required**, not optional:

- **Lock down CORS.** The HTTP transport currently sends
  `Access-Control-Allow-Origin: *` (`index.ts:231-232`). The SPA is same-origin
  behind Caddy, so CORS is unnecessary — remove the wildcard (or restrict to the
  configured origin). A wildcard on a credentialed API is needless exposure.
- **CSP + Permissions-Policy** at Caddy (§0.5), tuned to the SPA.
- **Aggressive throttle/lockout.** Single-user, so legitimate failures are rare:
  use a low threshold + long lockout (e.g. 5 fails → 15 min), keyed on
  `X-Forwarded-For`, **plus `fail2ban`** on the daemon's 401 log lines (OS-layer ban
  at the firewall) — defense in depth, not either/or.
- **Raise the bcrypt cost factor** from 10 to 12 (`hashPassword`, `index.ts:897-900`).
  The expensive hash runs client-side at login + once at password-set, so per-request
  auth stays cheap; cost 12 slows offline cracking if a hash ever leaks and slows an
  attacker's per-guess derivation.
- **Trim public info disclosure.** `/health` currently returns daemonId / version /
  mode / transports; reduce the unauthenticated response to a bare liveness `{ ok }`
  (move details behind auth). Keep `/api/auth/info` to the minimum (`authRequired`,
  `salt`, `requiresUsername`).
- **Fail-closed start.** Keep the existing guard that refuses to enable the HTTP
  transport without a password; treat a missing/short password as a hard startup error.
- **Patching is the #1 mitigation** for the pre-auth-surface risk: enable
  `unattended-upgrades` and keep Node / Caddy / Fastify / tmux / git current (a
  public endpoint means a dependency CVE is internet-reachable).
- Confirm the always-on items: daemon bound `127.0.0.1` (§1.5), FS sandbox (§1.6),
  token redacted from logs (§1.5), 32+ char random password (§0.3), TLS 1.2+/HSTS
  (Caddy default).

## Phase 2 — tmux-backed session persistence

Rework `SessionManager` (`apps/daemon/src/sessions.ts`) so PTYs are owned by a
tmux server that outlives the daemon.

### 2.1 Dedicated tmux server

- Fixed socket `tmux -S /var/lib/orquester/tmux.sock …` on every call — isolates
  from user tmux and gives a stable reattach point independent of the cgroup.

### 2.2 Create

- `tmux -S … new-session -d -s orq-<id> -x <cols> -y <rows> -c <cwd> [-e K=V …] -- <bin> <args…>`,
  then spawn the streaming PTY as `tmux -S … attach -t orq-<id>` via `node-pty`.
  Downstream input/resize/output + broadcaster paths are unchanged.

### 2.3 Reattach on boot

- Persist `daemon/sessions.json`: `{ id, title, order, projectPath, refId, kind,
  cwd, createdAt }` per session. On startup, `tmux -S … ls`, reconcile against the
  index, re-create attach PTYs for survivors. Mark index entries with no live tmux
  session as exited/closed.

### 2.4 Scrollback

- Seed a (re)connecting client from `tmux -S … capture-pane -p -S - -t orq-<id>`
  instead of the in-memory ring (lost on restart). Keep a small live ring for hot replay.

### 2.5 Exit detection

- Command exits → tmux session ends (default `remain-on-exit off`) → attach PTY
  exits → mark `exited`, capture exit code → broadcast (current behavior).

### 2.6 Resize

- `pty.resize(cols, rows)` drives tmux window size; set `window-size latest`.

### 2.7 Lifecycle / KillMode reasoning (the easy-to-miss trap)

- `tmux new-session -d` daemonizes the tmux **server** (setsid → reparented to
  PID 1) but it stays in the systemd service **cgroup**. Default
  `KillMode=control-group` would kill it (and every pane) on restart.
  **`KillMode=process` (§0.4)** signals only the main node process.
- When node dies, its PTY masters hang up → the `tmux attach` clients get SIGHUP
  and exit on their own (no orphaned duplicate clients); the tmux **server**
  survives; the restarted daemon reattaches via the fixed socket.
- Fallback if flaky: launch the tmux server in its own transient scope
  (`systemd-run --scope`) or a separate `orquester-tmux.service`.

## Phase 3 — Workspace/project metadata + deletion

Introduces the metadata store both new features need, plus delete.

### 3.1 Metadata store — `packages/config/src/index.ts` (mirror `remotes.json`)

- `workspacesConfigSchema = z.object({ version: z.literal(1).default(1),
  workspaces: z.array(z.object({ name, gitAccountId: z.string().optional(),
  createdAt })).default([]) })` + `createDefault…`/`parse…` + `workspacesMetaPath()`
  returning `<appdir>/daemon/workspaces.json` (daemon-side; keyed by **name**, the
  stable identifier — `workspacesDir` paths contain `$vars`).
- Resolve `workspacesMetaFile` into `ResolvedPaths` (`index.ts:62-114`).
- Read-with-fallback + `writeJsonFile` (`index.ts:884-895`).

### 3.2 API contract — `packages/api/src/index.ts`

- `WorkspaceSummary` gains `gitAccount?: { id, label, githubLogin } | null` and
  `createdAt?`. `listWorkspaces` (`index.ts:826-844`) merges the metadata side-table
  onto the filesystem listing (filesystem stays source of truth for existence).
- No project-level metadata for now (projects inherit the workspace binding).

### 3.3 Delete endpoints — `apps/daemon/src/index.ts`

- `DELETE /api/workspaces/:workspace` and
  `DELETE /api/workspaces/:workspace/projects/:project`, modeled on the create
  handlers (`index.ts:379-414`) for path build + `isValidName` guards
  (`index.ts:801-809`), and on `DELETE /api/sessions/:id` (`index.ts:573-579`) for
  the 204/404 reply.
- **Extra safety the create path lacks:** after `join`, verify the resolved target
  is strictly inside `resolved.workspacesDir` (realpath prefix check) before
  `await rm(path, { recursive: true, force: true })` (`rm` already imported,
  `index.ts:52`).
- Cascade: call a new `SessionManager.closeByProjectPrefix(prefix)` (§3.4); prune
  the workspace's `workspaces.json` entry; remove its `includeIf` rule
  (Phase 4 §4.6) via `git config --global --unset`.

### 3.4 Sessions cascade — `apps/daemon/src/sessions.ts`

- `closeByProjectPrefix(prefix)`: iterate `this.sessions`, call existing `close(id)`
  (`sessions.ts:144-157`, kills PTY + emits `"closed"`) for any session whose
  `summary.projectPath === prefix` or `startsWith(prefix + sep)`. (Exact-match for
  delete-project; prefix for delete-workspace.) The `session.closed` broadcast
  already drops tabs client-side (`app.ts:738-741`).

### 3.5 Client — store + service + api-client

- `ApiClient.deleteWorkspace(name)` / `deleteProject(workspace, name)` via
  `this.send("DELETE", …)` (`api-client.ts:60-74`); add to `workspaceService`.
- `store/app.ts`: `deleteWorkspace` / `deleteProject` actions (mirror
  create + reload, `app.ts:527-568`). Also: if the deleted item is
  `currentWorkspace`/`currentProject`, reset (reuse `closeWorkspace`, `app.ts:541`);
  clear `fileTabsByProject`/`activeTabByProject`/`viewModeByProject` entries
  (`app.ts:183-187`) for the removed path(s) — those client-local maps are keyed by
  path and won't be cleaned by `session.closed`.

### 3.6 UI — sidebar delete + confirm

- Add `onContextMenu` to the row buttons in `WorkspaceList.tsx` (`:48-59`) and
  `ProjectList.tsx` (`:68-83`), copying the `TabStrip` pattern (`TabStrip.tsx:54,
  104-107,165-167`): local `menu` state + `<ContextMenu>` with a `danger: true`
  Delete item (`context-menu.tsx:62-64`).
- Build a `ConfirmDialog` from `Modal` (`modal.tsx`, AuthModal layout
  `AuthModal.tsx:40-77`) — no confirm primitive exists today. **Workspace delete
  requires typed-name confirmation** (it `rm -rf`s all projects); **project delete
  is a simple confirm**. Red confirm button via `className` override (no
  destructive `Button` variant exists; borrow the red from `context-menu.tsx:63`).

## Phase 4 — Git accounts per workspace

Bind a GitHub/git identity + SSH key to each workspace; terminals pick it up
automatically. Account + key management happens **over authenticated HTTPS**
(decided), with the invariant that **private keys and the PAT are never returned by
any API and the PAT is never persisted**.

### 4.1 Accounts store + keys — `packages/config` + daemon

- `daemon/accounts.json` (mirror `remotes.json`): array of
  `{ id, label, githubLogin, gitName, gitEmail, publicKey, keyPath, githubKeyId,
  createdAt }`. **No private key, no token** in this file or any response.
- Keys in `<appdir>/daemon/keys/<id>` (+ `.pub`). Create `keys/` with `0700` in
  `prepareDirs` (`index.ts:966-970`); `ssh-keygen -f` writes the private key `0600`
  (no `chmod` code exists today — add explicit modes for the dir).

### 4.2 Connect flow (auto-upload via PAT)

1. Panel: user enters a `label` + a **GitHub PAT**. Minimal scopes — classic:
   `write:public_key` (upload the SSH key) + `user:email` (read primary email)
   (+ `read:user` for the display name); or a fine-grained token with *Git SSH
   keys: write*, *Email addresses: read*, *Profile: read*. The PAT is held in
   memory for the request only.
2. Daemon generates an ed25519 key:
   `ssh-keygen -t ed25519 -f <keyPath> -N "" -C "orquester:<label>"` (via
   `execFile`/`spawn` with an args array — **not** the shell-based `run()` at
   `registry.ts:333`, since inputs are user-controlled).
3. Daemon calls GitHub: `POST /user/keys` (upload pubkey, title `orquester:<label>`,
   store the returned `githubKeyId`); `GET /user` (login, name); `GET /user/emails`
   (primary verified email; fall back to the `…@users.noreply.github.com` address).
4. Persist the account (no token). `gitName`/`gitEmail` are prefilled from GitHub
   and **editable** in the panel.
5. Discard the PAT.

### 4.3 Per-workspace git mechanism (the elegant part)

- Per-account include file (written via `git config --file <includePath> …`):
  ```
  [user]   name = <gitName>   email = <gitEmail>
  [core]   sshCommand = ssh -i <keyPath> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
  ```
- On binding, register one global rule per workspace:
  `git config --global includeIf."gitdir:<REALPATH(workspaceDir)>/".path <includePath>`
- Effect: every repo under that workspace — present and future — inherits the right
  identity **and** the right key, with **standard clone URLs** (no host-alias
  rewriting). `IdentitiesOnly=yes` makes multi-account deterministic (otherwise ssh
  offers the wrong key and GitHub rejects it).

### 4.4 Endpoints — `apps/daemon/src/index.ts`

- `GET /api/accounts` (metadata + public keys only), `POST /api/accounts`
  (connect flow §4.2), `DELETE /api/accounts/:id` (§4.7), `POST /api/accounts/:id/test`
  (`ssh -T git@github.com` via the account key → returns the authenticated login).
- **Security boundary (decided relaxation):** these are allowed over the remote HTTP
  transport (unlike `PUT /api/config/daemon`, which keeps its unix-socket-only guard
  at `index.ts:310-316`). Justification: on the VPS, HTTP is the only transport; it
  is gated by TLS + `mapacho`/password + throttle; **private keys and PATs never
  appear in any response and the PAT is never stored**, so an authenticated client
  can create/bind but cannot exfiltrate key material.

### 4.5 Workspace creation with account — UI + daemon

- Promote workspace creation from inline `NewItemInput` (`WorkspaceList.tsx:31-40`)
  to a small `Modal` (AuthModal template): a name `Input` + an **account picker**
  `Dropdown` (ServerSwitcher's list shape, `ServerSwitcher.tsx:55-69`) listing
  connected accounts + **"No account (default identity)"** + "Add account…" (opens
  the panel).
- `createWorkspace(name, gitAccountId?)` (`store/app.ts:527-534` + service +
  `api.createWorkspace`). The daemon `mkdir`s, writes the `workspaces.json` entry
  with `gitAccountId`, and (if bound) writes the `includeIf` rule (§4.3).

### 4.6 Accounts panel — UI

- New **section in `SettingsModal`** (`SettingsModal.tsx:13-17` `SECTIONS`): list
  accounts (login + git email, `Test` button + result, hover `Trash2` to
  disconnect), and an "Add account…" form (label + PAT, "Connect" with `busy`/error
  message). Store wiring mirrors remotes (`loadAccounts`/`addAccount`/`removeAccount`,
  cf. `app.ts:400-504`).

### 4.7 Immutability + account deletion

- Binding is **set at workspace creation and never changed** (no rebind endpoint;
  shown read-only on the workspace). Re-account = delete + recreate the workspace.
- **Deleting an account that is still bound to any workspace is blocked** (409 +
  the list of workspaces using it). Since the PAT isn't stored, disconnect deletes
  locally and **reminds the user to remove the key from GitHub** (we show the title
  / `githubKeyId`); optional: re-enter a PAT to also `DELETE /user/keys/:id`.
- Workspaces with no `gitAccountId` (incl. dirs created via `mkdir` outside
  orquester) use the daemon's global/default git identity (no include rule).

### 4.8 Gotchas (must implement, per analysis)

- **`known_hosts`**: seed `github.com` (§0.1) and/or `StrictHostKeyChecking=accept-new`
  — otherwise the first `git push` hangs the PTY on a host-authenticity prompt.
- **Cross-platform matcher (macOS + Linux)**: the daemon runs on the Linux VPS
  **and**, bundled in the desktop app, on a local macOS machine, so the binding
  must work on both. Key the rule on `fs.realpath(workspaceDir)` (git resolves
  symlinks — essential on macOS: `/var`→`/private/var`) with a mandatory
  **trailing slash**, and use a **platform-aware matcher**: `gitdir/i`
  (case-insensitive) on macOS/Windows, `gitdir:` on Linux, chosen at runtime —
  a case-sensitive matcher on macOS's case-insensitive FS silently fails to match.
  Bind and unbind use the same matcher. **Quote the key path** in `core.sshCommand`
  (spaces in `/Users/First Last/…`), and **preflight `git`/`ssh-keygen`** with a
  clear message (macOS: Xcode CLT). A local macOS daemon edits the user's real
  `~/.gitconfig` (additive, scoped to workspace dirs). **Windows is deferred.**
- **`execFile`/args array** for all git/ssh-keygen calls (injection-safe).
- **Pin `HOME`** to one source of truth (`process.env.HOME ?? homedir()`) so the
  include is written into the same `~` sessions read (§0.3 sets `HOME`).
- **Drive all global edits through `git config --global`** (file locking + clean
  replace/unset of `includeIf` keys).

## Phase 5 — optional / deferred

- **mTLS client certificate** in Caddy (only enrolled devices connect) — the
  recommended upgrade to genuine device-binding (see the access-control decision).
- **WS subprotocol auth** (`Sec-WebSocket-Protocol`) to drop the URL token.
- **Idle-session limits / max session count**, session TTL.
- **Persist the PAT (encrypted)** to enable repo browsing / one-click clone / remote
  key removal on disconnect.
- **GitLab/other hosts**, project-level git overrides.
- **Workspace + config backups**, password/key rotation tooling.

## Security model & threat analysis

"Only me" rests on these layers, most important first:

1. **TLS everywhere** (Caddy + HSTS) — no cleartext; credential not sniffable.
2. **Username + password**, constant-time, no enumeration — the 32+ char password
   is the backbone; `mapacho` adds a second known factor + uniform rejection.
3. **Login throttle** — brute force impractical.
4. **Localhost-bound daemon + ufw** — daemon unreachable except via Caddy.
5. **FS sandbox + non-root service user + systemd hardening** — limited blast radius.
6. **Secret handling for accounts**: SSH **private keys never leave the VPS** (no
   API ever returns them; `keys/` is `0700`, keys `0600`); the **GitHub PAT is
   transient** (used for the connect call, never persisted). The accounts API is
   reachable over authenticated HTTPS (a deliberate, scoped relaxation of the
   "secrets are local-only" rule), but it exposes only public keys + metadata + bind
   ops — so a leaked credential lets an attacker create/bind accounts, **not**
   exfiltrate existing keys. `PUT /api/config/daemon` (network/password) keeps its
   unix-socket-only guard.
7. **Ops hygiene** — unattended security upgrades, log rotation, backups.

### Access-control decision (informed, recorded)

The user was presented with **mTLS client certs**, **VPN (Tailscale/WireGuard)**,
**TOTP 2FA**, and **password-only + max hardening**, with an explicit explanation
that password-only on a public endpoint is **not** "only my devices" and that no
configuration is "100% secure." The user **chose password-only + max hardening**.
This is recorded deliberately:

- **"Only me" = secrecy of `mapacho` + the password + a patched stack.** It is a
  single knowledge factor on an internet-reachable endpoint, with no device or
  network factor in front of it.
- **Accepted residual risks:** (1) a phished / reused / leaked / keylogged / guessed
  password grants full access; (2) any **pre-authentication** vulnerability in the
  exposed stack (Caddy / Fastify / TLS / static serving / `/api/auth/info`) could
  bypass the credential entirely, because the daemon's surface is public; (3) the
  endpoint is reachable for DoS.
- **Compensating controls (all of §1.9 + the layers above)** reduce but do not
  eliminate these. The single most effective ongoing mitigation is **keeping the
  stack patched**.
- **Upgrade path (Phase 5), unchanged:** adding **mTLS client certificates** is the
  recommended way to convert this into genuine device-binding (two factors, whole
  surface gated) without losing the open-a-URL convenience; a **VPN** removes the
  public surface entirely. Either can be added later without reworking the app.

Separately, delete is `rm -rf` of real directories — irreversible — which is why
workspace delete is gated by typed confirmation and the resolved-path-inside-
`workspacesDir` check.

### Hardening checklist (password-only posture)

- [ ] Daemon binds `127.0.0.1` only; firewall allows 22 + 443 only.
- [ ] Caddy TLS (Let's Encrypt) + HSTS + CSP + Permissions-Policy + security headers.
- [ ] CORS wildcard removed (same-origin).
- [ ] 32+ char random password; bcrypt cost 12; fail-closed if unset.
- [ ] Username + password, constant-time, no enumeration, token redacted from logs.
- [ ] Aggressive in-daemon throttle (XFF-keyed) + `fail2ban` on 401s.
- [ ] FS API sandboxed to `workspacesDir`; SSH private keys + PAT never exposed.
- [ ] Public `/health` trimmed; non-root `orquester` user; systemd hardening.
- [ ] `unattended-upgrades` on; Node/Caddy/Fastify/tmux/git kept current.
- [ ] Workspace + config + `keys/` backups.

## Data flow

```
Login:
  AuthModal(username, password) ─▶ deriveAuthHash(password, salt) ─▶ buildCredential
                                ─▶ Bearer base64("mapacho:"+hash)
  daemon onRequest/ws: decode ─▶ constant-time userOk && passOk ─▶ 200 | 401(+throttle)

Session (persistent):
  POST /api/sessions ─▶ tmux new-session -d orq-<id> ─▶ tmux attach (node-pty) ─▶ client xterm
  daemon restart ─▶ tmux ls + sessions.json ─▶ re-attach survivors ─▶ reconnect (onReset + capture-pane)

Connect account:
  panel(label, PAT) ─▶ ssh-keygen ─▶ GitHub POST /user/keys + GET /user[/emails]
                    ─▶ accounts.json (no key, no token) ─▶ discard PAT

Create bound workspace:
  modal(name, accountId) ─▶ mkdir ─▶ workspaces.json{gitAccountId}
                         ─▶ git config --global includeIf."gitdir:<realpath>/".path <include>
  terminal in workspace ─▶ git inherits HOME ─▶ reads include ─▶ right identity + key

Delete:
  context-menu ─▶ ConfirmDialog ─▶ DELETE /api/workspaces/:ws[/projects/:p]
              ─▶ closeByProjectPrefix (sessions) + rm -rf + prune workspaces.json + unset includeIf
              ─▶ session.closed events + reload ─▶ sidebar/tabs update
```

## Edge cases

- **Wrong username vs wrong password** — indistinguishable response + timing.
- **Token in logs** — redacted; TLS protects it in transit.
- **Daemon restart mid-session** — panes keep running; brief reconnect + replay.
- **VPS reboot** — tmux server dies (panes lost); `sessions.json` survivors marked
  exited on next boot. (Cross-reboot survival is out of scope.)
- **`fsRoot` / delete traversal** (`..`, symlinks) — realpath prefix check rejects.
- **Delete a workspace/project with live sessions** — `closeByProjectPrefix` kills
  them first; client-local tab maps cleared by the store action.
- **Delete the currently-open workspace/project** — store resets
  `currentWorkspace`/`currentProject`.
- **`known_hosts` unseeded** — first push hangs the PTY (mitigated §0.1/§4.8).
- **Symlinked workspaces dir** — `includeIf` keyed on realpath or it silently won't match.
- **Account bound to a workspace, then disconnect attempted** — blocked (409).
- **PAT with insufficient scope** — connect fails with a clear message; nothing persisted.
- **Two accounts, wrong key offered** — prevented by `IdentitiesOnly=yes` + per-account `-i`.
- **Workspace created outside orquester (`mkdir`)** — no metadata entry; uses global
  git identity; still deletable/bindable-by-recreate.

## Testing / verification

No test runner; verification is:

- `pnpm check` (workspace typecheck) must pass.
- **Phase 0**: browser + desktop reach the VPS, password works, a session runs.
- **Phase 1**: wrong username rejected identically to wrong password; `localStorage`
  stores username + hash; `/api/auth/info` never returns the username; `/api/fs`
  rejects a path outside `fsRoot`; repeated bad logins lock out.
- **Phase 2**: long-running command + `systemctl restart orquester` → session
  reconnects with the process alive and scrollback intact; `tmux -S … ls` shows the
  survivor.
- **Phase 3**: right-click delete a project (simple confirm) and a workspace
  (typed-name confirm) → directory gone, sessions closed, sidebar updated; a delete
  path outside `workspacesDir` is rejected.
- **Phase 4**: connect an account (key uploaded to GitHub, login shown); `Test`
  returns the right login; create a workspace bound to it, `git clone` a private
  repo with a standard URL inside a terminal and confirm `git config user.email` +
  the commit author + a push all use that account; create a second account/workspace
  and confirm no key cross-talk; confirm no endpoint ever returns a private key or
  the PAT; confirm disconnect is blocked while bound.
- Small standalone unit tests for `decodeCredential`, the constant-time verdict, and
  the realpath-prefix delete guard could be added, but a framework is out of scope.

## Operational runbook (ongoing)

- Enable `unattended-upgrades`; keep Node/pnpm/Caddy/tmux/git patched.
- Rotate the password by editing `daemon.env` + `systemctl restart orquester`.
- Log rotation for `daemon/logs/*` and `/var/log/caddy/*`.
- Back up `/var/lib/orquester/workspaces`, the daemon config, **and**
  `daemon/keys/` + `accounts.json` (losing keys means re-connecting every account).
- Removing an account's key from GitHub is manual unless you re-enter a PAT at
  disconnect (PAT is never stored).
