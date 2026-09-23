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
long-lived terminal sessions (bash/zsh) running in real PTYs, plus a file browser and editor, and
a supervised **agent host** that drives coding agents (Claude Code, Codex, OpenCode, Grok) over
their machine protocols and renders them as a native **chat GUI** rather than a TUI in a pane.
Clients are thin. It ships two clients over one shared React UI:

- an **Electron desktop app** that embeds the daemon in-process over a Unix socket, and
- a **Vite web client** that is a thin remote client to a daemon running on a VPS, reached over
  HTTPS through Caddy.

The remote-deployment design frames the end state as *"a private, self-hosted Coder/Gitpod for
one person"* — single user. Because the daemon owns the PTYs (via **tmux** where available),
sessions survive client disconnects, page reloads, and **daemon restarts**.

**Features:** workspaces → projects → tabs (workspaces/projects are just directories); many
concurrent persistent terminal sessions per project; **agent tabs are chat tabs** — an agent runs
in the agent host over its own protocol and the client renders messages, reasoning, tool calls,
diffs, approvals, questions and subagents as structured rows (see "Agent chat GUI" below); an
installable agent registry (`claude`, `claudex`, `claudemix`, `codex`, `opencode`, `grok`
— npm or vendor installers; `deepseek` is detect-only, its npm package no longer exists) with live
version detection; detection + "Open on…" for shells/IDEs/explorers/browsers; xterm.js terminals with
WebSocket-multiplexed PTY streaming, scrollback replay and resize; a CodeMirror file editor;
tab drag-reorder + inline rename (server-authoritative); a per-project grid view; a **command
palette** (`Ctrl/Cmd+K`) over open tabs and projects and an **Attention Center** in the top bar
(`Ctrl+Shift+A` cycles the agents waiting on you); **cross-agent conversation history** — a
per-project scan of every agent CLI's own on-disk transcripts, one click to resume; a
daemon-owned **recent-projects** landing list every client shares; archivable
workspaces/projects (a metadata-only `isArchived` flag — the directory is never touched —
hidden from the sidebar and restorable from a muted "Archived" footer panel, optionally
password-gated by the "Protect archived data" daemon toggle); remote access
with TLS, username+password auth, per-IP login throttling, and tmux persistence; per-workspace
git identities (GitHub, Bitbucket Cloud, Bitbucket Server/DC); a **git tab** (status/diff/history
plus stashes, a gitk-style commit graph, and live status pushed only to the clients looking at
that project); **system status** — host CPU/memory/disk, this daemon's own process tree and the
TCP ports it listens on (a top-bar CPU/mem chip + Settings → System panel with a confirm-gated
process kill and a copyable ports table); **project templates**
in the New Project dialog (scaffolders typed into a fresh terminal tab, never run daemon-side);
seven **colour schemes** × light/dark/system/dynamic; a Settings **usage overview** with
per-window quota bars and a per-device reset-time format (countdown / clock / both);
**browser tabs (Design Mode)** — a server-side headless Chromium per
project streamed as an interactive tab over a `/ws-browser` channel, with an element picker that
delivers HTML/CSS/screenshot payloads into an agent's composer or PTY, and embedded Chrome DevTools (the browser's own version-matched frontend proxied by the daemon — right-dock split on desktop, full-screen on mobile); and an installable **PWA** web client
(service worker + Web Push notifications on agent-session bells).

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
`/api/workspaces` + `/projects` (CRUD; deletes are realpath-guarded and cascade-close sessions;
creating a project into a non-empty existing dir is a 409 `DIRECTORY_NOT_EMPTY`);
`/api/projects/recent` (GET the daemon-owned list — newest first, capped at 30, each row joined
against `workspaces.json` so `isArchived` is true exactly when the sidebar would hide it and the
UI can keep the archive curtain closed; POST marks one interaction — silently ignored for
anything that isn't a `<workspacesDir>/<ws>/<project>` dir inside the sandbox, because the
caller's real action already succeeded, and the daemon marks on session create itself rather
than trusting clients to report it); `/api/accounts` (git-hosting SSH
identities — GitHub/Bitbucket; **never returns private keys or tokens**);
`/api/fs/*` (file browser, sandboxed to `fsRoot`, 1 MB read cap); `/api/registry` +
`/:id/{version,install,update}`; `/api/templates` (scaffold catalog + this host's availability);
`GET /api/agents/conversations?path=` (per-project resume picker; fail-soft — a bad path or an
unreadable history answers `{conversations:[]}`, never an error); `/api/git/stashes` +
`/api/git/stash{,/apply,/pop,/drop}` (a client only ever names a **position** — the daemon builds
`stash@{n}` itself, so no raw revision crosses the wire — and must send the `sha` it saw there:
the list shifts under a client whenever another client or a terminal stashes, and an index-only
Drop would destroy a different, unrecoverable stash, so a re-resolve mismatch is a 409);
`/api/system/{resources,processes,ports}` +
`POST /api/system/processes/kill`; `/api/sessions` CRUD + `/input` + `/resize` + `/reorder` +
chunked `GET /:id/output`; `GET /events` (NDJSON event bus + heartbeat; an optional
`?project=<path>` additionally subscribes that stream to `project.git.changed` — see the git
watcher below); `GET /ws` (multiplexed WebSocket for all terminals).

**The scoped git watcher.** `GitWatcher` (`git.ts`) polls a project's `git status` **only**
while ≥1 `/events?project=<path>` stream is open on it (refcounted, so several clients or a
reconnect share one loop) and publishes `project.git.changed` on a real change. Two filters
keep it honest: the change key excludes `lastFetched` (the Git tab's own 60 s auto-fetch bumps
`.git/FETCH_HEAD` and would otherwise fake a change on that cadence), and `passesGitEventFilter`
drops a status blob for any stream that didn't ask for that project — matched on the parsed
event `type`, not on a substring of the line.

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
  daemon/   daemon.json (bcrypt passwordHash, protectArchivedData)  daemon.sock (control socket)
            tmux.sock (dedicated tmux server)         sessions.json (reattach index)
            workspaces.json (side-table: gitAccountId, createdAt, isArchived, archivedProjects)
            recent-projects.json (shared recents, capped at 30; entry-wise tolerant parse)
            accounts.json  keys/ (0700 per-account SSH keys)  logs/
            env/ (per-launcher env files: opencode.env, and the generated claudex.env/claudemix.env)
            hooks/ (managed agent hook script)
            cliproxy/ state.json (model proxy config + routerProviders)  secrets.json (0600)
                      config.yaml (generated)  token  auth/  logs/  claude-home-<entryId>/
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
PATH, marks entries `enabled` only when a binary is found, loads optional per-launcher env files
from `<appdir>/daemon/env/<id>.env` (for example `opencode.env` for an OpenCode-only proxy), and
detects agent versions in the background. `install()`/`update()` run the agent's
`npm install -g …`, re-resolve the bin, re-detect the version, and broadcast `registry.changed`.
Launcher env values are applied only to spawned sessions and are redacted from registry responses.

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

### Agent chat GUI (`apps/daemon/src/agent-host`, `apps/daemon/src/agent-chat`, `packages/ui/src/components/agent-chat`)

An **agent tab is a chat tab**, not a TUI in a pane. `SessionKind` is
`"shell" | "agent" | "agent-chat"`; `"agent"` survives only for legacy terminal records that still
have a live `orq-*` tmux session. Design spec:
`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` — it is authoritative, cites T3 Code
under every derived statement, and carries a `*Built: …*` line wherever the implementation
deliberately departs from a sentence.

**The agent host is a separate process.** `apps/daemon/src/agent-host/main.ts`, run with tsx like
the daemon, spawned by the daemon into a **tmux service session `orqsvc-agent-host`** exactly as
cliproxy is. That is the whole point: `deploy/orquester.service` uses `KillMode=process`, so a
deploy signals only the node process and the host — with every provider child and every in-flight
turn — survives it. It hosts the four adapters, owns every provider child, owns the per-thread
event logs, and serves HTTP over a unix socket at `<appdir>/daemon/agent-host.sock`, authenticated
by the 0600 `<appdir>/daemon/agent-host.token` (regenerated only when no host is alive, so
adoption survives a daemon restart). The daemon side — supervision, adoption, the route proxy, the
tab records — is `apps/daemon/src/agent-chat/**`. On a no-tmux host the host is a plain daemon
child and dies with it; the boot reconcile recovers.

**Appdir layout** (paths from `@orquester/config`, `agentChat*`/`agentHost*`):

```
<appdir>/daemon/
  agent/
    threads/<sessionId>/
      meta.json        ThreadHead; atomic rewrite every 50 events and on every head-shaped change
      binding.json     the durable provider-session binding: the RESUME CURSOR's real home, plus
                       adapterKey/runtimeMode/providerInstanceId/status. Never replaced whole —
                       merged field-wise (undefined = unchanged, null = cleared). See the gotchas.
      events.ndjson    append-only DOMAIN events, per-thread monotonic `seq` — the durable record
      raw.ndjson       untranslated provider frames, REDACTED, rotated 10 MiB x 10, 14 days
      attachments/<id>.<ext>
    receipts.json      commandId -> {seq, status}, a ring of 500 (idempotency)
  agent-host.sock      the host's control socket (named pipe on Windows)
  agent-host.token     0600 shared secret, daemon <-> host
```

A thread id **equals** its session id. `sessions.json` stays tab metadata only (`kind:"agent-chat"`
plus an optional `chat` block) and is parsed entry-wise tolerantly; the host is the source of truth
for thread state. `events.ndjson` is outside every deploy rollback — an older host must still fold
what a newer one wrote.

**Routes** (all proxied by the daemon onto the socket; bearer auth on HTTP, unchanged):

| | |
|---|---|
| Commands (POST, JSON, every body carries a client-minted `commandId`) | `/api/sessions/:id/{turn,interrupt,approval,answer,dismiss,revert,compact,mode,session/stop}` → `{seq}` |
| Daemon-owned, command-shaped (NOT proxied verbatim) | `POST /api/sessions/:id/account` `{commandId, accountId}` → `{seq}` — §3.4's account switch; see the gotcha below |
| Reads | `GET /api/sessions/:id/thread` (whole snapshot) · `GET …/events?after=<seq>` (long-lived chunked **NDJSON**, `:hb` every 15 s — no new WebSocket) · `GET …/turns/:n/diff` · `GET …/items/:itemId` (unslimmed payload) · `GET …/attachments/:attachmentId` |
| Host level | `GET /api/agent/providers` · `POST /api/agent/providers/:id/refresh` · `POST /api/agent-host/stop` |

Everything is built in one place — `agentChatRoutes` in `packages/api/src/agent-chat/wire.ts`; use
it rather than spelling a path. `POST /api/sessions {kind:"agent-chat"}` creates the tab **first**,
then the thread; a bad `resume` is a 400 `RESUME_UNAVAILABLE` there and nowhere else.

**The four adapters** (`agent-host/adapters/<id>/`), one live session per thread:

| Adapter | Process | Protocol |
|---|---|---|
| `claude` (also `claudex`/`claudemix`, Claude + cliproxy env) | one CLI per thread, owned by the SDK | `@anthropic-ai/claude-agent-sdk` streaming input, `pathToClaudeCodeExecutable` = the registry bin |
| `codex` | one `codex app-server` per thread | hand-written NDJSON JSON-RPC over stdio (**no `jsonrpc` field**), bindings generated under `adapters/codex/_generated/` |
| `opencode` | one `opencode serve` **per project**, shared by its threads | HTTP + SSE via `@opencode-ai/sdk` |
| `grok` | one `grok agent stdio` per thread | hand-written ACP client + `x.ai/*` extensions (`adapters/grok/acp/`) |

Every adapter normalises into one closed `RuntimeEvent` union (`@orquester/api/agent-chat`); the
host translates those into ~14 persisted **domain** events; the client folds those into the
timeline. An unmapped provider message is a `satisfies never` typecheck error and a
`runtime.warning` at runtime — never a silent drop, and never the end of a turn.

**Tests and fixtures.** `pnpm test` (root) → `pnpm -r --if-present test` → `node --import tsx
--test $(find src -name '*.test.ts')` per package. Replay tests live **under `src/`** (the daemon's
test glob only walks `src`) and read recorded real-CLI captures from
`apps/daemon/test/fixtures/{claude,codex,opencode,grok}/`, each with a `capturedWith` provenance
block and a `README.md` of protocol observations that is required reading before touching its
adapter. Nothing waits on a sleep: wait on a receipt, on `ThreadStore.drain()` /
`Ingestion.drain()`, or on an event. Filtered runs while developing:
`pnpm --filter @orquester/daemon test`, `pnpm --filter @orquester/ui test`.

**Gotchas that bite:**

- **Never write through a symlinked account home.** `<GROK_HOME>/config.toml` on a managed account
  home is a **symlink** to the daemon user's own `~/.grok/config.toml`; writing it reconfigured
  Grok host-wide, for every terminal tab and every account, twice during the build. Grok's
  `[features] support_permission = true` + `auto_update = false` therefore ride a per-thread
  overlay pointed at by **`GROK_CONFIG_PATH`**. Claude's project-trust write goes to a real
  `~/.claude.json` and must stay atomic (`writeFileAtomic`, mode forced 0600) and confined to a
  realpath'd `projectPath` inside `fsRoot` — never to the request's `cwd`.
- **The resume cursor lives in `binding.json`, not in the event log.** `thread.session-set`
  names the WHOLE session block, so an event that omitted `resumeCursor` — a turn settling to
  `ready`, a stop — replaced it with nothing; the head lost the cursor and the next host, after a
  drain-restart, opened a **fresh** provider session that remembered nothing. The authority is now
  `threads/<id>/binding.json` (`apps/daemon/src/agent-host/store/binding.ts`), the Orquester
  spelling of T3's `provider_session_runtime` row. **It has exactly one writer,
  `ThreadStore.upsertSessionBinding`, and every write is field-wise: `undefined` means *unchanged*,
  `null` means *cleared*.** Never add a "replace the binding" call, and never write
  `resumeCursor: null` on a path that merely does not know the cursor — that is what the omission
  is for. Reads go through `persistedResumeCursor` (binding, else head), and the head's copy plus
  the fold's carry-forward stay as the §8 rollback fallback for threads written before the file
  existed. The `continueAfterRestart` marker deliberately stays on the head, where it already was.
- **A Claude turn is many API messages, and every message restarts its content indexes at 0.**
  Anything in the Claude normaliser that remembers a streamed block by its bare `index` for the
  whole turn is wrong: the text block of the message after the next tool round-trip has the same
  index as the first one, and the fold appends streamed text by item id — so a long turn's final
  summary once rendered inside the turn's opening bubble, and the user read "the agent said
  nothing". Assistant text block state is keyed by `(message.id, index)` (`textBlockKey`), and the
  CLI's complete per-block `assistant` frames carry the stream's `message_start` id, which is how
  a snapshot finds its streamed block. `inFlightTools` is keyed by index only because a tool block
  is deleted the moment its result arrives.
- **Registry `args` are the terminal launcher's flags and never reach a chat launch** — permissions
  come only from `runtimeMode`, `full-access` = `bypassPermissions`; effort only from the model
  selection. (`buildRefIdIndex` in `agent-host/main.ts` carries a row's adapter and bins, never its
  `args`; Claude's mapping is `RUNTIME_MODE_TO_PERMISSION_MODE` in `adapters/claude/launch.ts`.)
- **`HISTORICAL_RAW_SOURCE`** (`"history.replay"`) tags every event projected out of a provider's
  *native* history on resume. A replayed row is the past: it claims no token usage and its turns
  are already settled. Anything that treats a raw frame as live must check it.
- **One `opencode serve` per project, not per thread** — safe only while chat threads register
  nothing thread-scoped into that server and every automatic approval is a **one-shot** grant.
  OpenCode's `always` is directory-wide across every session of that server; an `always` from a
  full-access thread silently widens a supervised one. Both are invariants, not preferences.
- **Code is highlighted with Lezer, never Shiki.** The production CSP is `script-src 'self'` with
  no `'wasm-unsafe-eval'` and `/etc/caddy/Caddyfile` is reconciled by hand, so a WASM highlighter
  fails silently after a deploy. `@codemirror/language-data`'s parsers are already in the bundle.
  Markdown is `react-markdown` + `remark-gfm`, never an HTML string.
- **No lazy dynamic `import()` anywhere under `agent-host/`.** A surviving host runs old code until
  its drain-restart; loading changed source into it is a correctness bug. That drain-restart is
  triggered by a protocol-version bump **or by a moved code stamp**: the host reports the commit it
  started from in `/health` (`support/code-stamp.ts` reads `.git/HEAD` without the git binary) and
  the daemon compares it with its own at boot, so a code-only deploy replaces the host as soon as
  no turn is active. An unreadable stamp on either side never restarts anything.
- **A fresh host must not answer `GET /providers` with `[]` for five minutes.** Three layers, all
  in `agent-host/orchestration/provider-snapshots.ts`, ported from T3 (`makeManagedServerProvider`
  + `ProviderRegistry`). **(1) A pending seed, synchronously at construction** — before the cache
  is read and before any probe, every adapter's `pendingSnapshot()`
  (`agent-host/adapters/pending.ts`, wired through `ADAPTER_PENDING_SNAPSHOTS`) supplies a row with
  `status:"unknown"`, `auth:{status:"unknown"}`, "… has not been checked in this session yet." and
  the best catalogue it can name without I/O (Claude's `FALLBACK_CLAUDE_MODELS` family aliases,
  Grok's two; Codex/OpenCode read theirs off a live server and honestly answer `[]`). A pending row
  is **never `status:"error"`** — that spelling makes the client raise "sign in again" for a
  provider nobody has looked at — and is never persisted or hydrated. **(2) The disk cache is
  correlated, not just keyed**: `provider-snapshots.json` is v2, each row `{identity, snapshot}`
  with `{adapterId, hostProtocolVersion, binPath, version}` inside the file, and a row hydrates
  only when the adapter id agrees in all three places, the protocol version matches and the CLI is
  still at the same path — so a cache written before an `npm install -g` moved the binary is
  discarded rather than rendered. A correlated row overrides the pending seed; a v1 identity-less
  payload is dropped. **(3) The registry forces a probe of every provider at boot itself**
  (`startBootRefresh()`), called from `main.ts` after `host.openGate()` and never awaited — a probe
  must never delay readiness. The 5-minute interval is only a top-up and stays gated on a live
  watcher; the old first-watcher priming survives as a no-op fallback.
  **A moved or updated CLI binary re-probes on the next read**: the identity also carries a cheap
  `realpath` + `stat` of the resolved bin (`binRealPath`/`binMtimeMs`/`binSizeBytes` — the native
  installer's `~/.local/bin/claude` is a *symlink*, so an update moves its target and never its
  path), every `GET /providers` compares it (rate-limited per adapter) and a mismatch kicks ONE
  background refresh through the same one-permit chain while the current snapshot is still served;
  and **an install/update from the registry asks the host to refresh** that entry's `chat.adapter`
  (`AgentChatService.onRegistryEntryChanged`, fired from the daemon's `registry.changed` listener
  on `installing → idle` or on a version that moved — fire-and-forget, debounced per adapter, and
  the `changed:true` answer publishes `agent.providers.changed` exactly as the manual route does).
  `POST /api/agent/providers/:id/refresh` is the manual escape hatch. Client side nothing branches
  on `status`: `resolveLaunchModel` takes only `models`, so a pending snapshot **with** a catalogue
  is launchable and "Still loading this agent's models" means the catalogue is genuinely empty.
- **The provider probe runs under the daemon user's own login.** `auth.status` from the host
  therefore describes the system home, which may be stale while every managed account is fine.
  The daemon overlays it on the way out (`agent-chat/provider-auth-overlay.ts`): a family with at
  least one managed account not flagged `needsReauth` is reported authenticated through it, so the
  "sign in again" toast fires only when nothing of that family is signed in.
- **`auth.status: "unknown"` is NOT `"unauthenticated"`.** `unauthenticated` is a *verdict* and may
  only be written where the adapter can prove it — Codex's `account/read` answering
  `requiresOpenaiAuth`, Grok's CLI printing that it is not logged in. Every other failure, timeout
  or silence is `unknown`: a Claude init that merely lacks an `account` block is NOT proof (the CLI
  initialises fine under API-key/Bedrock envs and under logins whose account block it does not
  return), and reading it as one made the client toast "claude needs signing in again" at a host
  whose managed accounts were all valid. Client-side, only `unauthenticated` earns the sign-in
  copy; an errored-but-`unknown` snapshot still surfaces, with neutral copy, and only while the CLI
  is installed. The remembered dismissal is keyed on `[adapterId, status, auth.status, message]`, so
  the same verdict never re-toasts but a moved one does
  (`adapters/*/probe.ts`, `packages/ui/src/lib/agent-chat/providers.ts`, `lib/agent-auth-notice.ts`).
- **`responseMode` decides four behaviours and they must never disagree.** It rides
  `PendingUserInput` as a first-class field (`dismissible` is derived from it, never authored):
  `/dismiss` is legal only for `"message"`; the terminal-turn cleanup force-resolves only the
  NON-message requests of the turn that just ended (a message-mode question may outlive its turn
  and still accept a later user message); an async question never parks the turn at ingestion's
  flush point. A message-mode answer commits its `user-input.resolved` activity and its
  `thread.message-sent` in **one** orchestrator decision with the steer as the only effect — the
  card must not be able to close without the message, or the reverse — and its text echoes each
  question before its answer so the agent, which sees an ordinary user turn, can tell what was
  answered.
- **`raw.ndjson` is as sensitive as the repository it watched** — it records whatever the agent
  read, and Grok's `_x.ai/mcp/servers_updated` carries the host's real MCP credentials. Redaction
  runs before anything is written, and before any stderr excerpt leaves the host.
- **A running state never outlives its process.** Before `session.exited` the adapter settles the
  in-flight turn, closes every live task `stopped` and fails every parked request. Every wait on a
  child has a deadline (`support/deadline.ts`), and an expired one kills the child.
- **The agent host is a protected kill target but its children are not.** `system-status.ts` takes
  the host pid in `protectedPids` and registers it as an extra tree **root** (`extraRootPids`), so
  a runaway provider child stays killable from Settings → System even though the host runs in a
  tmux service session `panePids()` excludes.
- **Agent rows must survive resumes and retention, and a drill-in must not filter itself away.**
  Four rules that fell out of one owner incident (two subagents cut by a rate limit, resumed,
  finished — and the chat still showed them as "terminated" at the bottom of the timeline):
  (1) Claude resumes a subagent under the SAME task id with a NEW launching `tool_use_id`, so the
  roster fold (`packages/api/src/agent-chat/roster.ts`) reopens a terminal row on a changed
  `toolUseId` and only then — an unchanged one is a late delivery and must not reopen anything.
  (2) `task_progress.description` is the agent's live activity, never its name: the normaliser
  fills a task's description from progress only when it has none. (3) Retention has two windows
  (`fold.ts`): the parent's last 500 rows, from which an agent's `task.started`/`task.completed`
  are exempt because they anchor its timeline row, and a per-agent window (200, 2 000 across
  agents) for the rows an agent owns — those render only in its drill-in and were evicting the
  parent's rows and the anchors within minutes. (4) The drill-in derives its rows with
  `{ ownerAgentId }` (`entries.logic.ts`): §7.2's quiet-timeline filter drops every agent-owned
  row from the PARENT timeline, and applying it again inside the agent's own view is how every
  drill-in read "This agent has not reported anything yet". Streamed `tool.output` chunks ride
  `payload.delta` and become the entry's `detail`, untrimmed, for `joinLifecycleDetails` to fold.
  (5) **Message segments are keyed per agent** — `(turnId, agentId | none, role)` in
  `ingestion/index.ts`, with the owner baked into the message id (`ownedBaseKey`) and stamped on
  every `thread.message-sent` of an agent-owned segment: a subagent narrates inside the PARENT's
  turn, so a turn+role key put its prose in the parent's own bubble and let its first visible word
  close the parent's thinking block. `splitThreadItems(items, ownerAgentId)` is the client mirror
  — the parent's view drops agent-owned messages, the drill-in keeps its own — and the Claude
  normaliser projects a nested `thinking` block as the agent's reasoning row, which it used to drop.
- **Background shells (Claude): only detached ones are surfaced, and their output is TAILED from a
  file.** Every ordinary Bash call raises a `local_bash` task, so `is_backgrounded` — not the task
  type — is the discriminator: a `false` one is the blocking tool call's own row and gets no
  `task.started`, no `task.completed` and no liveness (surfacing it flashed a roster row, reading
  like a subagent, for every foreground command). A later `task_updated {patch:{is_backgrounded:
  true}}` (Ctrl+B) **promotes** it — `task.started` first, then the update — and that is where its
  roster life begins; `ambient`/`skip_transcript` tasks are never surfaced at all. An **absent**
  field is not `false` (older CLIs, and fixture `07`). A surfaced shell also gets its own
  `command_execution` item, `itemId: "bgshell:<taskId>"`, `agentId: <taskId>`, because **the CLI
  streams a background command's output nowhere** — it writes it to a file under its own `TMPDIR`
  and names that file **only** in the launching call's placeholder `tool_result`
  (`task_notification.output_file` arrives when it is already over, and is `""` for a foreground
  task). The normaliser parses that path and hands it to the session
  (`onBackgroundShell`); the session tails it with `support/tail-file.ts` — appended bytes only,
  UTF-8 safe across reads, ≤64 KiB per read and **≤1 MiB per shell**, then one truncation notice
  naming the file — and each read becomes `content.delta {streamKind:"command_output"}` on that
  item. Two ordering rules are load-bearing: the message loop **drains the tail before** a
  `task_notification` (or a settling `task_updated`) is normalised, because `item.completed` is
  where ingestion closes the item's output buffer; and `background_tasks_changed` is a **level**
  signal that must never be correlated with the edges — closing a task on its absence wrote a
  "Task stopped" row just before the real completion, and the roster fold keeps the first terminal
  status, so a clean shell read as interrupted forever. The level may still name unknown tasks and
  clear liveness, but it is not a roster event (fixtures README observation 18).
- **The context meter is per adapter and never a subagent's or a thread's cumulative total.**
  `thread.token-usage.updated` is ingested verbatim into a `context-window.updated` activity and
  the client takes the **latest one whole** — last-writer-wins, never merged — so every emission
  must be a *complete* reading (`maxTokens` included whenever it is known) and only the MAIN
  agent's own context may move it. The four sources: **Claude** asks the SDK
  (`Query.getContextUsage({detail:"summary"})` — the CLI's own `/context`, no token-count API call)
  after the handshake, after every `result` and after every `compact_boundary`, measuring
  `totalTokens` against **`rawMaxTokens`**, with `message_delta` usage between calls and
  `totalProcessedTokens` from Σ `modelUsage[*]` (cumulative across turns, subagents included);
  **Codex** uses `last.totalTokens − last.reasoningOutputTokens` against `modelContextWindow`;
  **Grok** stamps the handshake's window onto every row including the per-chunk ones; **OpenCode**
  uses each owned `step-finish`'s `tokens.total` against `GET /provider`'s `limit.context`, read
  once per server. Three things that were bugs and must not come back: a subagent's
  `task_progress`/`task_notification` `usage.total_tokens` fed into the thread meter (it made the
  ring jump to whichever subagent had run longest — that usage is roster data only); `result.usage`
  used as `usedTokens` (it is the per-turn MAIN-LOOP rollup, not a context size); and an emission
  that omits a window the adapter already knows (it erases the ring the previous row drew). Claude's
  control request is best-effort in every direction — an older CLI, a timeout or an SDK without the
  method is one debug line and the last known reading, never a `runtime.warning` and never a failed
  turn. `compactsAutomatically: false` is a *verdict* (Claude's `isAutoCompactEnabled`) and the
  popover then says "Auto-compaction is off."; an absent field means nobody asked.
- **Switching a thread's account writes `launch.json` FIRST, and only while the thread is idle.**
  The composer's account chip re-points an existing chat thread at another managed account
  (`POST /api/sessions/:id/account` → the host's `POST /threads/:id/identity`), applied on the
  **next message**: §3.4's ensure-session step sees the changed `accountKey`, restarts with reason
  `"account"` and carries the resume cursor, so the conversation survives. Four invariants.
  (1) **The launch config is rewritten before the head** — `main.ts`'s `buildEnv`/`resolveHome`
  prefer `launch.homePath`/`launch.launchEnv` over the head's account (they must: it is the
  daemon's resolved answer), so a head that moved first would claim the new identity while every
  relaunch kept the old home's credentials; a failed append rolls it back. (2) **It is refused
  unless nothing is in flight** — `identitySwitchRefusal` (`orchestration/session-policy.ts`) is
  the one expression, mirrored client-side by `canSwitchChatAccount`
  (`packages/ui/src/lib/agent-chat/account-switch.ts`) to gate the chip. (3) **The home KIND never
  crosses the cliproxy boundary** — it is a function of the registry entry, which never changes,
  and a cliproxy home does not share `projects/` with the rest. (4) **OpenCode is excluded**: one
  server per project under the daemon's own identity, so there is no per-thread account to move.
  The route is daemon-owned rather than a §6.2 command precisely because the body is **not**
  forwarded verbatim — only the daemon can apply the family gate, the seeded-account gate and the
  launch-env recompose. `binding.json` gains no new writer.
- **Rewind counts turns by ORDER, never by checkpoints.** `targetTurnCount` on `/revert` and on
  `thread.reverted` means "keep the first N started turns" — `startedTurns(turns)` in
  `packages/api/src/agent-chat/turns.ts`, the fold's turn rows with a provider turn id, in order —
  on the host (the command's bound, the checkpoint numbering, the `RollbackTarget` handed to the
  adapter), in the fold (`reduceReverted` keeps those turns' rows; the checkpoint-count rule survives
  only for a log with no turn rows) and in the client (`revertTurnCount` = the index of the turn
  whose `userMessageId` is the message). The checkpoint list is sparse exactly where a rewind
  matters — a non-git project captures nothing, a failed capture skips a turn, a resumed thread has
  no checkpoint for its history — which is why "rewind to here" never appeared on a real thread.
  Three rules follow. (1) **An adapter resolves the cut BY ID** (`firstRemovedTurnId`) and refuses
  an id it cannot place: Claude keeps `turnBoundaries` (our turn id ↔ transcript uuid, remapped on
  every fork) in its cursor, Codex sends `thread/revert {beforeTurnId}`, OpenCode looks the turn up
  in its messages; the count is only the fallback for a caller that predates the id. (2) Checkpoint
  refs are `turn/<ordinal>`, sparse by design, and `runtime.revertedTo` is cleared by the next
  `turn.started` — it used to stay set forever, so the first turn after a rewind never captured
  again. (3) The client withholds the affordance before the last compaction marker and on a
  `/compact` message and on a `user` row the provider's transcript wrote itself
  (`<command-name>`, `<task-notification>`, … — `isProviderInternalUserMessage`), and `rewindTo`
  keeps `reverting` (the composer's one `inert` reason) until the truncation is folded, then returns
  the message's text and attachment chips to the composer; the host keeps an unreferenced
  attachment for 24 h, which is what lets those chips stay valid. Esc-Esc while idle opens the same
  picker the composer's rewind control does. Two more things that were bugs: the compaction marker
  is exempt from the 500-row activity window (a busy thread evicted it in minutes, and the gate then
  offered every pre-compaction message), and Claude's "compacted in between" check is decided by the
  anchor's POSITION relative to the transcript's last `isCompactSummary` row — `preserved_messages.
  all_uuids` names the pre-compaction rows the CLI kept, never the rows written afterwards, so
  reading it as the set of reachable anchors refused every rewind after a live `/compact`. OpenCode's
  live turn ids are now the prompt's message id (its own `opencode-turn-<uuid>` was unresolvable),
  with an in-memory map across its own forks.
- **A `/compact` is a visible phase, not "Working".** The first `system/status {status:
  "compacting"}` latches `thread.state.changed {state:"compacting"}` (the CLI sends six of them);
  the next non-compacting status ends the phase. `compact_result: "failed"` emits
  `{state:"compaction-failed", error}` **and** a `runtime.warning` — a failed compaction produces
  no `compact_boundary`, so that frame is the only notice there will ever be. A success is silent
  there because the boundary follows with the real before/after counts. Ingestion turns all three
  into one `context-compaction` activity kind and the client renders on `payload.state`.
  **The marker also carries the CLI's own summary and reveals it behind a "Show summary" toggle**
  (collapsed by default, like `ctrl+o`): the boundary's `compacted` event is HELD for exactly one
  frame so the synthetic `user` frame that follows it — `isSynthetic: true`, a plain-string body,
  `uuid == compact_metadata.preserved_messages.anchor_uuid` — rides it as `summary` instead of
  becoming an 18 KB "user message" nobody typed (any other frame, a turn end or a closing session
  releases the marker unchanged); `project-history.ts` maps the transcript's `isCompactSummary`
  row to the same marker on resume, and §5.6's 16 KiB wire cap + `truncated` point the row at
  `GET …/items/:itemId` for the rest.

Start here: `apps/daemon/src/agent-host/README.md` (module map + package ownership).

**Orquester MCP** (`apps/daemon/src/mcp/`). `POST /mcp` lets an external agent drive chat sessions
the way the chat GUI does: 29 tools (catalogue, sessions, messages, pending requests, waiting,
usage, files, todos) and no terminal I/O — terminal tabs are only listed and closed. It is mounted
**only on the HTTP transport** (`mode:"remote"`, behind the global bearer hook; the unauthenticated
unix socket never serves it) as a stateless Streamable-HTTP endpoint with one `McpServer` per
request, a 16 MiB body limit and `405` for `GET`/`DELETE`. Every tool but the kept todo/file pair
is an **in-process client of the daemon's own REST API**: `InjectDaemonApi` (`daemon-api.ts`) runs
every call through `app.inject()` with the caller's own `Authorization` header, so each route's
gates (the create route's claudex model gate, seeded-account gate, `chat.adapter` check and
tab-then-thread order; the proxy routes' `THREAD_NOT_FOUND`/`HOST_UNAVAILABLE` guards) and error
codes are the GUI's by construction, not by review. Two invariants:

- **Tools never touch services directly — only `DaemonApi`.** No `services.sessions`, no host
  client, no store: the seam's only non-route methods are the attachment upload (over
  `AgentChatService`) and the bus subscription. A route that proves awkward gets a `DaemonApi`
  method; a tool never imports a service. The one standing exception is the kept todo/file pair,
  which reaches `TodoTools`/`FsTools` (`todo-tools.ts`, `fs-tools.ts`) through its `ToolContext`.
- **Waits ride the `Broadcaster`, never sleeps.** `send_message`/`implement_plan` with `wait` and
  `wait_for_session` (`wait.ts`) subscribe to the bus the `/events` clients read and evaluate the
  session summary (`activity` plus the six chat fields) on every event, with a 10 s list re-read
  only as a safety net, a 300 ms settle window for siblings stamped by one host poll, and the
  request's `close` aborting them; `revert_session` waits (≤ 10 s) for the host's asynchronous
  rewind the same way, re-reading the thread on each bus event about the session, else after 1 s.
  `wait_for_session` compares `activity.needsAttentionAt` with the caller's `after` and hands back a
  `cursor`: a chat tab's `finished` is sticky, so "return what is already flagged" was a busy loop
  in v1. For the cursor to miss nothing, the daemon moves that stamp whenever something new calls
  for the user, not only when the attention value changes (`agent-chat/summary.ts`): a request id
  the previous host poll did not have, or a latest turn whose `completedAt` is later than that poll
  — never a rewind or a replayed history, which land on turns that settled long ago.

Addressing: sessions only by `sessionId` (titles are not unique, so there is no title matching);
`project` as the absolute path or `"<workspace>/<project>"`, resolved by `resolveProject()`
(`addressing.ts`) to exactly `<workspacesDir>/<ws>/<name>` inside `fsRoot` — the string
`GET /api/sessions?projectPath=` matches. The tools are deliberately stricter than the GUI in a
few places: `project`, `cwd` and attachment paths must realpath inside `fsRoot`; `accountId` is
family-checked before a create (the daemon silently falls back to the system home); at most 24
running sessions per project; `update_session` refuses a mid-turn model/permission change without
`force`. Like the GUI, `send_message` refuses while a request is pending (the host alone would take
the message as a steer). A result is one JSON object capped at 60 000 bytes (`result.ts`); every
tool that can outgrow it bounds itself first and says what it cut (`truncated`, `optionsOmitted`,
`subagentsTruncated`, `filesTruncated`, …), so `ok()`'s byte cut is only the last resort. An error
is `<CODE>: <message>`, the message capped at 4 000 code points. `server.ts` replaces the SDK's
`tools/call` handler (public `server.setRequestHandler`) so a schema refusal answers the same
`<CODE>: <message>` envelope as every other error, and it parses the arguments strictly
(`argumentsSchema`, `.strict()` at the top level): an argument name the tool does not take is
refused and named, never silently dropped — `tools/list` already advertises
`additionalProperties: false`. Tool docs: `docs/orquester-mcp.md`; design: the v2 spec,
`docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md`.

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
- **`CreateSessionRequest.initialCommand` is TYPED, never executed.** Both backends write it into
  the fresh PTY as keystrokes (newline appended) the moment the pane exists — the shell decides
  what to run, the daemon never spawns it out-of-band and never quotes or rewrites it. Ordering
  needs no delay: the bytes queue in the pane's tty until the shell's first read, which is the
  whole point (a client-side "sleep, then send an input frame" is droppable by a reconnecting
  socket). Because it rides `/input`'s trust it gets two bounds `/input` can't have — ≤
  `MAX_INITIAL_COMMAND` (4096) chars and **no control bytes** — so nobody can smuggle an escape
  sequence into a tab the user never saw. A 400 `INVALID_INITIAL_COMMAND` otherwise.
- **Uploads are raw binary streams, never base64 JSON.** `POST /api/fs/upload` and
  `POST /api/sessions/:id/upload` take the file bytes as an `application/octet-stream` body with
  the metadata (`destDir`/`relativePath`/`onConflict`, `name`/`type`) in the query string. The daemon
  (`apps/daemon/src/upload-stream.ts`) pipes the body to a temp file beside the destination and
  renames it into place, so memory stays flat and the shared `MAX_UPLOAD_BYTES` (500 MiB, in
  `@orquester/api` — the clients skip bigger files before sending) is a disk/UX guard that can be
  raised freely. Don't go back to base64-in-JSON: Fastify buffers a JSON body into one V8 string,
  capped at ~512 MiB, and the browser hits the same wall building the data URL — that path topped out
  near 380 MB. Fastify's `bodyLimit` does not apply to a stream parser, so the cap is enforced twice
  (a declared `Content-Length` above it is refused before a byte is read; `receiveUpload` counts what
  arrives) and every refusal that leaves the body unread answers with `Connection: close` so Node
  shuts the socket instead of draining a 500 MB body. The octet-stream parser is registered on an
  encapsulated scope per route — every other route still answers 415 to a binary body. Conflicts are
  decided after the body is received, so `{conflict:true}` is always a reply to a completed request.
  Clients hand a `File`/`Blob` straight to `uploadFsEntry`/`uploadSessionFile` (the browser streams
  it from disk); the desktop bridge is the one place a file is read into memory, because Electron's
  IPC clones ArrayBuffers but not Blobs.
- **Resume refuses; it never silently degrades.** `resumeConversationId` is checked twice before
  launch: `resumeLaunchArgs` (`sessions.ts`) drops anything outside `/^[\w.][\w.\-/]*$/` or
  containing a `..` segment (the leading char excludes `-`, so an id can never arrive as a flag),
  and the route 400s `RESUME_UNAVAILABLE` when the id is unusable **or** the agent has no
  `resumeArgs` in the static catalog — rather than opening an empty session the user believes is
  their old one. Resume args go **last**, after the entry's own flags (codex resumes via a
  `resume <id>` subcommand, which must follow the global options). Client side, the store surfaces
  it as a toast offering a fresh launch with the same agent/account/model.
- **A conversation only exists inside the HOME that wrote it.** `agent-conversations.ts` scans the
  union of the daemon's own HOME, every managed account home
  (`agent-accounts/<family>/<id>/home`) and the proxy homes (`cliproxy/claude-home-<entryId>`),
  deduping roots by dir and then collapsing symlink aliases per history dir by `realpath` — a
  managed account home *symlinks* `projects`/`sessions` back at the daemon's own agent home, so
  without that the same transcripts get scanned once per account and burn the per-agent file cap
  on duplicates. First spelling wins and the system home is listed first, so a merely-symlinked
  transcript is correctly reported as resumable under the system home. Every remaining row is
  stamped `home` + `accountId`/`proxyRefId`, and the
  UI's `resumeAccountId` maps it: `account` → that id, forced (only that home sees the transcript);
  `system` → the user's selected/preferred account, because every managed home symlinks its history
  dir back to the system one by construction so any identity can resume it — forcing the host
  identity here once broke resume with "session expired, run /login" whenever the system home's own
  login was stale (the sentinel is used only when there is no fallback at all). `cliproxy` rows have no expressible identity — claudex/claudemix carry no `resumeArgs`,
  and plain `claude` in the wrong HOME cannot find the transcript — so the UI filters them out of
  both resume surfaces (`isResumableConversation` in `packages/ui/src/lib/resume-account.ts`); the
  full fix (resumeArgs on the launchers + routing on `proxyRefId`) is a known follow-up.
  Every lister is independently try/caught to `[]` and file-capped: this reads other tools' private
  formats, so a failure may only shrink the list.
- **Template availability is probed against the SESSION PATH, not the daemon's.** `/api/templates`
  gates each entry's `requires` with `isBinOnPath(bin, sessionPath())`. The daemon's own PATH is
  deliberately narrow under systemd and omits the per-user bin dirs (`~/.local/bin`,
  `~/.cargo/bin`, `~/go/bin`, …) that sessions get — probing it would grey out templates the
  terminal runs fine. Probed per request (not cached) so a tool installed from a tab lights its
  card up on the next modal open.
- **`/api/system/processes/kill` protects the daemon, the tmux server, and the managed cliproxy
  process** (the route passes the proxy's live child pid via the service's `protectedPids` hook —
  on a no-tmux host cliproxy is a daemon child and would otherwise be a legal target).
  Everything else must descend from a daemon-tree root (its own children plus every `orq-*` tmux
  pane pid) or it's `PROCESS_NOT_MANAGED`. The guard is two-pass on `/proc` starttime, never on the shared 2 s
  snapshot cache: once the first SIGTERM lands, children reparent and `ppid` stops being an
  identity, so pass one records starttimes while the tree is intact and pass two re-checks each one
  immediately before signalling (a recycled pid must never get the signal). Everything under
  `/api/system/*` is Linux-only by construction (all `/proc`); off Linux each route answers
  `supported: false` with zeroed data, the same host-gating shape `/api/fs/capabilities` uses.
- **Adapter/localStorage loads must go through a schema (or field-wise validation) with
  fallback — old bundles' payloads outlive deploys.** Raw `JSON.parse` output must never reach
  typed code: a `usage` blob persisted by a pre-migration bundle once crashed the whole web
  client on load ("Cannot read properties of undefined"). Pattern: zod `safeParse` + default
  fallback (see `packages/ui/src/lib/app-config.ts`) or per-field `typeof` validation (see
  `panel-sizes.ts` / `view-mode.ts` / `search-options.ts`). Review for this whenever adding a
  persisted client-side shape or changing an existing one.
- **Secrets never cross the wire.** Plaintext passwords are migrated to bcrypt at rest;
  `sanitizeDaemonConfig` masks username/passwordHash/fsRoot; SSH private keys and git-hosting
  tokens (GitHub PATs, Bitbucket API/HTTP access tokens) are never returned by any API; the
  `?token=` is redacted from logs. *(A bound workspace's token **is** written to local 0600 files
  — a git-credentials store inside the per-account `includeIf` file, plus `~/.config/gh/hosts.yml`
  (GitHub) or `<appdir>/daemon/keys/<id>.env` (Bitbucket; see below) — so that
  workspace's terminals/agents can use HTTPS git + `gh` as the account. It stays on-host (same
  user), off any command line, and is still never returned by the API. `gh` must be installed on
  the host separately; it is not an npm package.)*
- **Bitbucket session-CLI contract.** There is no `gh` equivalent for Bitbucket, so a bound
  Bitbucket account instead writes `<appdir>/daemon/keys/<id>.env` (0600, shell-sourceable) that
  agents/scripts can `source` on demand to call the REST API. Keys: `BITBUCKET_PROVIDER`
  (`bitbucket-cloud` | `bitbucket-server`), `BITBUCKET_BASE_URL` (REST root —
  `https://api.bitbucket.org/2.0` for Cloud, the instance base URL incl. context path for DC),
  `BITBUCKET_USER` (Atlassian email for Cloud, username for DC), `BITBUCKET_TOKEN`, and
  `BITBUCKET_AUTH`: `basic` ⇒ `curl -u "$BITBUCKET_USER:$BITBUCKET_TOKEN"`, `bearer` ⇒
  `curl -H "Authorization: Bearer $BITBUCKET_TOKEN"`. Written by `AccountsService.syncCliAuth`;
  never injected into session env by default.
- **Git providers.** Provider-specific REST/URL/credential behavior lives in
  `apps/daemon/src/providers/` (`github`, `bitbucket-cloud`, `bitbucket-server` behind the
  `GitProvider` interface + `providerFor()`); `AccountsService` stays provider-agnostic (keygen,
  `includeIf` binding, credential files). Bitbucket Cloud SSH always uses `ssh.bitbucket.org`
  (the old `bitbucket.org` SSH host dies 2026-11-12) and REST auth is Basic `email:token` with a
  **scoped** Atlassian API token; Bitbucket Server/DC uses `Authorization: Bearer` and its clone
  URLs come from the repo's `links.clone[]` — **never derived** (either entry may be absent: no
  `ssh` ⇒ HTTPS-only, no `http` ⇒ SSH-only, so a repo listing must tolerate both and skip a repo
  with neither). DC identity comes from the instance's `X-AUSERNAME` response header, never from
  the typed username. `Account.provider` is a zod discriminant with a preprocess that
  migrates legacy `githubLogin`/`githubKeyId` records.
- **known_hosts pins name both Cloud hostnames.** `apps/daemon/src/known-hosts.ts` seeds
  `bitbucket.org,ssh.bitbucket.org <type> <key>` lines into the daemon-owned
  `<appdir>/daemon/keys/known_hosts`: OpenSSH matches on the hostname it dials, and all Cloud SSH
  traffic dials `ssh.bitbucket.org`, so a `bitbucket.org`-only pin would silently degrade to TOFU
  (`StrictHostKeyChecking=accept-new`). A once-per-process best-effort refresh from
  `https://bitbucket.org/site/ssh` only ever *adds* lines for those two hosts. DC hosts are TOFU'd
  into the same file.
- **Model proxy (cliproxy) & router providers.** The "Model proxy" is a daemon-supervised
  CLIProxyAPI process (`apps/daemon/src/cliproxy*.ts`) that lets the `claudex`/`claudemix`
  launchers drive GPT (Codex OAuth), Claude OAuth, **router** and **Grok** (xAI OAuth) models
  through the Claude Code harness. Its state lives in `<appdir>/daemon/cliproxy/`: `state.json`
  (enabled, port, model picks, `modelOverrides`, seeded accounts, **`routerProviders[]`**) and
  `secrets.json` (0600 —
  proxy api key, management secret, **`routerKeys` = providerId → API key**). Keys never cross the
  wire; `CliProxyStatus.routerProviders[].keyState` is `"none" | "set" | "verified"` only.
  - **Router providers are data, not code.** A provider is
    `{id (slug /^[a-z0-9][a-z0-9-]{0,31}$/, reserved: codex/claude), label, baseUrl (http(s)),
    preset: "openrouter"|"tokenrouter"|null, models: [{name, alias?, contextWindow?, compactWindow?,
    compactPct?}], keyVerifiedAt, createdAt}` (zod in `packages/config`). `ROUTER_PRESETS` only
    *prefills* the create form — behavior always comes from the stored fields. Routing is
    `resolveRouterModel(providers, model)` (matches name **or** alias, tolerating an `acc<hex>/`
    prefix), the single source of truth for: bare-vs-account-prefixed launch model, the
    seeded-account launch gate, `compactEnvForModel`, the probe catalog union, and the UI's
    "keyless — account ignored" dimming. Never reintroduce a model-name regex.
  - **`config.yaml` projection.** `renderConfigYaml` emits one `openai-compatibility` entry per
    provider that has **both** a stored key and ≥1 model (keyless/model-less are skipped). Every
    emitted string goes through `JSON.stringify` (a label/baseUrl is user text — YAML-injection
    guard), and free-text labels reaching `claudex.env` go through `envSafeLabel`. **`models` is a
    provider-level key** (sibling of `api-key-entries`); nested under an api-key entry it parses
    but registers zero models and every request 502s `unknown provider for model <alias>`.
  - **Mutations are HTTP-only and restart-gated.** `PUT/DELETE /api/cliproxy/providers/:id`,
    `POST/DELETE /api/cliproxy/providers/:id/key` are 403 over the unix socket (`refusedOnSocket`)
    and answer 409 `{ok:false, affectedSessions}` while dependent sessions are live unless
    `force`. `GET /api/cliproxy/providers/:id/catalog` is read-only (404 unknown / 409 no key /
    502 upstream). Key verification: openrouter-preset uses its `GET /key`, everything else an
    authed `GET {baseUrl}/models` — only 401/403 rejects; network/timeout stores *unverified*.
  - **Legacy mirror rule.** A pre-router `secrets.openRouterKey` migrates once at load
    (`migrateLegacyOpenRouter`) into an `openrouter` provider + `routerKeys.openrouter`, copying
    `state.openRouterKeyVerifiedAt` into `keyVerifiedAt`. Both legacy fields stay **written at
    rest** one release for rollback safety (precedent 914ec27) — new code writes the mirror and
    never reads it. The `claudex.env` Fable slot is gated on `routerKimiAvailable()` (some keyed
    provider serving name/alias `kimi-k3`), not on OpenRouter. *(The managed `kimi` agent row it
    also gated is gone: `kimi`, `gemini`, `agy`, `cline` and `deepcode` were dropped from the
    catalog when agent tabs became chat tabs — a row with no `chat` adapter cannot open one.
    `deepseek` stays, detect-only and chat-less.)*
  - **Grok is a third MANAGED ACCOUNT family (`agent: "grok"`) — same pipeline as
    claude/codex.** Accounts live in the agent-accounts store (`agent-accounts/grok/<id>/home`,
    credential = the grok CLI's native `auth.json`, the `"<issuer>::<client>"` keyed map);
    acquired three ways, all in Settings → Accounts: **import** (upload `~/.grok/auth.json`,
    auto-detected), **import the server's own login** (`fromSystem:"grok"` on the import route —
    reads the FIXED `$GROK_HOME/auth.json` path server-side, so it is remote-transport-safe
    unlike arbitrary `from` paths), or the **device-code link** — an RFC 8628 flow the daemon
    drives DIRECTLY against `auth.x.ai` (`/oauth2/device/code` → poll `/oauth2/token`,
    grok-CLI client id, scope incl. `api:access` — required by grok CLI ≥ 1.0, whose 403
    names the missing scope — plus legacy `grok-cli:access`; `grok-device-auth.ts`), so it is
    **proxy-independent** and on approval the tokens become a managed account
    (`grokAuthJsonFromDeviceTokens`) — deliberately NOT auto-seeded. Separately,
    `adoptOrphanXaiFiles` remains the boot migration for pre-managed deployments: an unbacked
    proxy-written `auth/xai-<email>.json` is converted to native shape
    (`grokAuthJsonFromStorage`), imported, renamed to the seeded filename `xai-acc<hex>.json`
    and marked `proxyOwned`. Grok Build sessions get account chips → `GROK_HOME=<home>` (unset
    `XAI_API_KEY`); idle managed accounts are refreshed by `refreshGrokToken` (standard OIDC
    refresh against `auth.x.ai/oauth2/token`, client id shared with seed conversion). **Seeding
    to the proxy is `provider:"grok"`** on the normal seed/unseed routes:
    `grokStorageFromAuthJson` (NO `prefix` field — xai launch models are always bare; the proxy
    routes internally) writes `xai-acc<hex>.json`, two-way credential sync + freshness use
    `seededAuthFileName()` for the xai- naming exception. `CliProxyStatus.providers` includes
    grok; `status.xai` (linked/expired = seeded files present, + linking progress) still gates
    xai model chips, `resetDanglingModelPicks` and claudex coupling
    (`codexOk || routerOk || xaiLinked`). `DELETE /api/agent-accounts/:id` un-seeds first for
    every family. Accepted risks unchanged (brainstorm 2026-08-05): the proxy **impersonates the
    first-party Grok CLI**; **no per-request quota readout exists** (best-effort
    `lastQuotaError`); a `…-usage-exhausted` 429 **cools the account 24 h**; and the synthesized
    native `auth.json` from adoption omits profile-only fields (team/names) the CLI treats as
    optional.
  - **Grok usage bar.** `createGrokSource` (`apps/daemon/src/usage-sources.ts`) reads the
    subscription's weekly credit pool from the first-party
    `cli-chat-proxy.grok.com/v1/billing?format=credits` (the endpoint behind the grok CLI's own
    `/usage` command; spoofed client headers required or it 426s, pinned `GROK_CLIENT_VERSION`).
    One `weekly` window only — SuperGrok has no 5h window; omitted `creditUsagePercent` on a
    live period means **0%**, not unknown (proto3). Credential precedence: proxy-owned
    `cliproxy/auth/xai-*.json` (this is the ONE sanctioned reader of xai token material outside
    the proxy subsystem — the token never leaves the source closure) → managed grok account
    homes (freshest `expires_at`) → the grok CLI's `~/.grok/auth.json`. Expired stamp ⇒
    stale/no-fetch (the proxy/CLI/accounts-refresher refreshes, never this source).
    `usage-parse.ts:parseGrokBilling`; chip enum + `USAGE_AGENT_IDS` include `grok`.
- **Security boundary asymmetry.** `PUT /api/config/daemon` is **Unix-socket-only** (403 over
  remote HTTP) — **except the single-field `PUT /api/config/daemon/protect-archived`, which is
  allowed on both transports** (normal bearer auth) because it toggles a client-side UI curtain
  ("Protect archived data"), not daemon security posture; `/api/accounts` *is* allowed remotely
  (safe — no key material is ever returned).
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
- **fs GET routes take the path as base64url `?p=`, and the plain `?path=` still works.**
  Browser ad blockers (uBlock, ABP, Brave Shields) filter on the raw request URL, query
  included, so a preview/download of anything under a `banners/` dir or named `*_300x250.jpg`
  matched EasyList and died in the browser as `ERR_BLOCKED_BY_CLIENT` (DevTools shows
  `(blocked:other)`, 0 bytes) before reaching the daemon. Every `/api/fs/*` GET that names a
  path (`fs`, `files`, `search`, `read`, `raw`, `archive`, `parquet`, `download`) now goes
  through `fsPathFromQuery` (`apps/daemon/src/fs-path-query.ts`): `p` wins when present and a
  malformed `p` is a 400 (never a fallback to `path`, never a partial decode); `path` is kept for
  curl/scripts/older bundles. The client mirror is `fsPathQuery` in
  `packages/ui/src/lib/fs-path-query.ts` — use it for any new fs GET rather than `{ path }`.
  Not a security measure: the decoded path hits the same `assertInsideFsRoot`. The `DELETE
  /api/fs` and `/api/git/*?path=` routes still send the plain form.
- **Default endpoint is `127.0.0.1:47831`.** On the VPS it stays on loopback; Caddy (443) is the
  only public face. CORS is intentionally absent (single-origin server; desktop dodges CORS via
  Node HTTP).
- **PWA is `apps/web`-only and needs `dist`.** `/sw.js` + `site.webmanifest` must genuinely
  exist in `apps/web/dist` (Vite copies `public/`); the daemon's SPA fallback returns
  `index.html` for any missing GET, so a missing `sw.js` silently serves HTML and breaks the
  service worker. Run `pnpm build` after touching either. Web Push state lives in
  `<appdir>/daemon/push.json` (chmod 0600 — it holds the VAPID **private** key, never returned by
  any API); pushes fire from agent-session status: hook-reporting agents
  (claude/codex/opencode/grok via managed hooks → `POST /api/sessions/:id/agent-event`,
  unix-socket-only) send distinct
  "needs your input" / "finished" pushes; agents without hook coverage keep the bell fallback.
  Debounced 30 s per session per type. Session activity (working/waiting/idle + attention, plus
  `needsAttentionAt` — the stamp the Attention Center orders and cycles by) lives on
  `SessionSummary.activity` and streams as `session.activity` events — the UI never re-derives it.
  A process exiting also raises "finished" attention, stamped **after** the `session.exited`
  broadcast (that summary carries no activity, so a client resetting on exit must see the stamp
  land last). The SW never intercepts `/api`, `/events`, `/ws`, `/health`, `/mcp`,
  `/devtools-frontend`, `/ws-devtools` or non-GET requests (caching the proxied DevTools bundle or
  falling its navigations back to `index.html` corrupts it → "Failed to convert value to
  'Response'"; bump the SW `VERSION` when changing this list). Registration is web-host-only
  (`apps/web/src/pwa.ts`, PROD-gated) — Electron never touches it. `/theme-boot.js` is an
  **unhashed root static** that the SW **precaches with the shell** (`SHELL_PRECACHE` next to
  `/index.html`) and serves network-first with the cached fallback, so first paint stays themed
  offline; it must genuinely exist in `apps/web/dist` — `pnpm build` after touching it, same trap
  as `sw.js`, and changing the precache list means bumping the SW `VERSION` (now v5).
- **Theming is data, not component logic — and the boot script must stay external.** Every surface
  already paints with Tailwind's `neutral` scale, so `packages/ui/tailwind-preset.ts` remaps that
  scale to `rgb(var(--n-<step>) / <alpha-value>)` and a colour scheme becomes eleven RGB triples
  per mode in `styles/globals.css` under `[data-scheme][data-mode]`. No component branches on the
  scheme; keep the `<alpha-value>` placeholder or every opacity modifier (`bg-neutral-900/40`)
  silently stops compiling. The bare `:root` block is Tailwind's own neutral triples, so an
  unstamped document renders pixel-identically to the pre-theme app. `data-mode` is always a
  *resolved* `light`/`dark`; `system`/`dynamic` (19:00–07:00) are decided in `lib/theme.ts` and
  never reach the CSS. `apps/{web,desktop}/public/theme-boot.js` stamps the persisted choice on
  `<html>` before the module bundle loads (anti-FOUC) and is a **separate file on purpose**: the
  production Caddy CSP is `script-src 'self'`, and `/etc/caddy/Caddyfile` is reconciled by hand, so
  a hash-pinned inline script would silently stop running after a deploy. Two surfaces stay dark in
  every scheme by design — xterm keeps its own static palette, and the CodeMirror editor swaps only
  on the resolved *mode* (`oneDark` ↔ CodeMirror's own light chrome), never on the scheme.
- **One global shortcut listener, capture phase.** `GlobalShortcutListener` is the single
  `window` keydown handler, so the surfaces that own their keys are excluded once via
  `insideShortcutBailZone`. Capture phase + `stopPropagation` are load-bearing: xterm reads
  `Ctrl+Shift+A` as plain `Ctrl+A` and would encode `\x01` into the focused PTY. `Ctrl+Shift+A`
  walks a *cursor* through the Needs-Attention group rather than always taking the top row —
  focusing a tab clears the bell/hook `attention` but not the structural `waiting` state, so a
  session parked on a permission prompt would otherwise trap every press. **Caveat: Chrome
  reserves `Ctrl+Shift+A`** for its own tab search, so an installed PWA may never receive it —
  the Attention Center menu is the reliable path. `Ctrl/Cmd+K` matches the physical `code`
  (`KeyK`), survives layouts that rewrite `key`, and only swallows the event when a mounted
  palette actually took it.
- **Mobile safe-area insets: one layer owns insets *and* vertical sizing.** The app shell
  (`AppWrapper`, `#root`'s only child) is what `useViewportHeight` sizes from
  `visualViewport.height` so it fits above the soft keyboard, so `apps/web/src/styles.css` pads the
  `env(safe-area-inset-*)` onto **`#root > *`** with `box-sizing: border-box` — keeping the insets
  *inside* that measured height. Padding `#root` itself (as it used to) stacks top+bottom inset on
  top of the shell's height and pushes its last row, the mobile key bar, below the fold by exactly
  `inset-top`. Because the shell owns the bottom inset for every layout, **no in-flow component may
  pad for it again**; the one exception is by construction — `position: fixed` overlays escape the
  box and pad their own (see `ui/sheet.tsx`, `browser/PickComposeSheet`). Web-only: the Electron
  host never loads this stylesheet.
- **Browser-tab Chromium exposes a loopback debug port.** The per-project headless
  Chromium launches with `--remote-debugging-port=0` (not the stdio pipe) so the
  embedded DevTools can attach; the daemon proxies its frontend at
  `/devtools-frontend/:browserId/*` (generic Chrome assets) and its CDP WS at
  `/ws-devtools/:browserId` (`?token=` auth). Both routes are **remote-transport
  only** (never on the unauthenticated unix socket). The port is unauthenticated
  **on-host** — same trust level as the scoped-sudo terminal sessions on this
  single-user box. The DevTools frontend is served same-origin, so it's contained
  two ways: the UI iframe is `sandbox`ed without `allow-same-origin` (opaque origin,
  no access to the credential in `localStorage`), and the Caddyfile's
  `/devtools-frontend/*` CSP island locks `connect-src`/`form-action` to `'self'`
  (so even a pop-out window can't exfiltrate the credential off-origin). Deploys
  need that Caddy carve-out or the iframe is blocked by `X-Frame-Options: DENY`.

---

## Production deployment

Stack: Ubuntu LTS, Node 20, pnpm, tmux, Caddy 2, ufw — daemon as a hardened systemd service,
Caddy as the TLS reverse proxy. Templates live in `deploy/`. Use placeholders
`orquester.example.com` / `203.0.113.10` (never commit a real domain/IP/secret).

> **Deploys go through `./deploy.sh`** (deploy / provision / verify / rollback / logs /
> rotate-password). Real host definitions live in the **gitignored** `deploy/targets.conf`
> (copy `deploy/targets.conf.example`); machine-specific notes live in the gitignored
> `DEPLOY_TO_VPS.md` (copy `DEPLOY_TO_VPS.md.example`). Check both before deploying. The
> manual command sequences below remain as reference/fallback for what the script runs.

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

> **Preferred: `./deploy.sh provision <target>`** — runs this sequence on a fresh Ubuntu
> VPS (needs `domain` + `repo` in `deploy/targets.conf`; generates the HTTP password on the
> VPS and prints it once). A `git@…` (ssh) `repo` URL additionally needs a deploy key +
> `known_hosts` entry for **root on the VPS** — a fresh box has neither, so prefer an
> `https://` URL for a public repo. The manual sequence below is the reference.

```bash
# 1. Service user (home = the appdir)
sudo useradd --system --create-home --home-dir /var/lib/orquester --shell /usr/sbin/nologin orquester

# 2. Runtime + build tools (node-pty needs python3/make/g++), plus tmux, ufw, Caddy
sudo apt-get update && sudo apt-get install -y git openssh-client tmux ufw python3 make g++ curl ca-certificates p7zip-full ripgrep
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

> **Preferred: `./deploy.sh deploy all`** — runs exactly this sequence per target, plus
> bundle-hash verification and the browser smoke test, with the CI=1 / stdin-detach /
> no-pipes gotchas enforced structurally. The manual sequence below is the reference.

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
- **After any web/ui deploy, run the browser smoke test** (mandatory, after the health curl):
  `node scripts/smoke-web.mjs https://<your-domain>` from your dev machine. It loads the
  deployed SPA headlessly with clean storage **and** with legacy localStorage fixtures
  (`scripts/smoke-web-fixtures.json`) and fails on any uncaught page error, console error, or
  an empty `#root` — catching the "deploy looks fine, page dies on real users' stale state"
  class the health curl can't see. Needs a local Chrome/Chromium (`SMOKE_CHROME=` to override).
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
| Agent conversation history + resume | `apps/daemon/src/agent-conversations.ts`, `resumeLaunchArgs` in `apps/daemon/src/sessions.ts`, `resumeArgs`/`canResumeAgent` in `packages/registry/src/index.ts`, `packages/ui/src/components/main/ProjectOverview.tsx` |
| Recent projects (daemon-owned) | `apps/daemon/src/recent-projects.ts`, `packages/ui/src/components/main/RecentProjects.tsx` |
| System status (`/proc`, process tree, kill guard) | `apps/daemon/src/system-status.ts`, `panePids`/`serverPid` in `apps/daemon/src/tmux.ts` |
| Git watcher, stashes, commit graph | `GitWatcher` + `passesGitEventFilter` in `apps/daemon/src/git.ts`, `packages/ui/src/components/git/git-watch.ts`, `packages/ui/src/components/git/graph.ts` |
| Project templates + create dialog | `TEMPLATES` in `packages/registry/src/index.ts`, `packages/ui/src/components/sidebar/NewProjectModal.tsx` |
| Attention Center, command palette, shortcuts | `packages/ui/src/components/attention/`, `packages/ui/src/components/command-palette/`, `packages/ui/src/lib/session-nav.ts` |
| Themes (schemes + light/dark) | `packages/ui/src/lib/theme.ts`, `packages/ui/tailwind-preset.ts`, `packages/ui/src/styles/globals.css`, `apps/{web,desktop}/public/theme-boot.js` |
| Electron embedding | `apps/desktop/src/main.ts` |
| Browser tabs (Design Mode) | `apps/daemon/src/browsers.ts`, `apps/daemon/src/browser-pick.ts`, `packages/ui/src/components/browser/` |
| Git hosting accounts (GitHub/Bitbucket) | `apps/daemon/src/accounts.ts`, `apps/daemon/src/providers/`, `packages/ui/src/components/settings/SettingsModal.tsx` |
| Model proxy + router providers + xAI (Grok) account | `apps/daemon/src/cliproxy.ts`, `apps/daemon/src/cliproxy-files.ts`, `apps/daemon/src/cliproxy-secrets.ts`, `apps/daemon/src/cliproxy-xai.ts`, router/xai schemas in `packages/config/src/index.ts`, `packages/ui/src/components/settings/ModelProxySettings.tsx` |
| Agent chat: the host process, adapters, store, checkpoints | `apps/daemon/src/agent-host/README.md` (module map), `…/main.ts`, `…/adapters/<id>/`, `…/store/`, `…/checkpoints/` |
| Agent chat: daemon side (supervision, route proxy, tab records) | `apps/daemon/src/agent-chat/{supervisor.ts,proxy-routes.ts,service.ts,session-router.ts,home-prep.ts}` |
| Agent chat: wire contracts, runtime/domain events, fold | `packages/api/src/agent-chat/{wire.ts,runtime-events.ts,domain-events.ts,fold.ts,slim.ts,roster.ts}` |
| Agent chat: client state, transport, timeline, composer, roster | `packages/ui/src/lib/agent-chat/`, `packages/ui/src/components/agent-chat/` |
| Agent chat: protocol fixtures (read the per-provider `README.md`) | `apps/daemon/test/fixtures/{claude,codex,opencode,grok}/` |
| Orquester MCP (tools, in-process client, waits) | `apps/daemon/src/mcp/server.ts`, `…/daemon-api.ts`, `…/wait.ts`, `…/tools/` |
| Deployment | `deploy/` + `docs/superpowers/specs|plans/2026-06-19-remote-*.md` |
