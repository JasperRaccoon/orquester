# AGENTS.md

Source-of-truth guide to the **Orquester** codebase for engineers and AI coding agents:
what it is, how it's built, how to run it locally, the conventions that bite, and how it
deploys to a VPS. `CLAUDE.md` is a thin pointer to this file.

> **Instruction priority for agents:** explicit user instructions > this file > defaults.
> Follow your process skills (TDD, systematic-debugging, verification) unless the user says
> otherwise.

> **⛔ Never launch, restart, or stop the daemon unless I explicitly tell you to.** This repo
> is frequently checked out **inside a running Orquester instance** — a live daemon is already
> serving the very workspace you're editing. Do **not** run `pnpm dev`, `pnpm dev:daemon`,
> `pnpm dev:web`, start `apps/daemon/src/cli.ts`, bind the daemon port/socket
> (`127.0.0.1:47831` / `daemon.sock`), or `systemctl restart orquester` on your own initiative:
> a second daemon collides with the live one (the port/socket is already held) and can disrupt
> the user's running session. Verify daemon/server-side changes with `pnpm check` (typecheck)
> and code review instead. Drive a real daemon **only** when explicitly asked — and then against
> a separate checkout, never this one.

## Git & Commits

- **When asked to commit, commit to the _current_ branch as-is. Do NOT create a new branch first** — even when on `main` — unless I explicitly ask for one. (This overrides the default "branch first when on the default branch" behavior.)

---

## What Orquester is

Orquester is a **local-first coding orchestrator**: a single Node **daemon** owns and manages
long-lived terminal and coding-agent sessions (bash/zsh, Claude Code, Codex, Gemini, …) running
in real PTYs, plus a file browser and editor. Clients are thin. It ships two clients over one
shared React UI:

- an **Electron desktop app** that embeds the daemon in-process over a Unix socket, and
- a **Vite web client** that is a thin remote client to a daemon running on a VPS, reached over
  HTTPS through Caddy.

The remote-deployment design frames the end state as *"a private, self-hosted Coder/Gitpod for
one person"* — single user. Because the daemon owns the PTYs (via **tmux** where available),
sessions survive client disconnects, page reloads, and **daemon restarts**.

**Features:** workspaces → projects → tabs (workspaces/projects are just directories); many
concurrent persistent terminal/agent sessions per project; an installable agent registry
(`claude`, `codex`, `gemini`, `deepseek`, `opencode` via `npm install -g`) with live version
detection; detection + "Open on…" for shells/IDEs/explorers/browsers; xterm.js terminals with
WebSocket-multiplexed PTY streaming, scrollback replay and resize; a CodeMirror file editor;
tab drag-reorder + inline rename (server-authoritative); a per-project grid view; remote access
with TLS, username+password auth, per-IP login throttling, and tmux persistence; per-workspace
git/GitHub SSH identities; and an installable **PWA** web client (service worker + Web Push
notifications on agent-session bells).

---

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Package manager | **pnpm 10** | workspaces `apps/*`, `packages/*` |
| Language | **TypeScript 5.8**, ESM everywhere | `strict`, `moduleResolution: Bundler`, **`noEmit: true`** |
| TS runner | **tsx** | daemon runs `.ts` directly — **no compiled `dist` for the daemon** |
| HTTP/WS server | **Fastify 4** | `@fastify/websocket`, `@fastify/static` |
| PTY | **node-pty 1.1** | native addon; postinstall fixes the exec bit |
| Session persistence | **tmux ≥ 3.2** | external binary; falls back to direct node-pty when absent/old |
| Auth hashing | **bcryptjs** | in daemon **and** UI (client derives the same hash) |
| Schemas | **zod** | only in `@orquester/config` |
| Desktop | **Electron 33** + electron-builder | main bundled to CJS via esbuild |
| Bundler | **Vite 6** (renderer/web), **esbuild** (Electron main) | |
| UI | **React 18**, **zustand**, **Tailwind**, **@xterm/xterm 6**, **CodeMirror 6** | |

