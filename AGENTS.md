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
palette** (`Ctrl/Cmd+K`) over open tabs and projects — with a `?` full-text search mode over every
open chat — and an **Attention Center** in the top bar
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
delivers HTML/CSS/screenshot payloads into an agent's composer or PTY, and embedded Chrome DevTools (the browser's own version-matched frontend proxied by the daemon — right-dock split on desktop, full-screen on mobile); an installable **PWA** web client
(service worker + Web Push notifications on agent-session bells); and a **right rail** beside the
tab content (on phones, a bottom bar of sections, each shown full screen) with two panels — **Saved prompts** (global and
per-project, searchable, pinnable, with built-in `{variable}`s: project, workspace, branch,
changed files, the uncommitted diff, date/time, agent, model) and **History & checkpoints** (every
prompt of the open chat — the whole thread, from the host's index — and each turn's checkpoint:
its files, its diff, "Rewind to here") — both delivering to the visible chat by **Insert** (into
its composer) or **Send** (exactly as Enter would).

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
| Thread index | **better-sqlite3 12** | native addon; the agent host's thread index only — derived, disposable; the durable record stays NDJSON |
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
`POST /api/system/processes/kill`; `/api/saved-prompts` (`GET ?projectPath=` global + that
project's, `POST`, `PUT/DELETE /:id`, `POST /:id/used`; both transports — the right rail's prompt
library, see the gotcha) and `GET /api/git/working-diff?path=&maxBytes=` (a project's uncommitted
changes as ONE patch, cut at a line within `maxBytes` — 64 KiB default, 512 KiB max — plus the
untracked files; a saved prompt's `{diff}`); `/api/sessions` CRUD + `/input` + `/resize` + `/reorder` +
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
in production (`--appdir`). The daemon persists **JSON, not a database** (the one SQLite file, the
agent host's thread index, is a derived cache of NDJSON logs — see "Agent chat GUI"):

```
<appdir>/
  app/      app.json, remotes.json, logs/
  daemon/   daemon.json (bcrypt passwordHash, protectArchivedData)  daemon.sock (control socket)
            tmux.sock (dedicated tmux server)         sessions.json (reattach index)
            workspaces.json (side-table: gitAccountId, createdAt, isArchived, archivedProjects)
            recent-projects.json (shared recents, capped at 30; entry-wise tolerant parse)
            saved-prompts.json (the right rail's prompt library, global + per project, ≤ 1000;
                               entry-wise tolerant parse; a corrupt file is moved aside)
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
      leftover-work.json  the user's work earlier launches left running (Grok): each launch's task
                       sessions, swept at the user's next end of the session; 0600, the adapter's own
      state.json       the fold snapshot: the folded state as of one seq, a CACHE of the log;
                       rewritten (0600, atomic) on every head-shaped change and, inside a turn, at
                       most once per 200 events AND 30 s; discarded on version, seq or byte mismatch
      raw.ndjson       untranslated provider frames, REDACTED, rotated 10 MiB x 10, 14 days
      attachments/<id>.<ext>
    receipts.json      commandId -> {seq, status}, a ring of 500 (idempotency)
    index.sqlite       the disposable SQLite thread index (+ -wal/-shm): turn byte ranges, activity
                       positions, message spans, FTS5 text; deleted and rebuilt from the logs on any
                       schema or corruption problem; 0600, as sensitive as raw.ndjson
  agent-host.sock      the host's control socket (named pipe on Windows)
  agent-host.token     0600 shared secret, daemon <-> host
```

A thread id **equals** its session id. `sessions.json` stays tab metadata only (`kind:"agent-chat"`
plus an optional `chat` block) and is parsed entry-wise tolerantly; the host is the source of truth
for thread state. `events.ndjson` is outside every deploy rollback — an older host must still fold
what a newer one wrote. `state.json` and `index.sqlite` are caches of it, outside that boundary: an
older host ignores both, and a newer one re-derives from the log whatever it cannot trust.

**Routes** (all proxied by the daemon onto the socket; bearer auth on HTTP, unchanged):

| | |
|---|---|
| Commands (POST, JSON, every body carries a client-minted `commandId`) | `/api/sessions/:id/{turn,interrupt,approval,answer,dismiss,revert,compact,mode,session/stop}` → `{seq}` |
| Daemon-owned, command-shaped (NOT proxied verbatim) | `POST /api/sessions/:id/account` `{commandId, accountId}` → `{seq}` — §3.4's account switch; see the gotcha below |
| Reads | `GET /api/sessions/:id/thread` (whole snapshot, with `history` bounds) · `GET …/events?after=<seq>` (long-lived chunked **NDJSON**, `:hb` every 15 s — no new WebSocket) · `GET …/turns/:n/diff` · `GET …/items/:itemId` (unslimmed payload) · `GET …/items/:itemId/output[?offset=&maxBytes=]` (the streamed output of the tool call the item belongs to — its `tool.output` chunks joined from the log: with a window query, one UTF-8 window `{toolUseId, offset, text, totalBytes, nextOffset?, complete, truncated}` from the host store's tool-output cache; without, the whole join, ≤ 8 MiB; 404 `ITEM_NOT_FOUND`) · `GET …/attachments/:attachmentId` · `GET …/history?before=<cursor>&turns=<n>` (a block of older history from the index; 503 `INDEX_UNAVAILABLE` without one) · `GET …/prompts?before=&limit=` (the thread's own user prompts, newest first, from the index — the right rail's History; 200 `indexed:false` without one) · `GET …/prompts/:messageId` (one prompt's whole text; 404 `PROMPT_NOT_FOUND`) |
| Host level | `GET /api/agent/providers` · `POST /api/agent/providers/:id/refresh` · `POST /api/agent-host/stop` · `GET /api/agent/search?q=&limit=&projectPath=` (full-text over every open chat; 200 `indexed:false` without an index) |

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
--test $(find src -name '*.test.ts')` per package. The daemon and UI scripts also preload
`./test/quiet-mock-timers.mjs`, which drops node:test's "The MockTimers API is an experimental
feature" `ExperimentalWarning` — only that one, every other warning still prints — so a run's output
stays pristine (`node --test` hands `--import` on to each file's child process). The daemon and UI
scripts then run every `*.check.ts` script as a plain node script, which fails the run on a throw;
a check must build its own inputs, never read the machine's — `usage-sources.check.ts` clears
`CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GROK_HOME` first, because the sources honour those
overrides as the CLIs do, and an agent session points them at a real account. Every test script
(the `.check.ts` loops too) also preloads the shared `scripts/test/assert-ok.mjs`: without it, a
failing `assert.ok(x)` or `assert(x)` with no message either quotes the wrong code in its message or
hangs its whole file, because Node 20 looks the call up in the `.ts` file at a position in tsx's
one-line output, and its `findColumn` can then re-parse the file until the stack overflows. The preload writes that one message
itself, through the source map and the TypeScript parser, and changes nothing else — keep it on any
new test invocation (`apps/daemon/src/assert-ok.test.ts` pins it). Replay tests live
**under `src/`** (the daemon's test glob only walks `src`) and read recorded real-CLI captures from
`apps/daemon/test/fixtures/{claude,codex,opencode,grok}/`, each with a `capturedWith` provenance
block and a `README.md` of protocol observations that is required reading before touching its
adapter. Their redaction is checked by `src/agent-host/adapters/fixture-redaction.test.ts`: every
line, and every value a provider streamed in pieces joined the way its protocol streams it, for the
host's home, managed-account ids, e-mail addresses and credentials — a per-line redaction misses a
path the CLI split across two chunks. Nothing waits on a sleep: wait on a receipt, on
`ThreadStore.drain()` / `Ingestion.drain()`, or on an event. Filtered runs while developing:
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
- **A turn the CLI starts by itself streams before the turn exists.** When a background task or
  subagent finishes, the CLI answers on its own. The new message's `message_start` and its whole
  first block stream first; only then does the per-block `assistant` frame arrive that opens the
  synthetic turn. Every stream handler needs an open turn, so those frames used to be dropped,
  and with them the `message_start` id that `textBlockKey` joins on:
  - the text streamed as `?:<index>`;
  - its per-block frame minted a snapshot-only twin under `<message.id>:0`;
  - `completeTurn` flushed the twin at `result`, BELOW the final summary, where the client took it
    for the turn's answer and folded the real one away.

  That was live thread 19976137 (seq 38664/38963): 160 of 288 CLI-started turns across three
  threads, and none of the user-started ones. A text-first opening message had no twin, but still
  surfaced only at `result`, and every such turn lost its opening thinking.

  The fix (all in `adapters/claude/normalize.ts` unless noted):
  - A parent message that starts streaming with no turn open is held (`preTurnStream`).
    `beginTurn` replays it into whichever turn opens next: the synthetic one, or a `sendTurn` that
    lands mid-message.
  - Consecutive deltas of one block are merged while held, so the hold grows with the message's
    content, never with its frame count, and loses nothing: no thinking, no tool input.
  - The held message is dropped at `message_stop`, at a turn-less `result` and in
    `closeLiveTasks`.
  - The stream join (`streamMessageId`, `streamedBlocks`, `snapshotBlockCursor`) is scoped to the
    MESSAGE, not the turn. A message can outlive the turn it started in: `sendTurn` settles a
    stale synthetic turn and opens the user's while the CLI's own message is still streaming.
    The block streaming at that moment SPLITS by design: its first part closes with the settled
    synthetic turn, and the rest opens in the user's turn. A test pins this, so don't "fix" it
    back into one item: under a turn-scoped join that was exactly the twin.
  - `beginTurn` settles a synthetic turn that is still open rather than overwriting it. The CLI
    can open one during `sendTurn`'s own awaits.
  - `events.ndjson` keeps the old copies, so for Claude threads only, the client's
    `splitThreadItems` drops a turn's LAST assistant message when it is finished and repeats the
    turn's FIRST finished one, same author, word for word — exactly where the copy sits and what
    it copies. The rule is `reEmittedAssistantCopies` in `@orquester/api` (`re-emitted.ts`), and
    `repairsReEmittedAssistantCopies(adapter)` says where it applies — Claude threads only, the
    parent view only — for the GUI (`store.ts`) and the MCP (`lastReply`/`reply`,
    `read_transcript`) alike. Codex narration may legitimately repeat itself, and so may a long
    Claude turn — a goal run is one turn of many rounds, which can end two rounds on the same
    words — so no other repeat is dropped. "Finished" is the message's raw `streaming` flag, never
    its read-side liveness (`isMessageStreaming`): a message a dead host left flagged is never
    dropped, only possibly left in (the conservative side).

  A call in that held message starts on the turn it is replayed into, and a parent call that
  registers with no turn OUTSIDE a held message — the tail of a message whose turn ended while it
  still streamed — is its message's turn's (rule (6) of "Agent rows must survive…"), never the next
  turn's. Nothing adopts a call any more; logs written before the hold keep turnless starts for
  every woken call, and logs written before 2026-09-28 an adopted tail's, which the read-side rules
  still handle.
- **A completion's `detail` stands in only for a message that delivered no text this turn.**
  Ingestion keeps `turnDeliveredMessageIds` past `finalizeMessage` because a prompt
  (`request.opened`, `user-input.requested`) closes an open message before its provider
  `item.completed` arrives. OpenCode flushes a text part's closing snapshot after the tool call
  that follows it, and that `detail` used to be appended to the closed bubble a second time. This
  is T3's "fallback only onto a missing or empty message".
- **One message per provider item, even when the provider abandons one.** Codex can stream part of
  an `agentMessage`, drop that attempt without an `item/completed`, and restate it as a new item.
  The normaliser closes the abandoned message when the next item of its turn starts
  (`closeAbandonedMessages`; fixtures README observation 22). Otherwise ingestion glued the
  restatement onto it, under the abandoned id and its `commentary` phase, and the turn's answer
  folded away. Grok's ACP chunks name no message at all, but every chunk carries its
  `_meta.promptId`. The normaliser closes the open segment when a chunk names a different prompt,
  so after a steer the cancelled prompt's late chunks still join its own bubble, and the steered
  reply opens a new one. A segment with no prompt id falls back to T3's close at the steered
  prompt's dispatch. Left open, the steered reply was glued into the cancelled prompt's bubble,
  above the user's steer.
- **Registry `args` are the terminal launcher's flags and never reach a chat launch** — permissions
  come only from `runtimeMode`, `full-access` = `bypassPermissions`; effort only from the model
  selection. (`buildRefIdIndex` in `agent-host/main.ts` carries a row's adapter and bins, never its
  `args`; Claude's mapping is `RUNTIME_MODE_TO_PERMISSION_MODE` in `adapters/claude/launch.ts`.)
- **`HISTORICAL_RAW_SOURCE`** (`"history.replay"`) tags every event projected out of a provider's
  *native* history on resume. A replayed row is the past: it claims no token usage and its turns
  are already settled. Anything that treats a raw frame as live must check it. A replayed user row
  has any trailing `Attached files:` block stripped (`agent-host/adapters/attachment-lines.ts`,
  `stripAttachmentPathLines`): the block is provider input the host never persists, and the native
  transcript is the only place it survives — unless the block was the whole message, which is kept
  as the turn's only evidence. (Claude only: the block-only leading text block of a skill dispatch
  is dropped when the command block carries the text.)
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
  it is **drained**. An unreadable stamp on either side never restarts anything.
- **"Drained" means no active turn AND no live background work, and the old host must EXIT before
  its session is killed.** Two things that were bugs (owner incident 2026-09-23: a code-only deploy
  under five working subagents). (1) The drain waited on `activeTurnThreadIds` alone, so the
  restart fired the moment the parent's turn settled — a subagent fleet or a background shell
  outlives its turn inside the provider process, the restart killed every one of them, and the CLI
  reported each as "didn't finish before the previous session ended" on the next message with no
  notice in between. `/health` now also carries `backgroundWorkThreadIds` (the host's liveness
  registry, `working` and `monitoring` both — the registry's TTL bounds a silent watch loop, so a
  dev server cannot defer a deploy for longer than that window, and the end of a turn the HOST
  sent drops a watch loop that reported nothing during that turn. Never the end of a turn the
  provider started itself — a Grok wake, an OpenCode woken reply, Claude's synthetic woken turn,
  read off the fold as a `turn.started` with no `/turn` row (`livenessObservation` in
  `orchestrator.ts`, `LivenessObservation.providerInitiatedTurn`): wakes come at every background
  end and monitor line, and sweeping at their ends dropped a silent dev server long before its
  TTL, so a deploy's drain killed it. An agent holds the drain until its
  end, except one whose rows carry `livenessTtlMs` — Grok's, whose runs report their end and a
  heartbeat but whose chat lives until Stop or the tab closes — which holds it for at most 60
  minutes after the latest row naming it, see the Grok gotcha); the supervisor unions it with the
  daemon's own summary-poll view (`AgentChatSummaryService.threadsWithBackgroundLiveness`, so the
  host a deploy replaces — which predates the field — is held too; that view is `null` = unknown
  until the first poll round, because boot adoption runs BEFORE the poll starts and an empty view
  would read as "nothing running"), and `onBackgroundWorkEnded` reopens the window exactly as a
  settled turn does. (2) The supervisor read a quiet socket as "the
  host is gone", but `server.close()` is the FIRST step of the host's teardown and
  `adapter.stopAll()` runs after it: the tmux session was killed ~400 ms after `/stop`, so no
  `session.exited` and one "Task stopped" row out of five were ever written, and the threads kept
  reading "running" for work that was already dead. `awaitHostExit` now waits for the PROCESS —
  the service session ending (`isAlive()` on a direct child) and the socket — bounded at 30 s, and
  an intentional `/stop` ends the process explicitly (`onStopped` → `process.exit`). That `/stop`
  answers BEFORE teardown starts (`afterStopResponse`, on the reply's `finish`): a teardown queued
  as a microtask raced the reply and hung the socket up mid-handover. A replacement that misses
  its readiness deadline latches `error`, but the health probe keeps running there and adopts it
  the moment it answers healthy (the respawn cap still holds) — `error` used to be terminal until
  the daemon restarted. A manual `POST /api/agent-host/stop` still restarts at once, by design.
  A continuing Codex goal would hold the drain for as long as it runs — its turns follow each
  other within milliseconds, though it never feeds `backgroundWorkThreadIds` — so once goals are
  all that blocks it, every drain re-evaluation asks the host to HOLD them between their turns
  (`POST /goals/hold`, the Codex goal gotcha below).
- **Boot folds only orphaned threads.** The §3.3 reconcile decides "orphaned" from `meta.json`
  alone (`isOrphanedHead`: `starting`/`running`, an `activeTurnId`, `ready` with a prepared
  `continueAfterRestart`, or an unprepared marker on a settled head, below; `commit` rewrites the
  head on every session transition for exactly this reader), read with
  `loadHead(id, { seedRuntime: false })`, which never opens `events.ndjson`, and folds nothing else
  before the gate. **The deploy handover's marker survives the teardown's rows:** `/stop` marks a
  running turn (`markThreadsForContinuation`), and the host's teardown then writes what it did to it
  — every adapter's rows reach the log since the Grok fix wave — so the head reads `stopped` with no
  active turn, which the next host used to take for a settled thread: nothing continued, the marker
  left for good (final review A r1). Such a head is a candidate (`meta.json` cannot see the turns)
  that the full path decides (`continuesSettledTurn`): the marked turn must be the thread's LATEST
  (positional) and settled `interrupted`, and the marker STAMPED (`markedAt`, which this code writes
  on every marker it sets; the config schema lists it, since a zod object drops a key it does not
  know), and is then continued as an orphan whose turn is already settled — no second settle, no
  error row, and a marker the thread cannot use (a closed tab, no cursor) is simply dropped. An
  older host's unstamped marker keeps the rule it was written under — continued only while the head
  still reads running — and on a settled head is cleared, never continued: a manual stop during a
  Claude or OpenCode turn could leave one on a thread nobody touched since, and continuing it would
  replay a turn of any age (final review A r2). A marker that names anything else is stale and
  dropped too, as it is
  whenever the thread moves on (`dropContinuationMarker`: the user's end, a new turn's effect before
  its session is ensured, any other turn's `turn.started`), and with no active turn an unprepared
  marker matches only that settled turn: a crash while a new turn's session starts never continues
  the old one. Every other thread goes into `bootSettlePending`: §3.4's stale-`pending`-turn settle,
  which the reconcile used to run on every idle thread at boot, runs on the thread's **first load**,
  inside `loadRuntime` before the runtime is published — and so does the closing of the requests,
  calls and tasks its last process left open and the naming of its legacy agents' launches
  (`repairLeftovers`, see "A running state never outlives its process" and "Agent rows must survive
  resumes and retention"), which an orphan gets in the reconcile itself — so no read, stream
  snapshot or command can see the thread unsettled — and never at boot. A head that cannot be read
  is folded, as before. Measured before, on the owner's VPS (2026-09-23): 16 s of folding for 78 MB
  of logs, all of it on the readiness path — an 18 s "connecting" window on every host replacement;
  the reconcile now costs one `meta.json` read per thread plus the orphans' own folds. The deploy
  handover's `/stop` (`markThreadsForContinuation`) applies the same rule: it folds only a thread
  this host serves, one with a live provider session, or one whose `meta.json` says a turn is
  running in an opted-in project with a cursor — folding every log there made a healthy host take a
  minute to acknowledge its stop. The boot sweep is `sweepStartup` (fired unawaited just before the
  gate): stale partial uploads and the raw-log ceiling, no history read at all. The deep
  attachment-reference sweep (`sweepNow`) runs on the store's 6 h schedule, reads references off the
  snapshot + tail (`foldForSweep`) and skips a thread with no stored attachment outright; a host
  restarted more often than that collects orphaned completed attachments late — disk, never
  correctness. The folds on the load, history, sweep and item-read paths yield to the loop every 500
  events (`applyEventsChunked`; the store's `foldForward`), and decoding a log yields every 8 ms
  (`DECODE_SLICE_MS`: `readLog`, `decodeWindow`): a multi-second fold or parse starved the 15 s
  health probe (5 s timeout), and two consecutive misses restart a healthy host.
  The same `meta.json` read finds a handover's goal resume marks (`resumeGoalAfterRestart`, and a
  held goal's `goalHeldForHandover` → `goalResumePending`), acted on only after the gate (the Codex
  goal gotcha below).
- **The fold snapshot, the thread index and the tool-output cache are caches, never authorities.** `events.ndjson` stays
  the record; any doubt — another version, a seq or byte offset that does not line up, a file that
  does not parse — is resolved by discarding the cache and re-deriving from the log, never the
  reverse. Rules that must not be broken: (1) **bump `FOLD_SNAPSHOT_VERSION`**
  (`packages/api/src/agent-chat/fold-snapshot.ts`) whenever the fold (`fold.ts` and what it calls)
  produces something different from the same log — otherwise an old `state.json` keeps the old
  result for every event before its seq while the tail folds with the new rules, and the two never
  reconcile until the thread is deleted. Never reuse a number another line of development shipped:
  two builds once took 4 for two different fold changes (the open-work retention below and the goal
  field of the goals gotcha), so the merge of both is 5 — the goal build's version-4 `state.json`
  would have parsed as current under the merged fold. The same holds for `INDEX_SCHEMA_VERSION` (4
  was `clipAtCut` on one build and the prompts columns on the other; 5 since the merge).
  (2) `serializeFoldState` drops `activities`, rebuilt from `items` on load as the SAME objects:
  the fold updates an activity in place by finding the SAME object in `activities`, and retention
  drops a row from both lists by identity, so a separately parsed copy would append a duplicate on
  the first update and let the lists drift. The fold's
  derived structures (the id→position index, the retention counters, the roster engine) are not
  state at all — see the next gotcha.
  (3) A snapshot is written on every head-shaped change (a session transition above all), after a
  cold load that folded ≥ 200 events, and inside a turn only once 200 events **and** 30 s have
  passed (`FOLD_SNAPSHOT_EVENT_INTERVAL`, `FOLD_SNAPSHOT_MIN_INTERVAL_MS`) — never per event: a
  subagent-heavy state is ~22 MiB and ~160 ms of blocked loop to serialize. (4) `saveFoldSnapshot`
  refuses `state.seq !== seq` (a file `parseFoldSnapshotFile` rejects is a silent, permanent cache
  miss) and drops a save for a deleted thread or one claiming more than the log holds. (5) The store
  truncates a torn trailing line (a crash mid-write) when a thread is first loaded, before anything
  appends to it, and rolls a failed append back (length and `seq`): a batch glued onto a fragment is
  a malformed line `readAll` stops at forever while position-based reads (a snapshot's tail, the
  index) step over it. When the rollback fails too (`resyncFromDisk`), both counters are re-read
  from the file the way the load seeds them and a warning names the thread — never `seqBefore` (a
  line that landed would be minted again, a collision `readLog` reads as corruption) and never the
  advanced counter (a hole in the log's own sequences, which no index catch-up can bridge); a
  fragment nobody could cut (`tornTail`) is cut by the next append before it writes a byte, or that
  append fails having written nothing. The index is fed strictly AFTER the append (`observeIndex` in `commit`), so a
  crash leaves it behind the log, never ahead; a batch that does not continue a thread's index
  cursor is dropped, and only a catch-up fills the hole — the boot's, so a failed index write
  mid-run leaves that thread's rows (history and search) behind until the next host start. What a
  thread has in flight before the provider starts a turn (the pending turn anchored at its prompt,
  the prompts nobody claimed) rides `threads.inflight` in the same transaction as the cursor: kept
  only in memory, a restart between the prompt and the turn's start re-anchored the turn at the
  adopting `session-set` and gave its prompt to the previous turn's range. A host stop calls
  `ThreadIndex.stop()` — queued observes applied, the boot catch-up ended at its next check, file
  closed — never `drain()`, which waits for every catch-up and would hold a deploy. (6) The host
  store's **tool-output cache** (`store/tool-output-cache.ts`, memory only) serves
  `GET …/items/:itemId/output?offset=&maxBytes=` and `readItem`'s activities: an item cursor per
  `(thread, item)` — its newest write, the line and the call it names, so an activity read is the
  log's tail plus one `pread` of its line (checked by `seq` and id; a message is never the store's
  to answer while the thread's resident fold holds it — the orchestrator's `readItem` returns the
  fold's copy, unslimmed and merged as the store's whole-log fold would merge it — and only one
  retention dropped folds the whole log) — and an incremental join per `(thread, call)`, keyed by CALL so an item re-pointed at
  another call never rebuilds one (`ToolOutputJoin`, the same step as `joinToolOutput`; the
  split-point property test in `tool-output.test.ts` holds them equal). Every entry is extended by
  the COMMITTED log past its cursor (`entry.logBytes` — never an append in flight, which a rollback
  may undo) with `readLog`'s rules: a line that does not decode, or whose seq does not climb, stops
  that cursor for good, as it stops every reader. A log that does not continue the cursor — shorter,
  or its next line empty, undecodable or not `seq + 1` — rebuilds the entry from byte 0;
  `deleteThread` drops the thread's entries and bumps its generation, so a scan already running
  publishes nothing; a revert invalidates nothing (the join reads the raw log). One scan per key at a
  time; bounded at 32 MiB of join buffers and 1 024 item cursors (and as many joins), LRU, an entry
  idle 10 minutes expiring when next touched — no timer; an evicted entry is rebuilt, slower, never
  wrong. A window counts in the whole join's UTF-8 as it stands (a lone surrogate reads as U+FFFD),
  the same bytes on every host, so offsets carry across a host restart; the no-query answer stays
  the whole join on the whole-log path, for a daemon from before windows.
- **The fold's work per event must not grow with the window.** The fold is shared by the host and
  the browser, and it used to cost ~1.8 ms per event on a big thread: every event rescanned,
  regrouped and sorted the whole retained window (`activitiesToDrop`), copied the id→position map,
  and refolded the roster from every activity. Measured on the owner's VPS (2026-09-23): 45–81 s to
  fold a 70–80 MB subagent-fleet log — every first open after a deploy, every history page over a
  fleet stretch, every "load full output" on a message, and every live frame in the browser paid
  it. Now 1.3–1.6 s for the same logs (design `2026-09-23-fold-performance-design.md`). Three
  mechanisms, and the rules that keep them honest. (1) **Batch retention**
  (`FOLD_SNAPSHOT_VERSION` 2): the limits are unchanged (500 parent rows, 200 per agent, 2 000
  across agents, 2 000 messages) but a class is trimmed only once it holds more than its limit
  plus its `*_SLACK` (50 / 50 / 200 / 200) in rows retention may drop; the trim then applies
  today's rules at the exact limits to every class in one pass. The trigger reads the state alone —
  never "rows since the last trim" — so a snapshot folded forward still equals the whole-log fold;
  today's gate (`activities.length > 500`) still keeps a history page of ≤ 400 activities lossless;
  the cross-agent ceiling sorts `createdAt` with plain `<`, not `localeCompare`. Since
  `FOLD_SNAPSHOT_VERSION` 4 (5 since the merge with the goals build) every trim also keeps the
  **opening row of running work**
  (`open-work.ts`, `openWorkOf`: a call's first `tool.started`/`tool.updated` that no
  `tool.completed`/`tool.denied` has closed, a background task's non-agent `task.started` with no
  `task.completed`) — a long command's own `tool.output` chunks used to evict its start on chunk 550
  (chunk 250 in an agent's window, and under the ceiling), and a running shell's `task.started`
  after 550 parent rows, which took the shell off the roster. It is capped and ranked by last
  activity, chunks included — `OPEN_WORK_RETENTION_LIMIT` 16 among the openings each window's cut
  would drop (one among the window's newest rows survives anyway and takes no slot),
  `OPEN_WORK_TOTAL_RETENTION_LIMIT` 64 under the ceiling among the openings that survived their own
  window — because work a dead host left open stays open until the thread's next first load closes
  it (see "A running state never outlives its process"), a finished call can read open again (the
  limits `open-work.ts` documents), and those dangling openings must not crowd out a command still
  printing. A kept row still counts in its class, as an open question does, so a
  trim frees at least its slack minus the cap, minus (in the parent's window) the old open
  questions, which count and are kept too; and the walk runs inside a trim only. `state.evicted`
  (serialized, never cleared) records that retention has dropped something, and `windowBoundary`
  considers the activity classes only then — otherwise a thread holding 501–550 parent rows that
  never trimmed would offer a first page of rows the window already shows. Its positional windows
  stay conservative, so a first page may repeat up to a slack's worth of the window's oldest rows;
  the client renders each id once. (2) **Caches are not state**: the index (a shared base map plus
  the tail of `items` appended since), the droppable counters and the roster engine live in a
  module-level `WeakMap` keyed by the state object, built lazily for a state that has none (a
  snapshot, `deserializeFoldState`, the client's `foldStateFromSnapshot`) and never mutated — a
  test folds two different events onto one base state and gets two correct results.
  `__foldCacheConsistency` (tests only) compares the kept caches with ones rebuilt from the arrays;
  the determinism suites (`fold.determinism*.test.ts`) check snapshot + tail at every split point.
  (3) **The roster is folded per task**: every arm of the roster fold touches only its own `taskId`,
  so `roster.ts` keeps each task's rows and folded state and refolds only the task a row touches;
  `foldSubagentActivities(list)` is literally `rosterFromEngine(createRosterEngine(list))`, and the
  property tests check the engine against it at every step. **Roster rows are shared objects**
  between reads and engines: never write one. Rules: never add per-event work that walks the
  window (only the arrays' own copy and a bounded backwards lookup of a replaced row remain); never
  mutate anything reachable from a returned state; any change to retention, or to what the fold
  produces, bumps `FOLD_SNAPSHOT_VERSION`.
- **History pages are blocks of the log by activity count, not turns.** `GET …/history` walks back
  400 activities per page (`HISTORY_PAGE_ACTIVITIES`) — below the 500 rows at which retention starts
  dropping anything, so a page's fold is lossless — because one fleet turn runs to thousands of
  events, more than the retained window, and a "page = N turns" model hands back exactly what the
  window already shows and never the fleet's early work; `turns` is only a soft cap. Cursors are
  content-derived `{t, a, i, s?}` — thread, anchor `requestedAt`, turn id, optional in-turn seq
  (`packages/api/src/agent-chat/history-cursor.ts`, T3's `threadDetailCursor.ts` rule) — so they
  survive an index rebuild and a revert; a malformed or foreign one is a first-page request. A page
  never splits a streamed message (`messagesSpanning` moves both boundaries back to the message's
  first chunk), and a revert's cut (the removed turns' lines and the `thread.reverted` itself) is
  never folded into a page — not even inside a surviving turn's range. A late event naming a turn
  grows its range up to `MAX_LATE_REFERENCE_BYTES` past the next turn's start (`extendReferenced`:
  a turn-end capture, a first-load closer, every row of a call a background agent started in it and
  finished later — the Claude normaliser stamps a call's rows with the turn it started in), so a
  rewind that kept such a turn left it reaching into the turns it removed, and "Load older" served
  their rows again. A revert now clips every surviving range at its cut, the first removed turn's
  first line (`clipAtCut` in `index/indexer.ts`, `INDEX_SCHEMA_VERSION` 4, 5 since the merge). The
  rows past the cut lose their item positions and search rows with the removed turns' — user
  messages aside, which a revert judges by the fold's own rule instead (`dropRevertedUserMessages`,
  the prompts gotcha below), so one the fold keeps keeps its search row and its place in the prompt
  list — but keep their page (save the
  one case below): a block that holds a revert's gap — the cut and what follows it until the next
  turn begins — folds out of it the rows the fold keeps (`historyBlockEvents` / `keptOutOfGap` in
  `orchestrator.ts`, the arms of `reduceReverted`): a row written after the latest revert, which no
  revert has judged; a row naming a turn the index still has that began before it (by
  `referencedTurnId`, the index's own rule — a kept turn's late row); a turnless activity; a
  turnless user message the index still holds; a turnless checkpoint only from a block that holds
  the latest revert, and there only within every later revert's count — a block that does not hold
  it serves none, which is conservative, and harmless while the window's 500 checkpoints hold them
  — and never a removed turn's row, a session change or the revert. **A turnless prompt written
  before the latest revert is on a page exactly while the fold keeps it**, out of a gap and inside
  a kept turn's range alike (`droppedByRevert`): the fold keeps one a kept turn claims, and up to
  `turnCount` no turn claims by its fallback pass — counted over the whole thread, which no block
  can count — and the index applied that very rule when the revert landed
  (`dropRevertedUserMessages`), so a block asks it (`ThreadIndex.keepsUserMessage`) rather than
  counting a third time. Before, such a prompt restored out of a cut was in search and History but
  on no page, and one a rewind dropped inside a kept turn's range (an idle `/goal` no turn claims)
  was on a page though the timeline had dropped it. Such a prompt names no turn, so neither search
  nor History offers a reveal of it (`planReveal` pages by turn); "Load older" reaches it. The page
  lists the newest kept turn its gap rows name when it lists no later one: a rewind that removes it
  removes every later turn, so the client still drops the page (`historyAfterRevert`), and a search
  reveal judges a page by the rows it shows, never by its turns (`planReveal`). A later rewind can
  also drop a turnless message no kept turn claims by the fallback's count, which no turn a page
  lists says, so the client drops its pages and bridge for a rewind whenever one of them shows such
  a message of the parent's (`mayDropTurnless`), and reads them again.
  The index counts none of the rows of a cut, so the page does: its gap rows count
  against its 400 (`indexedActivityBudget` plans the block again from the same end with that many
  fewer indexed activities; a row written after the revert is indexed, counted already), and a cut
  holding more of them than a page folds beside one activity is served without them, with a warning,
  whenever folding them would evict. A gap's messages count against no budget — a page counts
  activities, and an in-range prompt counts against nothing either — but a page whose fold evicts a
  message beside them is served without its gap rows the same way. Query time only: nothing the index derives changed. A deploy of
  a bump deletes an older `index.sqlite` (version 3, or either build's 4) and rebuilds it once, in
  the background, by the boot
  catch-up (one thread at a time, never on the readiness path): until a thread's catch-up reaches
  it, it offers nothing older and search misses it — and a tab snapshotted before then, until its
  next snapshot. The window boundary behind `hasOlder` is the newest first row of any FULL retention
  class (the parent's 500, an agent's 200, the 2 000 across agents — `windowBoundary`), never simply
  the oldest activity the fold holds: anchors, open questions and the opening rows of running work
  survive out of age order, and a fleet whose agents lost their early rows would read as having
  nothing older. Once the thread has been rewound and retention has dropped an activity, it never
  lies before the first line the index positions past the latest revert, else the index's end
  (`pastLatestRevert`): a revert shrinks a class below its limit while the rows it evicted before
  stay gone, and a class whose window lies wholly in a cut cannot be positioned at all. Such a
  boundary gets no cursor, and the client asks for the page below the window without one. So right
  after such a rewind the first page ends there and repeats rows the window still holds — often most
  of the window — and on a fleet's thread (~2 500 activities retained) so can the next few: the
  client renders each row once, and one "Load older" pages on past a page that shows no row the
  timeline did not already show, up to five pages (`HISTORY_PAGES_PER_LOAD`, the MCP's bound;
  `showsNewRow`, `loadHistoryPages` in `store.ts`), `history.loading` set throughout. The client
  projects rows over the CONCATENATION of every loaded page (memoised by the pages array —
  per page, a turn a boundary splits would open its group twice), dedupes by item id, and
  renders an item the live window also holds once, at the page's older position with the
  window's newer content (`packages/ui/src/lib/agent-chat/history.logic.ts`). **The bridge**: while a
  page is loaded (or the first one is on its way), the reducer keeps every parent-visible row
  retention evicts from the window (`itemsDroppedByRetention`) in `history.bridge`, rendered between
  the newest page and the window — without it an evicted row vanished from the screen, because a
  page holds only what was older than the window when it was fetched. Pages, bridge and window
  dedupe by id across all three: one row, at the oldest position, with the newest content. The
  timeline stays in LOG order: `windowCut` sends every window row written before the end of the
  loaded history — the newest page's `page.endItemId` (the first row it does not hold, named by the
  host), else the last row a page shares with the window, or the newest bridge row — to the history
  section. Never decide that order by timestamp: rows replaced in place carry a fresh `createdAt` at
  their first position. The window rows the history section takes that no page holds keep the
  window's order among the history's own rows too, each ahead of the rows both hold at one line that
  follow it in the window, by stamp only among the rest (`withWindowContent`) — the entries'
  order-sensitive steps (a spawn batch's anchor, a call's lifecycle) meet them as the window's own
  projection does; the timeline's last step orders the entries by stamp in both. A running turn's
  rows in the history section render live, as the window renders them.
  Pages + bridge are capped at `HISTORY_ROW_CAP` (20 000 rows): past it the oldest
  pages go first (the cursor chain keeps "Load older" exact), and when the bridge plus the newest
  page alone pass it, everything is dropped and a fresh snapshot is re-read through a guarded path
  that never rewinds the stream. `windowEvicted` offers "Load older" the moment the window evicts a
  visible row, even after a snapshot that said `hasOlder:false`, and that request goes out without
  a cursor — a stale snapshot cursor would leave a gap. Known gaps: a thread
  whose only evictions are messages (2 000 retained) reports `hasOlder:false`; indexed text is capped
  at 128 K chars per row (`MAX_INDEXED_TEXT_CHARS`); the bounds ride snapshots only, so a tab
  snapshotted before its thread was indexed (first boot, a rebuild) offers nothing older until its
  next snapshot.
- **`GET /api/agent/search` is never a 404 and never an error for "no index".** Without a usable
  index — the native driver did not load, the file could not be opened or rebuilt — the host answers
  200 with `indexed:false` and no hits, and the daemon synthesises the same body when a surviving
  older host answers its route-miss 404 during a rollout (`unindexedSearch` in
  `agent-chat/proxy-routes.ts` — on this route only: on `…/history` a 404 can also mean the thread
  is gone). The palette shows "Search is unavailable on this host" ONLY off `indexed:false`; an HTTP
  error is a failed request it offers to retry. `GET …/history` answers 503 `INDEX_UNAVAILABLE`,
  and the snapshot's `history` says `indexed:false`. FTS query text is never handed to the parser
  raw: `q` is clamped to 200 code points, split on whitespace and every token quoted as a phrase
  with inner `"` doubled (`toFtsQuery`), so `NEAR`, `OR`, `*`, `-` and `:` match as text; `limit`
  is clamped to 50.
- **`GET …/prompts` lists the PARENT's user prompts straight from the index.** The right rail's
  History reads every prompt a thread ever had without folding anything: `message_docs` carries
  each message's author — `role` and the owning subagent's `agent_id` (NULL for the parent), from
  its first line — plus its `turn_id` (latest line) and `created_at` (first line), and the partial
  index `message_docs_prompts (thread_id, first_seq) WHERE role='user' AND agent_id IS NULL` walks
  a thread's prompts newest first, joining `messages_fts` by rowid only for the rows it walks; that
  is why `INDEX_SCHEMA_VERSION` moved (4 on the prompts build, 5 since the merge with the clipping
  build's own 4 — and why the first host on it rebuilds the whole index). Which
  user messages are prompts, and their text, is ONE rule for the host and the client —
  `recallablePromptText` (`packages/api/src/agent-chat/prompts.ts`: never a provider-internal row,
  the verbatim `/compact` or an Implement; `[Image #N]` placeholders stripped). A page walks at most
  2 000 rows (`PROMPTS_SCAN_BUDGET`, batches of `max(limit + 1, 256)`), so it can end SHORT or
  EMPTY with a `before` cursor — only `before: null` means "no older prompts", and the client
  fills a short list by itself (`fillWantsOlder`) and pages the whole thread in for a search
  (`searchWantsOlder`, capped at 5 000 prompts; both through `useAutoLoadsOlder`). `turnOrdinal`
  and `rewindable` come from the same turn rows and compaction rule the history page uses, and a
  revert drops user rows by the FOLD's own rule (a port of `retainMessagesAfterRevert`), not by
  log position, so History never lists a prompt the timeline dropped. "Load older" asks the index
  the same question for every turnless prompt written before the latest revert
  (`keepsUserMessage`, the history-pages gotcha), so a prompt the fold's restoring pass keeps out of
  a revert's cut is on a page too.
  The cursor is `base64url({t, s})` on the log seq — it survives a rebuild and a revert; a malformed one is a
  first page. Before answering, the host checks the index COVERS the thread (`coverage`: it waits
  for queued live appends, never for a catch-up): a thread still catching up (a rebuild, the boot
  sweep not there yet) answers 200 `indexed:false, catchingUp:true` and the client re-asks with
  backoff (3 s → 30 s, 40 tries, then Retry); no usable index, or rows that will stay behind until
  a restart, answer a terminal `indexed:false`; a failed read is a retryable 503
  `INDEX_UNAVAILABLE`; `…/prompts/:messageId` answers 404 `PROMPT_NOT_FOUND` only when coverage is
  complete. A host from before the route answers its route-miss 404: in every fallback the client
  lists what the chat itself holds, merged with the pages (the window's whole, live text wins).
- **`better-sqlite3` is a native addon, handled like `node-pty`:** root
  `pnpm.onlyBuiltDependencies`, a dependency of both `@orquester/daemon` and `@orquester/desktop`,
  and `external` in the desktop's esbuild main bundle. Pinned `^12` because this stack runs Node 20
  and v13 needs Node ≥ 22. It is resolved ONCE, at module load (`agent-host/index/sqlite.ts`:
  `createRequire(import.meta.url)` inside a try/catch — never a lazy `import()` under
  `agent-host/`), and the binding is probed there with one in-memory open, so a missing or
  ABI-mismatched build reads as "no driver" rather than as a broken file to delete. A host without
  the binding runs with `index.available === false`: history 503, search `indexed:false`, nothing
  else changes.
- **A fresh host must not answer `GET /providers` with `[]` for five minutes.** Three layers, all
  in `agent-host/orchestration/provider-snapshots.ts`, ported from T3 (`makeManagedServerProvider`
  + `ProviderRegistry`). **(1) A pending seed, synchronously at construction** — before the cache
  is read and before any probe, every adapter's `pendingSnapshot()`
  (`agent-host/adapters/pending.ts`, wired through `ADAPTER_PENDING_SNAPSHOTS`) supplies a row with
  `status:"unknown"`, `auth:{status:"unknown"}`, "… has not been checked in this session yet." and
  the best catalogue it can name without I/O (Claude's `FALLBACK_CLAUDE_MODELS` family aliases,
  Grok's four, the list its CLI advertised on the newest capture; Codex/OpenCode read theirs off a
  live server and honestly answer `[]`). A pending row is **never `status:"error"`** — that
  spelling makes the client raise "sign in again" for a provider nobody has looked at — and is
  never persisted or hydrated. **(2) The disk cache is
  correlated, not just keyed**: `provider-snapshots.json` is v2, each row `{identity, snapshot}`
  with `{adapterId, hostProtocolVersion, binPath, version}` inside the file, and a row hydrates
  only when the adapter id agrees in all three places, the protocol version matches and the CLI is
  still at the same path — so a cache written before an `npm install -g` moved the binary is
  discarded rather than rendered. A correlated row overrides the pending seed; a v1 identity-less
  payload is dropped. **(3) The registry probes, at boot, every provider that did not hydrate a
  correlated cache row** (`startBootRefresh()`), called from `main.ts` after `host.openGate()` and
  never awaited — a probe must never delay readiness. A correlated row is already the snapshot to
  serve: re-probing it launched a heavyweight Claude SDK process on every deploy, which could block
  the loop long enough for the supervisor to kill a ready host (2026-09-23). Manual and scheduled
  refreshes still probe everything (`refreshAllNow()`). The 5-minute interval is only a top-up and
  stays gated on a live watcher; the old first-watcher priming survives as a fallback over the same
  unprobed set.
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
- **One request, one closing row — the host's, when the host closed it.** A Stop writes its own
  "Request cancelled" / "Question cancelled" row (`settlePendingRequests`) and hands the adapter
  the cancel, which the adapter answers on the wire and reports; a turn's end dismisses a stranded
  native question in the log only (`settleStrandedQuestions`), and the adapter may settle it later.
  Every adapter's report of such a closure used to be a second row — "Approval resolved {decision:
  cancel}" / "User input submitted", saying someone answered. The host remembers the requests it
  closed itself (`ThreadRuntime.hostClosedRequests`) and drops, at the sink, an adapter row that
  repeats the closure as a cancellation (`repeatsHostClosure`: an approval's `decision: "cancel"`,
  a question with no answer — the adapters' echo and ingestion's `withdrawn` row). A real answer
  racing the Stop keeps its row; a new request reusing the id is not the host's closure (ids may be
  recycled, `pending.ts`); the adapter's answer on the wire is never touched. A card an ADAPTER
  closes on its own — its session's teardown on an interrupt, a steer's cancel, a rewind or the
  process's exit — is one row too, in all four adapters, and it is marked `withdrawn`
  (`RequestResolvedPayload`), so it reads "Request cancelled" / "Question cancelled": Grok wrote
  that closure twice (the teardown's row, then the parked handler's own — on an exit, after
  `session.exited`), and Claude's, Codex's and OpenCode's teardowns wrote it as "Approval resolved"
  / "User input submitted" (Codex's crash path on no turn at all). Grok's parked handler is now its
  cards' only emitter (`withdrawPendingRequests`); a Codex card's teardown cancel and crash go
  through the card's own `cancel` / `fail`, never `settle`, which carries the user's answers (a
  `cancel` among them), and on its own stamps. Every adapter withdraws its cards BEFORE the dying
  turn settles (Codex's `handleExit` settled the turn first), so a question on that turn is closed
  as nobody's answer, not left for the host's dismissal at the turn's end.
- **A non-image attachment reaches the agent as a PATH, guarded twice.** The upload reply
  carries `AttachmentRef.path` — the absolute host path; `validate.ts` rebuilds every ref from
  `{type, id, name, mimeType, sizeBytes}`, so the host's validation strips it from every command
  body and no adapter and no event ever sees it — and the
  composer inserts it into the prompt when the upload completes, exactly as the terminal-era
  upload typed it into the PTY (`composer-files.ts`). Independently, every adapter appends
  `Attached files:\n- <name>: <path>` for the refs it does not ingest natively
  (`agent-host/adapters/attachment-lines.ts`), skipping paths the text already names — Claude
  ingests images only, Codex images by path, OpenCode image/`text/*`/pdf ≤ 20 MiB as `file` parts,
  Grok nothing. Before any adapter sees a turn, `sendTurnEffect` resolves and STATs every
  attachment on every sending path — a steer, a turn queued behind a compaction and a message-mode
  answer included — and stamps the real size on the ref, so §6.3's bounds and OpenCode's cap hold
  against the file on disk. A question answer names its files as `Attached file: <name> (<path>)`
  lines instead (a native answer after its text, a multi-select's as one more array entry), and an
  answer naming a file that no longer resolves is refused before anything is committed. Before this, Claude and Codex dropped every non-image file silently behind a comment
  that assumed a host path line never ported from T3. Claude reads the path without an approval
  (the thread's attachments dir is an `additionalDirectories` entry); Codex and OpenCode may raise
  their own approval card for a read outside the project. Chips draw a vendored Material Icon
  Theme subset (`packages/ui/src/icons/files/`, MIT, pinned in its README — never the
  Office-branded vscode-icons set, whose decorative use the trademark guidelines forbid).
- **`raw.ndjson` is as sensitive as the repository it watched** — it records whatever the agent
  read, and Grok's `_x.ai/mcp/servers_updated` carries the host's real MCP credentials. Redaction
  runs before anything is written, and before any stderr excerpt leaves the host.
- **A running state never outlives its process — a dead host's included.** Before
  `session.exited` the adapter withdraws every parked request (one `withdrawn` row each, before the
  turn settles), settles the in-flight turn and closes every live task `stopped`. Every wait on a
  child has a deadline (`support/deadline.ts`), and an
  expired one kills the child. A host that is killed (a crash, an OOM, a hard stop) runs none of
  that teardown, and left alone its requests, calls and tasks stay open in the log for good: a card
  no process can answer blocks the composer ("Answer the request above first.") and the MCP's
  `send_message` until the user stops the session, the fold keeps a running call's opening row
  (`open-work.ts`, within its caps), and a roster row with no terminal row reads running again the
  moment a session is live. So a thread's **first load in a host lifetime** closes what that
  teardown would have closed (`closeLeftoverWork` in `orchestrator.ts`; the rows are derived from
  the folded window alone by `leftoverWorkClosings`, `orchestration/leftover-work.ts`): first every
  request the fold shows pending but a message-mode question, cancelled with the host's own Stop
  rows (`settlePendingRequests`, one builder: `cancelledRequestActivity` in `events.ts` — "Request
  cancelled" `approval.resolved {decision: "cancel"}` / "Question cancelled" `user-input.resolved`,
  on the turn the head says is running — or said, when the orphan reconcile settled it first:
  `runningTurnId`), which close it for good (`closedRequestIds`), never the
  provider's "resolved"/"submitted" rows, which would say someone answered; a message-mode question
  (`responseMode: "message"`) stays pending, where a Stop would cancel it too, since it parked no
  request and a later user message answers it; then for every open call a
  `tool.completed {status: "failed"}` with detail "Stopped when the agent host restarted." and its
  latest lifecycle row's item type, title, turn, owner, parent call and data (a completion carries a
  call's final state — the snapshot read drops every `tool.updated` a later completion supersedes;
  ingestion stores a `tool.updated` already slimmed, §5.6, and that data counts as cut only when it
  holds a cut OUTPUT, `closerData`: an identity-only cut such as Claude's `{command, toolName}`
  rides unmarked, the command kept — marked, it offered "Load full output" and an MCP `outputItemId`
  that read the same row back — while an output preview, Grok's `rawOutput` or a Claude update's
  result whose completion never landed, never passes for the whole output: the opening row's whole
  data rides instead, and the cut copy rides marked `truncated` only when no row holds whole data),
  and the files that row names at its top level (`changedFiles`, the slimmer's promotion out of the
  data: a Codex patch update is stored as `data: {}` beside them, so a closer that copied the data
  alone listed no files in the GUI's row or the MCP's entry) —
  except a call no row of the window anchors (`anchorsCall`,
  `packages/api/src/agent-chat/call-anchor.ts`: every row of it turnless and ownerless — what a
  rewind leaves of a Claude parent call a later turn adopted, rule (6) below), which no view shows
  and which a closer would bring back as a failed row after every host start; then for every task
  the roster shows `pending`/`running`/`waiting` (any agent kind — `idle` is left alone, as the
  fold's session-death rule leaves it) a `task.completed {status: "stopped"}` with its latest row's
  linkage, the roster's `agentKind`, and its start's owner and turn (a rewind keeps or drops a row
  by its turn: a stop on any other turn could go while the start stays, and the agent read running
  again). Calls come before tasks, so a background shell's item closes before its task, and every
  closer carries its opener's owner as the fold reads one (any non-empty `agentId`) — a closer in
  another retention class can age out first and leave the call reading open again. **One part of the
  teardown is not replayed:** a message still `streaming: true` is left as the log has it — every
  `thread.message-sent` moves the message's span in the thread index, a history page never splits a
  message (`outsideMessages`), and a settle appended here stretched an old message to the end of the
  log, so the first "Load older" page ended at its first chunk and every row between it and the
  window was on neither; its readers read it as settled instead (below). It runs in
  `settleOnFirstLoad` (the `bootSettlePending` settle, before the runtime is published) and in
  `reconcileThread` — for an orphan AFTER its turn is settled, BEFORE it is continued, since a
  continuation's process owns none of it — never for a thread an adapter lists as live
  (`listSessions()`); best-effort (a failed append is logged, the thread still loads); in passes
  that skip what an earlier one closed, because the roster lists 100 rows, live first. A second load
  finds nothing to close. **The turn that process was running ends when the process died, not at
  the restart:** the fold settles a turn at its settling `thread.session-set`'s `occurredAt`, and a
  reconcile that stamped its settle with the restart counted the whole downtime in the turn's
  duration. So the reconcile's settle — `settleAsError` for an orphan it does not continue,
  `settleStalePendingTurns` for a stale `pending` turn (and the running turn the same `stopped`
  settles) — is its FIRST row, stamped `crashSettleAt`: the `occurredAt` of the log's last line
  (`lastWriteAt`, which the fold keeps as `head.updatedAt`, so nothing is read for it), or the
  start of a turn it settles — for a turn that never started, its request — when that is later:
  ingestion stamps a flushed message with its first delta's time, so the last line can read seconds
  before its own turn's start, and a settle there ended the turn before it began. Every row after
  it — the notice, the closings, the launch names — keeps the clock's time, which is when the host
  noticed, and the log's times never go back (a settle is never stamped earlier than the line
  above it). The stale settle is written even when the session already reads `stopped`
  (`persistSession`'s `force`): skipped there as an unchanged session, it left the turn `pending`
  for good — the thread read "working" forever and every later first load wrote the notice again.
  A continuation that fails later settles at its own time (it ran in this host's lifetime), and so
  does a prepare that could not reach disk (the repairs before it are already at the clock's time).
  A closer on an old turn is a late reference: the index grows
  that turn's range over it, within `MAX_LATE_REFERENCE_BYTES` of the next turn's start
  (`extendReferenced`), and "Load older" still serves every row; a later rewind that keeps that turn
  and drops the ones after it clips the range at its cut, as it clips every surviving range; the
  closer, past the cut, is then served by the page that holds the cut, by the turn it names (the
  history-pages gotcha: a kept turn's late rows are folded out of a revert's cut). On the owner's
  host (2026-09-24) the three big threads' first loads would append 1–9 rows each (their live work
  at the time; no request was pending) and leave the 270–1 800 messages still flagged streaming in
  each window as they are. **Their readers decide instead, by one rule:** a message reads as
  streaming only by `isMessageStreaming` (`packages/api/src/agent-chat/message-liveness.ts`) — its
  flag says so, the session is live (`isSessionLive`, the roster's session-death notion), and its
  `turnId` is the head's `activeTurnId` or its `agentId` an agent the roster shows
  `pending`/`running`/`waiting`; anything else reads as settled — a dead host's stream, an agent's
  turnless words from before ingestion closed them, a turnless message nobody owns. Every reader
  that shows liveness goes through it: the GUI's rows derivation stamps it on a message row
  (`streaming`), which the reasoning row's "Thinking" shimmer and an answer's streaming text read,
  and only an answer that streams by it holds its turn's fold open — the window (`store.ts`), the
  history (`liveInputOf` keeps the session and the running turn only: the parent's timeline holds no
  agent's words, so no roster change re-projects it) and the drill-in (`drill-in.logic.ts`) all pass
  the thread's `messageStreamingContext` (`messageStreaming` on `TimelineRowsInput`; memoised by the
  roster array, so a streamed token keeps the fast path — except a token of a flagged message WITH a
  turn that reads settled, answer or thinking block alike, which rebuilds: its turn may fold, and
  the "Worked for …" of a fold with no settled turn row to read is timed by its terminal answer's
  and its last row's `updatedAt`; a turnless message joins no fold and keeps the fast path). Pure
  and read-side: the fold, its snapshot, the index, ingestion and the GUI's streamed-text fast path
  keep reading the flag, no version moves and nothing is written; the MCP reports no message
  liveness at all. **A settled turn's "Worked for …" is its own duration** in the parent's view —
  its start to its completion, off the fold's turn row (`deriveTurnFolds` in `rows.logic.ts`; the
  window and the history pass the thread's `turns`) — never the span to its last row: a first-load
  closer rides the turn its work started in, so a turn of seconds read "Worked for 50h". Only a turn
  still running, or one no row describes, is timed by its rows. A drill-in's folds are always timed
  by the agent's own rows (`drill-in.logic.ts` passes no `turns`): a background agent works long
  past the parent turn its rows ride, and that turn's seconds would say nothing of it. **A live
  agent's current run is the drill-in's running response** — while the session is live and the
  roster shows it `pending`/`running`/`waiting` (the `messageStreamingContext` notion, never a
  second one; a loop — or a legacy goal row — never), its run from its start (the roster's
  `startedAt`, else its latest launch) is unfolded, its in-progress calls are live rows, its tail is live and a working
  row heads it: a run is a POSITION, not a turn (`agentRunStartIndex` in `rows.logic.ts`), because
  an agent's rows ride whatever parent turn was live when each started, or none. A launch prompt
  (`agent-prompt.logic.ts`) heads its run: the rows after it fold by their turn AND that prompt
  (`timelineFoldKeys` — a drill-in fold's key, and its row id `turn-fold:<turn>@<prompt>`, is not a
  bare turn id), and it times only the fold of the rows right after it. A thinking block
  never holds a fold open, so a fold outside that run — a settled agent's, or an earlier run's — can
  end on a thought still being written: a fold its rows time keeps a clock (`TurnFoldClock` in
  `rows.logic.ts`: its start and the POSITIONS of its answer and its last row, which a token never
  moves), and the streamed-text fast path relabels it off that clock, so its "Worked for …" follows
  the tokens and closes on the thought's last write. The drill-in holds its disclosure sets across
  projections for that fast path (`shallowEqualInput` compares them by identity; a fresh pair per
  projection rebuilt every row on every token).
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
  The launching call is read off `task.started` rows ONLY: progress rows have stable ids
  (`task-progress:…`, `task-usage:…`) and are replaced **in place**, so in list order the
  relaunched run's progress row — already naming the new call — sits before the killed run's
  `stopped` row, and reading the call off it kept every relaunched agent `interrupted` for as long
  as it worked (2026-09-23). Anything that folds activities by position must remember that order
  is first-emission order, not time. **Every adapter that surfaces agents keeps the contract this
  rule reads:** an agent's FIRST `task.started` carries a launch id; re-engaging an agent that is
  not live emits a NEW `task.started` under a different one before any row of the new run; the run
  ends with the adapter's usual end row, and no stale end of an earlier run follows; and the
  adapter's own live set reopens, so Stop and exit close the new run `stopped`. A status-only
  reopen is not enough: an appended `task.updated {running}` is an ordinary row of the agent's
  window, and once retention drops it the roster reads the old end mid-run. OpenCode — a `task` call
  with `task_id` re-prompts the existing child, no `session.created` — starts every run from the
  parent's `running` `task` part under its `callID`; a live part naming a settled child under a call
  never seen for it is the relaunch; a frame of any call seen before, or a call on a live child,
  emits no task row (`linkChildFromTaskPart`) — a child's own `task` parts name ITS subagents the
  same way, and a child no part has named yet starts under `opencode-child:<session id>` — that
  start alone: once a part names its call, every row names it; and a child a Stop closed that the
  server confirms still runs is relaunched by the adapter itself under
  `opencode-revive:<callID>:<n>`, after a seed naming the first run's launch where its start named
  none (see "OpenCode: a subagent's answer arrives after its run ended", point 7). Codex starts
  under `codex-launch:<item id>` at `subAgentActivity started` and again under `codex-run:<turn id>`
  at a child's own `turn/started` after a settled run, or for a child this session never saw
  launched (`childAgentEvent`); an end record arriving during a turn a relaunch opened writes no
  end, and `interacted` carries no status — neither is evidence about the run in progress. Grok
  starts an agent at its `spawn_subagent` call's first frame under the call's id, and a
  `resume_from` launch starts the SAME task again under the new call — the resume's own, NEW
  subagent id joined to it by `subagent_spawned.resumed_from` (`launchSubagent`, `subagentSpawned`;
  see "Grok: shells are live work"). A resume the CLI runs itself, with no call, is relaunched at
  that `subagent_spawned`, under the resume's own id (`relaunchResumedSubagent`). An agent first
  launched by a host older than the relaunch fix
  (2026-09-24) has no launch id on its first start, so a relaunch from a terminal state could not
  reopen it; rather than weaken the late-delivery guard in the fold, a thread's first load in a host
  lifetime gives each settled one — OpenCode, Codex and Grok threads (the head's adapter): Claude
  always launched with an id, and the 2026-09-24 goals build's Grok agents started from a
  `subagent_spawned` no spawn call explained had none (`LEGACY_LAUNCH_ADAPTERS`) — one appended
  `task.started` naming `legacy-launch:<taskId>` (`legacyLaunchStarts` in `leftover-work.ts`,
  `recordLegacyLaunches`, after the leftover closings so an agent they stop counts as settled). It
  rides the agent's first start's turn (a rewind keeps or drops the two together) and owner, carries
  its newest row's linkage like a closer, and its row's `createdAt`/`updatedAt` are the roster's own
  `updatedAt` for the agent (the event is stamped with the load's time), so the roster reads exactly
  as before — a row stamped with the load's time would rank every legacy agent newest among the
  settled rows and let the 100-row cap drop the agents that really are — and only the launch id
  moves; it is that agent's anchor, merged into its spawn row, never a row of its own. An `idle`
  agent gets none (any start reopens it, and this one would), an active one is the closings' to
  settle first, and one with no start in the window gets none (a start would create it in the
  roster, running, once retention dropped its other rows). Once per agent: the next load finds a
  launch id and names nothing.
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
  **The drill-in's timeline renders exactly the rows its one projection hands it**
  (`useAgentChatDrillIn`, called by `AgentDrillIn`; `ChatTimeline` projects nothing of its own): a
  second projection inside the timeline once won whenever it had rows, which threw a background
  shell's one-row projection (`roster/background-shell.ts`) away for every shell on a turn.
  (5) **Message segments are keyed per agent** — `(turnId, agentId | none, role)` in
  `ingestion/index.ts`, with the owner baked into the message id (`ownedBaseKey`) and stamped on
  every `thread.message-sent` of an agent-owned segment: a subagent narrates inside the PARENT's
  turn, so a turn+role key put its prose in the parent's own bubble and let its first visible word
  close the parent's thinking block. `splitThreadItems(items, ownerAgentId)` is the client mirror
  — the parent's view drops agent-owned messages, the drill-in keeps its own — and the Claude
  normaliser projects a nested `thinking` block as the agent's reasoning row, which it used to drop.
  (6) **A call's rows are one owner's and one turn's — its output chunks included.** A subagent's
  `tool_result` names only `parent_tool_use_id`, and the Claude normaliser's `content.delta
  {command_output|file_change_output}` left out the `agentId` the call's `item.*` rows carried: the
  chunk folded as a PARENT `tool.output` row — a stray "Tool output" in the parent timeline, one
  more row in the parent's 500-row window — and the drill-in never showed the output (fixture
  `claude/07`, fixtures README observation 22). Every event of a call now carries the call's owner
  and rides `ToolInFlight.turnId`, the turn active when the call STARTED (absent between parent
  turns), never the one active when the event is emitted — one call, one `tool:<turn>:<id>` key.
  A woken parent's first message is held and replayed into the turn that opens next (the "A turn
  the CLI starts by itself" gotcha), so its calls start on that turn. **No call is assigned a turn
  late:** a parent call that registers while no turn is open outside a held message — the tail of a
  message whose turn ended while it still streamed — rides the turn its MESSAGE streamed in
  (`streamMessageTurnId`, set at the message's `message_start`), never the next turn to open,
  which is the user's next prompt and has nothing to do with it. How its turn ended decides the
  rest (`streamRunEnded`): after the CLI's `result` the run that message belonged to is over —
  capture 10 shows nothing of an interrupted message after its `result` (fixtures README
  observations 13, 14, 22) — so the call can never run and is closed at once, `failed`, on that
  turn, as the turn's end closes a call it cut (and one of a held message dropped with its run has
  no turn and is dropped with it); after the adapter settled the turn itself (`sendTurn` closing a
  stale synthetic turn while the CLI's own message streams on) the run goes on and the call runs,
  its rows on its message's turn. Until 2026-09-28 such a call ADOPTED the next turn to open with
  one `item.updated` (`adoptedToolEvent`, gone), leaving its start and any early input update
  turnless — the interrupted turn's call then read running in the user's next turn. A log written
  before then (or before the hold, for every woken call) keeps those turnless rows: the adopting
  turn's fold holds the call and a rewind to before it removes it (`reduceReverted` keeps turnless
  rows); what is left after such a rewind is all turnless, so neither view shows it running: the
  GUI drops the start (superseded by the update, else as turnless and ownerless — `startIsCallRow`,
  `entries.logic.ts`) and hides an in-progress update as a neutral row, and the MCP transcript
  builds no entry from a call whose rows are all turnless, ownerless and unclosed. That is one
  rule, `anchorsCall` (`packages/api/src/agent-chat/call-anchor.ts`: a row anchors its call by its
  turn, its owner, or as its close), and a host's first load follows it too: it writes such a call
  no closer (`leftover-work.ts`), which would anchor it and bring it back as a failed row. A log a
  host wrote before the stamp — an older host surviving a deploy writes such chunks until its
  drain-restart — is read by the call, on the read side only (no fold change, no version bump): an
  unstamped `tool.output` takes the owner of its call's lifecycle rows in the same derivation input
  — `callOwnersOf` in `entries.logic.ts` (`itemsForAgent` puts it in its owner's drill-in,
  `deriveWorkLogEntries` keeps it out of every other view) and `unstampedChunkOwner` in
  `mcp/transcript.ts`. One whose call's rows are gone stays the parent's; the fold, its retention
  and the history bridge keep mirroring the log. **A Codex collab child keeps the rule too**
  (`childItemEvents`, `adapters/codex/normalise.ts`): its `item/*` became only the roster's
  `task.progress` tick and its output deltas were dropped as chatter, so a Codex drill-in showed
  ticks and never a command. A child's call is now the child's own rows — `agentId` on the envelope
  (ingestion reads a row's author there: stamped on the payload alone, a child's call starting would
  end the parent's thinking block) and on the payload — under `codex-child:<thread>:<item>`
  (`childItemId`: a child's `call_1` is not the parent's), riding the parent turn live when the call
  started; its own `turn/completed`, its `thread/closed`, a Stop or the exit closes what it
  abandons, never the parent's settling turn (a Stop closes calls before tasks, as the exit does).
  Its approvals stay the parent's card — no owner, on the parent turn live as the request arrives
  (`requestTurnId`), like the call — joined to the namespaced call in the child's OWN request
  bookkeeping (`requestsOf`, `session.ts`), which only the child's own turn end, its thread's close,
  a Stop or the exit clears: cleared by the parent's settle, a decline on a card still open when a
  parent's `wait` returned read "you were not asked", and a file change's card lost its diff. A
  child's QUESTION rides no turn at all (`questionTurnId`): a turn's end dismisses the
  native-callback questions on it (`settleStrandedQuestions`, in the log only — the adapter is
  never answered), which on the parent's turn swept the child's open card while the child stayed
  blocked, and a turn the thread never had (the child's own) is dropped by every rewind; nothing
  settles an approval by its turn, so approvals stay on the parent's. **The end of the wait on a
  card nobody answered settles it** (`withdrawRequests`), the parent's own as a child's: the end
  of the turn that raised it (`turn/completed`, whatever the status; a child's own turn for a
  child's card — never the turn a card is merely stamped with), its thread's close
  (`thread/closed`, with or without a turn end), or a `serverRequest/resolved` naming it (a card
  still parked is never the ack of our own answer: every path that answers takes it out first). A
  card asked outside any turn (an MCP elicitation with `turnId: null`) is not ended by a turn's
  end. Left parked, a card paused the session's watchdog for every later turn, held one of the 32
  in-flight slots, kept an approval blocking the composer, and was answered by a later Stop. Each
  gets one row, the host's own Stop row ("Request cancelled" / "Question cancelled",
  `cancelledRequestActivity`, through ingestion's `withdrawn` rule), on the stamp the card was
  opened with — a child's before the rows its end writes, the parent's own after its turn's end, so
  a question the host dismissed at that end keeps the dismissal as its one row
  (`repeatsHostClosure`) — and nothing is answered on the wire (`CodexRequestWithdrawn`). Whether
  the server still holds such a request is read, not captured: the 0.155.1 binary's "client
  request resolved because the turn state was changed" reads as the server resolving a thread's
  pending requests itself at its turn's end, but "client request" could also name a
  client→server request (codex fixtures README observations 5 and 20). Writing no answer is safe
  either way — the server resolved the request, or the turn that asked is over.
  Left open, the card blocked the composer ("Answer the request above first.") and the MCP's
  `send_message` until the user answered a request nothing waited on, or pressed Stop. A card
  answered first is settled once, by its answer. A child's MCP progress is its heartbeat
  (`tool.progress` on its task); its message and reasoning items stay ticks (codex fixtures README
  observation 20).
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
  clear liveness, but it is not a roster event (fixtures README observation 18). **A running shell
  keeps its start and its roster row:** its `task.started` (a parent row, no anchor) and its
  `bgshell:` call's opening row are the opening rows of running work, which retention keeps
  whatever their age while they are among the 16 most recently active openings its window's cut
  would drop (`OPEN_WORK_RETENTION_LIMIT`, `FOLD_SNAPSHOT_VERSION` 4, 5 since the merge) — before
  that the start aged
  out after 550 parent rows and the shell left the roster while it ran, and a trickling shell's own
  output evicted its call's opening row (title, command) after 250 chunks.
- **Background agents (Claude) outlive the parent's turn.** Since CLI 2.1.280 `run_in_background`
  defaults to true: the parent's Agent call answers at once, its `result` ends the turn, and the
  agent works on — in the biggest live thread 97 of 112 subagents finished after their parent's
  turn (fixtures README observation 22; no capture yet). (1) `completeTurn` — and the auto-close of
  a stale synthetic turn, which goes through it — neither settles nor forgets an in-flight call
  whose owner, or an agent that owner runs inside, is a live task with `is_backgrounded: true`
  (`outlivesParentTurn`): settling it reported the call "completed" with no result and dropped the
  real one when it came. Such a call ends by its own `tool_result`; else `failed`, on its own turn,
  at its owner's terminal edge (`closeInFlightToolsOf`, from `task_notification` and a terminal
  `task_updated`, BEFORE the task row) or with the session (`closeLiveTasks` closes every call a
  subagent still has open: teardown runs it before `completeTurn`, and between parent turns there
  is no turn to complete). A foreground agent (`is_backgrounded` false or absent — fixture 07,
  older CLIs) keeps the settle at the parent's turn end. Nested frames never open a turn and the
  output chunk has no turn guard, so a subagent's call that starts between parent turns is
  turnless for its whole life. (2) Ingestion closes a turnless `assistant_message`/`reasoning`
  message on its own `item.completed` (`handleTurnlessCompletion`, the ids `handleContentDelta`
  mints with no turn): nothing else closed it but a session stop — after a host restart, nothing
  at all — and one live thread held 5 479 agent messages still "Thinking". A log written before
  keeps them flagged; they read as settled once their agent is no longer at work
  (`isMessageStreaming`, see "A running state never outlives its process"). (3) A `tool_progress`
  heartbeat belongs to its call (`toolProgressEvent`): no nested frame on 2.1.280 carries
  `task_id`, so owning it by `task_id` dropped every subagent heartbeat; `task_id` counts only for
  a surfaced subagent.
- **"Load full output" reads all a command printed: the host's join, else what its item kept.**
  A row holds only the chunks its window kept (a parent's 500 rows, an agent's 200), and a command's
  item holds its output only as far as its adapter kept it: a Codex completion keeps
  `aggregatedOutput` whole up to 64 KiB and past that only the head, its payload marked `truncated`
  at rest (`COMMAND_OUTPUT_MAX_BYTES`, `adapters/codex/items.ts`); an OpenCode completion whose
  final output its `bash` tool cut keeps what the tool kept — the END of the output, behind the
  tool's `...output truncated...` / `Full output saved to: <file>` note — marked the same way
  (`isCutFinalOutput`, `adapters/opencode/state.ts`; unmarked, the MCP answered that end as the
  whole output), and so does one of any other command-named tool (an MCP server's) that
  OpenCode's generic `Truncate.output` cut: the HEAD, its note at the END; a background shell's completion
  keeps its command and exit code, no output; an update is stored already slimmed, its data the
  row's preview. So a row whose command streamed (`streamedOutput`, `WorkLogEntry`: a
  `command_output` chunk, every lifecycle row of a call whose chunks the derivation input holds —
  wherever they fall — the row `joinLifecycleDetails` puts them on, and every lifecycle row of a
  Claude background shell's `bgshell:` call, whose chunks the cross-agent ceiling can evict while
  retention keeps its start) offers the button whether or not its payload was cut — a running
  command's start included (`fullOutputSourceOf`) — and the viewer reads the call's join first
  (`readFullOutput`, `packages/ui/src/lib/agent-chat/full-output.ts`) through the chat transport's
  `readItemOutput`: `GET …/items/:itemId/output` one window at a time,
  `THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES` wide, each starting where the last ended — else the read
  fails rather than stitch a text the call never printed. A command item stored cut asks the join
  next, even with none of the call's chunks in view — the MCP's order: `read_tool_output`'s step 1
  skips an item stored cut, its step 2 is the join. Where no join answers (an empty one, or a 404)
  the item answers by one rule both readers follow, `storedCommandOutput`
  (`packages/api/src/agent-chat/command-output.ts`): an output stored whole as text; the part a
  completion kept as text under "Only part of this output was kept." (the MCP: `command-output`,
  `truncated: true`) — never as JSON, never as the whole output, and naming neither the part (a
  Codex head, an OpenCode end) nor its size, since a first load's closer can carry an update's cut
  copy marked the same way, a one-line preview; an update's
  preview never as the output (its payload, as JSON); anything else as before (`fullOutputText`).
  The other notes above the text: "still running", and "only the first 8 MiB can be shown here" (the
  log keeps every chunk; only the join stops at its cap). A host from before windows answers the
  whole join, taken as it comes. Never a file change's join: its chunks are its result text (the
  MCP's rule). The subagent drill-in opens the same viewer: a read, not a command. The read is not
  routed through the thread store: an output the user asked to see once is not thread state.
- **OpenCode: a subagent's answer arrives after its run ended — a background one's as a prompt that
  wakes the parent into a turn of its own — and a running command restates its output.** (fixtures
  README observations 27-28, `adapters/opencode/normalize.ts`.) (1) The
  child's own `session.idle` ends a run just BEFORE the parent's `task` part completes with the
  answer (fixture 12, lines 179-180), and the once-per-run end guard dropped that part: every
  OpenCode roster row read `result: null`. The part now gives the run's end its result — one more
  `task.completed` of the same run, same linkage, `completed`, `summary` the text inside the tool's
  `<task_result>` envelope (`taskResultText`) — once per run (`resultPending`), never for a stale
  part of an earlier call; the roster fold takes a settled row's result from a later completion
  and reopens nothing. A part that settles first ends the run itself, with the same text. A run in
  the BACKGROUND answers "still working" at once, and 1.18.32 delivers its answer as a prompt to
  the calling session instead — a user message whose one text part is `synthetic` and wraps it in
  the same envelope, naming the child — which gives the run its result the same way
  (`takeBackgroundResult`; carried by the child's own end when it comes first) — only for a run
  whose launching part answered in the background (`answersInBackground`) and whose call's
  description the answer's summary names, so an answer arriving after a relaunch is never the new
  run's. That prompt is still no row, live or replayed: E6 history skips `synthetic` user text
  parts (`history.ts`). No result follows an end by `session.error` or a stop. (2) Every running
  frame of a `bash` part restates ALL its output so far in `state.metadata.output`, which rode only
  the item row's `data.state` — dropped by the wire slimmer — so nothing showed until the
  completion. Each frame is cut against the value last seen for the part (`advanceOutputMark`,
  `OpenCodeSessionState.outputMarks`) into `content.delta {command_output}` of just what it adds,
  on the call's item and under its owner: past 30 000 characters the tool keeps `"...\n\n"` and a
  sliding tail window, and what follows the window's longest overlap with the last value is new —
  only a value carrying that head is searched. Never text already shown: a value that rewinds, or
  of any other shape, adds nothing, and output that repeats itself can overlap further than it
  really did — a repeat is then lost, not doubled. The joined chunks are the call's output in the
  GUI, settled too, and the final `output` is not always the last running value (a timeout's or an
  abort's `<shell_metadata>` note, a cut behind "Full output saved to", what a missed frame
  carried): the completion first appends what it holds past the stream (`finalOutputRemainder`: the
  rest of a final output that extends it, else what follows the LAST place it holds the stream's
  last 512 characters — no anchor under 64 — else nothing), BEFORE its own item event closes the
  call's output buffer; a final output the tool cut ends that with its note's pointer,
  `Full output saved to: <file>`, which the join otherwise never holds. A stream that showed
  nothing adds nothing, and an errored part has no final output. Such a completion's
  `data.result` holds only what the tool kept — the END of the output, behind that note (`es` in
  `ShellTool.run` walks the lines from the last) — so it is marked `truncated` (`isCutFinalOutput`,
  the note `finalOutputRemainder` reads): unmarked, the MCP's `read_tool_output` answered that end
  as the whole output while the GUI's viewer read the join; now both read the join first and show
  the kept end only when none answers, as "only part of" the output (`storedCommandOutput`). (3)
  That background answer WAKES the parent: 1.18.32 prompts the calling session through
  `SessionPrompt.prompt` (the `prompt_async` path; read from the source) and runs a reply no `/turn`
  opened — it streamed turnless, the thread read idle, and its end raised no "finished". The first
  `message.updated` of an assistant message now decides whose reply it is (`claimReply`,
  `claimedPromptIds`): a reply to a prompt the host sent (`sendTurn` claims the id it mints before
  sending it) or one a turn already claimed is that turn's; a reply to any other prompt is claimed
  by the turn running when it begins (the server answers a prompt that arrives mid-run in the same
  run, `ensureRunning`), and while none runs it opens the WOKEN turn — `turn.started` named by the
  prompt's id, as a live turn is by its prompt (a rewind finds it), before any row of the reply, and
  a `turn-woken` signal for the session's record. From there it is any turn: the run's idle settles
  it, a `session.error` fails it, a Stop aborts it, the session's stop closes it, a restart's
  reconcile settles it, and a user message steers it — never Claude's auto-close of a synthetic
  turn: this run is live, and the prompt joins it. Its steps are its own. Only with a run behind it
  — the parent's `busy` since its last `idle` (`parentBusy`; a reconnect clears it): with none no
  `idle` would settle the turn and `turn.started` never arms the watchdog, so it would hold a
  deploy's drain. A compaction's summary (`summary: true`) claims its prompt but never joins
  `promptMessageIds` (off the meter): the host's own `/compact` stays turnless (`compact()` holds
  `hostCompacting` up across `summarize`), a woken run that compacts FIRST (its context already
  full) opens the turn at its summary. Never opened for a reply that already ended (a fork copies
  completed messages — fixture 10; a rewind also claims every prompt its fork copied) or output
  after an interruption (the demux drops it first) — a guard every path a LATER turn settles by now
  ends (`endInterruptionBefore`): only `completeTurn` did, so a later turn that failed (a rate
  limit) left the Stop behind and every woken reply after it was dropped. A NEW run ends it too: a
  `busy` once the interrupt is over and the parent has said idle since it began
  (`endInterruptionAtNewRun`, `idleAfterInterrupt`; checked again as the interrupt ends, for a
  `busy` the stream delivered before the abort answered) — 1.18.32 publishes a cancelled run's idle
  only after its fiber ended, so nothing of the stopped run follows it (README observation 29), and
  a background answer injected after the abort starts the parent again: that run's reply used to be
  dropped with the leftovers, its requests shown to nobody's turn; it now gets its woken turn. A
  `busy` with no idle since ends nothing (the stopped run wrote one at the top of every step), and
  once the boundary ends an interruption at a run the provider started (no host turn active), one
  abort error until the parent's next idle is an echo of that abort (`abortEchoExpected`: that run
  may be the abort's after all — the natural-idle race — and its `MessageAbortedError` failed the
  woken turn or read the session `error`). A host turn's run never is: `sendTurn` prompts only once
  every interrupt is over, so once its prompt is taken and the stopped run's idle has come, an abort
  error fails it, whether its `busy` ended the interruption or the interruption's residue outlived
  that `busy` (the prompt's answer first, fixture 10's order: `hostTurnSinceInterruption`); both
  used to take the turn's own abort for the Stop's echo, for the whole turn. A user message's part
  is never dropped (an injected answer is a run's result). The child's end always precedes the
  answer's prompt (the runner publishes its idle before resolving its run), so neither it nor the
  answer's result ever rides the woken turn (README observation 27). The replay harness claims the
  host's prompt ids up front, and models `hostCompacting`, for the same reason `sendTurn` claims
  first: a blocking `/command` or `summarize` is recorded after its frames. (4) A background run
  OUTLIVES a turn that fails on its own (a `session.error`, a rate limit), as a Claude background
  agent outlives its parent's turn: 1.18.32 cancels a background job only through
  `SessionRunState.cancel` — the `abort` route, which a Stop, the session's stop and a failed
  admission send — so `failActiveTurn` closes only the runs that fail with it
  (`closeLiveChildAgents` `scope: "foreground"`: a child whose launch answered in the background, or
  one inside it, lives on) and returns the session to `ready`, as Claude and Grok do after every
  settled turn — an `error` session is a dead one to the roster (every running row `interrupted`)
  and refuses commands until a Stop, which would cancel that job. The turn stays `failed` (the
  activity ladder still ranks it `error`). Closed, the child read "interrupted" while it worked,
  left the drain's liveness, and lost its answer as its result. (5) A child
  session's question rides no turn, and neither does its resolution (`questionTurnId` in
  `normalize.ts`, Codex's and Grok's rule): a turn's end dismisses every question on it in the log
  only (`settleStrandedQuestions`), and a background child outlives the parent's turn, so its card
  was swept at the parent's turn end while the child still waited on the answer. A resolution on a
  turn its question does not ride would reopen the card after a rewind of that turn. The parent's
  own questions, and every approval, ride the parent's open turn. (6) A request that reaches the
  thread after a Stop waits for the server's word on its asker (README observation 29, read from the
  source). The abort ends every run and job it reaches, and an ask it interrupts drops out of `GET
  /permission`/`GET /question` with no event, but that ask's frame can still arrive late — and a run
  it never reached asks from a live asker: a background answer injected after it starts the parent
  again; a `task_id` extension's child runs on. The adapter marked every request that arrived while
  no turn ran after an interrupt resolved and answered nothing, so a live asker waited for good (and
  so did the next turn, which joins the blocked run). Now one that arrives while an interrupt is
  under way (`asInterrupt`: a Stop from its first step — withdrawing the parked cards comes before
  the abort — and a failed admission's abort, which now leaves the same lingering state a Stop
  does), or after it before any run says `busy` (`interruptionLingers`, the windows the parent's
  output is dropped in), is held (`holdsRequests`) and judged once every interrupt is over
  (`judgeHeldRequest`, `abortsSettled`): asked again if another interrupt began while the server
  answered (`interruptsBegun`) — a Stop that starts and ends during the reads makes their answer
  stale; listed by the server and its session busy — the card, as any (a child's question on no
  turn), or full access's `once`; unlisted or its session idle (an older server's orphan) — no card,
  a reject on the wire, and no row when it closes. A read that fails decides nothing: the card is
  shown unless the other read says the asker is gone — without the server's word a reject would
  answer for the user, and 1.18.32's `Permission.reply` rejects every other ask of that session with
  it. (7) A child the adapter closed itself (a Stop, a failed admission's abort, a failed turn:
  `closeLiveChildAgents` marks `endedByAdapter`, as does its launching call's abort cleanup
  (`interrupted: true`, the parent's word on its call) — which, like the child's own abort error,
  ends the run `stopped`, never `failed`) that runs on — a `task_id` extension's child, a job
  started after the abort listed the jobs — read "interrupted" and held no drain while it worked. An
  end the adapter wrote is not the provider's word: a report of a live run (the child's `busy`, a
  delta, a text part with no end, a running call, a reply not completed) asks the server once the
  interrupts are over (`reportChildRun`, `judgeChildSurvival`, `settleChildSurvival`). Busy —
  confirmed — the child is RELAUNCHED under the relaunch contract ("Agent rows must survive resumes
  and retention", rule (1)): a new `task.started` naming a NEW launch id,
  `opencode-revive:<callID>:<n>` (`launchId`, which every row of the reopened run names; `toolUseId`
  stays the provider's call, whose part still gives the run its answer). A grandchild is launched by
  its child's own `task` part, which names it as a parent's part names a child — its launch, and its
  answer; a child no part has named yet starts under `opencode-child:<session id>`, its start alone
  — rows name the call once a part names it, so the timeline hides the call behind the agent; a call
  resuming it (`task_id`) is never taken for its launch, and relaunches it once it settled; and a
  run whose start named none would get a seed naming its first run's before the relaunch, as the
  roster reopens only on a changed launch — defensive, unreachable today: every start this adapter
  writes names one (`startLaunchId`) and its records never outlive the host, so an older log's runs
  are the host's first load's (`legacyLaunchStarts`). The roster reopens the row — running, the
  Stop's end and summary cleared — liveness counts it, it is back in the live set (a later Stop or
  the exit closes it `stopped`), and its own idle and answer end it `completed` with its result,
  once. For the roster to read it running the session must read live after a Stop: `turn.aborted`
  folds to `stopped`, a dead session to the roster (every running row `interrupted`) and one the
  host refuses the next Stop on, so the Stop now returns it to `ready` (`session.state.changed`,
  `turn:interrupted`), as Claude's and Grok's do after every settled turn. One exception: a failed
  admission leaves the session `error` — a transport doubt, kept as ruled — which the roster reads
  as dead too, so a child relaunched after one reads `interrupted` there until the session reads
  live again, while liveness counts it all the same. Idle — the report was a cancelled run's last
  frames: nothing, and only a `busy` asks again. The child's own idle voids a check in flight; a
  read that fails relaunches it too (the drain outranks a duplicate row). The Grok adapter keeps its
  adapter-written end on a revival (a late delivery, status-less rows): its reports are the CLI's
  own listings and frames, not confirmed by a status read like this one. (8) A rewind ends the
  children the fork leaves behind (`closeChildWorkLeftBehind`, from `rollbackThread`). The fork is a
  new session holding copies of the source's messages (README observation 17), and a child's parent
  is the source — whose frames, once the thread is on the fork, are a foreign session's and are
  dropped: a child still working (a background run outliving its turn, a run relaunched after a
  Stop, whose start rides no turn a revert could drop) stayed `running` in the roster, kept liveness
  `working` — holding every code-only deploy's drain until the session exited — and no Stop could
  close it. Before the re-point every call a child still has open is closed `failed` — on the newest
  turn its rows rode that the rewind keeps, and not at all when only removed turns carried it (the
  host's revert drops those rows, and a closer there could only survive as a lone failed row) — then
  every live run `stopped`, each "Stopped by a rewind."; a run's closer rides no turn, so no revert
  drops it, whichever of the host's `thread.reverted` and these rows lands first. After it the
  source session, then its tree (`abortDescendants`), is aborted on the server, their frames — the
  aborts' own — already a foreign session's. (9) A Stop whose `POST …/abort` failed still ends the
  turn once the stream or the server says the run is over — `turn.aborted`, the session back to
  `ready`, as the Stop ends it — whether the run's idle came while the request was pending
  (`deferredIdle`) or after it failed (`failedStopTurnId`: two idle frames, or 1.18.5's lone
  `session.idle`), or a reconnect's status poll said so (Machine 2; `endFailedStopTurn`). That end
  counts as the idle after the interrupt (`idleAfterInterrupt`), so the next `busy` is a new run's:
  uncounted, a lone idle or the poll kept the next woken run dropped and took the next turn's own
  abort for the Stop's echo. Until then the turn is still the thread's, and the next Stop of it asks
  the server again; a steer into it is the user taking it back — the failed Stop is over, the run's
  end completes the turn as any, and its children run on. An end after the failure
  (`endFailedStopTurn`) closes the children before it aborts them, outside the interrupt, so that
  abort counts as one (`interruptsBegun`) and the judges wait for it (`descendantAborts`,
  `abortsSettled`): judged at once, a child's report in between relaunched it for a moment on the
  server's `busy` from before the abort, and an ask it then ended got a card. A second Stop used to
  find the turn already interrupted and do nothing, and an idle that came while the abort was
  pending was parked where nothing read it: the turn stayed active — the thread reading working,
  every deploy's drain held — and no Stop could end it.
- **Grok: shells are live work; a subagent is its call, the CLI's `subagent_*` reports and its child
  session's own frames; the CLI's own prompts get turns; a run nobody hears from stops counting
  after an hour.** Captured on 2026-09-25 (fixtures 15–23, observations 37–47 of the Grok fixtures
  README — read them before touching any of this). (1) Grok stamps every task row of a background
  shell with the shell itself (`agentId` = `taskId`), and the liveness registry read any stamped
  non-agent task as "a subagent's own work, covered by its owner" and dropped it: a dev server left
  running in the background never read "monitoring" and never held a deploy's drain. An `agentId`
  names an owner only when it is not the row's own `taskId` (`orchestration/liveness.ts`) — Claude
  stamps only a real owner and Codex/OpenCode type every live row `subagent` (Codex's typeless
  Stop/exit closer is terminal either way), so none reads differently — and a Grok shell is a watch
  loop like any other, bounded by the registry's TTL and turn-boundary sweep. (2) **A subagent is
  its call and the CLI's reports.** `grok_build`'s `spawn_subagent` call (matched by its vendor
  block's name AND namespace) starts a `taskType: "subagent"` task under the call's id at its first
  frame, stamped with itself, `toolUseId` = the call (its rows are `collab_agent_tool_call`, hidden
  behind the agent's row like a Claude `Agent` call). `subagent_spawned` (parent session) names the
  run's `subagent_id`, which IS its child session's id, and joins it to its launch — an id the
  launch's answer already reported (a background launch answers before this frame), a resume's
  `resumed_from`, else the launch no spawn has named and whose answer named no child yet, a
  matching `description` first, narrowed by the `subagent_type`/`capability_mode` the spawn repeats.
  `subagent_spawned` names no call, and the CLI spawns in an order of its own (the real 1.0.3 goal
  session, rows 2101–2119), so when two launches remain — two of one description in parallel, which
  that session's engine does with its own agents (fixtures README observation 58) — the child is HELD, writing nothing, until evidence decides
  (`HeldSpawn`, `subagents.ts`): its session's prompt echo (its first `user_message_chunk`, after its
  hooks, is the call's `prompt` argument verbatim — every capture, all 27 model launches of that
  session; `childPromptChunk`: a call whose whole prompt IS the echo wins over an older call whose
  longer prompt it only begins; an echo no candidate's prompt begins or is begun by makes the child
  an agent of its own, as an unexplained spawn — a goal's skeptic spawned while model calls are
  open), a call's answer naming its id, or every other candidate dropping out (taken by another
  child, its answer naming another child, a declined spawn — for a spawn whose description matched
  no candidate, only once its echo has begun, since it may be none of them). Joined to "the oldest"
  at once, as before, a child that belonged to the newer call was swapped with the other one between
  their calls' rows for good. Only when one of its rows must be routed first (never seen: nothing
  but hooks precedes the prompt), or a Stop, the session's stop or a report naming it comes, does the
  oldest open candidate its echo leaves take it: in practice only for launches identical in every argument, whose
  rows read the same on either agent. A launch a spawn already took learns no id from its answer, so
  no call ever becomes two children's. A spawn no launch explains is an agent of its own under its id, and a
  `resumed_from` with no call behind it — a goal engine resuming its skeptic — relaunches the
  source's ended row under the resume's own id (`relaunchResumedSubagent`), so the resumed run's
  answer is the agent's result (`subagentSpawned`). `subagent_progress` is its
  heartbeat — about every ten seconds and after each of its tool calls: a STATUS-LESS
  `task.progress` with its counters (a heartbeat must never reopen an ended run) that re-arms its
  liveness hour. `subagent_finished` is its end, every way it ends — its own answer (`completed`,
  `output`), a kill, a Stop's `session/cancel`, a cut call (`cancelled`, `error`) — once, with its
  clean `output` as the result and its counters as usage; the call's `SubagentCompleted` answer a
  millisecond later, a poll or a kill answer end it only when that end never came. A `background:
  true` launch (its answer is a `Text` naming the id) and a foreground run the CLI moved past its
  await budget (fixture 22: "Subagent took longer than the foreground budget and was moved to the
  background…") go on without their call: `task.updated {isBackgrounded: true}`, once. A foreground
  call a Stop cuts does NOT go on: the CLI cancels its child with the turn (fixture 23,
  `subagent_finished {cancelled}` 42 ms after the cancel) — the "caller gone; auto-backgrounding"
  line in the binary is not what a `session/cancel` does, and `endTurn` sends nothing to the
  background. Result texts drop the `<subagent_meta>`/`<subagent_result>` blocks the CLI appends for
  the parent model (`subagentAnswerText`). (3) **A child session's frames are its agent's own rows,
  never the parent's.** They reach the stdio client under the child's `sessionId` (fixture 15: its
  thinking, words, tool calls, background tasks, turn ends, hooks, queue and catalog): the adapter
  routes them by session (`childSessionUpdate`, `childXaiUpdate`) — its calls, words and thinking
  become the agent's rows (`agentId` on the envelope and on an item's payload, on the turn live when
  each STARTED, a turnless segment named by its own item id so its own `item.completed` closes it —
  ids that name the child session too, so a resume, a new child session under the same task, speaks
  in messages of its own instead of streaming into the first run's), its background tasks the
  agent's own (`agentId` = the agent: the registry counts them through it — until the agent ends,
  when each one it left is re-stamped with itself under its own tracked status — a resting one is
  not re-armed, one the CLI revived gets its own start row again — and a running one counts on its
  own until its own end, `orphanAgentTasks`), and its context size, turn usage, catalog, title,
  mode, model, hooks and self-resolved interactions touch nothing of the parent's — a child's
  `_meta.totalTokens` moved the parent's meter, its `turn_completed` usage replaced the parent's
  turn usage, its `background_tasks` (which lists its own tasks only) ended every parent shell as
  "dropped out". Prompt ids, the queue and MCP reports are read off the parent's session only
  (`isParentSession`). (4) **Background tasks end by the CLI's own report.** `_x.ai/task_completed`
  is a shell's or monitor's end — its `task_snapshot` (twenty fields: `exit_code`, `signal`,
  `explicitly_killed`, `output`, …), in the session that owns the task, before its snapshot says so
  (`taskCompleted`: a kill is `stopped`, else the exit code, else a signal is `failed`). The poll
  and kill answers are T3's shapes, now captured: `TaskOutput {Result | MultiResult: {mode, results,
  summary}}`, each `{task_id, command, status, exit_code, started, ended, duration_secs, output, …}`
  (a running entry's `output` is advice to the model, not output), and `KillTask {Result: {task_id,
  outcome: "killed", message}}`; `explicitly_killed` / `kill_result_delivered` are snapshot fields,
  never a kill answer's. The other outcome, `already_exited` (captured 2026-09-26, fixture 27:
  "Task had already completed" / "Subagent already completed", no status, no exit code), means the
  kill found the task done: its end was reported first and the answer adds nothing, and a run whose
  end the adapter never saw reads `completed` — never `stopped`, nobody stopped it (`killEnd`). A
  monitor (fixture 20) starts from `_x.ai/task_backgrounded` (it carries `monitor_description`) or
  its call's `Monitor` answer (`{type, taskId, timeoutMs, persistent}`, T3's reader), is typed
  `monitor` (the registry's monitoring bucket), reports each line by `_x.ai/monitor_event` (a
  `task.progress`, replaced in place, re-arming it), and ends by `task_completed` with its LAST line
  as the summary. Answers between turns count, on the turn the run started in, and a run already
  ended gets no second end (`taskAnswers`). (5) **The CLI's own prompts get turns**
  (`prompt-queue.ts`'s `GrokWakes`, which the session and the capture-replay driver both run;
  `session.ts`, `onQueueChanged`, `onPrivateUpdate`). A background subagent's end, a monitor's line
  and a monitor's end wake the agent: the CLI runs a prompt of its own (`subagent-completed-<id>`,
  `notifications-<uuid>`, `task-completed-<id>`) — the `runningPromptId` the parent's
  `_x.ai/queue/changed` never listed in `entries` (every client prompt is listed first) — and
  streams the parent's reply under it, with no RPC of ours and no `prompt_complete`; its
  `turn_completed` settles its turn with that frame's usage, and a user message during it steers it
  (cancel, then our prompt under the same turn id — the cancelled wake's `turn_completed` then
  settles nothing). Before, the woken reply was dropped and the thread read idle. Its turn opens AT
  ONCE when no turn is open (the reply may follow in the same read, and a chunk with no open turn is
  dropped — safe, because `sendTurn` decides steer-or-new under the lock by reading the open turn).
  Announced while a turn is still open — ours settling (fixture 20: 15 ms before the RPC result), or
  ours continued by a steer — it waits for that turn to settle, and so do its frames: **the first
  parent frame naming it starts a hold, and every frame after it — of any session, naming anything
  or nothing — queues behind it** until its turn opens, then comes back through the same gate in
  arrival order. Holding only the named frames reordered the rest: a woken parent's spawn call
  waited while its `subagent_spawned` was handled first, a phantom agent. A held `turn_completed` is
  its prompt's end. **A held frame is never dropped** — an earlier hold deleted them past its bound,
  on a cancel after the waiting prompt had already finished, and at a stop or an exit. Past 256
  (`HELD_FRAMES_MAX`), or when a card opens on the open turn (the parent's approval, or a question
  that rides that turn — never a request answered without a card, nor a child session's), the held
  frames join the open turn in order, and the prompt keeps a turn of its own for what it streams
  after that turn settles, unless it finished by then. A cancel (a Stop, a steer's) ends the newest
  waiting prompt still running: its frames join the open turn and it gets no turn — one that already
  finished keeps its reply and its turn. Our own prompt running (a steer; a prompt sent after a wake
  started during the `set_model` round trip) means every waiting prompt is over and none can get a
  turn before ours, which it continues: their frames join ours, in order. A stop and an exit flush
  them into the open turn before it settles. Held frames that join the open turn keep a bubble per
  prompt: a chunk naming another `_meta.promptId` closes the open bubble (`segments.ts`). **A question rides no turn when its asker outlives the
  open one** (Codex's `questionTurnId` rule; `GrokSession.questionTurnId`): a turn's end dismisses
  every question on it in the log only (`settleStrandedQuestions`), never answering the adapter, so
  a question the CLI's own waiting prompt asked in that window, riding our turn, was swept at our
  turn's end while the CLI stayed blocked and the wake's turn read running with no card, holding a
  deploy's drain; a subagent's child session's question likewise. Every other question rides the
  open turn — the wake's own once its turn is open — and its resolution rides the same. **A
  monitor's wake re-arms it**: its line arrives just BEFORE the wake it causes, so the liveness
  registry's turn-boundary sweep read it as silent through that turn and dropped it at the wake's
  end — a code-only deploy stopped waiting for a running monitor between its lines. A wake's end
  sweeps nothing now (a turn the provider started, see "Drained" means…), but a wake that adopted
  a user's pending turn row reads as the host's and does, so the wake's turn
  opens with a status-less `task.progress` for each live monitor its `runningText` names (a
  `<monitor-event>` block's `task_id`, in any attribute order; `rearmMonitors`), replaced in place;
  only those, since re-arming every monitor at every wake would let unrelated wakes hold a silent
  one forever, and a line's wake naming no live monitor logs one debug line. (6) **An hour, not
  forever**: every row naming a Grok agent carries `livenessTtlMs` (`GROK_AGENT_LIVENESS_TTL_MS`, 60
  min), and the registry counts it "working" — holding a deploy's drain — for at most that long
  after the latest such row; its heartbeat and a poll answering running re-arm it. Only liveness
  lapses: the roster keeps the row and a later end is recorded as any end is. (7) `resume_from`
  spawns a NEW subagent id naming its source in `resumed_from` (fixture 17) and starts the SAME task
  again under the new call (the relaunch contract); the task is found by the subagent id the
  source's result or spawn reported — the UUIDs in it, read without assuming a shape: `rawOutput`
  first, the text only when that names none, never an id the launch's own input, the session, a live
  shell or an ended task names; an id no launch reported (a host restart since) starts a row under
  that id; a resume the CLI refuses fails the call, never the agent; and any launch resets the
  agent's snapshot listing. `hasSubagents` is "this turn launched one" (Codex's rule) — a spawn the
  CLI makes itself while the turn runs (a goal's planner) included — never "one is live". (8) A finished call never starts again: a frame of a call the CLI already ended is dropped
  (`finishedCalls`, 1 024 ids) — a status-less one re-opened the call as a new `item.started` and
  the exit sweep then failed a command that had completed (a monitor's call even streams its output
  AFTER its completion, fixture 20) — but the CLI's end of a call the adapter closed itself (a
  Stop's `failOpenTools`) is its first real end, and lands. Nor does a task whose end the CLI
  reported: its id — a shell's, or every id that named the subagent run — is remembered
  (`endedTasks`, 1 024 ids), and a snapshot entry or a late frame naming it starts nothing. One
  rule, for shells and subagents alike: an end the adapter wrote itself (Stop, the session's stop,
  the exit, a task dropping out of a snapshot unannounced) is not the CLI's word — captured (fixture
  21), a Stop's `session/cancel` cancels a background subagent (its `subagent_finished {cancelled}`
  is then the CLI's final word, with no row) but leaves a background shell running (a poll 12 s
  later answered `running`; the shell even outlived the CLI's exit), and never letting a deploy kill
  running work outranks a duplicate row — so ANY report from the CLI that the task still runs (a
  listing, a start frame, a poll answering `running`, a heartbeat, a monitor's line) counts it live
  again: its own start row is re-emitted, naming its own launch, which the roster reads as a late
  delivery (it keeps the adapter's end), while liveness counts it under its own bound, re-armed by
  further reports — status-less rows, because a status would reopen the roster's row. A report of
  its end is the CLI's end: remembered, no second row, final. A resting (`idle`) listing says
  neither. (`shellReport`, `subagentReport`, `reviveShell`, `reviveSubagent`.) (9) **A snapshot
  emits a row only on a change.** `background_tasks` restates every task of its session whenever one
  of them starts or ends, and a `task.updated` is an appended row: an entry whose status, title and
  output file are unchanged emits nothing, and a changed one exactly one row carrying every change
  (`snapshotChange`) — nothing needs a re-arm from it (a shell is a TTL-bounded watch loop, a
  monitor re-arms on its lines, an agent on its heartbeat). (10) Teardown closes calls before tasks,
  as every adapter's does (Stop, the session's stop, the exit; a run's end closes its child's open
  calls before its task row). A call a `session/cancel` cut is closed by the adapter too: the CLI
  never answers it after the cancel (fixtures 05's `write`, 23's spawn call, 31's question — every
  other call in every capture gets a terminal frame), so the Stop's `interrupt()` fails the prompt's
  own open calls on its turn before the turn settles (`cutTurnCalls`, "Stopped."), and so does a
  steer's cancel ("Cancelled: a new message was sent.") — left open, each read in progress in the
  MCP transcript, took an open-work retention slot and got the next host's "Stopped when the agent
  host restarted." A subagent's own calls are not the prompt's: a cut foreground child's close with
  its run at `subagent_finished`, a background child's outlive the turn. A cut spawn whose launch no
  `subagent_spawned` joined — supervised, the CLI asks before it spawns (observation 49), so a Stop
  that withdrew the spawn's own card — has no child to cancel and no `subagent_finished` to come:
  its agent, started at the call's first frame, ends there, `stopped`, "Stopped before it started."
  (`cutUnspawnedLaunch`; left live it read running and held a deploy's drain for its hour), and a
  late `subagent_spawned` still joins that launch, never a second agent — one narrow, known window:
  unsupervised, when that report trails the Stop by the 7–20 ms of observation 37, the child did
  start, and its frames join the ended agent's drill-in while its row keeps "Stopped before it
  started." (the CLI's own `cancelled` end then adds no row). A question the HOST cancels (a Stop,
  the session's stop, a closed tab) reaches the CLI as its own cancel, `{outcome:
  "cancelled"}`: the host flags it (`respondToUserInput`'s host-only `options.cancel`, which the
  other adapters ignore), because its `{}` is also a user's skip — passed on as an answer, it told
  the CLI the user had answered, nothing. (11) **What the 2026-09-26 captures settled** (fixtures
  25–30, observations 49–53). Supervised, the spawn call itself asks first (`x.ai/tool` kind `task`,
  "Yes, send once" or decline), and a subagent's own tool asks on the PARENT's session, naming the
  child's call: the parent's card, on the parent's open turn, no owner — Codex's collab rule — while
  the call itself is the agent's own row. A run that ends short is `subagent_finished {status:
  "cancelled", error}` every way it does — a kill, a Stop, a declined tool, the runtime's turn cap
  ("max turns reached (limit: 1)"); the CLI never said `failed`, so the run reads `stopped` and its
  `error` is the row's reason (a bare "Stopped" before). A spawn the user declined never runs: its
  call fails ("User rejected the execution for tool `spawn_subagent`", fixture 25 turn 2) with no
  `subagent_spawned` joined to it, so its agent ends `stopped` with that text — never a failed agent
  that never existed — and its start, emitted before the card, keeps the prompt that was declined (a
  start cannot be withdrawn); only a run that started fails. The scheduler (`/loop`,
  `scheduler_create`) reports by methods of its own, `_x.ai/scheduled_task_created` / `_fired` /
  `_deleted` (a peer warning per frame before they were registered — one per fire of a week-long
  loop): each loop is a roster row, typed `scheduled`, which the roster folds to a kind of its own,
  `loop` (`RuntimeSubagent.kind`): chipped as what it is, a metrics line of its own ("scheduled
  prompt"), a live loop `Scheduled` rather than "Working", a settled one's line its end reason,
  never a shell's row, and never counted or token-summed as work (`deriveAgentPanelModel`) —
  background, and `INERT_TASK_TYPES` in the liveness registry, so it never holds a deploy's drain
  (its fires do, each a subagent the CLI spawns itself: an agent row under its own id, whose end
  wakes the parent), and the open tab's own liveness skips it (`deriveBackgroundLiveness` in the
  store), agreeing with the host, the tab strip, the Attention Center, pushes and the
  account-switch gate that a thread with only a loop live is idle. A fire notes itself on the
  loop's row, in place; `scheduled_task_deleted` ends it (`stopped`, `completed` on expiry); the
  session's end closes it, as the loop lives in the CLI's process — an end the user did not choose
  saying so on the row ("Ended when the agent host stopped / the session restarted / the agent
  process exited.", `endedNote`; a bare "Stopped" read as the user's doing), the user's end and a
  Stop saying nothing (whether a Stop's `session/cancel` stops a loop is not captured: a later fire
  notes itself on the ended row, and only the CLI re-creating a loop it ended itself opens a new
  run). A run's launch id names the launch that numbered it (`loop-run:<task>:<launch>:<run>`,
  `<launch>` the first 8 hex digits of the session's launch id): every launch counts runs from 1,
  and a loop a later launch reports again (a CLI restoring it on `session/load` — PLAUSIBLE,
  uncaptured) reused the ended run's id, which the roster read as a late delivery, the row staying
  ended. `/goal` (`goal_updated` on the private channel) is the thread's goal — the goals gotcha
  below; the 2026-09-26/27 build made it a roster row of kind `goal`, which the roster still reads
  (inert, never written again). A genuine `failed` status was not triggered: a
  subagent's model is set only in the account home's `config.toml`, never written. Noise the
  captures showed, silenced: a child's `skills-reload` / `workflows-reload` replies to requests the
  CLI sent itself are not warnings (the ACP peer drops a reply to nothing that carries an id the
  adapter names, `agentOwnReplyIds`); an MCP server's failure is said once until it recovers (the
  CLI re-handshakes the thread's servers at every spawn); the self-resolved-approvals advisory is
  said once, and only where approval cards were promised (never under `auto` / `full-access`, where
  the CLI resolving its own interactions is the mode working).
- **What a Grok CLI starts outlives it. Its helpers are stopped at every end of its session; the
  work its agent started only when the USER ends the session — a deploy must never kill running
  work.** The CLI starts every child of its own — the MCP servers it boots from the host's
  configuration (observation 30) and its shells — in a session of its own (`pgid = sid = pid`; Grok
  fixtures README observations 48 and 55, verified live on 2026-09-26), so `spawnProviderChild`'s
  group signal reaches the CLI alone: after a clean SIGTERM a `bash` with its `sleep` and two MCP
  servers ran on, reparented to init, and every session leaked the MCP servers it had booted. Every
  Grok launch's env carries `ORQUESTER_AGENT_LAUNCH` (`AGENT_LAUNCH_ENV_VAR`), one random value per
  launch — never the injectable `uuid()`: two test files' deterministic ids would stop each other's
  processes — which every descendant inherits (eleven processes carried it in that run). A sweep
  (`GrokSession.stopLeftovers`, `support/leftover-processes.ts`) takes only processes carrying it IN
  A SESSION ONE OF THE CLI'S CHILDREN LED, recorded while the CLI lives, so a process that
  daemonized into a session of its own (agent-browser's daemon, an SSH ControlMaster: host-wide
  helpers a chat may have started first) is spared — verified for agent-browser 0.34: its browser
  daemon, spawned at the first browser command, leads a session of its own under init, Chrome runs
  in the daemon's session, and nothing of the browser stays in the MCP server's (Grok fixtures
  README observation 56); SIGTERM, then SIGKILL past `DEFAULT_KILL_GRACE_MS` to whatever a fresh
  scan still finds, each pid identified by its `/proc` starttime on both sides of the environment
  read and again before each signal, a live session leader against the one recorded — the kill
  guard's rule: never a recycled pid; a zombie is gone. Two kinds, two rules. **The CLI's own
  helpers** — its children while its session opens, which are its MCP servers (fixture 31: all four
  existed as `session/new` answered, none of the user's work had run), recorded as the CLI reports
  them booting (`_x.ai/mcp/servers_updated` and `init_progress` arrive before `session/new` answers,
  `server_status` after it: a CLI that dies after its first MCP report leaves unswept none of the
  helpers it had started by then — whether every server's process exists by that first report is not
  captured, and one that dies before any report still leaves them recorded nowhere), once the open
  answered, and at any end before the session was announced (every child a helper then, never the
  user's work: a host teardown during the open used to record them as work and leave them running) —
  are swept at EVERY end: a restart of a thread that goes on (an account, permission-mode or cwd
  change — Grok switches models in-session), the host's teardown (a drain-restart's included), the
  CLI's own exit (a crash, an open that failed), the user's stop. The host's teardown waits for
  them: both of its `stopAll()` calls — the adapter's abort listener's, then `main.ts`'s — wait for
  every stop in flight, and `stop()` lets the consumers read what the stops queued before the
  orchestrator stops consuming (`host-teardown.test.ts`; the second call used to return at once, and
  the process exited with the sweep unsent and the closing rows unwritten — Codex's stream, too,
  closed before its teardown rows). There the helpers' grace is 1 s
  (`HOST_TEARDOWN_SWEEP_GRACE_MS`), well inside the SIGTERM path's 3 s backstop; a CLI that ignores
  SIGTERM itself spends its own 2 s first, and the backstop can then cut the helpers' SIGKILL — a
  helper that ignored SIGTERM too runs on, a marked orphan Settings → System lists (a deploy's
  `/stop` has no such backstop). **The work its agent started** — its shells, the dev servers they
  run — is swept ONLY when the user ends the session: the session stop command or a closed tab
  (`stopSessionInternal` passes `stopSession(…, {endedByUser: true})`; the MCP's `stop_session` and
  `close_session` are that command and that close) — recorded FIRST, before anything reaches the
  CLI: the orchestrator calls the adapter's `prepareUserEnd` before it answers the session's cards
  with its cancels (a cancel can end the CLI, and a CLI already gone gets no `stopSession`), which
  records them while the CLI lives, remembers them in `leftover-work.json` and marks the end as the
  user's; the stop that follows records again as it begins. They are swept by a sweep of their own
  (`stopTaskLeftovers`), so a CLI exiting in the middle of the end (on its card's cancel, say)
  cannot hand it a helpers-only sweep: its exit, marked the user's end, sweeps them itself and
  closes them `stopped` with no "Left running…", and the thread's `sweepEndedSession` finds them too
  (until 2026-09-27 the cards were answered first, and such an exit read as a crash) — and on an
  open that failed, where nothing of the user's has run. Never at a deploy's teardown or a restart:
  the drain waits for live work only within its bound (a watch loop's TTL, an agent's hour), and a
  dev server started in a Grok chat must survive every deploy that comes after it. Never at a crash
  either (no user ended anything). There it runs on as a marked orphan, listed and killable in
  Settings → System, and — at a deploy's or a restart's end, and at the CLI's own exit — never
  silently: its task's closing row says so — "Left running when the agent host stopped / the session
  restarted / the agent process exited — stop it from Settings → System." (`leftRunningNote`),
  marked `leftRunning` on the row and the roster entry — the one summary a stopped shell's row shows
  in place of a bare "Stopped"; any other completion summary (the CLI's stop sentence, a killed
  shell's output line) never replaces it. A HOST that crashed (an OOM, a SIGKILL) ran no teardown
  and wrote no such row: the next host's first load closes the task with the generic `stopped` row
  of `leftoverWorkClosings` ("Task stopped", `orchestration/leftover-work.ts`), which cannot tell
  work that runs on from work that died — the process is still listed and killable in Settings →
  System. Nor is it forgotten: each launch's task sessions — recorded as the CLI reports the work (a
  shell's, a monitor's `task.started`: nothing can be read off a CLI that crashed) and again at
  every end, while it lives — are kept in the thread's `leftover-work.json` (SID, leader starttime,
  launch id; the last 8 launches; 0600, atomic, written only while the thread's directory exists (a
  late record must not raise a deleted thread), the adapter's own file, never `binding.json`;
  `support/leftover-work.ts`), so a LATER user end — the session stop command or a closed tab, live
  session or not: `stopSessionInternal` calls `AgentAdapter.sweepEndedSession` either way — sweeps
  what every earlier launch left, with the same identity checks. A Claude chat's background shells
  outlive their session the same way — the SDK closes the Claude CLI's stdin and SIGTERMs it 2 s
  later, before the CLI's own 5 s wind-down would stop them, and they run on under init
  (`bun run dev`, `stripe listen`, `vite` of closed Claude chats, live on the owner's host on
  2026-09-26). An open that fails stops its CLI now too: a `session/load` the CLI refused (a cursor
  it no longer knows) left it running outside the adapter's map, holding its pipes. It adds no row
  of its own either: the start's rejection is its whole report, which the host writes — an exit row
  besides it read as a crash of a session that never ran (`GrokSession.announced`) — and a CLI that
  ends after `session/new` answered but before the session is announced (on the open's
  `session/set_model`, say) fails the open with its exit rather than being announced ready, dead. A
  work process whose shell had exited before the stop is in no recorded session and stays running; a
  process that scrubs its environment (`env -i`, `sudo`'s `env_reset`) escapes. A Stop kills
  nothing: its `session/cancel` leaves the CLI — which owns them — running (fixture 21). Linux-only
  (`/proc`); elsewhere the sweep reads and signals nothing. **Settings → System reads the same
  marker**: a process of the daemon's own uid that no root reaches, whose parent is init (or gone)
  and that carries any launch's marker is a root of its own — listed under the chat its
  `ORQUESTER_SESSION_ID` names, and a legal kill target (`launchedOrphans` in `system-status.ts`),
  what it started coming with it as its descendants — so the work a session end left running, and
  whatever a crashed host never swept, is in reach. A marked process whose parent still runs outside
  every root is that parent's, never a root: no marker makes it ours — nor is one a subreaper
  adopted (`systemd --user`, a container's non-pid-1 init; the kill-guard gotcha). Every adapter's
  launches carry the marker (next bullet); only Grok's sweep by it.
- **Every provider launch carries a launch marker; only the Grok adapter sweeps by it.** The host's
  `buildEnv` (`agent-host/main.ts`) stamps `ORQUESTER_AGENT_LAUNCH` on every provider child's
  environment through `buildProviderEnv`'s required `launchId` — one `randomUUID()` per call, and
  every adapter builds one env per launch: the Claude CLI the SDK spawns for a thread, each Codex
  `app-server`, each OpenCode `serve` (one per project), each Grok CLI (whose session stamps its own
  value over it), and the probes — set last, so no launcher env shadows it. Every process a provider
  starts inherits it, so Settings → System reaches what outlives its provider (a Claude chat's
  background shells run on under init after its CLI is gone — `bun run dev`, `stripe listen`, `vite`
  on the owner's host on 2026-09-26) exactly as it reaches a Grok chat's: listed under the chat its
  `ORQUESTER_SESSION_ID` names, killable, never swept. For Claude, Codex and OpenCode it is a marker
  and nothing more — no adapter but Grok's records sessions or sweeps; a sweep for another adapter
  would need its own evidence of what its children are and its own ruling on when the user's work
  may be stopped (the Grok bullet above).
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
  **Grok** stamps the handshake's window onto every row including the per-chunk ones, and reads
  the parent session's chunks only (a subagent's child session streams its own `_meta.totalTokens`
  under its own session id, which moved the meter until 2026-09-25); **OpenCode**
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
  A continuing Codex goal refuses the switch too (`Pause the goal before switching accounts.`; a
  goal a deploy holds, in words of its own), and a switch that applies carries the goal to the new
  home (`carryGoal`) — the Codex goal gotcha below.
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
  picker the composer's rewind control does. Which row is "the last compaction marker" is ONE rule,
  `isSettledConversationCompaction` (`packages/api/src/agent-chat/compaction.ts`): a
  `context-compaction` row or the legacy `thread.state.changed {state:"compacted"}`, settled (an
  unreadable state is), and never a subagent's own (a non-blank `agentId` on the row or on its
  payload). The thread index's `markers` rows behind a history page's `rewindable` and the MCP's
  `revert_session` call it; the GUI's window gates compose the same parts (`isCompactionActivity`,
  `compactionMarkerState`) over the parent timeline, whose filter also drops `timelineBypass` rows
  (`rows.logic.ts` `isCompactedMarkerEntry`, `history.logic.ts` `hasSettledCompaction` — a change to
  the rule must be mirrored there). They used to disagree; the index derives rows by it, so changing
  it bumps `INDEX_SCHEMA_VERSION`, and the fold's retention exempts every parent row
  `isCompactionActivity` names, so changing that part bumps `FOLD_SNAPSHOT_VERSION` too. Two more
  things that were bugs: the compaction marker — either spelling, by `isCompactionActivity`; the
  legacy one was evicted like any row until `FOLD_SNAPSHOT_VERSION` 3 — is exempt from the parent's
  500-row activity window (a busy thread evicted it in minutes, and the gate then offered every
  pre-compaction message; an agent's own marker stays an ordinary row of its window), and Claude's
  "compacted in between" check is decided by the
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
- **Goals are provider-owned; Orquester mirrors them and never runs its own loop.** Claude, Codex
  and Grok each run their own goals and the host never prompts toward one by itself — goal STATE
  only ever comes from what the provider reports
  (`docs/superpowers/specs/2026-09-24-agent-goals-design.md`). One path for all three: an adapter
  emits `thread.goal.updated` (`GoalUpdatedPayload {goal, change, previous?}`,
  `packages/api/src/agent-chat/goal.ts`), ingestion writes ONE `goal.updated` activity per event
  (none for a `HISTORICAL_RAW_SOURCE` one), and the fold's `goal` is the last such row that parses —
  untouched by retention, `thread.reverted` and history pages, because it is the provider's state,
  not the conversation's. It rides the snapshot as `goal`, and the tab summary as `goal {objective,
  status, continuing}` only while the goal is unfinished; that new fold field moved
  `FOLD_SNAPSHOT_VERSION` (4 on the goals build, whose 3 was the legacy compaction marker's
  retention; 5 since the merge with the open-work build's own 4). Every goal adapter
  remembers the last goal it emitted, seeded from the fold (`StartSessionInput.knownGoal`), emits
  only real changes (`sameGoalState`) and throttles `change: "progress"` to one per 30 s itself —
  ingestion does not coalesce them. A `progress` tick
  is hidden from the timeline (`isHiddenGoalChange`) and written under ONE stable id per thread
  (`goal-progress:<threadId>`, `ingestion/message-ids.ts`), replaced in place rather than spending a
  slot of the 500-row window on every tick, and the thread index skips its text. What a provider
  supports rides `capabilities.goals` (`command`, `actions`, `continuesAcrossTurns`), and the
  snapshot registry overlays the adapter's live `capabilities` on every row it serves — cached,
  pending or probed (`orchestration/provider-snapshots.ts`) — so a row cached before `goals` existed
  still carries it. **Claude**'s goal is a session Stop hook judged by a small model, and a goal
  that is met, found impossible or cleared by an unrecoverable error prints NOTHING on stdout: only
  a `goal_status` attachment row in the CLI's transcript records it, and that row lands about 100 ms
  AFTER `result` (queued for the store's write timer; an SDK session flushes first only under
  `CLAUDE_CODE_EAGER_FLUSH` / `CLAUDE_CODE_IS_COWORK`, neither ours to set). So after every `result`
  while a goal is unfinished the adapter reads
  `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<cliSessionId>.jsonl` incrementally, through a locator of
  its own (`adapters/claude/goal-transcript.ts` — the history reader's `getSessionMessages` never
  returns an attachment), and reads again ~0.3 s and ~1.5 s after a turn end that evaluated but
  found no verdict (`GOAL_VERDICT_REREAD_DELAYS_MS`): one read at `result` missed the verdict in the
  normal case. Walks run one at a time; a goal epoch moves only on real stdout goal news, never on a
  no-op frame or a transcript read, and a walk whose epoch moved ends without reading, so a slow
  read never resurrects a cleared goal. The evaluation is **skipped** whenever background work is
  live at turn end, and a chat session (SDK, non-interactive) has no idle check-in, so the goal is
  next judged only when a later turn ends with nothing running in the background; the adapter
  reports `phase: "waiting-background"` meanwhile — expected, not a stall (observed live: two turn
  ends under running subagents, no `goal_status`, goal still active). The SDK types an `active_goal`
  feed for met/not-met, but the CLI writes it only in remote mode (`CLAUDE_CODE_REMOTE` — never set
  it, it flips 183 remote-mode code sites); it is recognised, never a `runtime.warning`. And a
  never-streamed `<synthetic>` assistant frame (every local-command output, `Goal set: …` included)
  completes its text at once: parked until `result`, the confirmation used to appear only when the
  whole goal run was over. The goal's `Stop hook feedback:` and `Goal check-in: «…` frames —
  synthetic `user` frames — become `checked` / `progress` updates and never render as user messages;
  feedback from any other Stop hook is unchanged. **Grok** runs the whole goal inside the prompt
  that set it (planner, worker rounds, verifiers, summarizer) and reports it as xAI `goal_updated`
  session updates, which `GrokGoalTracker` (`adapters/grok/goal.ts`, held by the normaliser)
  mirrors as the thread's goal — never a roster row; the 2026-09-26 build's roster kind `goal`
  survives only to read the rows that build wrote. The run's other traffic is the adapter's
  captured vocabulary (the Grok bullets above: the planner, workers, skeptics and summarizer are
  agents the CLI spawns itself, roster agents under their own ids; a shell's or monitor's end is
  `task_completed`) plus, read off 1.0.3 sessions, `retry_state` — one invisible heartbeat per retry
  episode, the parent's only — and `compaction_checkpoint`, nothing (fixtures README observations
  53, 57, 58). 1.0.34's `/goal clear` answers `goal_updated {status: "cleared"}` with every id and
  text emptied and no `last_event` (fixture 30), which the tracker reads as the level
  `goal_cleared` is — before, the chip kept the goal the user had cleared. The planner runs under
  `phase: "executing"` with a `planning: true` flag, absent once the plan is written (1.0.3 and
  1.0.34 alike), which the tracker shows as the phase `planning` (`phaseOf`; on a phase other than
  `executing` the frame's own stands) — `Goal · planning` on the chip, `phase` in the MCP's
  `chat.goal`. A phase move is a hidden `progress` the 30 s throttle never holds back: 1.0.34
  sends no goal frame while the parent works the goal after its plan, so a held-back end of
  planning read "planning" for the whole run. A Grok goal active at a
  host restart keeps reading active until the provider's next goal frame or the next load's
  reconcile: the adapter invents no provider state. A new
  `not_achieved` verdict is a `checked` row (`Goal check <rounds>: not met — …`) whose `lastCheck`
  is the verdict's own text, `Verification: not achieved (attempt n of m)` — the attempt dropped
  when either count is unknown — and never `last_event_detail`, which on a verdict frame is still
  the worker's own round summary. Replayed `goal_updated` rows emit nothing; once the session is up
  the provider's last state is compared with the fold's and at most one update goes out, live —
  `restored`, `cleared`, `achieved`/`failed` or `progress` — but a `session/load` that replayed no
  goal rows says nothing (absence is not "cleared"), while a fresh `session/new` has no goal by
  definition. A replayed goal's user message is a ~6 KB `<system-reminder>` block (`A goal has been
  set: …`), not what was typed; it is shown as `/goal <objective>`. **The watchdog**, for every
  adapter: a Grok goal turn can be silent for 10–20 minutes while its verifiers run, past the
  10-minute idle window, so the host's turn watchdog widens to 60 minutes while the fold's goal is
  `active` (`TURN_LIVENESS_WINDOWS.goalMs`, `isGoalActive`), never sleeping past the normal window
  on the goal's word — every wake re-reads it. **OpenCode has no goal** — an owner decision: no
  `goals` capability, no events, no chip; `/goal` stays `F*`, forwarded only if its `command.list`
  has one.
- **A continuing Codex goal is work, even between its turns.** Codex drives continuation itself:
  while a goal is `active` the app-server starts a hidden-prompt turn at every idle point, which the
  fold adopts as provider-initiated. The goal is **continuing** (`goalContinuingNow`,
  `orchestration/orchestrator.ts` — ONE predicate for the summary, the account-switch refusal and
  the `/compact` advice) while it is `active` on a `continuesAcrossTurns` adapter AND either a goals
  §5.5 resume mark is pending, or the session is live with a turn running or within
  `GOAL_CONTINUATION_GRACE_MS` (60 s) of its last turn settling or its session (re)starting — the
  grace keeps a continuation that never starts from reading "working" forever. While it is, a
  settled turn is not "finished": the ladder's `goal-continuing` rung (below approval, question,
  `starting` and a running turn) raises no finished stamp and no push, and the `error` rung yields
  to it — Codex blocks the goal on a turn error, and that update ends `continuing`. **Deploys**
  (goals §5.7). It never feeds `backgroundWorkThreadIds`, but its turns follow each other within
  milliseconds, so `activeTurnThreadIds` is almost never empty and a code-only deploy's drain would
  wait for the whole goal. So while a version restart is pending and the drain is blocked, the
  supervisor's every re-evaluation (a settled turn, background work ending, the 15 s health tick)
  sends `POST /goals/hold` (`requestHoldGoals` → `holdContinuingGoals`), a lease the host keeps for
  `GOAL_HOLD_LEASE_MS` (120 s) past the last request. Once the host's own blockers are ALL goals it
  can hold, it holds every continuing goal on a live session: the head field `goalHeldForHandover`
  FIRST (written before the pause, cleared again if the pause does not land — a crash in between
  must leave a mark, never a paused goal nobody resumes; a pause its own stop cuts short keeps the
  mark, since the request may have landed), then `goalCommand {kind:"pause"}` (which
  stops only the NEXT continuation — the running turn finishes), then one `goal.status` row with
  `payload.heldForUpdate` (the MCP's `/goal` answer wait skips such rows); and it keeps reading the
  goal as continuing (no "finished", no push). Nothing new is held while other work blocks the
  drain (background work anywhere, a held goal's own thread's included, or a running turn on a
  thread whose goal is neither held nor holdable), and a held goal idle behind such work for
  `GOAL_HOLD_IDLE_MS` (3 min) is released until goals are the last thing in the way again. The turn
  settles, the drain goes ahead, and the next host's reconcile takes the field as a resume mark:
  it resumes the session and then the goal. Every resume of a held goal is CONDITIONAL
  (`goalCommand {kind:"resume"}, {onlyIfPaused: true}`): the fold trails Codex — a set's own update
  trails its reply, and a host can stop before it lands — so Codex's REPLY to a `thread/goal/get`
  decides (not even the adapter's tracker, which a stale progress notification can have set back
  to `active` meanwhile); a goal Codex does not hold paused is left alone (`notPaused`, no row). An
  expired lease (the deploy withdrawn) resumes what the host held, starting a session whose
  provider died first; a resume that does not happen says so in a row (`… Send /goal resume to
  continue it.`). The user's
  own `/goal` (but `status`), Stop or session stop releases the thread for the rest of the lease
  and resumes nothing. The GUI names a held goal (`isGoalHeldForUpdate`: `Goal · paused for
  update`, info tone) rather than showing it as the user's own pause, and the MCP flags it
  `heldForUpdate`. The daemon never awaits a hold request (one in flight at a time), so boot
  adoption does not wait on the host's answer. A host from before the hold answers the route with
  a 404 and cannot pause a goal: once Codex goal loops are all that block its drain (turns with
  no `userMessageId`, each starting within 3 s of the last one's end, read off the host's own
  `{kind: "snapshot", thread}`), the supervisor stops each goal thread's session while its turn is
  young (`LEGACY_GOAL_TURN_BOUNDARY_MS`, 45 s — the 15 s health tick is what re-evaluates in a goal
  loop), and the replacement resumes those sessions without a turn (`POST /goals/resume-sessions`)
  — Codex continues each goal. A stop that
  comes anyway (a manual `POST /api/agent-host/stop`)
  marks every goal that continues on a live
  session with a resume cursor — no project opt-in, the goal is the opt-in — as the head field
  `resumeGoalAfterRestart`, and the next host resumes that session after the gate WITHOUT sending a
  turn: Codex continues by itself. The mark is cleared on success, on failure, by the user's own
  session stop and when the thread cannot even be loaded; it is kept when a stop cuts the resume
  short; and `continuing` stays true while it is pending, whatever the session reads — after a
  handover it may read `stopped` or `error`, which the resume recovers. **Stop** pauses the goal
  FIRST: the host's `goalCommand {kind:"pause"}` (no options, bounded at
  `AGENT_HOST_DEADLINES.goalPauseMs`) runs before any card is cancelled — a Codex card `cancel` ends
  the turn by itself, and an active goal starts the next one at once — then the host re-reads the
  active turn and interrupts it; a stale Stop still pauses, and interrupts the running turn only
  when the provider started it. A goal set going a moment ago — a host resume, the user's own
  `/goal resume` — still reads `paused` until Codex's update lands, and reads continuing meanwhile
  (`goalResumedAt`, `goalJustResumed`); a Stop in that moment pauses it too (`resumeInFlight`). An interrupt alone leaves the goal active and the next continuation
  starts at once (openai/codex #28104), which is also why the adapter's own `interruptTurn` pauses
  an `active` goal before `turn/interrupt` — the host watchdog's stall interrupt included. On Codex
  that watchdog owns a goal's turns: the adapter's own idle watchdog stands down while the goal is
  active, and the host's arms lazily on the first live `turn.started` of a turn it did not send.
  **`/goal`** is parsed by the HOST (`parseHostGoalCommand` in `orchestration/slash.ts`, right after
  the `/compact` check, only where `capabilities.goals.command === "host"`) and run as
  `thread/goal/*` through the adapter's `goalCommand`: the host records the user message — and a
  model picked with it, handed on as `{modelSelection}`, which Codex applies with
  `thread/settings/update` before the goal request — starts no turn, and answers in a `goal.status`
  / `goal.command.failed` row; the goal itself still moves only on the adapter's
  `thread.goal.updated`. It used to reach the model as prose. It is refused while a compaction runs
  or turns are queued (`Wait for the compaction to finish before changing the goal.`), and the
  client sends it at once, past the follow-up queue and past an open approval or question card.
  **Accounts.** Goals live in `goals_1.sqlite` under the thread's `CODEX_HOME`, and managed account
  homes share only `sessions/`, `config.toml` and `hooks.json`, so an account switch loses them:
  that restart passes `carryGoal` and the adapter re-creates the fold's unfinished goal on the new
  home (`restored`). A switch is refused while the goal is continuing (`Pause the goal before
  switching accounts.` — a provider-started turn under the old account would be killed by the next
  message's restart), and a `/compact` refused for a running turn advises `Pause the goal before
  compacting.` (a compaction in flight, or turns queued behind one, get the plain compaction refusal
  first). A goal a deploy holds is continuing too but paused already, so neither asks for a pause:
  the switch is refused with `GOAL_HELD_SWITCH_REFUSAL` (`… Send /goal pause to keep it paused,
  then switch accounts.`; the user's `/goal pause` releases the hold, and a paused goal may
  switch), which the GUI mirrors word for word, and `/compact` gets the plain running-turn refusal
  (a held goal starts no next turn). A stopped or errored session may switch, because pausing it
  would itself resume it and start a goal turn — except one whose resume mark is still pending
  (after a handover it may read `stopped` or `error`), which reads as continuing.

Start here: `apps/daemon/src/agent-host/README.md` (module map + package ownership).

**Orquester MCP** (`apps/daemon/src/mcp/`). `POST /mcp` lets an external agent drive chat sessions
the way the chat GUI does: 31 tools (catalogue, sessions, search, messages, tool output, requests,
waiting, usage, files, todos) and no terminal I/O — terminal tabs are only listed and closed. It is
mounted **only on the HTTP transport** (`mode:"remote"`, behind the global bearer hook; the
unauthenticated unix socket never serves it) as a stateless Streamable-HTTP endpoint with one
`McpServer` per request, a 16 MiB body limit and `405` for `GET`/`DELETE`. Every tool but the kept
todo/file pair is an **in-process client of the daemon's own REST API**: `InjectDaemonApi`
(`daemon-api.ts`) runs every call through `app.inject()` with the caller's own `Authorization`
header, so each route's gates (the create route's claudex model gate, seeded-account gate,
`chat.adapter` check and tab-then-thread order; the proxy routes'
`THREAD_NOT_FOUND`/`HOST_UNAVAILABLE` guards) and error codes are the GUI's by construction, not by
review. Two invariants:

- **Tools never touch services directly — only `DaemonApi`.** No `services.sessions`, no host
  client, no store: the seam's only non-route methods are the attachment upload (over
  `AgentChatService`) and the bus subscription. A route that proves awkward gets a `DaemonApi`
  method; a tool never imports a service. The one standing exception is the kept todo/file pair,
  which reaches `TodoTools`/`FsTools` (`todo-tools.ts`, `fs-tools.ts`) through its `ToolContext`.
- **Waits ride the `Broadcaster`, never sleeps.** `send_message`/`implement_plan` with `wait` and
  `wait_for_session` (`wait.ts`) subscribe to the bus the `/events` clients read and evaluate the
  session summary (`activity` plus the seven chat fields) on every event, with a 10 s list re-read
  only as a safety net, a 300 ms settle window for siblings stamped by one host poll, and the
  request's `close` aborting them; `revert_session` waits (≤ 10 s) for the host's asynchronous
  rewind the same way, re-reading the thread on each bus event about the session, else after 1 s.
  `wait_for_session` compares `activity.needsAttentionAt` with the caller's `after` and hands back a
  `cursor`: a chat tab's `finished` is sticky, so "return what is already flagged" was a busy loop
  in v1. For the cursor to miss nothing, the daemon moves that stamp whenever something new calls
  for the user, not only when the attention value changes (`agent-chat/summary.ts`): a request id
  the previous host poll did not have, or a latest turn whose `completedAt` is later than that poll
  — never a rewind or a replayed history, which land on turns that settled long ago.

**Goals reach the MCP as the GUI shows them** (the goals gotchas above). A Codex `/goal` is the
host's (`isGoalCommandText` + `capabilities.goals.command === "host"`, read through
`parseGoalSupport` — the rules the host and the composer use): `send_message` posts it, waits for
no turn — none starts — but for the host's answer row (a `goal.status`, a visible `goal.updated`,
or a `goal.command.failed` → `outcome: "failed"`; ≤ 15 s once the session is up, half a second for
a pause of a paused goal or a resume of an active one) and returns it as `answer`, and lets it past
an open request as the composer does; with the capabilities unread, a `/goal` is refused rather
than guessed at. A turn wait never ends on a turn that settles
while the goal continues (the `goal-continuing` rung). `read_transcript` shows the timeline's goal
rows (a `progress` tick never), views carry `chat.goal` (with `heldForUpdate` while a deploy holds
the goal) and `supports.goals`, and `update_session` refuses an account switch while the goal
continues — or a deploy holds it — before writing anything.

Addressing: sessions only by `sessionId` (titles are not unique, so there is no title matching);
`project` as the absolute path or `"<workspace>/<project>"`, resolved by `resolveProject()`
(`addressing.ts`) to exactly `<workspacesDir>/<ws>/<name>` inside `fsRoot` — the string
`GET /api/sessions?projectPath=` matches. The tools are deliberately stricter than the GUI in a
few places: `project`, `cwd` and attachment paths must realpath inside `fsRoot`; `accountId` is
family-checked before a create (the daemon silently falls back to the system home); at most 24
running sessions per project; `update_session` refuses a mid-turn model/permission change without
`force`. Like the GUI, `send_message` refuses while a request is pending (the host alone would take
the message as a steer). Like the GUI's "Load older", `read_transcript` reads turns the snapshot's
retained window no longer holds from the host's thread index (`history.ts`: `GET …/history`, at most
5 pages a call, merged under the window by id with the window's copy winning, in log order); a turn
it cannot read whole is named in `unavailableTurns` with a hint, and a failed page is never a tool
error. Like the GUI's "Load full output", `read_tool_output` reads the unslimmed item behind a tool
row's `outputItemId` (`GET …/items/:itemId`) in UTF-8 byte windows; a command answers its whole
output from the places the row's preview reads (`commandOutputText`, one list with
`commandDisplayDetail`), unless the item is stored already cut (`truncated`: an update; a Codex
command's completion, which keeps its `aggregatedOutput` in `data.item` up to 64 KiB and past that
only the head — `COMMAND_OUTPUT_MAX_BYTES`, `adapters/codex/items.ts`; or an OpenCode command's
completion whose output OpenCode cut, which keeps the end its `bash` tool kept behind its note, or
the head the generic `Truncate.output` kept before its own —
`isCutFinalOutput`, `adapters/opencode/state.ts` — a kept part that answers after the join, when
that is empty, as `command-output` with `truncated: true`, the text the GUI's viewer shows:
`storedCommandOutput`, the one rule both follow). A command's output
that exists only as streamed `tool.output` chunks — a Claude background shell's, a running
command's so far — is joined by the host (`GET …/items/:itemId/output`, `store/tool-output.ts`)
and answered with `running`/`truncated`; never a file change's (Claude streams its result text as
`file_change_output`, which is no command's output). The tool asks the host for ONE window
(`?offset=&maxBytes=`, the caller's own, the offset stopped one byte past 8 MiB), cut from the
host store's tool-output cache — a page costs the log's tail, not two whole-log reads and an 8 MiB
body — and trims it to the result's room by the rule it windows a whole text with, so the pages are
byte-identical whichever host cut them; a window outside the host's own rules is `INTERNAL`. A host
from before windows ignores the query and answers the whole join, which the tool windows itself
(`isThreadItemOutputWindow` tells the two bodies apart). `read_transcript` offers such a call's
latest command row as its `outputItemId` — in a drill-in, when retention evicted the call's rows, an
entry built from its latest chunk — and a host from before the route (its route-miss 404) falls
back to the item's own text, never an error. A result is one JSON object capped at 60 000 bytes
(`result.ts`); every tool that can outgrow it bounds itself first and says what it cut (`truncated`,
`optionsOmitted`, `subagentsTruncated`, `filesTruncated`, …), so `ok()`'s byte cut is only the last
resort. An error is `<CODE>: <message>`, the message capped at 4 000 code points. `server.ts`
replaces the SDK's `tools/call` handler (public `server.setRequestHandler`) so a schema refusal
answers the same `<CODE>: <message>` envelope as every other error, and it parses the arguments
strictly (`argumentsSchema`, `.strict()` at the top level): an argument name the tool does not take
is refused and named, never silently dropped — `tools/list` already advertises
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
  `pnpm.onlyBuiltDependencies` allows builds for `better-sqlite3`, `electron`, `esbuild`,
  `node-pty` (`better-sqlite3`: see the agent-chat gotcha on it).
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
  process** (the route passes the proxy's live child pid via the service's `protectedPids` hook — on
  a no-tmux host cliproxy is a daemon child and would otherwise be a legal target). Everything else
  must descend from a daemon-tree root (its own children plus every `orq-*` tmux pane pid, the agent
  host, and every orphan of the daemon's uid carrying an agent-host launch marker — what a provider
  CLI left behind, see "What a Grok CLI starts outlives it") or it's `PROCESS_NOT_MANAGED`. An
  orphan is rooted only when init adopted it or its parent is gone (`launchedOrphans`): **one a
  SUBREAPER adopted is not** — `systemd --user` when the desktop app runs inside a user session (it
  is `PR_SET_CHILD_SUBREAPER`, so every orphan of that session goes to it, not to pid 1), or a
  container's non-pid-1 init — so there Settings → System neither lists nor kills what a provider
  left running; it is found (and stopped) by hand, or by ending the chat's session, which sweeps a
  Grok chat's work. The guard is two-pass on `/proc` starttime, never on the shared 2 s snapshot
  cache: once the first SIGTERM lands, children reparent and `ppid` stops being an identity, so pass
  one records starttimes while the tree is intact and pass two re-checks each one immediately before
  signalling (a recycled pid must never get the signal). Everything under `/api/system/*` is
  Linux-only by construction (all `/proc`); off Linux each route answers `supported: false` with
  zeroed data, the same host-gating shape `/api/fs/capabilities` uses.
- **The right rail delivers through the composer, never around it.** Its target is the visible
  chat tab (`activeChatTab()`, the focused grid cell). **Insert** is `insertComposerText(…,
  "cursor", {focus: true})` — at the caret, then focused with the caret after it. **Send** is
  `submitComposerText` (`composer-bridge.ts`), decided by the pure `planExternalSubmit`
  (`composer-submission.ts`) exactly as Enter decides for that text as the whole draft: a bare
  `/plan`/`/default` switches the mode where the toggle shows; the composer's own guards over the
  TRIMMED text (a revert, a send in flight — the composer's send registry, read as it acts:
  `isComposerSending`, as Enter does —, an open approval or question card — a host `/goal`
  excepted, the provider-command refusals, the length bound); the thread's mode and model; and the
  follow-up preference — a running turn QUEUES it or is STEERED by it — with an identical queue
  inside 1 s refused as a double click's twin, and a failed send coming back into the draft.
  History's "Rewind to here" waits for a send in flight, as the composer's picker does
  (the panel reads the composer's send registry — `useComposerSending` for the button, `isComposerSending`
  fresh as the rewind runs — and hands it to `rewindBusyReason` as `isSending`). The goal chip's `sendText` is a
  different path (always steers, never returns to the draft — not even from the tab's outbox
  after a reload, which it rides as `generatedPrompt`); do not route the rail through it.
  Saved-prompt `{variables}` render on the client at click time
  (`lib/saved-prompts/variables.ts`): only `PROMPT_VARIABLES`' known names render, `{{name}}` is the
  literal `{name}`, anything else — code braces included — stays as written, and the git reads
  happen only for the variables a body uses; a failed read inserts nothing. `{diff}` is scoped to
  the project directory, `{changedFiles}` is `/api/git/status`'s whole-repo list (the Git tab's) —
  identical when the project is its repo's root. The editor modal is mounted ONCE
  (`SavedPromptEditorHost`, opened through `saved-prompts/editor-bridge.ts`), so History's "Save
  as prompt" reaches it from either panel.
- **The rail owns the keys typed into it.** The chat's chords (the composer's Ctrl/Cmd+E, +/,
  +Shift+M, +Shift+Enter, the timeline's Ctrl/Cmd+J) are capture-phase `window` listeners that no
  surface can stop, so they stand down for a key whose target is inside a root marked
  `data-keyboard-surface` (the dock, a phone's section, the prompt editor) or any `aria-modal`
  dialog or sheet (`insideKeyboardSurface`, `lib/keyboard-surfaces.ts`); the chat's own popovers
  are menus, not modal, so a chord still moves between them. The question card's digits stand
  down inside those AND inside any menu or listbox (`insideKeyboardOwner`), as well as under any
  open layer (the shortcut-listener gotcha), so a button focused in a modal, the sheet or a menu
  never answers a question, which cannot be undone. A phone's section (`MobileSections.tsx`: the
  bottom section bar, each panel full screen over the tab content, never replacing `MainView` in
  the tree) holds an open layer for as long as it shows, and its Escape goes back to the tab
  content. The dock also holds an open layer
  (`lib/open-layers.ts`) while focus is inside it, so the chat's Escape (interrupt, Esc-Esc rewind)
  and Ctrl+Shift+A stand down; an Escape nothing inside handled goes back to the composer, and a
  held Escape is ONE press (the textarea answers a repeat with `"hold"` — `composerEscapeAction` —
  or the repeats of an Escape that left the dock would stop the turn). Focus must never be stranded on `<body>`
  while a turn runs — a bare Escape there interrupts it: the dock pulls focus back to its root
  when the element it was on is removed, disabled, hidden or made inert (`focusFellOut`,
  `dock-keyboard.ts`), and `ui/modal.tsx` gives focus back to whatever opened a modal when the
  close leaves it on `<body>` (read at render, before the dialog's autofocus; decided a tick later
  so a StrictMode rehearsal never steals it; an opener that is gone is not revived).
- **Saved prompts are daemon-owned JSON** (`<appdir>/daemon/saved-prompts.json`,
  `apps/daemon/src/saved-prompts.ts`), broadcast on the `saved-prompts` channel
  (`savedPrompt.upserted` / `savedPrompt.deleted`) for every mutation, cascades included. The parse
  is entry-wise tolerant: a record keeps its unknown fields, and an entry it cannot read (a newer
  shape) or an unknown top-level key is written back **verbatim** on every save — never listed,
  never counted — so a rollback never strips a newer record; a change to a field's type or meaning
  bumps the file version instead. The four starter prompts are seeded ONLY when the file does not
  exist — its existence is the marker, so a deleted starter never comes back; a corrupt or
  unknown-version file is renamed aside (`.corrupt-<stamp>`) and never overwritten or re-seeded,
  and a file that merely could not be READ (EACCES, EMFILE, …) is left where it is. While the file
  cannot be written, every mutation answers 503 `SAVED_PROMPTS_UNAVAILABLE` rather than an edit that
  would vanish on restart. `projectPath` is `null` (global) or validated like the recent-projects
  path (`<workspacesDir>/<ws>/<project>`, inside `fsRoot`, an existing directory) and stored as that
  **string**, never a realpath — the client filters by comparing it with its own project path.
  Deleting a project or workspace deletes its prompts once the directory is gone (a failed `rm`
  deletes nothing); archiving does not, and neither does a generic `DELETE /api/fs` (as for
  to-dos).
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
  `insideShortcutBailZone`. Capture phase + `stopPropagation` keep a chord the listener takes from
  reaching the focused surface's own key handling: a Design Mode browser tab forwards every
  keydown to its remote page (`BrowserView`'s `onKey`), and on macOS CodeMirror's emacs-style
  `Ctrl-Shift-a` extends the selection to the line start. (xterm is not the reason any more: the
  installed `@xterm/xterm` 6.0.0 maps Ctrl+letter to a C0 byte only without Shift —
  `src/common/input/Keyboard.ts` — so `Ctrl+Shift+A` never reaches a PTY as `\x01`.) `Ctrl+Shift+A`
  walks a *cursor* through the Needs-Attention group rather than always taking the top row —
  focusing a tab clears the bell/hook `attention` but not the structural `waiting` state, so a
  session parked on a permission prompt would otherwise trap every press. **Caveat: Chrome
  reserves `Ctrl+Shift+A`** for its own tab search, so an installed PWA may never receive it —
  the Attention Center menu is the reliable path. `Ctrl/Cmd+K` matches the physical `code`
  (`KeyK`), survives layouts that rewrite `key`, and only swallows the event when a mounted
  palette actually took it. **`anotherLayerOwnsTheKeyboard()` is the one set of open layers** the
  `Ctrl+Shift+A` cycle, the chat's Escape (the shell's listener and both composer arms) and the
  question card's 1–9 keys stand down for: the store's modals, the palette, and every
  `Modal`/`BottomSheet`/`Dropdown`/`ContextMenu`/`ComposerPopover`/`CommandPalette` open at the
  moment — each registers through `useOpenLayer` (`packages/ui/src/lib/open-layers.ts`;
  `components/ui/open-layer-wiring.test.ts` fails for a portaled overlay that closes on Escape and
  does not) — and the right rail's dock while focus is inside it (`useDockKeyboardLayer`, built on
  `openLayer` because it asks whether a layer OTHER than its own is open). A layer closes on its
  own `document` listener, which a `window` capture handler always runs before, so a layer missing
  from the set loses its Escape to whichever of them acts: the chat's Escape stopped the turn under
  an open output viewer, which stayed up, and under the goal popover it paused a Codex goal through
  Stop. Only the composer's own `@`/`/`/`$` token menu ranks ahead of an open layer: it sits at the
  caret, so the textarea's Escape closes it first. A new layer primitive calls `useOpenLayer(open)`;
  nothing keeps a second list. **Where a key landed is the other axis, and it is target-based.** The
  chat's chords (the composer's Ctrl/Cmd+E, +/, +Shift+M, +Shift+Enter, the timeline's Ctrl/Cmd+J)
  stand down for a key typed inside a `[data-keyboard-surface]` root or an `aria-modal` dialog or
  sheet (`insideKeyboardSurface`, `lib/keyboard-surfaces.ts`) — never for a layer as such, so a
  chord still moves between the chat's own popovers. The question card's digits stand down for
  BOTH: any open layer, and a key typed inside a surface, a menu or a listbox
  (`insideKeyboardOwner`) — an answer cannot be taken back, and each catches what the other misses
  (a menu whose focus stayed on its trigger and the goal popover's non-modal dialog panel only the
  layer; a surface with no layer only its target). The chat's shell leaves alone an Escape typed
  into any editable field that is not the chat's own (`chatEscapeTargetGate` in
  `agent-chat/escape-action.ts`): a rename box, a sidebar field, a terminal or an editor in another
  grid cell keeps its key, with no registration per field. **A held key is one press everywhere**:
  a chord never fires on a repeat (`resolveChatShortcut`), the shell ignores a repeated Escape, the
  textarea answers one with `"hold"` (`composerEscapeAction`), and the dock leaves once
  (`dockKeyAction`). Focus is never left on `<body>` under a running turn, where a bare Escape
  interrupts it: `ui/modal.tsx` gives focus back to its opener, and the dock pulls it back when its
  element goes away (`focusFellOut`). A chat tab's popover — the composer's, the goal chip's, the
  context meter's — closes when the visible chat tab moves away from its own thread
  (`dismissWhenChatTabLeaves`), never when its own tab is the one activated, which in the grid is
  the click that opened it.
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
| Right rail: shell, saved prompts, history & checkpoints | `packages/ui/src/components/right-rail/` (`RightRailFrame`/`RightRailDock`/`RightRail`/`MobileSections`, `chat-target.ts`, `saved-prompts/`, `history/`), `packages/ui/src/lib/{saved-prompts,prompt-history}/`, `apps/daemon/src/saved-prompts.ts`, `packages/api/src/saved-prompts.ts`, `packages/api/src/agent-chat/prompts.ts`, the index's `prompts` query in `apps/daemon/src/agent-host/index/queries.ts` |
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
| Agent chat: fold performance (batch retention, fold caches, the per-task roster, the history bridge) | `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, `packages/api/src/agent-chat/{fold.ts,roster.ts}`, `packages/ui/src/lib/agent-chat/history.logic.ts` |
| Agent chat: lazy boot, fold snapshot, thread index, history pages, search | `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`, `apps/daemon/src/agent-host/index/`, `reconcileThread`/`foldFromDisk`/`readHistory`/`windowBoundary` in `apps/daemon/src/agent-host/orchestration/orchestrator.ts`, `packages/api/src/agent-chat/{fold-snapshot.ts,history-cursor.ts}`, `packages/ui/src/lib/agent-chat/history.logic.ts`, `packages/ui/src/components/command-palette/conversation-search.ts` |
| Agent chat: goals (the provider-owned goal mirror, per-provider goal handling, Codex's host `/goal`, the goal watchdog window, the goal chip) | `docs/superpowers/specs/2026-09-24-agent-goals-design.md`, `packages/api/src/agent-chat/goal.ts`, `apps/daemon/src/agent-host/adapters/{claude,codex,grok}/`, `parseHostGoalCommand` in `apps/daemon/src/agent-host/orchestration/slash.ts`, `decideGoalCommand`/`goalContinuingNow`/`stopContinuingGoal`/`holdContinuingGoals`/`resumeGoalSessionsAfterHandover` in `apps/daemon/src/agent-host/orchestration/orchestrator.ts`, the deploy hold's daemon half in `apps/daemon/src/agent-chat/supervisor.ts` (`requestHoldGoals`, and for a host from before the hold `stopLegacyGoalsAtTheirBoundary`/`legacyGoalTurnOf`), the goal window in `apps/daemon/src/agent-host/{support/deadline.ts,orchestration/turn-watchdog.ts}`, the `goal-continuing` rung in `apps/daemon/src/agent-chat/activity-ladder.ts`, `packages/ui/src/components/agent-chat/status/` (the goal chip) |
| Agent chat: protocol fixtures (read the per-provider `README.md`) | `apps/daemon/test/fixtures/{claude,codex,opencode,grok}/` |
| Orquester MCP (tools, in-process client, waits) | `apps/daemon/src/mcp/server.ts`, `…/daemon-api.ts`, `…/wait.ts`, `…/tools/` |
| Deployment | `deploy/` + `docs/superpowers/specs|plans/2026-06-19-remote-*.md` |
