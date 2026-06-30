# Terminal-control MCP (read/write Orquester sessions) — design

**Date:** 2026-06-30
**Status:** approved, pending implementation plan
**Related:** `2026-06-19-remote-vps-deployment-design.md` (the HTTP transport + bearer auth this rides);
`2026-06-19-remote-phase2-tmux-persistence.md` (the tmux session backend reads build on)

## Summary

A new **in-daemon `/mcp` endpoint** that lets an external coding agent (Claude Code / Claude
Desktop, or any MCP client) **observe and drive** the terminal/agent sessions Orquester already
runs — "look at the Claude in tab X, read what it's doing, type a reply." It exposes a small set
of MCP tools addressed the way a human thinks about Orquester — **`(workspace, project, tab)`** —
on top of the session machinery that already exists (`SessionManager`, `tmux capture-pane`, the
PTY input path, the per-session output emitter).

The work is two thin layers over existing code:

1. A **`TerminalControl` module** (`apps/daemon/src/mcp/terminal-control.ts`) — plain, testable
   functions (`resolveTab`, `readTerminal`, `writeInput`, `sendKeys`, `waitForIdle`,
   `sendAndWait`, `createTab`, `closeTab`) that take the existing `ISessionManager` + `RegistryService`
   + the workspaces dir as dependencies.
2. A **thin MCP server** (`apps/daemon/src/mcp/server.ts`) that maps **11 MCP tools** 1:1 onto
   those functions and mounts on Fastify at `/mcp` (Streamable-HTTP), gated by the daemon's
   existing bearer auth.

Plus one small backend addition (`captureText` on `ISessionManager`, for *clean* rendered text)
and one targeted refactor (export `listWorkspaces`/`listProjects` so both `index.ts` and the new
module share them).

No change to the wire contracts in `@orquester/api` (MCP carries its own JSON-RPC schema), no
change to the desktop/web UI, no new transport — `/mcp` is just another route on the daemon's
existing HTTP server.

## Background

- **A "tab" is a session.** `SessionSummary` (`packages/api/src/index.ts:463`) has an opaque
  `id` (UUID), a renamable `title` (defaults to the registry name, e.g. "Claude", "bash" —
  **not guaranteed unique** within a project), a `kind` (`shell`|`agent`), a `refId` (registry id),
  a `projectPath`, a `status` (`running`|`exited`), and a per-project `order`. Open sessions for a
  project *are* its tabs.

- **Project paths are deterministic.** `listProjects` (`apps/daemon/src/index.ts:2053`) reports a
  project's `path` as `join(workspacesDir, workspace, name)`, and sessions are created with exactly
  that string as `projectPath`. So `(workspace, project)` → `projectPath` is a pure `join`, and
  matching `session.projectPath === join(workspacesDir, workspace, project)` is exact (the same
  identity `closeByProjectPrefix` already relies on — see `index.ts:675`).

- **The plumbing for read/write already exists**, addressed by session id:
  - **Input:** `sessions.input(id, data)` (`sessions.ts:309`) writes raw bytes to the session's
    PTY. Surfaced today as `POST /api/sessions/:id/input` (`index.ts:1539`).
  - **Output (raw):** `sessions.subscribe(id, onOutput, onExit)` (`sessions.ts:388`) streams raw
    PTY bytes; `sessions.scrollback(id)` (`sessions.ts:290`) returns durable scrollback. Surfaced
    as the chunked `GET /api/sessions/:id/output` (`index.ts:1615`) and `/ws`.
  - **Rendered text:** `Tmux.capturePane(id)` (`tmux.ts:213`) returns the full visible + scrollback
    history of a pane via `capture-pane -p -e -J -S -` — **with** escape sequences (`-e`, for
    xterm) and joined wrapped lines (`-J`).

- **Two transports, one factory.** `createServer(...)` (`index.ts:333`) builds a Fastify instance
  used for both the always-on unix socket (`authRequired:false`, `mode:"local"`, `index.ts:252`)
  and the opt-in HTTP transport (`authRequired:true`, `mode:"remote"`, `index.ts:267`). A single
  `onRequest` hook (`index.ts:366`) gates auth: it lets `/ws` self-authenticate, and requires the
  bearer for any URL where `url.startsWith("/api") || url.startsWith("/events")` (except
  `/api/auth/info`) — `index.ts:377`. The credential is `base64("<user>:<bcryptHash>")` as
  `Authorization: Bearer …`, verified in constant time.

