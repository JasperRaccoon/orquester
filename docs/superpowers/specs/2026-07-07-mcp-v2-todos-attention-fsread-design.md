# Orquester MCP v2 — Todos, Attention Signal, File Reads (Design)

**Date:** 2026-07-07 · **Status:** approved design, pre-plan

## Context

The Orquester MCP (`apps/daemon/src/mcp/`, mounted as bearer-gated `POST /mcp`, remote
transport only) currently exposes 11 terminal-control tools: discovery projections
(`list_workspaces`, `list_projects`, `list_tabs`, `list_launchers`), screen observation and
driving (`read_terminal`, `write_input`, `send_keys`, `send_and_wait`, `wait_for_idle`), and
tab lifecycle (`create_tab`, `close_tab`). Its philosophy is "drive terminals like a human
user"; usage docs live in `docs/terminal-control-mcp.md`.

Three daemon capabilities are invisible to MCP clients today:

1. **Todo lists** are a first-class daemon feature (`TodoListManager` in
   `apps/daemon/src/todos.ts`, CRUD at `/api/todos*`, `todo.*` events, `TodoView` UI tab)
   with GitHub task-list markdown bodies — but no MCP surface.
2. **Activity/attention**: the UI derives per-tab `working|idle` + `attention` (terminal
   bell → "agent is waiting for you") client-side from the PTY byte stream
   (`packages/ui/src/store/app.ts`); neither the daemon nor MCP can see it. An MCP driver
   can only poll for output-silence, and `wait_for_idle`'s `settled` explicitly cannot
   distinguish "spinner still animating" from "done, awaiting input".
3. **Files**: no way to inspect a file or directory without burning a terminal tab on
   `cat`/`ls`.

This design adds 8 tools (19 total) plus a small daemon-core activity engine. Chosen scope
(user decision 2026-07-07): todos + attention + read-only fs. Explicitly parked: git tools
(structured `/api/git/*` routes already exist server-side and can be wrapped later),
fs write/delete/upload, workspace/project provisioning, registry mutation, event-bus
subscription, usage. The UI is untouched: the daemon-side activity engine is for MCP
consumers only; the UI keeps its client-side detection (accepted duplication).

## Goals

- Agents (outer orchestrators over HTTPS, or inner agents via loopback
  `http://127.0.0.1:47831/mcp` + bearer) can maintain the same todo lists humans see live
  in the UI, tick items atomically, supervise many agent tabs on a real
  "needs attention" signal instead of silence-polling, and read files/directories inside
  the existing `fsRoot` sandbox.
- Zero changes to transport, auth, UI, or wire contracts consumed by the UI.

## Non-goals

- No git MCP tools (future candidate; wraps existing `/api/git/*`).
- No fs mutation tools.
- No server-authoritative activity for the UI (fields are additive; UI logic untouched).
- No MCP resources/notifications; tools only, matching the existing server.

## New tool inventory

| Tool | Params (zod raw shape) | Returns (JSON in text block) |
|---|---|---|
| `list_todos` | `workspace: string`, `project?: string` | `[{id, name, scope, body, createdAt, updatedAt}]` |
| `create_todo` | `workspace: string`, `project?: string`, `name: string` | `{id, name, scope, body, createdAt, updatedAt}` |
| `update_todo` | `id: string`, `name?: string`, `body?: string` | updated record (same projection) |
| `delete_todo` | `id: string` | `{deleted: true}` |
| `toggle_todo_item` | `id: string`, `item: string \| int`, `checked?: boolean` | `{id, item, checked, body}` |
| `wait_for_attention` | `workspace?: string`, `project?: string`, `tab?: string`, `tabId?: string`, `timeoutMs?: int` | `{tabs: [{id, title, status, activity, attention}], settled, aborted?}` |
| `list_files` | `path: string` | `{path, entries: [{name, kind, size}], truncated}` |
| `read_file` | `path: string`, `offset?: int`, `maxBytes?: int` | `{path, text, size, offset, truncated}` |

Existing-tool additions: `list_tabs` rows and `read_terminal` results gain
`activity: "working" | "idle"`, `attention: boolean`, and (list_tabs only)
`lastOutputAt?: string` (ISO) — present on running tabs only.

Conventions carried over unchanged: snake_case `verb_noun` names in the existing families
(`list_files`/`read_file`, not `fs_*`); raw zod shapes with defaults applied in the
implementation, not the schema; success = `ok(JSON.stringify(...))` single text block;
projections whitelist fields; all failures through `toSafeToolError`; server version bumps
to `1.1.0`.

## Component 1: Todo tools

New module `apps/daemon/src/mcp/todo-tools.ts` exporting a small class (or plain functions)
with deps `{todos: TodoListManager, workspacesDir: string}`, mirroring the
`TerminalControl` deps pattern. `registerMcp(...)` in `apps/daemon/src/index.ts` gains the
`todos` manager (already constructed for the HTTP routes).