No Docker, no Turbo/Nx, **no test runner, no ESLint/Prettier config**. The pre-commit gate is
`pnpm check` (typecheck only).

---

## Repository layout

```
apps/      daemon (the core)  ·  desktop (Electron)  ·  web (Vite SPA)
packages/  config  ·  api  ·  registry  ·  ui
deploy/    orquester.service  ·  Caddyfile  ·  daemon.env.example  ·  README.md
docs/superpowers/  specs/ + plans/ (the remote-VPS roadmap, phases 0–5)
scripts/   fix-node-pty-perms.mjs (postinstall)
.stage/    committed dev sandbox appdir (config + seed workspaces)
```

| Package | Purpose | Entry / key exports |
|---|---|---|
| `@orquester/daemon` (`apps/daemon`) | The core: Fastify HTTP/WS + Unix-socket server owning sessions, registry, accounts, config, file browser. | `src/cli.ts` (process entry) → `src/index.ts` (`startDaemon`, all routes) |
| `@orquester/desktop` (`apps/desktop`) | Electron shell; embeds the daemon **in-process** over a Unix socket; hosts the shared UI. | `src/main.ts`, `src/preload.cjs`, `src/renderer.tsx` → `dist-electron/main.cjs` |
| `@orquester/web` (`apps/web`) | Vite SPA: thin remote client to a daemon over HTTPS. | `src/main.tsx` |
| `@orquester/config` | Single source of truth for **paths, the appdir layout, defaults, and all on-disk zod schemas**. | `DEFAULT_HTTP_PORT=47831`, `DEFAULT_HTTP_HOST="127.0.0.1"`, `resolveDaemonPaths`, `expandVars`, `parse*`/`createDefault*` |
| `@orquester/api` | Pure TS **wire contracts**: HTTP req/resp types, WS/stream message types, a reference HTTP client. | `SessionSummary`, `RegistryResponse`, `EventMessage`, `SessionStreamMessage`, `HttpOrquesterApiClient` |
| `@orquester/registry` | Static **catalog** of launchable tools (no logic). | `REGISTRY` (`shells`, `agents`, `ides`, `fileExplorers`, `browsers`) |
| `@orquester/ui` | Shared **React UI**: zustand store, transport layer, xterm terminals, all components. | `OrquesterApp`, `useAppStore`, `ApiClient`, `createTransporter` |

Dependency direction: `config` ← `api` ← `registry`; all three ← `ui`; the daemon depends on
`api`/`config`/`registry`. **Packages import each other's TypeScript source directly**
(`exports: "./src/index.ts"`) — there is no inter-package build step.

---

## Architecture

### The daemon (`apps/daemon/src`)

**Boot.** `cli.ts` → `startDaemon({ appdir, cwd, env })`, then installs SIGINT/SIGTERM handlers.
`startDaemon()` resolves the appdir, loads/creates `daemon.json` (migrating any plaintext
password to a bcrypt hash at rest), builds shared services (`RegistryService`, `Tmux`,
session manager, `AccountsService`, `Broadcaster`), runs `registry.init()` and
`sessions.reattach()` (resume tmux survivors), always starts the **Unix-socket** transport, and
conditionally starts the **HTTP** transport.

**Two transports** — same Fastify factory, different policy:

| | Unix socket (`mode:"local"`) | HTTP/WS (`mode:"remote"`) |
|---|---|---|
| Address | `<appdir>/daemon/daemon.sock` (named pipe on Windows) | `127.0.0.1:47831` (default) |
| Auth | none | bearer token required on `/api` + `/events` + `/ws` |
| Extra | `PUT /api/config/daemon` writable, `POST /api/daemon/shutdown` | serves the web SPA; `PUT /api/config/daemon` → 403 |
| Lifecycle | always on | opt-in, **hot-reloadable** without restarting sessions |