- **The daemon never touches tmux directly.** `index.ts` only ever calls the `ISessionManager`
  (`sessions.ts:37`); the manager encapsulates tmux. We keep that boundary: the new clean-text
  read is a method **on the manager**, not a tmux call from the MCP layer.

- **MCP SDK is not yet a dependency.** `apps/daemon/package.json` has no `@modelcontextprotocol/sdk`.
  It will be added (it pulls in `zod`, used for tool schemas).

## Goals

- An MCP client can list workspaces → projects → tabs, and identify a tab by its human title.
- An agent can **read** a tab's current screen + recent scrollback as **clean text** (no ANSI).
- An agent can **write** to a tab: type text (optionally submit), and send named control keys
  (Ctrl-C, Esc, arrows, Enter…) without doing its own ANSI escaping.
- An agent can **drive and wait**: send input and block until the pane settles (or a bounded
  timeout), getting the finished output back in one call — the ergonomic path for "ask the Claude
  in tab X something and read its answer."
- An agent can **create** a new tab (launch a shell/agent in a project) and **close** one.
- It all rides the daemon's existing auth/TLS and works against a local daemon or the VPS.

## Non-goals

- **No new UI.** This is a machine surface; the desktop/web clients are untouched.
- **No new wire contracts in `@orquester/api`.** MCP defines its own JSON-RPC tool schemas.
- **No write guardrails in v1** (allowlists, read-only mode, destructive-command confirmation).
  Full drive was chosen deliberately; `/mcp` does not widen the trust boundary (see Security).
- **No pixel-perfect rendering on non-tmux hosts.** Clean rendered reads need tmux; the local
  backend gets a degraded ANSI-stripped fallback (see Decisions).
- **No streaming MCP output / progress.** Reads are snapshots; "wait" blocks then returns once.
  (MCP progress notifications are a possible future add.)
- **No multi-daemon / remotes fan-out.** One MCP server drives the daemon it lives in.

## Design

### 0. Module layout

```
apps/daemon/src/
  workspaces.ts        ← NEW (extracted): listWorkspaces / listProjects (shared)
  sessions.ts          ← + captureText() on ISessionManager and both backends
  tmux.ts              ← capturePane() gains options (clean text, line range)
  mcp/
    terminal-control.ts ← NEW: the resolve/read/write/wait/create/close functions
    keys.ts             ← NEW: key-name → bytes table + encoder
    server.ts           ← NEW: McpServer with 11 tools; mounts on Fastify at /mcp
  index.ts             ← instantiate TerminalControl, mount /mcp, gate /mcp in the auth hook
```

`TerminalControl`'s only dependencies are `ISessionManager`, `RegistryService`, and
`workspacesDir: string` — so it is unit-testable against a fake session manager, and the same
functions could later back REST routes if ever wanted.

### 1. Clean-text reads — `captureText` on the session backend

`Tmux.capturePane` today is hardcoded for the xterm replay path (full history, **with** colors).
Reads for an agent want **plain** text and an optional bound on history. Extend it, keeping the
existing zero-arg behavior:

```ts
// tmux.ts
async capturePane(
  id: string,
  opts: { escapes?: boolean; lines?: number | "all" } = {}
): Promise<string> {
  const { escapes = true, lines = "all" } = opts;
  const start = lines === "all" ? "-" : String(-Math.max(0, lines)); // -S -  | -S -<n> | -S 0
  const args = ["capture-pane", "-p", "-J", "-S", start, "-t", tmuxName(id)];
  if (escapes) args.splice(2, 0, "-e");        // colors only when asked
  const result = await this.run(args);
  return result.code === 0 ? result.stdout : "";
}
```

- Existing callers (`scrollback()`) pass no opts → unchanged (`escapes:true`, full history).
- `lines: 0` ⇒ `-S 0` ⇒ current screen only; `lines: N` ⇒ last N rows of scrollback + screen.

Add a clean-text method to the backend contract so the MCP layer never imports tmux
(mirrors `scrollback()`):

```ts
// ISessionManager (sessions.ts:37)
/** Clean (no-ANSI) rendered text: current screen + last `lines` of scrollback. */
captureText(id: string, opts?: { lines?: number }): Promise<string>;
```