**Scope resolution** hides the `refKey` mechanics: `project` given → scope `"project"`,
`refKey = join(workspacesDir, workspace, project)`; else scope `"workspace"`,
`refKey = workspace`. Both names pass `isValidName` before any join (traversal guard, same
as `create_tab`). The project directory must exist (stat check), matching `create_tab`'s
behavior, so typos don't create orphan lists against never-existing paths.

**CRUD** maps 1:1 onto `TodoListManager.list/create/update/delete`. Responses project
`{id, name, scope, body, createdAt, updatedAt}` — `refKey` is omitted (the caller already
knows which workspace/project it asked about). `update_todo`'s `body` is the full task-list
markdown, replacing the stored body (last-write-wins, same as the HTTP API and UI).

**`toggle_todo_item`** is the atomic tick for the highest-frequency agent operation:

- Parse the stored body's task-list lines: `/^(\s*)[-*] \[( |x|X)\] (.*)$/` per line, in
  document order.
- `item` as integer = 1-based index over those matched lines. `item` as string =
  exact-after-trim, case-insensitive match on the item text (mirrors tab-title matching).
- `checked` true → `[x]`, false → `[ ]`, omitted → flip current state.
- No match → `ToolError` listing the available items with indices (or stating the list
  has no task items). Two or more text matches → `ToolError` telling the caller to use
  the index (never guess — same philosophy as `AmbiguousTab`).
- Returns `{id, item, checked, body}` where `item` is the matched item's text and
  `checked` its resulting state.
- The read-modify-write runs synchronously in one event-loop tick before the awaited
  persist, so concurrent MCP ticks cannot interleave; against simultaneous UI full-body
  saves it still touches only one line, minimizing the clobber window. Returns the updated
  `body` so the model needn't re-list.

Persistence (`todos.json`, atomic tmp+rename), `todo.created/updated/deleted` events, and
live `TodoView` updates all come free from the existing manager. No new events.

**Error mapping:** `toSafeToolError` gains a `TodoError` branch — its messages
("todo not found", "invalid scope") are already path-free and surface verbatim.

## Component 2: Activity/attention engine (daemon core)

New self-contained module `apps/daemon/src/ansi-activity.ts`: a per-session streaming
scanner with a minimal escape-state machine — states `ground`, `esc`, `csi`,
`osc-string`, and the DCS-class string states (DCS/SOS/PM/APC) — with state persisting
across chunk boundaries. A BEL (`\x07`) in `ground` is a bell; a BEL inside `osc-string`
(or the other string states) is a string terminator, not a bell — this is the whole reason
a naive byte scan is wrong (every terminal title update embeds `\x07`).

Per-session activity state, owned by the session managers: `{lastOutputAt: number,
attention: boolean}`.

- Every output chunk updates `lastOutputAt` and runs through the scanner; a bell sets
  `attention = true`.
- Any `input(id, ...)` clears `attention` (the driver or human responded). The UI also
  clears on *viewing* a tab; the daemon cannot see views, so typing is the only clear
  signal — a small, documented divergence.
- `activity` is derived on read, never stored: `working` when
  `now − lastOutputAt < ACTIVITY_WORKING_MS (3000)` (mirrors the UI's
  `IDLE_THRESHOLD_MS`), else `idle`. No server-side timers.
- State is in-memory only: a daemon restart resets flags (bells rung mid-restart are
  lost); a tmux reattach redraw may perturb `lastOutputAt`. Accepted and documented —
  the signal is advisory, and `read_terminal` remains the ground truth.

`ISessionManager` (both backends — tmux `SessionManager` and `LocalSessionManager`) gains:

- `activity(id): {lastOutputAt: number | null, attention: boolean} | undefined`
- `onActivity(listener: (ev: {id: string, type: "bell" | "exit"}) => void): () => void` —
  one manager-wide stream (not per-session subscriptions), so a multi-tab wait needs no
  N-subscription fan-out. `exit` fires alongside the existing per-session exit path.

Both backends feed the scanner at the same point they feed the ring buffer / subscriber
fan-out (tmux attach-PTY `onData`; local pty `onData`). The bell reaches the daemon on the
same path the UI's xterm `onBell` proves works today (inner pane → tmux attached client →
attach PTY).

## Component 3: `wait_for_attention`

Implemented in `TerminalControl` beside `waitForIdle`, reusing its conventions
(`DEFAULT_TIMEOUT_MS` 120 s, `MAX_TIMEOUT_MS` 600 s clamp, request-close `AbortSignal`,
idempotent teardown).

- **Addressing:** `tabId` or `workspace`+`project`+`tab` resolves one tab (via
  `resolveTab`); `workspace`+`project` without `tab` watches **all running tabs of the
  project** as snapshotted at call time (tabs created mid-wait are not watched —
  documented). Partial addressing → `ToolError`. A project with zero running tabs →
  `ToolError` ("nothing to wait for" — never a silent empty wait).
- **Immediate return:** if any watched tab already has `attention = true`, return without
  blocking.
- **Blocking:** subscribe via `onActivity`, filter to the watched id set; the first `bell`
  or `exit` resolves. Timeout resolves `settled: false`; abort resolves
  `{settled: false, aborted: true}` without touching the transport further.
