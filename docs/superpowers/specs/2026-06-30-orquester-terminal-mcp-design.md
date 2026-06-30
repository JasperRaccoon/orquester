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

Plus one small backend addition (`captureText` on `ISessionManager`, for *clean* rendered text).
No file is extracted: `createServer` (the composition root) already has `listWorkspaces`/
`listProjects` in scope and **injects** them into the MCP layer (see §7 / Decisions — this avoids
an `index.ts` import cycle).

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
  identity `closeByProjectPrefix` already relies on — see `index.ts:678`).

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
  sessions.ts          ← + captureText() on ISessionManager and both backends
  tmux.ts              ← capturePane() gains options (clean text, line range)
  mcp/
    terminal-control.ts ← NEW: the resolve/read/write/wait/create/close functions
    keys.ts             ← NEW: key-name → bytes table + encoder
    text.ts             ← NEW: leaf stripAnsi/trimTrailingBlankLines (no imports — breaks the cycle)
    server.ts           ← NEW: McpServer with 11 tools; mounts on Fastify at /mcp
  index.ts             ← build TerminalControl (injecting listWorkspaces/listProjects);
                          reserve /mcp in BOTH the auth hook AND the SPA not-found handler
  packages/config      ← isValidName moves here (was index.ts-private) so the MCP layer reuses it