- **tmux backend:** `this.tmux.capturePane(id, { escapes: false, lines: opts?.lines ?? 0 })`.
  Default `lines: 0` = just the visible screen (what a human sees); the tool exposes `lines` to
  pull more history.
- **local backend (no tmux):** degraded fallback — return the hot ring (`this.buffer(id)`) with a
  best-effort ANSI strip (a `\x1b\[[0-9;]*[A-Za-z]` / OSC regex). Documented as approximate (no
  cursor/reflow emulation). The VPS has tmux, so this only affects desktop-on-Windows/stock-macOS.

### 2. Tab resolution — `resolveTab`

The heart of the `(workspace, project, tab)` ergonomics. Name-first, id fallback, ambiguity is an
error (never a guess):

```ts
// terminal-control.ts
class TabNotFound extends Error {}        // includes the available titles
class AmbiguousTab extends Error {}       // includes the matching {id,title} list

resolveTab(sel: { workspace?: string; project?: string; tab?: string; tabId?: string }): SessionSummary {
  if (sel.tabId) {
    const s = sessions.get(sel.tabId);
    if (!s) throw new TabNotFound(`No tab with id ${sel.tabId}.`);
    return s;
  }
  if (!sel.workspace || !sel.project || !sel.tab)
    throw new Error("Provide tabId, or all of workspace+project+tab.");
  if (!isValidName(sel.workspace) || !isValidName(sel.project))
    throw new TabNotFound("Invalid workspace/project name.");
  const projectPath = join(workspacesDir, sel.workspace, sel.project);
  const tabs = sessions.list(projectPath);
  const matches = tabs.filter((t) => t.title.toLowerCase() === sel.tab!.toLowerCase());
  if (matches.length === 0)
    throw new TabNotFound(`No tab "${sel.tab}". Open tabs: ${tabs.map((t) => t.title).join(", ") || "(none)"}.`);
  if (matches.length > 1)
    throw new AmbiguousTab(`"${sel.tab}" is ambiguous (${matches.length}). Retry with tabId: ` +
      matches.map((m) => `${m.title}=${m.id}`).join(", "));
  return matches[0];
}
```

Every read/write tool takes the selector `{ workspace?, project?, tab?, tabId? }`. The MCP server
maps `TabNotFound`/`AmbiguousTab` to MCP tool errors (`isError: true`) whose message lists the
candidates/ids — so the agent can self-correct by retrying with `tabId`.

### 3. The read/write/drive functions

```ts
// terminal-control.ts — sketches (errors omitted)

async readTerminal(sel, opts?: { lines?: number }) {
  const t = resolveTab(sel);
  const text = await sessions.captureText(t.id, { lines: opts?.lines ?? 0 });
  return { text, status: t.status, exitCode: t.exitCode, cols: t.cols, rows: t.rows };
}

writeInput(sel, data: string, opts?: { submit?: boolean }) {
  const t = resolveTab(sel);
  sessions.input(t.id, opts?.submit ? data + "\r" : data);   // Enter == CR in a PTY
}

sendKeys(sel, keys: string[]) {                              // ["Enter"], ["C-c"], ["Escape","Up"]
  const t = resolveTab(sel);
  sessions.input(t.id, keys.map(encodeKey).join(""));        // encodeKey from keys.ts
}

createTab(sel: { workspace, project }, opts: { refId, title?, cwd? }) {
  const projectPath = join(workspacesDir, sel.workspace, sel.project); // validated
  return sessions.create({ kind: registry.get(opts.refId)!.kind, refId: opts.refId,
                           projectPath, cwd: opts.cwd ?? projectPath, title: opts.title });
}

closeTab(sel) {                          // resolveTab errors on ambiguity → never kill the wrong tab
  const t = resolveTab(sel);
  sessions.close(t.id);
}
```

### 4. The idle engine — `waitForIdle` / `sendAndWait`

Event-driven (no polling): subscribe to the session's output emitter, debounce, hard-cap.