- **Result:** `tabs` contains only the tabs needing attention (bell-flagged or
  just-exited), each `{id, title, status, activity, attention}`; empty on timeout.
- **Description guidance** (PROMPT_HINT appended, since answering usually means a menu):
  attention means the inner agent rang the bell and is likely awaiting input —
  `read_terminal` next; only bell-ringing TUIs (e.g. Claude Code) raise it, so
  `wait_for_idle` remains the fallback for plain shells and non-bell TUIs.

## Component 4: File read tools

New module `apps/daemon/src/mcp/fs-tools.ts`, deps `{fsRoot: string}`, reusing
`assertInsideFsRoot` exactly as the `/api/fs/*` routes do. Paths: absolute (what
`list_projects` already returns) or relative — relative resolves against `fsRoot` first;
everything is sandbox-asserted after resolution. `FsSandboxError` keeps its existing
generic, path-free mapping.

- **`list_files {path}`** → the existing `listFiles` helper, projected to
  `{name, kind: "file" | "dir" | "symlink" | "other", size}`, capped at
  `MAX_FS_ENTRIES = 500` entries with `truncated: true` beyond (a stray `node_modules`
  must not flood the model's context).
- **`read_file {path, offset?, maxBytes?}`** → `readFile`, then:
  - Binary sniff: NUL byte in the first 8 KB → `ToolError` `"Binary file (N bytes); read_file only serves text."`
  - Window: `[offset, offset + min(maxBytes ?? 65536, 262144))` bytes, decoded UTF-8
    (byte-aligned windows may clip a multibyte character at the edges — accepted;
    documented in the tool description as "byte offsets").
  - Returns `{path, text, size, offset, truncated}` where `truncated` means bytes remain
    after the window; the model pages by advancing `offset`.

Read-only by design: no write/create/delete/upload tools in this iteration.

## Wiring

`buildServer` (`apps/daemon/src/mcp/server.ts`) grows the 8 registrations through the
existing `tool()` helper; its deps gain the todo-tools and fs-tools instances (constructed
in `registerMcp` from `todos`, `resolved.workspacesDir`, `resolved.fsRoot`).
`registerMcp`'s call site in `index.ts` passes the already-constructed `TodoListManager`.
Transport, auth, body limit, statelessness: unchanged. `SERVER_INSTRUCTIONS` gets one
sentence per new family and must stay under 2 KB (existing test enforces the budget).

## Security posture

- Net-new **mutating** surface is todos only: benign records, human-visible in the UI,
  every change on the event bus, cascade rules unchanged.
- `read_file`/`list_files` and the attention fields are read-only, but `read_file` flows
  file contents (possibly `.env`/secrets inside `fsRoot`) to the driving model — the same
  exposure class as `read_terminal`. `docs/terminal-control-mcp.md` §8 gains a sentence
  naming it.
- `wait_for_attention` holds a request open like `wait_for_idle` (bounded by the 10-min
  clamp, aborted on disconnect) — no new DoS surface.
- All name inputs pass `isValidName`; all paths pass `assertInsideFsRoot`; all errors pass
  `toSafeToolError` (no paths/stacks leak).

## Testing

Co-located `node:test` files, `pnpm check` clean, no daemon launched from a live checkout:

- `ansi-activity.test.ts`: BEL in ground = bell; BEL terminating OSC (title set) ≠ bell;
  DCS/APC/PM/SOS strings swallow BELs; sequences split across chunk boundaries; state
  reset on `ESC \` (ST).
- `todo-tools.test.ts`: scope/refKey resolution incl. `isValidName` rejects; toggle by
  index, by text, case-insensitive, flip vs explicit `checked`; no-match and ambiguous
  errors list items; body round-trips non-task-list lines untouched.
- `fs-tools.test.ts`: sandbox escape → generic error; relative-path resolution; entry cap
  + `truncated`; window offset/cap math; binary sniff.
- `terminal-control.test.ts` additions: `wait_for_attention` immediate-return, resolve on
  bell, resolve on exit, timeout, abort; snapshot semantics (mid-wait tab not watched).
- `server.test.ts` additions: new tools registered; load-bearing description guidance
  (bell caveat, byte-offset note) survives future trims; `SERVER_INSTRUCTIONS` ≤ 2 KB.

Live verification happens post-deploy against the VPS (fresh `claude` session required —
tool descriptions are cached per session).

## Documentation

`docs/terminal-control-mcp.md` is extended in place (filename kept; title notes the scope
is now "Orquester control", not just terminals): new tool reference entries, a
"Supervising agent tabs" pattern (wait_for_attention loop replacing short-timeout
`wait_for_idle` polling for bell-capable TUIs), and a "Shared todo lists" pattern
(orchestrator plans → inner agents tick → human watches TodoView).

## Future candidates (explicitly out of scope now)

Read-only git tools over the existing `/api/git/*` routes; fs write; event-bus
subscription (poll tool or MCP notifications); workspace/project provisioning incl.
clone/create-as-identity; registry install/version; usage quota tool.