**Key routes.** `GET /health` (bare `{ok:true}`); `GET /api/auth/info` (public: `{authRequired,
salt, requiresUsername}` — never the username/hash); `/api/config/{daemon,client,app,remotes}`;
`/api/workspaces` + `/projects` (CRUD; deletes are realpath-guarded and cascade-close sessions);
`/api/accounts` (git/GitHub SSH identities; **never returns private keys or PATs**);
`/api/fs/*` (file browser, sandboxed to `fsRoot`, 1 MB read cap); `/api/registry` +
`/:id/{version,install,update}`; `/api/sessions` CRUD + `/input` + `/resize` + `/reorder` +
chunked `GET /:id/output`; `GET /events` (NDJSON event bus + heartbeat); `GET /ws`
(multiplexed WebSocket for all terminals).

**PTY streaming has two paths:** chunked HTTP `GET /api/sessions/:id/output` (used by the
desktop over the socket) and the multiplexed `/ws` (used by the web client — one socket for all
terminals, avoiding the browser's per-origin connection cap). `/ws` wire protocol: client→server
`{t:"sub"|"unsub"|"input"|"resize", id, …}`; server→client `{t:"out", id, data}` / `{t:"end", id}`.

**Auth & throttle.** Wire credential = `base64("<username>:<bcryptHash>")` as
`Authorization: Bearer …` (or `?token=…` on WS). The client never sends the plaintext password —
it fetches the bcrypt salt from `/api/auth/info` and derives the hash client-side (bcrypt cost
12). The server verifies in **constant time with no early return** (one identical 401 for every
failure mode — no username enumeration). A per-IP `LoginThrottle` escalates lockout after repeat
failures, keyed on the rightmost `X-Forwarded-For` hop (Caddy-appended).

**Persisted state — the appdir.** Default `~/.orquester`; `./.stage` in dev; `/var/lib/orquester`
in production (`--appdir`). The daemon persists **JSON, not a database**:

```
<appdir>/
  app/      app.json, remotes.json, logs/
  daemon/   daemon.json (incl. bcrypt passwordHash)   daemon.sock (control socket)
            tmux.sock (dedicated tmux server)         sessions.json (reattach index)
            workspaces.json  accounts.json  keys/ (0700 per-account SSH keys)  logs/
  workspaces/   <workspace>/<project> dirs (the file-browser sandbox root, fsRoot)
```

**Sessions & PTYs — two backends** (`sessions.ts`, chosen at boot):

- **tmux-backed** (`tmux ≥ 3.2` on PATH): each session runs in a detached `orq-<uuid>` tmux
  session on a dedicated tmux server (`tmux -S <appdir>/daemon/tmux.sock`); the daemon attaches a
  thin streaming PTY. Because the command lives in tmux's own process tree, it **survives a
  daemon restart**. Scrollback is durable via `tmux capture-pane`. `reattach()` reconciles live
  `orq-*` sessions against `sessions.json` (and refuses to reap orphans if the index is corrupt,
  so one bad file can't wipe sessions). `shutdown()` kills only the attach PTYs, leaving tmux
  alive.
- **direct node-pty** (`LocalSessionManager`, when tmux is absent/old — Windows, stock macOS):
  each command is a direct child of the daemon; sessions do **not** survive a restart.

Env is passed per-session via `tmux new-session -e KEY=VAL` (it deliberately does **not** spread
`process.env`, to avoid leaking daemon secrets). `$TMUX`/`$TMUX_PANE` are stripped before any
tmux `attach` so the daemon can run inside a tmux pane (the common `pnpm dev:daemon` case).

**The agent registry.** `@orquester/registry`'s `REGISTRY` is static data; `registry.ts`'s
`RegistryService` materializes it at runtime: expands path tokens, resolves each `bin` against
PATH, marks entries `enabled` only when a binary is found, and detects agent versions in the
background. `install()`/`update()` run the agent's `npm install -g …`, re-resolve the bin,
re-detect the version, and broadcast `registry.changed`.

**Graceful shutdown.** On SIGTERM/SIGINT the daemon calls `daemon.stop()` with a **3 s hard-exit
backstop** so a connection that refuses to drain can't stall the stop. `stop()` detaches sessions
(tmux stays up), then for both transports does `server.close()` **+
`server.server.closeAllConnections?.()`** so long-lived WS/stream sockets are force-dropped and
`close()` resolves immediately. Paired with systemd `KillMode=process`, a redeploy restart is
near-instant and tmux sessions survive it.

### Frontends

- **Desktop (`apps/desktop/src/main.ts`)** — imports `startDaemon` and runs the daemon **inside
  the Electron main process** over a Unix socket (HTTP off by default). On launch it probes the
  socket; if a daemon already answers it attaches, else it starts its own. The renderer can't
  open a Unix socket, so `preload.cjs` (contextIsolation on, nodeIntegration off) exposes a
  bridge: socket requests go through the main process; **remote** daemon calls go through Node
  HTTP (bypassing the browser CORS gate, since the daemon serves no CORS). Built with esbuild
  (main) + Vite (renderer) + electron-builder.
- **Web (`apps/web/src/main.tsx`)** — resolves its daemon endpoint as
  `import.meta.env.VITE_ORQUESTER_API_URL ?? window.location.origin` (same-origin behind Caddy in
  production). Uses the default browser HTTP + `/ws` transport. Password prompt → `AuthModal`
  (auth UI lives in `@orquester/ui`).
- **Shared UI (`packages/ui`)** — root `OrquesterApp` is the integration seam; both hosts inject
  runtime-specific transport/window/config adapters. One zustand store holds connections, auth,
  navigation, server data, and client-local per-project tab state. `ApiClient` rides a pluggable
  `Transporter` (`HttpTransporter` + a shared multiplexed `WsSessionChannel` with auto-reconnect
  and re-subscribe). Terminals use xterm's **DOM renderer** (WebGL garbles on resize/hidden-tab
  reveal); since the PTY lives in the daemon, unmounting a terminal never kills the session.

### Key runtime flows

- **Create session + attach:** `POST /api/sessions {kind, refId, projectPath, cwd, cols, rows}` →
  daemon resolves the registry bin, assigns a per-project `order`, spawns (tmux or node-pty),
  emits `session.created`. The UI mounts `TerminalView` → opens the output stream.
- **WS PTY streaming:** `TerminalView` sends `{t:"sub", id}` on the shared `/ws` → daemon replies
  scrollback `{t:"out"}` then streams live `{t:"out"}`, `{t:"end"}` on exit; keystrokes/resizes go
  back as `{t:"input"}`/`{t:"resize"}`. On reconnect the channel resets xterm then re-subscribes.
- **Install + launch an agent:** Settings → Agents → Install → `POST /api/registry/:id/install`
  (runs the `npm install -g`) → on success, "+" launches it as a session.
- **Tab reorder/rename:** optimistic store update → `POST /api/sessions/reorder` /
  `PUT /api/sessions/:id` → daemon persists + emits `session.updated` → all clients reconcile.

---

## Local development

**Prerequisites:** Node 20 LTS, pnpm 10, and (for session persistence) tmux ≥ 3.2.

```sh
pnpm install            # runs postinstall → fix-node-pty-perms.mjs (restores node-pty exec bit)
pnpm dev:daemon         # daemon only, tsx watch, staged in ./.stage, on 127.0.0.1:47831
pnpm dev:web            # Vite SPA on :5173, pointed at the local daemon
# or the full desktop app (bundles its own daemon):
pnpm dev
```

| Script | What it does |
|---|---|
| `dev` | Desktop (Electron + Vite + in-process daemon), staged in `./.stage`. |
| `dev:bare` / `dev:desktop` | Desktop against the real `~/.orquester`. |
| `dev:daemon` | Daemon only via `tsx watch`, staged in `./.stage`. |
| `dev:daemon:bare` | Daemon only, against `~/.orquester`. |
| `dev:web` | Vite SPA (`:5173`) with `VITE_ORQUESTER_API_URL=http://127.0.0.1:47831`. |
| `build` | `pnpm -r build` — only `web` (`vite build` → `apps/web/dist`) and `desktop` emit artifacts. |
| `check` / `typecheck` | `pnpm -r typecheck` (`tsc --noEmit`). **The pre-commit gate.** |

**`ORQUESTER_APPDIR` / `./.stage`.** `ORQUESTER_APPDIR` selects the base config/state dir
(CLI `--appdir` → `ORQUESTER_APPDIR` → default `~/.orquester`). `./.stage` is a committed dev
sandbox so experiments don't touch your real `~/.orquester`. Its committed
`daemon.json` enables HTTP with a seeded bcrypt hash — **the stage password is `123456`**
(dev only; never use in production). `.gitignore` keeps committed stage config/seeds but ignores
`*.sock`, logs, and runtime workspaces.

---

## Conventions & gotchas

- **No build for the daemon.** `tsconfig.base.json` has `noEmit: true`; the daemon runs as
  TypeScript via `tsx` (`node --import tsx …/cli.ts`) in dev **and** production. There is no
  daemon `dist/`. Deployment ships source + `node_modules`. The only emitted artifact the daemon
  *serves* is the web SPA (`apps/web/dist`), so `pnpm build` is still needed for that.
  *(The spec docs mention an older `dist/cli.js` ExecStart — that is stale; the shipped
  `deploy/orquester.service` and reality use tsx.)*
- **ESM everywhere** (`"type":"module"`); the only CJS artifacts are the Electron `main.cjs` /
  `preload.cjs`.
- **No test runner.** "Done" = `pnpm check` is clean **and** you ran the app to verify behavior
  (drive the real surface: daemon API over the socket/HTTP, the terminal, Playwright for the SPA).
- **node-pty postinstall.** `scripts/fix-node-pty-perms.mjs` re-adds the exec bit to node-pty's
  `spawn-helper` (pnpm can strip it, breaking every PTY with `posix_spawnp failed`).
  `pnpm.onlyBuiltDependencies` allows builds for `electron`, `esbuild`, `node-pty`.
- **tmux is version-gated.** Persistence needs tmux ≥ 3.2; otherwise the daemon silently uses the
  no-persistence `LocalSessionManager`. Never assume sessions survive a restart on Windows/stock
  macOS.
- **Secrets never cross the wire.** Plaintext passwords are migrated to bcrypt at rest;
  `sanitizeDaemonConfig` masks username/passwordHash/fsRoot; SSH private keys and GitHub PATs are
  never returned by any API; the `?token=` is redacted from logs. *(A bound workspace's PAT **is**
  written to local 0600 files — a git-credentials store inside the per-account `includeIf` file +
  `~/.config/gh/hosts.yml` — so that workspace's terminals/agents can use HTTPS git + `gh` as the
  account. It stays on-host (same user), off any command line, and is still never returned by the
  API. `gh` must be installed on the host separately; it is not an npm package.)*
- **Security boundary asymmetry.** `PUT /api/config/daemon` is **Unix-socket-only** (403 over
  remote HTTP); `/api/accounts` *is* allowed remotely (safe — no key material is ever returned).
- **Archive preview is host-tool-gated.** `GET /api/fs/archive` lists archive contents by
  shelling out to `7z` (p7zip-full) or `bsdtar` (libarchive-tools). Without either on PATH,
  archives degrade gracefully to a download card (`supported:false`). Not an npm package.
- **Folder download is host-tool-gated; file download is not.** `GET /api/fs/download`
  streams a file as-is (`createReadStream`, uncapped, `Content-Disposition: attachment`)
  or zips a folder on the fly by shelling out to `bsdtar`/`zip`/`7z` (`apps/daemon/src/zip.ts`,
  reusing `archive.ts`'s PATH probe) and streaming stdout. No tool → `GET /api/fs/capabilities`
  reports `folderZip:false` and the UI disables "Download as Zip" (the VPS's `p7zip-full`
  gives `7z`; add `libarchive-tools`/`zip` if needed). Zip tools are invoked with
  store-symlinks-not-follow flags so a link inside a folder can't read outside `fsRoot`.
  This is the **only** route that accepts the credential as `?token=` (besides `/ws`), so a
  native browser `<a download>` can authenticate; it's redacted from logs. Distinct from
  `/api/fs/raw`, the 50 MB-capped in-memory inline-preview route.
- **Default endpoint is `127.0.0.1:47831`.** On the VPS it stays on loopback; Caddy (443) is the
  only public face. CORS is intentionally absent (single-origin server; desktop dodges CORS via
  Node HTTP).
- **PWA is `apps/web`-only and needs `dist`.** `/sw.js` + `site.webmanifest` must genuinely
  exist in `apps/web/dist` (Vite copies `public/`); the daemon's SPA fallback returns
  `index.html` for any missing GET, so a missing `sw.js` silently serves HTML and breaks the
  service worker. Run `pnpm build` after touching either. Web Push state lives in
  `<appdir>/daemon/push.json` (chmod 0600 — it holds the VAPID **private** key, never returned by
  any API); pushes fire only from **agent**-session bells (shell beeps never push), debounced
  per session. The SW never intercepts `/api`, `/events`, `/ws`, `/health`, `/mcp` or non-GET
  requests. Registration is web-host-only (`apps/web/src/pwa.ts`, PROD-gated) — Electron never
  touches it.

---

## Production deployment

Stack: Ubuntu LTS, Node 20, pnpm, tmux, Caddy 2, ufw — daemon as a hardened systemd service,
Caddy as the TLS reverse proxy. Templates live in `deploy/`. Use placeholders
`orquester.example.com` / `203.0.113.10` (never commit a real domain/IP/secret).

> **Before deploying, check for a local `DEPLOY_TO_VPS.md` at the repo root.** It's a
> **gitignored**, per-machine runbook that records the actual VPS targets (host, SSH login,
> key, sudo) and copy-paste deploy commands for this checkout — the fastest way to know
> *where* and *how* to deploy. If it's missing, copy `DEPLOY_TO_VPS.md.example` to
> `DEPLOY_TO_VPS.md` and fill in real values (which stay off git). The generic procedure is in
> **Routine updates** below.

### Model

- **systemd (`deploy/orquester.service`)** runs the daemon as the unprivileged `orquester` user
  from `/opt/orquester`, appdir `/var/lib/orquester`. Notable directives and *why*:
  - `ExecStart=/usr/bin/node --import tsx /opt/orquester/apps/daemon/src/cli.ts --appdir /var/lib/orquester` — runs TS via tsx (no dist).
  - `ProtectSystem=strict` + `ReadWritePaths=/var/lib/orquester` + `ProtectHome=true` +
    `NoNewPrivileges=true` — the FS is read-only except the one appdir carve-out.
  - `Environment=TMPDIR=/var/lib/orquester/tmp` — tsx writes its transpile cache to `TMPDIR`, and
    `ProtectSystem=strict` makes `/tmp` unavailable; redirect it into the writable appdir.
  - `Environment=NPM_CONFIG_PREFIX=/var/lib/orquester/.npm-global` + `PATH=…/.npm-global/bin:…` —
    agents run `npm install -g`; the default `/usr` prefix is read-only/unwritable here and fails
    with `npm error code ENOENT`. This points npm at a writable prefix and puts its `bin/` on PATH
    so the daemon can launch what it installed.
  - **`KillMode=process`** (critical) — on stop/restart systemd signals **only** the node process,
    so the detached tmux server + all terminal sessions survive; the restarted daemon reattaches.
  - `Restart=always`, `RestartSec=2`, `PrivateTmp=false` (tmux socket lives under the appdir).
- **Caddy (`deploy/Caddyfile`)** — `reverse_proxy 127.0.0.1:47831` (auto WebSocket upgrade),
  automatic Let's Encrypt TLS, `encode zstd gzip`, HSTS + `nosniff` + `X-Frame-Options: DENY` +
  Permissions-Policy + `-Server`, and a CSP tuned to the SPA (`connect-src 'self' wss:` for the
  terminal channel; `style-src 'self' 'unsafe-inline'` for xterm/CodeMirror inline styles).
- **`deploy/daemon.env.example`** → `/etc/orquester/daemon.env` (chmod 600, owned by `orquester`):
  `ORQUESTER_HTTP_{ENABLED,HOST=127.0.0.1,PORT=47831,USERNAME,PASSWORD}`,
  `ORQUESTER_WEB_DIR=/opt/orquester/apps/web/dist`, `HOME=/var/lib/orquester` (so git/ssh + the
  tsx cache resolve under the daemon user). Generate the password with `openssl rand -base64 32`;
  it's bcrypt-hashed into `daemon.json` on first load.

### First-time provisioning

```bash
# 1. Service user (home = the appdir)
sudo useradd --system --create-home --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester

# 2. Runtime + build tools (node-pty needs python3/make/g++), plus tmux, ufw, Caddy
sudo apt-get update && sudo apt-get install -y git openssh-client tmux ufw python3 make g++ curl ca-certificates p7zip-full
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pnpm
# (install Caddy from its official apt repo)

# 3. Check out the repo, install, build the SPA
sudo mkdir -p /opt/orquester && sudo chown "$USER" /opt/orquester
git clone <your-repo-url> /opt/orquester && cd /opt/orquester
pnpm install          # runs the node-pty postinstall fix
pnpm build            # produces apps/web/dist (the daemon serves this; there is NO daemon dist)
sudo chown -R root:root /opt/orquester   # immutable code; avoids git "dubious ownership" later

# 4. Secrets env
sudo mkdir -p /etc/orquester
sudo cp deploy/daemon.env.example /etc/orquester/daemon.env
sudo sed -i "s|replace-with-a-32+char-random-secret|$(openssl rand -base64 32)|" /etc/orquester/daemon.env
sudo chown orquester:orquester /etc/orquester/daemon.env && sudo chmod 600 /etc/orquester/daemon.env

# 5. systemd unit + session dev tooling & scoped sudo (out-of-the-box for any new VPS)
sudo cp deploy/orquester.service /etc/systemd/system/orquester.service
sudo bash deploy/provision-devtools.sh       # build deps + scoped-sudo drop-in + user tools (uv; cargo-audit best-effort)
sudo systemctl daemon-reload && sudo systemctl enable --now orquester
curl -fsS http://127.0.0.1:47831/health      # expect {"ok":true}

# 6. DNS A record -> the VPS, then Caddy + TLS
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i "s|orquester.example.com|<your-domain>|" /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://<your-domain>/api/auth/info   # expect authRequired:true + salt, valid cert

# 7. Firewall: SSH + HTTPS only (47831 is never exposed)
sudo ufw allow 22/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

### Routine updates

```bash
cd /opt/orquester
sudo git fetch origin && sudo git reset --hard origin/main   # tree is root-owned → run git as root
sudo -u orquester CI=1 pnpm install --frozen-lockfile </dev/null   # CI=1 = non-interactive; </dev/null so pnpm can't steal stdin (see below)
sudo -u orquester pnpm build </dev/null   # only if web/ui changed (rebuilds the served SPA)
sudo chown -R root:root /opt/orquester
sudo systemctl restart orquester # near-instant (graceful SIGTERM); tmux sessions survive
curl -fsS http://127.0.0.1:47831/health
# on trouble: sudo journalctl -u orquester -n 50 --no-pager
```

- **"Dubious ownership" gotcha:** `/opt/orquester` is `root:root` while the daemon runs as
  `orquester` (intentional — immutable code). Run all git/pnpm-install/build as root (or
  `sudo -u orquester`), not as the service user.
- **Daemon code changes need no rebuild** — tsx runs the new source after `systemctl restart`.
  Only the web SPA (`apps/web/dist`) needs `pnpm build`. Caddy needs a reload only if the
  Caddyfile changes.
- **Unit changes need `daemon-reload`.** `deploy/orquester.service` carries the loosened sandbox
  that makes scoped sudo work; a routine `systemctl restart` does **not** re-read the unit. On an
  existing VPS run `provision-devtools.sh` once (build deps + sudoers drop-in + user tools;
  idempotent) then `systemctl daemon-reload && systemctl restart orquester`. New VPSes get it
  automatically via provisioning step 5.
- **Deploy installs must be non-interactive (`CI=1`).** pnpm prints an interactive *"reinstall
  modules from scratch? (Y/n)"* prompt when `node_modules` was built by a different pnpm version
  (it pins `pnpm@10.12.1` via `packageManager`, but a host's global pnpm may differ). Over a
  non-TTY SSH that prompt wedges the deploy and silently skips installing new deps, so the build
  then fails to resolve them. Always `CI=1 pnpm install --frozen-lockfile`. And **never pipe the
  build through `| tail`/`| grep`** — a pipeline's exit status is the last command's, so `set -e`
  won't catch a failed `vite build` and the script will restart into a stale/broken `dist`.
- **Detach pnpm's stdin (`</dev/null`) inside a piped `bash -s`.** If you wrap a deploy as
  `ssh host 'bash -s' <<'EOF' … EOF` (or `sudo bash -s`), a `pnpm install`/`build` in the script
  **reads the rest of the script from stdin** (pnpm reads stdin, e.g. on its *"ignored build
  scripts"* notice), so every step after pnpm silently never runs — the deploy looks done while
  the bundle/Caddy were never rebuilt. Append `</dev/null` to each pnpm command, or write the
  script to a file and `bash file` instead of piping. **Confirm a deploy by the live bundle hash**
  (`curl -s http://127.0.0.1:47831/ | grep -o 'index-[^.]*\.js'`), not the SSH output.

### Security posture

Single-user, **password-only auth on a public HTTPS endpoint** (a deliberate choice; mTLS / VPN /
TOTP were considered and deferred). Defenses: client-side bcrypt + constant-time server check (no
username enumeration), per-IP escalating login throttle, systemd hardening, daemon bound to
loopback with Caddy as the only public face, `ufw` allowing 22+443 only, key-only SSH for admin,
strict CSP/HSTS/headers, `/api/fs/*` sandboxed to the workspaces dir, and no key/PAT material ever
returned by the API. **The #1 ongoing mitigation is keeping the stack patched** (enable
`unattended-upgrades`). A leaked password grants full access — rotate `ORQUESTER_HTTP_PASSWORD`
(edit `daemon.env`, restart) if ever exposed. Sessions also have **scoped passwordless sudo** for
package managers (`deploy/sudoers.d/orquester-pkg` → `/etc/sudoers.d/orquester-pkg`); treat it as
≈root (apt/dpkg run maintainer scripts as root), so it does **not** change the threat model —
password secrecy + patching remain the real mitigations. It costs two loosened unit directives
(`NoNewPrivileges=false`, `ProtectSystem=strict` with carve-outs), keeping `/opt` code + `/boot` +
`/home` read-only even to a root session.

---

## Where to look first

| Need | File(s) |
|---|---|
| Routes, auth, config, transports | `apps/daemon/src/index.ts` |
| Session backends (tmux + local), persistence | `apps/daemon/src/sessions.ts`, `apps/daemon/src/tmux.ts` |
| Process entry + graceful shutdown | `apps/daemon/src/cli.ts` |
| Agent registry runtime | `apps/daemon/src/registry.ts`, `packages/registry/src/index.ts` |
| Appdir layout, paths, schemas, defaults | `packages/config/src/index.ts` |
| Wire contracts / message types | `packages/api/src/index.ts` |
| Client store + transport + WS channel | `packages/ui/src/store/app.ts`, `packages/ui/src/lib/api-client.ts`, `packages/ui/src/lib/transporters/ws-session-channel.ts` |
| Electron embedding | `apps/desktop/src/main.ts` |
| Deployment | `deploy/` + `docs/superpowers/specs|plans/2026-06-19-remote-*.md` |