```ts
const DEFAULT_IDLE_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;   // 2 min
const MAX_TIMEOUT_MS = 600_000;       // 10 min ceiling

async waitForIdle(sel, opts?: { idleMs?: number; timeoutMs?: number }) {
  const t = resolveTab(sel);
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const timeoutMs = Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const settled = await new Promise<boolean>((resolve) => {
    let idleTimer: NodeJS.Timeout;
    const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => done(true), idleMs); };
    const hardTimer = setTimeout(() => done(false), timeoutMs);
    const unsub = sessions.subscribe(t.id,
      () => arm(),                       // each output chunk re-arms the idle timer
      () => done(true));                 // session exited → settled
    function done(ok: boolean) { clearTimeout(idleTimer); clearTimeout(hardTimer); unsub(); resolve(ok); }
    arm();                               // start the idle countdown immediately
  });

  const after = sessions.get(t.id);
  const text = await sessions.captureText(t.id, { lines: 0 });
  return { text, settled, status: after?.status ?? "exited", exitCode: after?.exitCode };
}

async sendAndWait(sel, data, opts?) {    // subscribe BEFORE writing so no output is missed
  const t = resolveTab(sel);
  // (same Promise as above, but write the input — data + optional \r — immediately after subscribe)
  ...
}
```

- **`settled: false`** means the hard cap fired while output was still flowing — the command is
  still running. The agent re-invokes `wait_for_idle`/`send_and_wait` to keep waiting. The 2-min
  default just means fewer re-invokes for slow agents.
- Works on **both** backends — `subscribe()` exists on each; only the final `captureText` is
  degraded on non-tmux hosts.
- `sendAndWait` subscribes *before* writing, so the response to its own input is never missed.

### 5. Key encoding — `keys.ts`

A name→bytes table so the agent stays out of the ANSI business:

```ts
const NAMED: Record<string, string> = {
  Enter: "\r", Tab: "\t", Escape: "\x1b", Backspace: "\x7f", Space: " ", Delete: "\x1b[3~",
  Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D",
  Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~",
};
export function encodeKey(name: string): string {
  if (NAMED[name]) return NAMED[name];
  const m = /^C-([a-z])$/i.exec(name);                 // C-c → 0x03, C-d → 0x04, …
  if (m) return String.fromCharCode(m[1].toLowerCase().charCodeAt(0) & 0x1f);
  throw new Error(`Unknown key "${name}".`);           // → MCP tool error
}
```

### 6. MCP tool surface — `server.ts`

Uses `@modelcontextprotocol/sdk`'s `McpServer`; each tool's input is a `zod` shape; handlers call
one `TerminalControl` function and return its result as JSON text content (typed errors → MCP
`isError` results with actionable messages).

| Tool | Input | Returns |
|---|---|---|
| `list_workspaces` | — | `[{name, projectCount}]` |
| `list_projects` | `workspace` | `[{name, path}]` |
| `list_tabs` | `workspace, project` | `[{id, title, kind, refId, status, exitCode?, order}]` |
| `list_launchers` | — | enabled shells+agents `[{id, name, kind, version?}]` (valid `refId`s) |
| `read_terminal` | `sel, lines?` | `{text, status, exitCode?, cols, rows}` |
| `write_input` | `sel, data, submit?` | `{ok:true}` |
| `send_keys` | `sel, keys[]` | `{ok:true}` |
| `send_and_wait` | `sel, data, submit?, idleMs?, timeoutMs?` | `{text, settled, status, exitCode?}` |
| `wait_for_idle` | `sel, idleMs?, timeoutMs?` | `{text, settled, status, exitCode?}` (pure wait — no write; the re-invoke path) |
| `create_tab` | `workspace, project, refId, title?, cwd?` | the new tab summary |
| `close_tab` | `sel` | `{closed:true}` |

`sel` = `{ workspace?, project?, tab?, tabId? }` (provide `tabId`, or all of `workspace+project+tab`).

### 7. Fastify mount + auth (`index.ts`)

- **Mount** in `createServer` after services are in scope: build a `TerminalControl` from
  `services.sessions`, `services.registry`, `resolved.workspacesDir`, hand it to
  `registerMcp(app, control)`, which registers a `POST /mcp` handler (in stateless mode the SDK
  uses POST; GET/DELETE return 405). The handler **hijacks the reply** and passes
  `request.raw`/`reply.raw` (and the parsed
  body) to a `StreamableHTTPServerTransport` bound to the `McpServer` — the same `reply.hijack()`
  pattern `GET /api/sessions/:id/output` already uses (`index.ts:1626`).
- **Auth:** add `/mcp` to the gated set in the `onRequest` hook (`index.ts:377`):
  `url.startsWith("/api") || url.startsWith("/events") || url.startsWith("/mcp")`. On the HTTP
  transport this requires the bearer exactly like `/api`; on the unix socket it's open (local).