```

`TerminalControl`'s stateful dependencies are injected at construction — `ISessionManager`,
`RegistryService`, `workspacesDir: string`, and the existing `listWorkspaces`/`listProjects`
helpers (passed in from `createServer`, which already has them in module scope — see §7). Its only
*static* imports are leaf/pure: `isValidName` (moved to `@orquester/config`), the `text.ts` leaf
helpers, `keys.ts`, and **type-only** imports of `ISessionManager`/`RegistryService`/`SessionSummary`.
Crucially it has **no runtime import from `sessions.ts`** — `createTab` lets `sessions.create()`
throw `SessionError` rather than importing it (§3) — so importing it for a unit test does not
transitively load `node-pty`. It imports nothing from the 2000-line `index.ts`, and there is no
import cycle (the strip helpers live in the leaf `text.ts`, not in `terminal-control.ts`). The same
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

- **tmux backend — mirror `scrollback()` exactly (`sessions.ts:295-301`).** tmux's default
  `remain-on-exit off` destroys the pane when the command exits, so `capture-pane` on an exited
  session returns `""`; a *running* capture can also transiently return `""`. Both cases want the
  hot-ring fallback, so the logic is one expression:
  ```ts
  const captured = summary.status === "running"
    ? await this.tmux.capturePane(id, { escapes: false, lines: opts?.lines ?? 0 })
    : "";
  return trimTrailingBlankLines(captured || stripAnsi(this.buffer(id))); // mirrors scrollback's `captured || buffer`
  ```
  Without the fallback an exited tab reads as empty — silently dropping the *final* output of any
  command that prints then exits, i.e. the common `send_and_wait` case (the headline flow). `lines:0`
  = the visible screen.
- **local backend (no tmux):** `trimTrailingBlankLines(stripAnsi(this.buffer(id)))` — the ring
  survives exit, so no special-casing. `stripAnsi` must cover private/intermediate CSI params
  (`\x1b\[[0-9;?>=]*[ -/]*[@-~]`) and OSC (`\x1b\][^\x07]*(?:\x07|\x1b\\)`), else sequences like
  `\x1b[?25l` leak.
- **The fallback is degraded** (on *either* backend): `session.buffer` is the ANSI-stripped **raw
  attach stream** (a concatenation of redraws), not a tmux-rendered frame, and it caps at
  `MAX_BUFFER` (256 KB, `sessions.ts:17`). On the fallback paths `lines` is **best-effort** — sliced
  to the last `lines` lines when `lines>0`, else the ring tail; it can't reconstruct a single
  rendered screen. So only a *running* tmux tab yields a clean rendered read; exited tabs (and all
  non-tmux reads) are approximate. The headline flow is unaffected (it reads while `running`).

`stripAnsi()` + `trimTrailingBlankLines()` live in a **leaf** module `apps/daemon/src/mcp/text.ts`
(it imports nothing), so both `sessions.ts` and `terminal-control.ts` use them with **no**
`sessions.ts ⇄ terminal-control.ts` import cycle.

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
candidates/ids — so the agent can self-correct by retrying with `tabId`. `isValidName` is imported
from `@orquester/config` — it is moved there from its current `index.ts`-private home (`index.ts:1868`)
so the MCP layer can reuse it without importing `index.ts` (see Files touched).

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
  if (!isValidName(sel.workspace) || !isValidName(sel.project))
    throw new TabNotFound("Invalid workspace/project name.");
  const projectPath = join(workspacesDir, sel.workspace, sel.project);
  if (!statSafe(projectPath)?.isDirectory())            // a FILE passes existsSync, then tmux
    throw new TabNotFound(`No project "${sel.project}" in "${sel.workspace}".`);  // `new-session -c` fails ASYNC
  // No `registry.get(refId)!.kind`: it TypeErrors on a bad id, AND create() ignores req.kind (it
  // derives kind from the entry, sessions.ts:130) and already throws a clean SessionError for an
  // unknown/disabled refId (sessions.ts:114). Pass a placeholder kind to satisfy the (ignored)
  // type and let create() validate — so terminal-control.ts needs NO runtime SessionError import.
  return sessions.create({ kind: "shell", refId: opts.refId,
                           projectPath, cwd: opts.cwd ?? projectPath, title: opts.title });
}
// statSafe(p) = a tiny try/catch around node:fs statSync returning undefined on ENOENT.

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
- **What `settled:true` means:** the pane was *quiet for `idleMs`* — **not** "the command
  completed." A command that emits nothing for `> idleMs` before it starts (`sleep 5; echo done`)
  can settle early, before its output exists. For the primary case (a coding-agent TUI streaming a
  spinner/tokens) this is rarely hit; for shells the agent should read the result and
  re-`wait_for_idle` if it expected more. A larger `idleMs` is sensible for `agent`-kind tabs.
  (This is also why `read_terminal` exposes no `busy` flag — see Decisions.)

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
`list_launchers` filters `registry.list()` to `enabled` entries (it returns disabled ones too,
`registry.ts:138`). Errors map to MCP `isError` results: `TabNotFound`/`AmbiguousTab` (with the
candidate ids), `SessionError` (bad/disabled `refId` on `create_tab`), `encodeKey`'s unknown-key
throw, and a generic catch-all — each with an actionable message.

### 7. Fastify mount + auth (`index.ts`)

- **Mount** in `createServer`: build `TerminalControl` from `services.sessions`,
  `services.registry`, `resolved.workspacesDir`, and the in-scope `listWorkspaces`/`listProjects`;
  hand it to `registerMcp(app, control)`. It registers `app.post("/mcp", { bodyLimit }, …)` (see
  body-limit note). The handler **hijacks the reply** and passes `request.raw`/`reply.raw` **and the
  already-parsed `request.body`** (Fastify has consumed the raw stream, so the parsed body must be
  handed in) to a per-request `StreamableHTTPServerTransport` bound to a per-request `McpServer` —
  the same `reply.hijack()` pattern `GET /api/sessions/:id/output` uses (`index.ts:1626`).
- **Teardown (no leaks).** Server+transport are created per request, so close them when the response
  ends: `reply.raw.on("close", () => { transport.close(); server.close(); })`. Wrap
  `transport.handleRequest(...)` in try/catch and, on a throw *after* hijack, write a 500 to
  `reply.raw` and `end()` it — otherwise a post-hijack throw hangs the socket (the existing hijack
  route is a GET that can't throw mid-stream the same way).
- **Methods + the SPA catch-all (subtle).** Stateless mode only needs `POST /mcp`. But on the
  HTTP/remote transport `createServer` installs a `setNotFoundHandler` that serves the SPA's
  `index.html` for any non-matching **GET** whose path isn't reserved (`index.ts:1828-1838`), and its
  reserved set is only `/api`/`/health`/`/events` (`index.ts:1832`). So an unhandled `GET /mcp` would
  return the SPA **HTML (200)**, not a 404 — confusing a Streamable-HTTP client that probes the
  optional GET SSE channel. **Reserve `/mcp` there too:** add `url.startsWith("/mcp")` to that
  handler's reserved set. (`DELETE /mcp` already 404s.) Note this is a *second* reserved list,
  separate from the auth hook below — **both** must list `/mcp`.
- **Body limit.** `createServer` sets no global `bodyLimit`, so Fastify's ~1 MiB default applies to
  `/mcp`. A large paste in `write_input`/`send_and_wait` `data` (inside the JSON-RPC envelope) could
  413 at the parser. Give `/mcp` a route-level override (e.g. `{ bodyLimit: 8 * 1024 * 1024 }`,
  following the upload route at `index.ts:1557`). *(Aside: the "256 KB" in the upload comment at
  `index.ts:1553` is itself inaccurate — the real default is ~1 MiB; not fixed by this work.)*
- **Auth:** add `/mcp` to the gated set in the `onRequest` hook (`index.ts:377`):
  `url.startsWith("/api") || url.startsWith("/events") || url.startsWith("/mcp")`. On the HTTP
  transport this requires the bearer exactly like `/api`; on the unix socket it's open (local).
- **Transport mode:** v1 runs **stateless** (`sessionIdGenerator: undefined`, fresh server+transport
  per request) — every tool is independent, so there is no per-connection state, and it sidesteps
  MCP session-id lifecycle. (A stateful map can be added later if a client needs the handshake.)
- **Reachability + credential (client setup).** `/mcp` needs the **HTTP transport enabled** — a
  normal Streamable-HTTP client cannot reach the unix socket. The desktop app embeds the daemon with
  HTTP **off** by default (`apps/desktop/src/main.ts` forces `ORQUESTER_HTTP_ENABLED:"false"`), so
  `/mcp` targets the **VPS** (or a daemon with HTTP explicitly enabled), not a stock desktop install
  — Goals' "local or VPS" is true only with HTTP on. The client's `Authorization: Bearer` is
  `base64("<user>:<bcryptHash>")` — **not** the plaintext password and never the raw hash: the
  client fetches the bcrypt salt from `/api/auth/info`, bcrypts the password client-side (cost 12),
  and base64s `user:hash` (exactly what the web/desktop clients do). Document this derivation for
  whoever wires the MCP client config.
- **Caddy:** no change — `reverse_proxy 127.0.0.1:47831` already forwards every path (incl. the
  long-lived `/events`/`/ws`), so a blocking `send_and_wait` POST is covered the same way.

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
- **Path surface is parity with the existing session API.** Tab resolution uses
  `sessions.list(projectPath)` against existing sessions, with `workspace`/`project`
  `isValidName`-checked before the `join`; `create_tab` also `isValidName`-checks them and verifies
  the project dir exists. Its optional `cwd` *is* a client-supplied path used verbatim — but that is
  exactly what `POST /api/sessions` already accepts, so `/mcp` adds **no new** path surface beyond
  what the credential already grants (the daemon does not sandbox session `cwd` today).
- **Transparency.** Writes go through the *shared* attach PTY, so a human watching the tab in the
  UI sees the agent's keystrokes — intentional (no hidden side-channel).
- Future opt-in guardrails (read-only mode, command confirmation) are noted as out of scope.

## Edge cases

- **Ambiguous tab name** (two "bash"): reads/writes return an error listing `title=id` pairs;
  `close_tab` likewise refuses — the agent must pass `tabId`.
- **Tab exited:** `read_terminal` returns the hot-ring fallback (§1 — tmux's pane is gone once the
  command exits): the ANSI-stripped raw stream (**approximate, not a rendered screen**) with
  `status:"exited"`; `write_input`/`send_keys` are no-ops at the PTY (`input()` already guards a null
  pty) — surfaced with the tab's `status` so the agent can tell. (A `projectPath:""` session — not
  bound to a project — is unaddressable via `(workspace, project, tab)`; reach it by `tabId`.)
- **`create_tab` is provisional:** it returns immediately with `status:"running"` (tmux
  `new-session` is async, `sessions.ts:174`); the prompt may not be drawn yet, and a launch failure
  flips the tab to `exited` *after* the tool already returned (the `.catch` at `sessions.ts:192`).
  The agent should follow with `read_terminal`/`send_and_wait` to confirm. `createTab` pre-checks the
  project path is a **directory** (`statSafe(...).isDirectory()` — a file would pass `existsSync` then
  fail `new-session -c` async) and lets `create()` reject an unknown/disabled `refId` with a clean
  `SessionError` before spawning — so common failures surface as tool errors, not a ghost tab.
- **`send_and_wait` on a slow/silent command:** no output for `idleMs` → idle timer fires →
  `settled:true`. This correctly means "the pane went quiet," but also fires for a command that
  hasn't started emitting yet (`sleep 5; echo x`) — see §4's "what `settled:true` means": the agent
  treats it as "quiesced," reads, and re-`wait_for_idle`s if it expected more.
- **`send_and_wait` exceeds the cap:** `settled:false` + partial text; the agent re-invokes
  `wait_for_idle` to continue. `timeoutMs` is clamped to `MAX_TIMEOUT_MS` (10 min).
- **Session exits mid-wait:** the `onExit` path resolves `settled:true` with `status:"exited"`.
- **Non-tmux host:** `captureText` returns ANSI-stripped ring text (degraded — may miss
  cursor-addressed TUI redraws). `list_*`, write, keys, create/close, and the idle engine all work
  unchanged (they don't depend on tmux).
- **Concurrent writers** (human in the UI + MCP agent): both write to the same PTY; interleaving is
  possible, same as two humans sharing a terminal. Accepted.
- **`read_terminal` dims may be stale:** a reattached session reports `cols/rows` of `80/24` until
  the next resize (`sessions.ts:464`), so the reported dimensions can lag the real pane. Cosmetic —
  the captured text is unaffected.

## Testing / verification

- `pnpm check` (typecheck — the repo's only pre-commit gate). Includes the new SDK/zod types.
- **Unit** (`TerminalControl` against a fake `ISessionManager` exposing a drivable emitter + fake
  timers): `resolveTab` name-hit / not-found (lists titles) / ambiguous (lists ids) / `tabId`
  bypass; `createTab` bad-dir + unknown-`refId` → clean errors (no `TypeError`); `writeInput` submit
  appends `\r`; `encodeKey` table + `C-x` rule + unknown throws; `waitForIdle` resolves on debounce,
  on exit, and `settled:false` on cap; `captureText` **exited→buffer fallback** (the C1 path) and
  trailing-blank trim; the early-settle behavior (§4/I3) is asserted as documented behavior.
- **Manual, against a real daemon with tmux** (a *separate* checkout — never this one, per AGENTS.md):
  drive `/mcp` with an MCP client (or `mcp` inspector / curl JSON-RPC):
  - `list_workspaces`→`list_projects`→`list_tabs` reflect the live UI;
  - open a `claude` tab in the UI, `read_terminal` returns its clean visible text;
  - `send_and_wait("what is 2+2", submit:true)` returns the agent's settled reply, `settled:true`;
  - `send_keys(["C-c"])` interrupts a running command; `write_input` + `submit` runs one;
  - `create_tab(refId:"bash")` appears as a new tab in the UI; `close_tab` removes it;
  - ambiguity: two "bash" tabs → `read_terminal` errors with both ids; retry with `tabId` works;
  - auth: a request without/with a wrong bearer → 401 (same as `/api`);
  - `GET /mcp` returns a clean 404/405, **not** the SPA `index.html` (confirms the not-found-handler
    reservation at `index.ts:1832`).
- **Regression:** existing terminals (UI scrollback via the unchanged `scrollback()`/`capturePane()`
  default), and `pnpm check` clean.

## Files touched

- `apps/daemon/src/mcp/terminal-control.ts` — **new**: `resolveTab`, `readTerminal`, `writeInput`,
  `sendKeys`, `waitForIdle`, `sendAndWait`, `createTab`, `closeTab`, `listTabs`, `listLaunchers`
  (filters `enabled`) + typed errors (`TabNotFound`/`AmbiguousTab`). **No runtime import from
  `sessions.ts`** (type-only `ISessionManager`; `createTab` lets `create()` throw `SessionError`) —
  so it loads without `node-pty` and there is no import cycle.
- `apps/daemon/src/mcp/keys.ts` — **new**: named-key table + `encodeKey`.
- `apps/daemon/src/mcp/text.ts` — **new (leaf, imports nothing)**: `stripAnsi` /
  `trimTrailingBlankLines`, used by **both** `terminal-control.ts` and `sessions.ts` — this is what
  removes the would-be `sessions.ts ⇄ terminal-control.ts` cycle.
- `apps/daemon/src/mcp/server.ts` — **new**: per-request `McpServer` with the 11 tools;
  `registerMcp(app, control)` Fastify mount (Streamable-HTTP, hijack, stateless, **per-request
  teardown**, route `bodyLimit`); error→`isError` mapping (`TabNotFound`/`AmbiguousTab`/
  `SessionError`/`encodeKey` + catch-all).
- `apps/daemon/src/sessions.ts` — add `captureText(id, {lines?})` to `ISessionManager` and both
  backends, mirroring `scrollback()`'s `captured || buffer` fallback (C1: exited/empty → ANSI-stripped
  ring) via the `mcp/text.ts` leaf helpers; trims trailing blank lines.
- `apps/daemon/src/tmux.ts` — `capturePane(id, { escapes?, lines? })` options (back-compatible).
- `apps/daemon/src/index.ts` — build `TerminalControl` (injecting the in-scope `listWorkspaces`/
  `listProjects`) + `registerMcp(app, …)` in `createServer`; reserve `/mcp` in **both** the
  `onRequest` auth gate (`:377`) **and** the SPA `setNotFoundHandler` reserved set (`:1832`, else
  `GET /mcp` returns the SPA HTML); re-import `isValidName` from `@orquester/config` (moved out of
  this file). **No `workspaces.ts` extraction** — `listWorkspaces`/`listProjects` depend on
  `readWorkspacesMeta`/`writeWorkspacesMeta`, which ~6 other routes use, so extracting would force a
  `workspaces.ts` ↔ `index.ts` cycle; injecting from the composition root avoids it.
- `packages/config/src/index.ts` — **move `isValidName` here** (currently `index.ts`-private at
  `index.ts:1868`) and export it, so `terminal-control.ts` validates names without importing
  `index.ts`; update `index.ts`'s call sites to import it from `@orquester/config`.
- `apps/daemon/package.json` — add `@modelcontextprotocol/sdk` and `zod` (pin `zod` to the SDK's
  expected major to avoid a duplicate-`zod` `instanceof` footgun; `@orquester/config` already uses
  `zod ^3.25`).

## Decisions

- **In-daemon `/mcp`, not a standalone process.** Direct access to the live `ISessionManager`
  (no HTTP hop, no second credential), reuses the existing auth/TLS/Caddy, one thing to deploy.
- **Name-first addressing, id fallback, ambiguity is fatal.** Matches how a human refers to a tab;
  `list_tabs` makes ids discoverable; `read` tolerates ambiguity by erroring (harmless), `close`
  refuses to guess (killing the wrong agent isn't harmless).
- **Rendered reads via `tmux capture-pane`, clean (no `-e`).** Agents want what a human sees, not
  raw ANSI; tmux already renders the screen + scrollback. The existing colored full-history capture
  stays for the xterm replay path.
- **Degraded raw fallback for non-tmux hosts AND exited tabs (v1).** A clean *rendered* read needs a
  live tmux pane, so only a *running* tab on the tmux backend gets one; exited tabs (pane destroyed)
  and all non-tmux reads fall back to the ANSI-stripped hot ring — approximate, not a rendered frame.
  The VPS has tmux and the headline flow reads while running, so this is acceptable; a headless VT
  renderer (`@xterm/headless`) is a noted follow-up, not v1.
- **Event-driven idle, not polling.** Reuses the existing per-session emitter; backend-agnostic;
  `idleMs:1000` / `timeoutMs:120s` defaults with a 600s ceiling and `settled:false` re-invoke for
  slow agents.
- **No `busy` flag on `read_terminal`.** A one-shot snapshot can't reliably tell "at a prompt" from
  "mid-command"; faking it would mislead. Liveness is the job of `wait_for_idle`/`send_and_wait`
  (which actively observe and return `settled`).
- **Stateless MCP transport (v1).** Every tool is independent; no per-connection state to manage
  (fresh server+transport per request, torn down on response close).
- **Inject `listWorkspaces`/`listProjects`, don't extract a module.** `createServer` already has
  them in scope; injecting keeps the change small and avoids a `workspaces.ts` ↔ `index.ts` import
  cycle (those helpers' `readWorkspacesMeta`/`writeWorkspacesMeta` deps are used by ~6 other routes).
- **`settled` means "quiesced", not "completed".** The idle engine reports pane-quiet, which the
  agent re-checks; honest semantics beat a fragile "is it done?" guess (same reason `read_terminal`
  has no `busy` flag).
- **Stays out of `@orquester/api`.** MCP carries its own JSON-RPC schema; the REST/WS contracts are
  unaffected, keeping the surface contained to the daemon.

## Future (out of scope)

- Headless VT rendering for clean reads on non-tmux hosts.
- Write guardrails: read-only mode, destructive-command confirmation, per-tab allowlist.
- MCP progress notifications / streaming output during a long `send_and_wait`.
- `resize_tab`, and MCP **resources** (e.g. a tab's scrollback as a readable resource) /
  **prompts**.
- Multi-daemon fan-out (drive tabs across several daemons / the remotes list).