- **Transport mode:** v1 runs the transport **stateless** (`sessionIdGenerator: undefined`, a fresh
  `McpServer`+transport per request) — every tool is an independent read/write, so there is no
  per-connection state to keep, and it sidesteps MCP session-id lifecycle management. (A stateful
  map can be added later if a client needs the long-lived session handshake.)
- **Caddy:** no change — `reverse_proxy 127.0.0.1:47831` already forwards every path (including the
  long-lived `/events` and `/ws`), so a blocking `send_and_wait` POST is covered the same way.

### Component / call flow

```
MCP client (Claude Code/Desktop)
   │  POST /mcp   Authorization: Bearer base64(user:bcryptHash)
   ▼
Fastify onRequest hook  ── gates /mcp like /api ──►  StreamableHTTPServerTransport
   ▼
McpServer tool handler ──► TerminalControl.<fn>(sel,…)
   ├─ resolveTab(sel)      → ISessionManager.list/get   (name → SessionSummary)
   ├─ read                 → ISessionManager.captureText → tmux capture-pane (clean)
   ├─ write / keys         → ISessionManager.input       → PTY (shared attach)
   ├─ wait                 → ISessionManager.subscribe    (debounced idle)
   └─ create / close       → ISessionManager.create/close
```

## Security

- `/mcp` requires the bearer credential exactly like `/api` (added to the same `onRequest` gate)
  and rides Caddy's TLS. It does **not** widen the trust boundary: anyone holding the password can
  already inject input via `POST /api/sessions/:id/input` and read via `GET /api/sessions/:id/output`.
  `/mcp` is an ergonomic re-packaging of capabilities the credential already grants.
- **No path surface.** Tabs are resolved through `sessions.list(projectPath)` against existing
  sessions; `workspace`/`project` are `isValidName`-checked before the `join`. `create_tab`'s
  `cwd` defaults to the (validated) project path. No raw filesystem path is taken from the client.
- **Transparency.** Writes go through the *shared* attach PTY, so a human watching the tab in the
  UI sees the agent's keystrokes — intentional (no hidden side-channel).
- Future opt-in guardrails (read-only mode, command confirmation) are noted as out of scope.

## Edge cases

- **Ambiguous tab name** (two "bash"): reads/writes return an error listing `title=id` pairs;
  `close_tab` likewise refuses — the agent must pass `tabId`.
- **Tab exited:** `read_terminal` still returns the last captured screen with `status:"exited"`;
  `write_input`/`send_keys` are no-ops at the PTY (`input()` already guards a null pty) — surfaced
  with the tab's `status` so the agent can tell.
- **`create_tab` not-yet-booted:** returns immediately (tmux `new-session` is async, `sessions.ts:174`);
  the PTY may not have drawn its prompt yet. Documented: follow with `read_terminal` or
  `send_and_wait`. An unknown/`disabled` `refId` → tool error (mirrors `SessionError`).
- **`send_and_wait` on a silent command:** no output after the write → idle timer fires after
  `idleMs` → `settled:true` with the current screen. Correct (nothing was happening).
- **`send_and_wait` exceeds the cap:** `settled:false` + partial text; the agent re-invokes
  `wait_for_idle` to continue. `timeoutMs` is clamped to `MAX_TIMEOUT_MS` (10 min).
- **Session exits mid-wait:** the `onExit` path resolves `settled:true` with `status:"exited"`.
- **Non-tmux host:** `captureText` returns ANSI-stripped ring text (degraded — may miss
  cursor-addressed TUI redraws). `list_*`, write, keys, create/close, and the idle engine all work
  unchanged (they don't depend on tmux).
- **Concurrent writers** (human in the UI + MCP agent): both write to the same PTY; interleaving is
  possible, same as two humans sharing a terminal. Accepted.

## Testing / verification

- `pnpm check` (typecheck — the repo's only pre-commit gate). Includes the new SDK/zod types.
- **Unit** (`TerminalControl` against a fake `ISessionManager`): `resolveTab` name-hit / not-found
  (lists titles) / ambiguous (lists ids) / `tabId` bypass; `writeInput` submit appends `\r`;
  `encodeKey` table + `C-x` rule + unknown throws; `waitForIdle` resolves on debounce, on exit, and
  `settled:false` on cap (fake emitter + fake timers).
- **Manual, against a real daemon with tmux** (a *separate* checkout — never this one, per AGENTS.md):
  drive `/mcp` with an MCP client (or `mcp` inspector / curl JSON-RPC):
  - `list_workspaces`→`list_projects`→`list_tabs` reflect the live UI;
  - open a `claude` tab in the UI, `read_terminal` returns its clean visible text;
  - `send_and_wait("what is 2+2", submit:true)` returns the agent's settled reply, `settled:true`;
  - `send_keys(["C-c"])` interrupts a running command; `write_input` + `submit` runs one;
  - `create_tab(refId:"bash")` appears as a new tab in the UI; `close_tab` removes it;
  - ambiguity: two "bash" tabs → `read_terminal` errors with both ids; retry with `tabId` works;
  - auth: a request without/with a wrong bearer → 401 (same as `/api`).
- **Regression:** existing terminals (UI scrollback via the unchanged `scrollback()`/`capturePane()`
  default), and `pnpm check` clean.

## Files touched

- `apps/daemon/src/mcp/terminal-control.ts` — **new**: `resolveTab`, `readTerminal`, `writeInput`,
  `sendKeys`, `waitForIdle`, `sendAndWait`, `createTab`, `closeTab`, `listTabs` + typed errors.
- `apps/daemon/src/mcp/keys.ts` — **new**: named-key table + `encodeKey`.
- `apps/daemon/src/mcp/server.ts` — **new**: `McpServer` with the 11 tools; `registerMcp(app, control)`
  Fastify mount (Streamable-HTTP, hijack pattern, stateless).
- `apps/daemon/src/workspaces.ts` — **new (extracted)**: `listWorkspaces` / `listProjects` moved
  from `index.ts` so both it and `terminal-control.ts` import them.
- `apps/daemon/src/sessions.ts` — add `captureText(id, {lines?})` to `ISessionManager` and both
  backends (tmux: clean capture-pane; local: ANSI-stripped ring).
- `apps/daemon/src/tmux.ts` — `capturePane(id, { escapes?, lines? })` options (back-compatible).
- `apps/daemon/src/index.ts` — instantiate `TerminalControl` + `registerMcp(app, …)` in
  `createServer`; add `/mcp` to the `onRequest` auth gate; import the extracted workspace helpers.
- `apps/daemon/package.json` — add `@modelcontextprotocol/sdk` (+ `zod` for tool schemas).

## Decisions

- **In-daemon `/mcp`, not a standalone process.** Direct access to the live `ISessionManager`
  (no HTTP hop, no second credential), reuses the existing auth/TLS/Caddy, one thing to deploy.
- **Name-first addressing, id fallback, ambiguity is fatal.** Matches how a human refers to a tab;
  `list_tabs` makes ids discoverable; `read` tolerates ambiguity by erroring (harmless), `close`
  refuses to guess (killing the wrong agent isn't harmless).
- **Rendered reads via `tmux capture-pane`, clean (no `-e`).** Agents want what a human sees, not
  raw ANSI; tmux already renders the screen + scrollback. The existing colored full-history capture
  stays for the xterm replay path.
- **Degraded raw fallback on non-tmux hosts (v1).** The VPS (the real deployment) has tmux, so
  rendered reads work there; a headless VT renderer (`@xterm/headless`) for the local backend is a
  noted follow-up, not v1.
- **Event-driven idle, not polling.** Reuses the existing per-session emitter; backend-agnostic;
  `idleMs:1000` / `timeoutMs:120s` defaults with a 600s ceiling and `settled:false` re-invoke for
  slow agents.
- **No `busy` flag on `read_terminal`.** A one-shot snapshot can't reliably tell "at a prompt" from
  "mid-command"; faking it would mislead. Liveness is the job of `wait_for_idle`/`send_and_wait`
  (which actively observe and return `settled`).
- **Stateless MCP transport (v1).** Every tool is independent; no per-connection state to manage.
- **Stays out of `@orquester/api`.** MCP carries its own JSON-RPC schema; the REST/WS contracts are
  unaffected, keeping the surface contained to the daemon.

## Future (out of scope)

- Headless VT rendering for clean reads on non-tmux hosts.
- Write guardrails: read-only mode, destructive-command confirmation, per-tab allowlist.
- MCP progress notifications / streaming output during a long `send_and_wait`.
- `resize_tab`, and MCP **resources** (e.g. a tab's scrollback as a readable resource) /
  **prompts**.
- Multi-daemon fan-out (drive tabs across several daemons / the remotes list).
