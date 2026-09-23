# Orquester MCP v2 — chat-native control surface (design)

*Status: draft for review. Supersedes the terminal-control MCP (`apps/daemon/src/mcp/`,
`docs/terminal-control-mcp.md`). Companion to the agent chat GUI spec
(`2026-09-21-agent-chat-gui-design.md`), whose §6 routes are the substrate this server sits on.*

---

## 0. Summary

Orquester's MCP server was written when an agent tab was a Claude Code TUI inside a tmux pane. Its
tools scrape screens, emit keystrokes, guess quiescence and teach the driving model to recognise
`❯` prompts and `[ ]` checkboxes. Agent tabs are now **chat tabs** driven by the agent host over
each provider's machine protocol, and on a chat tab every one of those tools either returns
nothing, reports success for a write that never happened, or busy-loops (§3).

v2 replaces that surface with **29 chat-native tools** (*Built: 30 — `search_sessions` was added
after v2 shipped, §7.2*) that mirror the chat GUI one-to-one: what a user can do from a chat tab —
open, resume and close sessions; pick model, effort, permission mode, plan mode and account; send
messages with attachments; answer questions and approvals; read status, transcripts and subagents;
wait for something to happen; read quota per account — an MCP client can do with the same
semantics, the same gates and the same error codes, because the tools are a thin **in-process
client of the daemon's own REST API** (§4.2). No screen text, no keystrokes, no quiescence
heuristics, no TUI prompt guidance.

---

## 1. Goal

An external or orchestrating agent (a Claude Code session, Claude Desktop, a phone client through a
remote MCP connector, a script) can, through `POST /mcp`:

1. **Discover** projects, launchable agents with their valid models / options / permission modes /
   accounts, and past conversations to resume.
2. **Open, resume, configure and close** chat sessions of Claude Code (incl. `claudex`/`claudemix`),
   Codex, OpenCode and Grok — the same fields as the composer bar: model, effort (and the other model
   options), permission mode, plan mode, account.
3. **Talk** to a session: send a message, optionally with images or files, and get the reply back in
   the same call; steer a running turn; interrupt; compact; rewind.
4. **Answer what the agent asks**: single-select, multi-select, custom text, several questions in
   one request, attachments on an answer, Codex's async (message-mode) questions incl. dismissing
   them; tool approvals with every decision the provider offers.
5. **Read state** the way the GUI does: working / waiting / idle, the attention flag and *why*
   (approval, question, plan ready, finished, error, background work), pending requests in full, the
   proposed plan, the subagent roster with per-subagent status and a drill-in transcript, the context
   meter.
6. **Wait** for a session (or every session of a project) to need attention, event-driven, with a
   cursor so nothing is missed and nothing is reported twice.
7. **Read usage** exactly as the top-bar widget shows it: per family, per managed account, the 5h /
   week / per-model windows with % used and reset times, plus the Cost tab.

Every tool follows one naming and addressing convention (§5), every result is one shape family
(§6), and every capability exists in exactly one place.

## 2. Non-goals

- **Terminal I/O.** `read_terminal`, `write_input`, `send_keys`, `send_and_wait`, `wait_for_idle`
  are removed and not replaced. Driving a shell by keystrokes is the tmux gimmick this redesign
  exists to delete; the driving agent has its own shell tool. Terminal tabs remain *listed* (so the
  caller sees the tab strip) and *closable*, nothing more.
- **Creating terminal tabs** from the MCP (the `+` menu can; the MCP does not — see §15).
- **Registering the MCP into the agents Orquester launches**, and per-thread scoped credentials.
  Deferred to a phase 2 (§13); v2 keeps the bring-your-own wiring documented today.
- **Fixing the collateral bugs the audit surfaced** (§14), except the one v2 depends on (§8.4).
- Provider refresh, host stop, daemon/app settings, git, browsers, system status.

---

## 3. What the audit found

Seven read-only sweeps of the daemon, host, wire contracts and UI (2026-09-22, commit `9ec164c`)
established the facts the design rests on. File references are to that commit.

**The current server** (`apps/daemon/src/mcp/server.ts`, 20 tools, `@modelcontextprotocol/sdk`
1.29, stateless Streamable HTTP, HTTP transport only, master bearer via the global auth hook):

- Zero references to the chat subsystem. Chat tabs reach the terminal tools through
  `ChatAwareSessionManager`, whose PTY methods are silent no-ops (`agent-chat/session-router.ts:168-199`):
  `read_terminal` → `""`; `write_input`/`send_keys` → `{ok:true}` with **zero writes**;
  `wait_for_idle` → `settled:true` after ~1 s of nothing; `wait_for_attention {project}` returns in
  1 ms forever, because a settled chat tab carries a sticky `finished` attention
  (`agent-chat/activity-ladder.ts:141-152`), so the documented supervision loop is a busy loop.
- `create_tab` with an agent `refId` creates a **legacy `kind:"agent"` tmux terminal** — the last
  remaining creator of that kind (`mcp/terminal-control.ts:403-412`; `packages/ui/src/lib/session-kind.ts:14-16`
  says "Nothing creates one any more"). It bypasses the chat create route's model, account and
  claudex gates.
- `close_tab` on a chat tab deletes the whole host thread directory (`DELETE /api/sessions/:id`);
  the description says "Close a tab."
- `get_usage` drops every per-account row, the System row and the per-model windows (`Fable`);
  the top-bar widget renders exactly those.
- ~880 chars of Claude-TUI prompt guidance (`PROMPT_HINT`) are appended to six tool descriptions;
  no parameter has a description; no tool has annotations; all successes are a JSON string in a
  text block; errors mix `{ok:true}` / `{closed:true}` / `{deleted:true}` acks.
- Nothing in Orquester registers `/mcp` into any agent it launches (Claude SDK `mcpServers: {}`,
  Grok `mcpServers: []`, Codex/OpenCode untouched); wiring is manual with the master credential.
- 71 unit tests pass; none covers a chat tab, the auth gate or the transport mount.

**The substrate v2 builds on** (all already shipped and exercised by the GUI):

| Need | Route(s) | Notes |
|---|---|---|
| Create / list / rename / delete tabs | `POST /api/sessions {kind:"agent-chat",…}`, `GET /api/sessions[?projectPath]`, `PUT /api/sessions/:id`, `DELETE /api/sessions/:id` | No `GET /api/sessions/:id` — filter the list. The tab is written first, then the host thread (§6.1 of the GUI spec). |
| Commands | `POST /api/sessions/:id/{turn,interrupt,approval,answer,dismiss,revert,compact,mode,background,session/stop}` + daemon-owned `/account` | Bodies in `packages/api/src/agent-chat/wire.ts`; every body carries a client-minted `commandId`; answer `{seq}`; closed error-code list. |
| Reads | `GET …/thread` (snapshot `{head, items, turns, checkpoints, pending, roster, seq}`), `GET …/turns/:n/diff`, `GET …/items/:itemId`, `GET /api/agent/providers` | The snapshot is already folded; `pending` is derived; `roster` is the subagent list. |
| Attachments | `POST /api/sessions/:id/upload?name&type` (raw octet-stream) → `AttachmentRef {type,id,name,mimeType,sizeBytes}`; `/turn` and `/answer` carry refs only | `AgentChatService.uploadAttachment(id, {name,type}, Readable)` is the in-process entry. |
| Session state | `SessionSummary.activity {state, attention, needsAttentionAt}` + the six chat fields (`hasPendingApprovals`, `hasPendingUserInput`, `hasActionableProposedPlan`, `backgroundLiveness`, `latestTurn`, `chatSessionStatus`); resolved by the one ladder `resolveChatActivity` (`agent-chat/activity-ladder.ts:107-155`) | Produced by a 1.5 s poll of the host; pushed on the `/events` bus as `session.updated` / `session.activity` / `agentChat.turn` / `agentChat.pending` through `Broadcaster` (`broadcaster.ts`). |
| Catalogues | `GET /api/registry` (`chat.adapter`), `GET /api/agent/providers` (models + `optionDescriptors`, capabilities), `GET /api/agent-accounts`, `GET /api/cliproxy` + `/api/cliproxy/models` (claudex/claudemix launch models), `GET /api/agents/conversations?path=` | |
| Usage | `GET /api/usage[?refresh=1]` (`UsageResponse` with `accounts[]`, `system`, `scopedWindows`), `GET /api/usage/tokens` (Cost tab) | `usage.changed` on the bus. |

Facts that shape specific tools (each cited where used): a chat `SessionSummary.status` is always
`"running"` (the real state is `chatSessionStatus`); the chat model/mode live only on the thread
head (`GET …/thread`), not on the summary; a turn ends when `thread.session-set` leaves
`running`/`starting`; `responseMode:"message"` questions never block the turn and are the only
dismissible ones; `/mode` has no idle gate and restarts a live Claude session on any selection
change; the `error` session status refuses every command except `session/stop` and `revert`;
`POST /api/sessions` does not confine `projectPath`/`cwd` to `fsRoot`, and a bad `accountId` at
create silently falls back to the system home.

---

## 4. Architecture

### 4.1 Placement and transport — unchanged

`POST /mcp` stays where it is: registered **only on the HTTP transport** (`mode:"remote"`), behind
the daemon's global bearer hook, as a stateless Streamable-HTTP endpoint with JSON responses, one
`McpServer` instance built per request. The desktop app (HTTP off) has no MCP; the unix socket
never serves it. Two small changes: the body limit becomes 16 MiB (inline base64 attachments,
§8), and `GET /mcp` / `DELETE /mcp` answer **405** instead of the daemon's JSON 404, so a client
probing the endpoint gets the answer the MCP spec promises.

### 4.2 The tools are an in-process client of the daemon's own REST API

Every tool is *argument mapping → one or more daemon calls → projection*. The daemon calls go
through one seam:

```ts
export interface DaemonApi {
  /** Runs the daemon's own route pipeline in-process (auth hook included). */
  request(method: "GET"|"POST"|"PUT"|"DELETE", path: string,
          opts?: { query?: Record<string,string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
  /** The one non-JSON path: streams bytes to the host's attachment store. */
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable,
                   sizeBytes: number): Promise<{ status: number; value: AttachmentRef | { code: string; message: string } }>;
  /* Built: no `sizeBytes` parameter (the stream is counted as it arrives). The first draft also had
     `attachmentPath(sessionId, attachmentId)` for the non-image path line; §8.4's path lines are
     written by the host, so no tool needed it and it was removed. */
  /** Bus subscription — every EventMessage the /events clients see. */
  subscribe(listener: (event: EventMessage) => void): () => void;
  readonly fsRoot: string;
  readonly workspacesDir: string;
}
```

The production implementation, `InjectDaemonApi`, wraps `app.inject()` (Fastify's in-process
dispatcher, already used by the daemon's own route tests) and **forwards the MCP request's own
`Authorization` header**, so every daemon call is authorised exactly as the caller is; it wraps
`AgentChatService.uploadAttachment` for the attachment upload (*Built:* the only attachment method); and it wraps
`Broadcaster.add/remove` with a sink that parses the NDJSON line back into an `EventMessage`.

Why this and not direct service calls: the create-session route alone applies the claudex model
gate, the seeded-account gate, the registry `chat.adapter` check, the recent-project mark and the
tab-then-thread ordering inside the route handler (`apps/daemon/src/index.ts:3726-3757`,
`agent-chat/service.ts:476-591`); the proxy routes add the `THREAD_NOT_FOUND` / `HOST_UNAVAILABLE`
guards and the status mapping. Calling the routes is the only way to get *all* of that with zero
duplication, and it makes "the MCP behaves like the GUI" true by construction rather than by
review. The costs — one JSON round-trip through Fastify per call, and an unusual (but supported and
tested) use of `inject` in production — are accepted. The seam keeps the alternative open: if
`inject` proves awkward for one route, that method of `DaemonApi` can call the service directly
without touching a tool.

Tools never touch `services.sessions`, the host client or the store directly; the exceptions
above (the attachment upload and the bus subscription) are on the seam.

### 4.3 Waiting without polling

Two tools block (`send_message` with `wait`, `wait_for_session`). They wait on the **same signal
the Attention Center reads**: the six chat summary fields and `activity`, delivered on the bus. A
wait registers a `DaemonApi.subscribe` listener for its duration, evaluates its predicate on every
`session.updated` / `session.activity` / `session.closed` for the watched ids, and re-reads
`GET /api/sessions` every 10 s as a safety net (the host poll idles while the host is unhealthy).
The listener is removed on resolve, timeout, or abort; the `/mcp` request's `close` aborts every
in-flight wait, as today. Semantics in §9. There is no `sleep` anywhere and no reading of the
per-thread event stream: the exact stream would give ~1.5 s better latency at the cost of
duplicating the client fold in the daemon, and a wait's outcome is read from the thread snapshot
afterwards anyway.

### 4.4 Files

```
apps/daemon/src/mcp/
  server.ts            registerMcp(app, deps) — the mount, buildServer, instructions, result/error helpers
  daemon-api.ts        DaemonApi + InjectDaemonApi (+ FakeDaemonApi in daemon-api.test.ts helpers)
  addressing.ts        resolveProject(), projectNamesFor(path), isChatSession()
  views.ts             SessionView / SessionDetail / pending / subagent / usage projections (§6)
  transcript.ts        snapshot items → TranscriptEntry[] (§7.6), size shedding
  wait.ts              waitForSession(), waitForTurn() (§9)
  attachments.ts       inline attachment → upload (§8)
  tools/
    catalog.ts         list_projects, list_agents, list_conversations
    sessions.ts        list_sessions, get_session, create_session, update_session, close_session,
                       stop_session, interrupt_session, revert_session, compact_session, get_turn_diff
    messages.ts        send_message, implement_plan, read_transcript
    requests.ts        answer_question, dismiss_question, resolve_approval
    watch.ts           wait_for_session
    usage.ts           get_usage, get_cost
  todo-tools.ts        kept (scope params normalised, §7.9)
  fs-tools.ts          kept
```

Deleted: `terminal-control.ts`, `keys.ts` and their tests; `apps/daemon/scripts/mcp-spike.ts`.
Moved: `mcp/text.ts` → `apps/daemon/src/terminal-text.ts` (it is `sessions.ts`'s `captureText`
renderer, not MCP code). Shared code that moves *out* of the UI into `@orquester/api/agent-chat`
because the daemon now needs it too: the plan-implementation prefix and its "is the plan
implemented" test (`packages/ui/src/lib/agent-chat/plan.logic.ts`), and the claudex/claudemix
launch-model derivation (`packages/ui/src/components/topbar/NewTabMenu.tsx:255-310`) as a pure
function of `CliProxyStatus` + the proxy catalogue. Each moves with its tests; the UI imports the
shared copy.

### 4.5 Result and error conventions

- A tool result is one JSON **object** (never a bare array), returned as `structuredContent` and
  as the same JSON in a single text content block. Lists are wrapped: `{sessions: [...]}`.
- Every tool that mutates a session returns the session's fresh view under `session`, so the caller
  sees the effect without a second call. Commands also return the host's `seq`.
- Errors are `isError: true` with text `<CODE>: <message>` and `structuredContent {code, message,
  detail?}`. Daemon codes pass through unchanged (`THREAD_NOT_FOUND`, `COMMAND_REJECTED`,
  `COMPACTION_UNAVAILABLE`, `HOST_UNAVAILABLE`, `RESUME_UNAVAILABLE`, `SESSION_UNAVAILABLE`,
  `UPLOAD_TOO_LARGE`, `INVALID_COMMAND`, `COMMAND_ID_CONFLICT`). MCP-level codes: `INVALID_ARGUMENT`,
  `PROJECT_NOT_FOUND`, `SESSION_NOT_FOUND`, `NOT_A_CHAT_SESSION`, `PENDING_REQUEST`,
  `SESSION_BUSY`, `PATH_NOT_ALLOWED`, `INTERNAL`. `INTERNAL` never carries a path or stack; the
  detail is logged server-side (as today's `toSafeToolError`).
  *Built: the todo store adds `NOT_FOUND` (a list id that does not exist; the message names the id:
  `No todo list with id "<id>"; list_todos shows the ids.`) and `CONFLICT` (its 409),
  through `result.ts`'s `TodoError` mapping, which `TodoTools` lets through. A daemon answer that
  names no code maps by status (`errors.ts`): 401 `UNAUTHORIZED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`,
  409 `COMMAND_REJECTED`, 413 `UPLOAD_TOO_LARGE`, 429 `TOO_MANY_ATTEMPTS`, 502/503
  `HOST_UNAVAILABLE`, any other 4xx `INVALID_ARGUMENT`, any other 5xx `INTERNAL`. The SDK's own
  `tools/call` handler is replaced (public `server.setRequestHandler`), so an argument the tool's
  schema refuses answers this envelope too (`INVALID_ARGUMENT` naming up to five bad fields, each in
  at most 200 characters, so a huge value zod echoes back is cut with "…") and a call
  with no `arguments` object takes the defaults; the schema is strict at the top level (`server.ts`
  `argumentsSchema`): an argument name the tool does not take is refused and named, never dropped
  (`tools/list` already advertised `additionalProperties: false`), while a nested object keeps its
  own mode (an attachment is strict; `create_session.resume` still drops an unknown key); an unknown
  tool name is JSON-RPC InvalidParams (−32602), deliberately — SDK 1.29's own handler would answer
  an `isError` result. A message quotes at most 100 code points of a todo list id, a todo item, an
  unknown tool's name, an unknown model slug or a request tool's values — five of those at most,
  then a count (`result.ts` `clipText`, `MAX_ECHO_CHARS`); other messages quote the value whole,
  bounded only by the cap below. A todo refusal JSON-escapes its quote (up to 602 characters when
  every code point is a control character or a lone surrogate) and lists at most 40 of the list's
  items, each cut to 70 code points — 3 701 characters at worst for a 3 000-item list, so the cap
  never cuts its tail — and `toSafeToolError` caps every message at 4 000 code points, so no
  argument can make a large error.*
- **Retries.** A command that answers 503 `HOST_UNAVAILABLE`, or whose in-process call throws, is
  retried with the **same `commandId`** up to 3 times at 250 ms · 2ⁿ (≤ 4 s) — the GUI's rule
  (`packages/ui/src/lib/agent-chat/store.ts:546-587`). Any other rejection is final.
- **Size.** Every result's text is capped at 60 000 UTF-8 bytes (Claude Code discards MCP results
  above ~25k tokens). Each tool sheds in a fixed, documented order and reports `truncated: true`
  plus what was cut; `read_transcript` and `get_turn_diff` take explicit `maxChars` bounds.
  *Built: `get_turn_diff` takes no `maxChars` — its diff is bounded by the result budget itself,
  with `truncated`, and its file list keeps its head (`filesTruncated`, §7.2). `get_cost`,
  `list_files`, `list_todos`, `read_file`, `list_agents`, `list_conversations`, `search_sessions`
  and every session detail bound themselves too (§6.2, §6.3, §7.1, §7.2, §7.8, §7.9). A result
  still over the cap keeps its leading bytes, never cutting a character, and ends with
  `… [truncated: N bytes over the 60 000-byte cap]`; its `structuredContent` is then only
  `{truncated: true, truncationNote}`.*
- **Annotations.** `readOnlyHint` on every list/get/read/wait/usage/file tool; `destructiveHint`
  on `close_session`, `revert_session`, `delete_todo`; `idempotentHint` on reads and on
  `update_session`, `stop_session`, `interrupt_session`, `compact_session` (*Built: and on
  `close_session`, `revert_session`, `delete_todo` — the destructive ones — and `update_todo`; but
  not on `interrupt_session`, whose retry after the turn has stopped goes on to stop the background
  work, nor on `compact_session`, whose retry compacts again*). Every parameter has a
  `.describe()`; every tool has a `title`. Tool descriptions stay under ~400 characters and
  carry no TUI guidance. *Built: `openWorldHint: false` on every read/wait/usage/file tool and on
  the five todo tools, which touch only the daemon's own state; the tools that drive an agent keep
  the default.*
- **Instructions** (≤ 2 KB): what a session is, how addressing works, "call `list_agents` for valid
  values", "use `wait`, never poll", "percentages are % used", "attachments are inline".
- Server identity: `{name: "orquester", version: "2.0.0"}`.

---

## 5. Conventions

**Names.** Tools are `verb_noun` in snake_case; parameters and result fields are camelCase. One
noun per concept: `session` (a tab; a chat tab is a thread), `agent` (a launchable registry entry,
its `refId`: `claude`, `claudex`, `claudemix`, `codex`, `opencode`, `grok`), `project`,
`workspace`, `conversation` (a resumable provider transcript), `question` / `approval` (pending
requests), `todo`, `file`. The same concept has the same parameter name everywhere: `sessionId`,
`project`, `workspace`, `agent`, `accountId`, `model`, `options`, `runtimeMode`, `planMode`,
`requestId`, `timeoutMs`, `wait`, `after`, `path`, `attachments`.

**Addressing.**

- `sessionId` — the tab id (`SessionSummary.id`, equal to the thread id). No title matching, no
  `(workspace, project, tab)` triples: titles are not unique and were the source of v1's
  `AmbiguousTab` errors. `list_sessions` is the discovery step.
- `project` — either the absolute path as `list_projects` returns it, or the short form
  `"<workspace>/<project>"`. `resolveProject()` (in `addressing.ts`) accepts both: names must pass
  `isValidName` and the joined `<workspacesDir>/<ws>/<name>` must be a directory; a path must
  `realpath` inside `fsRoot` and exist. The canonical `path` handed to the daemon is the plain
  joined path (names) or `path.resolve(input)` without a trailing slash (path) — the same string the
  GUI uses, because `GET /api/sessions?projectPath=` matches exactly.
- A session's `project` is reported back as `{workspace, name, path}`; `workspace`/`name` are
  `null` when the path is not `<workspacesDir>/<ws>/<name>`.

**Option ids.** Model options are exposed and accepted as an object `{id: value}` (the wire's
`[{id, value}]` array is an implementation detail). `effort` is the canonical spelling of the
reasoning-effort option for every adapter and is mapped to the adapter's real descriptor id
(`effort` for Claude and Codex, `variant` for OpenCode, `reasoningEffort` for Grok); the real id is
also accepted. `list_agents` reports the real ids next to `effortOptionId`.
*Built: a listed model without option descriptors takes no options — any is refused
`INVALID_ARGUMENT` (`<model> takes no options.`), as the GUI shows it no chips (Claude's `haiku`);
claudex's proxy models carry the options of the Claude catalogue's default model (the composer's
`resolveSelectedModel` fallback), so their effort is checked against it (while Claude's own
catalogue is still the pending fallback, whose models carry no descriptors, claudex's models take
none either — the composer shows no chips then); only an empty catalogue, still being probed,
passes options through unchecked, for the host to judge.*

**Values.** `runtimeMode` is the wire enum verbatim: `approval-required` (Supervised),
`auto-accept-edits` (Accept edits), `auto` (Auto), `full-access` (Full access; the default, as in
the GUI). `planMode` is a boolean (the wire's `interactionMode: "plan" | "default"`). Approval
`decision` is the wire enum verbatim.

---

## 6. Shared views

Defined once in `views.ts`; every tool that returns a session returns one of these two.

### 6.1 `SessionView` (light — from `SessionSummary` only)

```
{
  id, kind: "chat" | "terminal",           // terminal = shell tabs + legacy "agent" tabs
  agent: <refId>, adapter?: "claude"|"codex"|"opencode"|"grok",   // adapter on chat only
  title, project: { workspace, name, path }, cwd, createdAt, order,
  status: "working" | "waiting" | "idle",  // SessionSummary.activity.state, verbatim
  attention: "needs-input" | "finished" | "bell" | null,
  needsAttentionAt: ISO | null,
  reason: "approval" | "question" | "plan-ready" | "error" | "starting" | "running"
        | "background-working" | "monitoring" | "completed" | "new" | "exited" | null,
  chat?: { sessionStatus: "idle"|"starting"|"ready"|"running"|"stopped"|"error",
           accountId: string,              // "system" for the daemon's own login
           latestTurn: { turnId, state, startedAt, completedAt } | null,
           pending: { approvals: boolean, questions: boolean },
           planReady: boolean, backgroundLiveness: "working" | "monitoring" | null },
  terminal?: { status: "running" | "exited", exitCode?: number, legacyAgent?: boolean }
}
```

`status`, `attention` and `needsAttentionAt` are the daemon's own values — the same the tab strip
and the Attention Center render. `reason` is the ladder's rung (`resolveChatActivity`) with two
additions: `"new"` for a chat tab that has never run a turn (`chatSessionStatus:"idle"` and no
`latestTurn` — the ladder calls that "completed/finished", which is a GUI quirk the MCP does not
repeat), and `"exited"` for an exited terminal tab.

### 6.2 `SessionDetail` (full — adds the thread snapshot)

`SessionView` plus:

```
chat: { …SessionView.chat,
        model: string, options: { [id]: string | boolean }, runtimeMode, home: "system"|"account"|"cliproxy",
        accountLabel?: string, activeTurnId: string | null, turnCount: number, lastError?: string,
        continueAfterRestart?: boolean,   /* Built: always present */
        contextWindow?: { usedTokens, maxTokens?, percentUsed?, compactsAutomatically? },
        supports: { planMode, rollback, compaction, backgroundTasks } },
pending: { approvals: PendingApprovalView[], questions: PendingQuestionView[] },
plan?: { planId, markdown /* ≤ 16 KiB, truncated flag */, actionable: boolean },
subagents: SubagentView[], subagentsTruncated?,  /* Built */
lastReply?: { turnId, text /* main agent's assistant text of the latest settled turn, ≤ 16 KiB */, completedAt }
           /* Built: plus `truncated` when cut; the 16 KiB caps here and in §7.4 are 16 384 characters, not bytes;
              a detail that would still pass the result cap once its subagent rows are shed cuts
              `lastReply.text`, then `plan.markdown`, by bytes on a code-point boundary, each marked
              `truncated` (send_message's `replyTruncated`), only as far as it needs to */
```

```
PendingApprovalView = { requestId, kind: "command"|"file-read"|"file-change"|"mcp-elicitation"|"permission",
                        createdAt, detail?, appName?, tool?: { name, input },
                        decisions: [{ decision, label, warning? }] }
                      // decisions = the provider's advertised options, else the GUI's default four:
                      // accept "Approve", acceptForSession "Always allow this session", decline "Decline", cancel "Cancel"
PendingQuestionView = { requestId, createdAt, turnId?, responseMode: "blocking" | "message", dismissible,
                        questions: [{ index /* 1-based */, id, header, question,
                                      options: [{ label, description, value? }],
                                      multiSelect, allowCustomAnswer, isSecret?, isOther? }] }
SubagentView        = { id, kind, agentKind: "agent"|"background", title, status, model?, effort?,
                        progress?, lastToolName?, startedAt, completedAt, error? }
```

`tool.input` for an approval comes from the raw `approval.requested` activity's `payload.args`
(Claude: `{toolName, input}`); `isSecret`/`isOther` come from the raw `user-input.requested`
payload, because the derived `pending` drops them (`packages/api/src/agent-chat/pending.ts:142-186`).
*Built: `lastReply` is the main agent's answer — Codex's commentary messages (`messageKind:
"commentary"`) are left out — and `contextWindow.percentUsed` is clamped to 100 while
`usedTokens` stays raw.*
*Built: `plan.actionable` is judged on the snapshot with the host's rule (`proposedPlan`,
transcript.ts — the one helper behind `plan.actionable`, `read_transcript`'s plan rows and
`implement_plan`), never on the summary's `hasActionableProposedPlan`, which trails by one poll;
`chat.planReady` and `reason` stay the summary's. A subagent's `title`, `progress` and `error` are
capped at 200 code points, and a detail over 59 000 bytes (the cap less 1 000 for a tool's other
fields) drops subagent rows — settled first, oldest first, then live, read_transcript's rule — with
`subagentsTruncated: true`; a detail that would still pass the result cap once its subagent rows
are shed cuts `lastReply.text`, then `plan.markdown`, by bytes on a code-point boundary, each
marked `truncated` (send_message's `replyTruncated`), only as far as it needs to; send_message and
implement_plan fit it again beside the `pending` they return twice. Every other field stays
whole.*

A terminal session's `get_session` is its `SessionView` plus `terminal`; there is no transcript.

### 6.3 `AgentView` (`list_agents`)

```
{ id: <refId>, name, adapter, enabled, disabledReason? /* Built */, installed, version, status, message?,
  auth: { status: "authenticated"|"unauthenticated"|"unknown", label?, email? },
  models: [{ slug, name, shortName?, isDefault, isLegacy?, providerLabel? /* Built */,
             options: [{ id, label, type: "select"|"boolean", description?,
                         values?: [{ id, label, description?, isDefault? }] }]
                      /* Built: or optionsOmitted: true */ }],
  modelsTruncated?, modelCount?,   /* Built */
  effortOptionId: string | null,   /* Built: always a string */
  runtimeModes: ["approval-required","auto-accept-edits","auto","full-access"], defaultRuntimeMode: "full-access",
  supports: { planMode, rollback, compaction, backgroundTasks, contextWindow },
  accounts: [{ id, label, email, plan, needsReauth, isDefault }],   // + { id: "system", label: "System" } first
  defaultAccountId }
```

For `claudex`, `models` is the proxy launch catalogue the `+` menu offers (the shared
derivation of §4.4: `defaultModel`, the curated proxy list, keyed router providers' models and
aliases, xAI models while linked); for `claudemix` — the Claude main loop through the proxy —
`models` is the **Claude adapter's** catalogue exactly as for `claude` (the `+` menu shows model
chips only for claudex and resolves claudemix's selection from the Claude provider snapshot).
For both, `accounts` are the **seeded** accounts of the backing family (codex for claudex, claude
for claudemix), because that is what the daemon's create and account routes accept.
*Built: the first draft gave claudemix the proxy catalogue too, which would have launched
claudex's GPT `defaultModel` on a Claude credential (`cliproxy.ts` `validateModel`: "the UI never
sends a model for claudemix"); only claudex launches a proxy model (`launchesProxyModel`).*
*Built: claudex's proxy models carry the option descriptors of the Claude adapter's default model,
as the composer offers them (`resolveSelectedModel`); `list_agents {agent, model}` finds a legacy
model too, but `create_session` refuses one — it serves only an existing session
(`update_session`). A claudex model served by a keyed router provider, or by a linked xAI account,
carries that provider's label as `providerLabel` (`proxyLaunchModels`; `"Grok account"` for xAI) —
the models the `+` menu marks keyless, dimming their account chip; a curated proxy model has none.*
Pending provider snapshots (`status:"unknown"`) are reported as they are; a
`models: []` means "still probing — retry", exactly as the GUI's "Still loading this agent's
models".
*Built: the list fits one result: over it, the options of non-default models go first (largest
catalogue first, each from the end of its list, then marked `optionsOmitted`), then whole
non-default models the same way, largest catalogue first (`modelsTruncated`, `modelCount`); the
header and the default model (the flagged one, else the first) are never shed.
`list_agents {agent, model}` returns one model whole. `loadAgents` never trims: create_session and
update_session read the full catalogue. `disabledReason` is the registry's runtime reason (e.g.
"proxy down"), present only on a disabled agent.*

### 6.4 `UsageView` (`get_usage`)

```
{ agents: [{ id: "claude"|"codex"|"grok", name: "Claude Code"|"Codex"|"Grok Build",
             available, stale, asOf?, ageMinutes?, plan?,
             accounts: [{ id, label, plan?, available, stale, asOf?, ageMinutes?, needsReauth?, email?,
                          windows: [{ id: "session"|"weekly"|"scoped:<label>", label: "5h"|"Week"|<label>,
                                      percentUsed, resetsAt?, resetsIn? /* "4h 44m" */ }] }],
             system?: <same row shape, id "system", label "System">,
             windows?: <the rows' windows shape>,   /* Built */
             aggregate?: { strategy, accountCount, staleAccountCount? } }] }
```

This is the top-bar widget's data, row for row (`UsageWidget.tsx` → `normalizeUsageWindows`),
joined with `GET /api/agent-accounts` for `needsReauth` and `email`.
*Built: an agent with neither an account row nor a system row carries the family-level reading as
its own `windows` (`usage-view.ts`), so its quota still shows; with either row present it has
none.*

---

## 7. Tools

Input schemas are zod; `?` marks optional. "GUI" names the surface the tool mirrors.

### 7.1 Catalogue

| Tool | Input | Output | Calls |
|---|---|---|---|
| `list_projects` | `workspace?`, `includeArchived? = false` | `{projects: [{workspace, name, path, isArchived, lastInteractedAt?, openSessions}], warnings?: string[]}` — recent first, then alphabetical | `GET /api/workspaces`, `GET /api/workspaces/:ws/projects`, `GET /api/projects/recent`, `GET /api/sessions` |
| `list_agents` | `agent?`, `model?` (with `agent` — *Built*), `includeLegacyModels? = false` | `{agents: AgentView[]}` — only registry entries with `chat.adapter` | `GET /api/registry`, `GET /api/agent/providers`, `GET /api/agent-accounts`, `GET /api/cliproxy`, `GET /api/cliproxy/models` |
| `list_conversations` | `project`, `agent?`, `limit? = 20` | `{conversations: [{id, agent /* launch refId */, title, preview?, updatedAt, home, accountId?, resumable}], truncated?, omitted?}` (`truncated?, omitted?` — *Built*) | `GET /api/agents/conversations?path=` |

`list_conversations.agent` is `proxyRefId` when `home` is `cliproxy`, else `agentRefId`
(`session-kind.ts:106-111`); `resumable` is "that refId has a chat adapter". The row's `id` is what
`create_session.resume.conversationId` takes.
*Built: `warnings` appears only when there is something to say — a workspace whose projects
cannot be read is left out and named there (fail-soft, as `/api/agents/conversations` is), and a
`workspace` filter naming an archived workspace without `includeArchived` says why the list is
empty. An unknown or empty `workspace`/`agent` filter is refused (`INVALID_ARGUMENT`) rather than
answering an empty list. `resumable` also needs the row to be reachable — a `cliproxy` row that
names no `proxyRefId` is `false`, and `create_session` refuses it (`conversationLaunch`,
`agents.ts`) — and its launch agent to be enabled (the GUI's `isResumableByInstalledAgent`); rows
past the result cap are left out, oldest first (`truncated`, `omitted`; `limit` stays ≤ 200);
OpenCode history is never listed (`agent-conversations.ts` `listOpencode()` returns `[]`), so an
OpenCode conversation cannot be resumed, in the GUI either; a registry that cannot be read is
`INTERNAL`, never a list of unresumable rows.*

### 7.2 Sessions — read

| Tool | Input | Output |
|---|---|---|
| `list_sessions` | `project?`, `kind? = "all"` (`"chat"`\|`"terminal"`\|`"all"`), `attention? = false` | `{sessions: SessionView[]}`. With `attention:true`: only sessions whose `attention` is set or whose `status` is `waiting`, ordered like the Attention Center (`needsAttentionAt` desc — *Built: `byAttention` (`tools/watch.ts`), shared with `wait_for_session`: by the instant of `needsAttentionAt`, else `createdAt` for an unstamped row, a tie going to the newer tab*); otherwise by project, then `order`. *Built: an empty `project` is refused (`PROJECT_NOT_FOUND`), never read as every project.* |
| `get_session` | `sessionId` | `{session: SessionDetail}` (`SessionView` + `terminal` for a terminal tab) |
| `read_transcript` | `sessionId`, `turns? = 3`, `agentId?`, `include? = ["tools","activity"]` (`"reasoning"` opt-in), `maxChars? = 40000` (≤ 55 000 UTF-8 bytes — *Built*, §7.6) | `{entries: TranscriptEntry[], turnCount, coveredTurns: [from, to] \| null, truncated, subagents: [{id, title, status}], subagentsTruncated?, hint?}` — §7.6 |
| `get_turn_diff` | `sessionId`, `turn?` (default: the latest checkpointed turn) | `{turn, fromTurn, files: [{path, additions, deletions}], filesTruncated?, omittedFiles?, diff, truncated}` (`diff` ≤ 80 000 chars — *Built: the file list gets max(20 000 JSON bytes, what the whole diff leaves unused) and keeps its head, `filesTruncated` and `omittedFiles` counting the rest; the diff gets whatever is left of the 60 000-byte result*) |
| `search_sessions` — *added after v2 shipped (2026-09-23)* | `query` (trimmed, then 1–200 UTF-16 code units, `THREAD_SEARCH_MAX_QUERY_CHARS` — refused, never cut), `project?`, `limit? = 20` (1–50, `THREAD_SEARCH_MAX_RESULTS`) | `{query, hits: [{sessionId, title, projectPath, turn, kind, role?, activityKind?, snippet, at}], truncated, omittedHits?, indexed, hint?}` — the command palette's `?` search. `GET /api/agent/search?q=&limit=&projectPath=` (`project` resolved as `list_sessions`' is), then only the hits whose `threadId` is a chat session open now (`GET /api/sessions`): a terminal tab's id or a closed tab's is not addressable, so it is dropped. `title` and `projectPath` are the session's own, as `list_sessions` shows them; `turn` is the hit's `ordinal` (null for a turnless row); `role` only on a message hit, `activityKind` only on an activity hit; `snippet` keeps the host's `«`/`»` marks. `indexed: false` is an answer — no hits and a `hint` that search is unavailable on this host right now; a non-2xx is an error through `daemonError`. Bounded like every tool: each title and snippet cut to 300 code points (ending in `…`), then the lowest-ranked hits dropped from the end, with `truncated: true` and `omittedHits`; `truncated` is also the host's own "more hits than `limit`". A hit is opened with `read_transcript {sessionId, beforeTurn: turn + 1, turns: 1}`. Annotated as a read (`openWorldHint: false`). |

### 7.3 Sessions — lifecycle

**`create_session`** — GUI: the `+` menu row, and its resume picker.

```
input:  project, agent (required unless resume), model?, options?: {[id]: string|boolean}, runtimeMode? = "full-access",
        accountId?, title?, cwd?, resume?: { conversationId }
output: { session: SessionDetail }
```

Validation, all before anything is created, each an `INVALID_ARGUMENT` / `PROJECT_NOT_FOUND` naming
the valid values: `project` resolves; `agent` is a registry entry with `chat.adapter` and
`enabled`; `model` is in the agent's catalogue (default: the catalogue's `isDefault` model, else
its first; `claudex`: the proxy catalogue, default `defaultModel`; `claudemix`: the Claude catalogue, like `claude`); every `options` id
is a descriptor of that model and its value one of the descriptor's choices (booleans for
`boolean` descriptors); `runtimeMode` is one of the four; `accountId` is `"system"` or an account
of the agent's family (seeded, for claudex/claudemix) — **checked here because the daemon silently
falls back to the system home on a bad id**; `cwd` (default: the project path) realpaths inside
`fsRoot`; at most **24 running sessions** in the project (an MCP-only guard against runaway
loops — the GUI has no cap). For `resume`, the conversation must be listed by
`list_conversations` for that project: its row supplies the launch `agent` (`agent` may then be
omitted; if given it must match), `resume.home`, and the account exactly as the GUI's `resumeAccountId` decides it
(`account` home → the row's account, forced; `system` home → the caller's `accountId`, else omitted so
the daemon applies the family default exactly as the GUI's chip pre-selects it — *Built: the first
draft said `?? "system"`; forcing the system home there is the stale-login resume bug AGENTS.md
documents*), and `title` defaults to the conversation's title. Proxy launchers always get an explicit
`accountId` (the seeded family default, else `"system"`) because the daemon does not fall back for
them. *Built: an empty `agent`, `model` or `cwd` is refused by the schema (`min(1)`), never read as
the default; a disabled agent's refusal carries the registry's `disabledReason` when it has one
(`claudex is not available on this host: proxy down.`).* Then:

```
POST /api/sessions { kind:"agent-chat", refId: agent, projectPath, cwd, title,
                     accountId, model? /* claudex only: the same proxy model; never for claudemix */,
                     chat: { accountId, modelSelection: { model, options: [{id, value}…] }, runtimeMode, resume? } }
```

followed by `GET …/thread` to build the `SessionDetail`. `RESUME_UNAVAILABLE` / `SESSION_UNAVAILABLE`
pass through with the daemon's message (the "already open in tab X" case arrives as
`SESSION_UNAVAILABLE`, §14).

**`update_session`** — GUI: the model, effort/option, permission and account chips, and rename.

```
input:  sessionId, title?, model?, options?, runtimeMode?, accountId?, force? = false
output: { applied: string[], session: SessionDetail }
```

One tool for everything on the composer bar that is thread state (plan mode is per message, §7.4).
All checks run before any write: chat session; `model`/`options` validated against the catalogue
as in `create_session`, with `options` **merged** onto the head's current options (setting `effort`
keeps `thinking`), and options the new model does not advertise dropped, as the composer does;
`accountId` family-checked and refused with `SESSION_BUSY` unless the thread is idle — the same
predicate as the GUI's `canSwitchChatAccount` / the host's `identitySwitchRefusal` (no
starting/running session, no pending request, no unsettled turn, no background work) — and refused
outright for OpenCode; `model`/`options`/`runtimeMode` refused with `SESSION_BUSY` while a turn is
starting or running unless `force:true`, because a live Claude session restarts on any selection
change and every adapter restarts on a permission change, cutting the turn (`/mode` itself has no
gate; the GUI lets it happen — this is the one place v2 is deliberately stricter). Writes, in
order: `PUT /api/sessions/:id {title}`; **one** `POST …/mode {runtimeMode?, modelSelection?}`
carrying all of model/options/runtimeMode (atomic on the host); `POST …/account {accountId}`.
Fields that already hold the requested value are skipped. A write that fails mid-way returns the
error with `applied` so far in `detail`.

| Tool | Input | Output | Behaviour |
|---|---|---|---|
| `interrupt_session` | `sessionId` | `{seq, session}` | GUI Stop / Esc. `POST …/interrupt` with `turnId` = `activeTurnId` only while `chatSessionStatus === "running"`; without a running turn it stops every live subagent, background shell and watch loop (the host's rule). |
| `stop_session` | `sessionId` | `{seq, session}` | `POST …/session/stop`: stops the provider process, keeps the tab, log and resume cursor; the next `send_message` resumes. **The recovery path for a session in `error`** (`chat.sessionStatus` — *Built*; the host refuses every other command there but `revert`) — the GUI has no control for it. |
| `close_session` | `sessionId` | `{closed: true, sessionId}` | GUI close-tab. `DELETE /api/sessions/:id` for chat and terminal tabs alike; the chat thread directory is deleted, the provider's own transcript survives and stays resumable via `list_conversations` *Built: for Claude, Codex and Grok (and claudex/claudemix from their proxy homes); OpenCode history is not listed (`agent-conversations.ts` `listOpencode()` returns `[]`), so for OpenCode closing a tab is final*. |
| `revert_session` | `sessionId`, `keepTurns` | `{seq, session}` | GUI "Rewind the conversation to here". `POST …/revert {targetTurnCount: keepTurns}`; refused (`INVALID_ARGUMENT`) unless the adapter supports rollback (not Grok) and `0 ≤ keepTurns < turnCount`; refused with `SESSION_BUSY` while a turn is active (*Built: the busy case takes the same code every other tool uses for it*). Conversation only — files are not restored; the description says so. *Built: also refused with `INVALID_ARGUMENT` for a target before the last settled compaction marker, using the GUI's rule (`rows.logic.ts` `buildRevertTurnCountByUserMessageId`; the message names the `keepTurns` range still allowed, if any) — a turn whose rows retention evicted is placed by its own start against the marker's stamp, since the marker and the turn records outlive the window — and with `PENDING_REQUEST` while a request is open. The host answers `{seq}` before the rollback runs (an effect), so after the POST the tool waits, on bus events and 1 s thread re-reads, for at most 10 s. It returns `{seq, session}` once at most `keepTurns` turns are started (or the first dropped turn is gone). A new `checkpoint.revert.failed` row gives `COMMAND_REJECTED` with its reason (`Rewind failed: …`). The deadline gives `SESSION_BUSY`, whose text ("The rewind is still in progress — do not call revert_session again. …") says not to retry and how to tell the outcome (`chat.turnCount` against `keepTurns`; `read_transcript` for a failure). A session closed mid-wait gives `SESSION_NOT_FOUND`. Every error after the POST carries `detail.seq`.* |
| `compact_session` | `sessionId` | `{seq, session}` | GUI "Compact context". `POST …/compact`; the host's 409s (`COMPACTION_UNAVAILABLE` while a turn runs, `COMMAND_REJECTED` on an empty thread) pass through. |

### 7.4 Messages

**`send_message`** — GUI: the composer's Send.

```
input:  sessionId, text?, attachments?: Attachment[], planMode? = false, wait? = true, timeoutMs? = 120000 (≤ 600000)
output: { seq, turnId?, outcome: "sent"|"completed"|"needs-input"|"plan-ready"|"interrupted"|"failed"|"timeout",
          reply?: string, pending?: SessionDetail.pending, session: SessionDetail }
```

Preconditions: a chat session; `text` (≤ 120 000 chars after trim) or ≥ 1 attachment; ≤ 8
attachments; **no pending approval or question** (`PENDING_REQUEST`, listing them — the GUI's
"Answer the request above first"; the host would accept the message as a steer, the GUI does not,
and the MCP mirrors the GUI); the session is not in `error` (`SESSION_BUSY` pointing at
`stop_session`); `planMode` only where the adapter shows the plan toggle (OpenCode's plan agent is
`options.agent = "plan"`). Attachments are uploaded first (§8). Then
`POST …/turn {commandId, input, attachments?, interactionMode}`. While a turn is running the message
**steers** it — the same as pressing Enter mid-turn with the default preference — and the result
says so (`turnId` is the running turn's). `wait:false` answers `outcome:"sent"` with the receipt.
`wait:true` blocks per §9.1 and fills `reply` (the main agent's assistant text of the settled turn,
≤ 16 KiB, `truncated` if cut — `read_transcript` has the rest) or `pending`.
*Built: the cut flag is `replyTruncated`. `reply` and `turnId` belong to the turn this message
started or steered: a turn already settled when the message is posted (in the snapshot the send
was checked on, or in the summary read just before the POST) never supplies them. A host restart
during a retried POST can still attribute the steered turn (a rare race; compare `turnId` with
`session.chat.latestTurn`).*

**`implement_plan`** — GUI: the composer's **Implement** button on a proposed plan.

```
input:  sessionId, wait? = true, timeoutMs?
output: same as send_message
```

Refused unless the session has an actionable proposed plan and no pending request. Sends the exact
message the GUI sends — `PLAN_IMPLEMENT_PREFIX + "\n" + planMarkdown.trim()` with `planMode:false`
— using the prefix constant shared with the UI and the host's `hasActionableProposedPlan`
(§4.4). Refining a plan is `send_message {planMode:true, text}` (the **Refine** button).
*Built: actionability is decided from the thread snapshot with the host's own rule (the latest
plan, unless a later user message implemented it), not from the lagging summary flag, so a second
call cannot send the plan twice; the same helper (`proposedPlan`) decides `get_session`'s
`plan.actionable` and the transcript's plan rows; a plan slimmed on the wire (`truncated`) is read
back whole from `GET …/items/:itemId` first, and a failed read-back sends nothing.*

### 7.5 Pending requests

The three tools share: `requestId` may be omitted when exactly **one** request of that kind is
pending (else `INVALID_ARGUMENT` listing the ids) *Built: an empty `requestId` is refused
(`min(1)`), never read as omitted*; the request must be pending on that session; the result is
`{seq, session}`. *Built: a refusal quotes the caller's values each cut to 100 code points, at most
five, then a count.*

**`answer_question`** — GUI: the question card's Submit.

```
input:  sessionId, requestId?, answers: { [questionIdOrIndex]: string | string[] }, attachments?: { [questionIdOrIndex]: Attachment[] }
```

Keys are the question `id`s as `get_session` reports them, or their 1-based `index` (exact id match
wins). Validation per question: every question of the request must be answered (the GUI requires
all before Submit) unless it is answered by attachments alone (`""`); a `multiSelect` question takes
an array (a lone string is wrapped); a single-select takes a string (a one-element array is
unwrapped); a selection must equal an option's `value` or `label`, or — when `allowCustomAnswer` is
not `false` — is sent verbatim as the custom answer (a non-empty custom answer beats selections, as
in the GUI); `isSecret` questions accept no attachments. The wire body is the GUI's:
`answers[q.id] = value ?? label | string[] | "<custom>"`, `attachmentsByQuestionId` per question
(§8). A `responseMode:"message"` (Codex async) question is answered the same way; the host turns
it into a user message that echoes each question before its answer, and steers or starts a turn.
*Built: every problem is reported in one pass; files count as an answer only where files are
allowed (`allowCustomAnswer` and not `isSecret`); every question's files are validated and uploaded
in ONE batch (a bad file anywhere uploads nothing), and a refusal names the question and its file
index. A `multiSelect` answer that carries files reaches the agent as its selections, the array
kept, with the `Attached file:` lines as one more entry.*

**`dismiss_question`** — GUI: the card's Dismiss (offered only for `responseMode:"message"`).
`POST …/dismiss`; the host's `COMMAND_REJECTED` for a blocking question passes through with its
message ("answer it or stop the turn"). *Built: the tool refuses a blocking question itself
(`INVALID_ARGUMENT`) and sends nothing, so the host's refusal is never reached.*

**`resolve_approval`** — GUI: Approve / Decline and the overflow menu.

```
input:  sessionId, requestId?, decision: "accept"|"acceptForSession"|"acceptAlways"|"decline"|"cancel"
```

`decision` must be one of the request's `decisions` (`INVALID_ARGUMENT` otherwise). The tool
description carries the two provider quirks the GUI shows as warnings: on Claude `acceptAlways`
denies ("cannot grant a permanent permission from here"); on OpenCode `acceptForSession` and
`acceptAlways` both mean `always` (directory-wide).

### 7.6 `read_transcript` — entries

Built from the snapshot's `items` and `turns` (already folded by the host); nothing is re-derived
from events. Each entry:

```
{ turn: number | null, turnId, kind, createdAt, agentId?,
  kind = "user"      → text, attachments?: [{name, type}]
       | "assistant" → text                       (messageKind commentary/answer both included)
       | "reasoning" → text                       (only with include "reasoning")
       | "tool"      → tool: { type /* itemType */, title, status, command?, detail?, changedFiles? }   // one entry per toolUseId, latest state
       | "approval"  → requestId, kind, detail?, decision?           (open or resolved)
                       /* Built: requestKind?, text? (≤ 2 000 chars), decision? */
       | "question"  → requestId, questions: [header…], answered: boolean
                       /* Built: questions? — each question's text, else its header */
       | "subagent"  → subagent: { id, title, status }                 (task anchors, parent view only)
       | "plan"      → text (planMarkdown), actionable
       | "changes"   → files: [{path, additions, deletions}]           (checkpoint per turn)
       | "compaction"→ state, beforeTokens?, afterTokens?
       | "error" | "warning" | "info" → text }
```

The parent view is the GUI's quiet timeline: items without `agentId`, plus each subagent's anchor.
`agentId` selects the drill-in: only that agent's own items (`splitThreadItems` semantics).
*Built: an empty or unknown `agentId` is refused (`INVALID_ARGUMENT`), never read as the parent
view.* `turns` counts back from the latest turn; `coveredTurns` says what was included. Shedding
order when over `maxChars`: reasoning → tool `detail` → oldest turns; `truncated:true` and a hint
to raise `turns` or use `get_turn_diff`. *Built: the hint says raise `maxChars`, include less, or use `get_turn_diff`.*
*Built: `maxChars` is a budget in UTF-8 bytes of the WHOLE result (max 55 000, because every
result is capped at 60 000 bytes), and a result that fits comes back whole. Otherwise 320 bytes
are held back for the `hint`, the subagent list gets at least a quarter of the rest when it needs
it and whatever the entries leave unused (settled rows dropped oldest first, then live ones;
`subagentsTruncated: true`, and the hint says `get_session` may list more of it — `get_session`
trims its own subagent list when its detail would pass the cap), and the entries shed reasoning,
then tool detail, then their oldest rows — never the latest turn's final
reply (else its newest row), which is cut last: its longest text field first, and its lists
(a checkpoint's `files`, a tool's `changedFiles`, a message's `attachments`) down to a head plus one
marker element of the same shape that counts the rest (`{path: "…N more files", additions,
deletions}` carries the omitted files' real line totals). Whatever the fitted entries leave unused
goes back to the subagent list in one more pass. Subagent titles are capped at 200 code points.
`coveredTurns` names only the turns with rows present (null when none).*

### 7.7 Waiting

**`wait_for_session`** — GUI: the Attention Center.

```
input:  sessionId? | project?  (neither = every session), after? (ISO; default: now), timeoutMs? = 120000 (≤ 600000)
output: { sessions: SessionView[], cursor: ISO, timedOut: boolean }
```

Semantics in §9.2. The result's `cursor` is what the next call passes as `after`; a caller that
loops `wait_for_session → act → wait_for_session` never sees the same event twice and never misses
one that landed between calls.

### 7.8 Usage

| Tool | Input | Output | Calls |
|---|---|---|---|
| `get_usage` | `refresh? = false` | `UsageView` (§6.4) | `GET /api/usage[?refresh=1]`, `GET /api/agent-accounts` |
| `get_cost` | `days? = 7` (≤ 90) | `{asOf, days, totalUsd, byDay: [{day, usd}], rows: [{agent, model, day, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}]}` — the Cost tab | `GET /api/usage/tokens` |

`get_usage`'s description keeps v1's rules: percent is **% used**; an absent family is not logged
in; `stale:true` with no `asOf` is "logged in, no reading yet"; `refresh:true` may still return
last-known data and must never be called in a loop.
*Built: `get_cost` rows are newest day first and `costUsd` is rounded to 4 decimals (an unpriced
model's stays `null` and counts as $0 in the totals). The result bounds itself at 50 000 UTF-8
bytes by dropping whole oldest days of rows (`truncated: true`, `rowsDropped`), while `byDay` and
`totalUsd` still count every row.*

### 7.9 Todos and files — kept, normalised

Todo lists are a shared GUI surface (the Todo tab) and stay. Their scope parameters follow §5:
`list_todos {workspace?, project?}`, `create_todo {workspace?, project?, name}` — exactly one of
`workspace` / `project` (*Built: each `min(1)`; an empty one is refused, never read as the other
scope*), with `project` resolved by `resolveProject()`; `update_todo {id, name?,
body?}`, `delete_todo {id}`, `toggle_todo_item {id, item, checked?}` are unchanged. `list_files
{path}` and `read_file {path, offset?, maxBytes?}` are unchanged (sandboxed to `fsRoot`).
*Built: `read_file` returns `nextOffset` whenever `truncated` is true, and the next window starts
there. A window may cover fewer than `maxBytes` bytes: it ends on a UTF-8 character boundary and
shrinks until the result fits the 60 000-byte cap; a `maxBytes` smaller than the character at
`offset` returns that one whole character (up to 4 bytes). `list_files` is byte-bounded too: past what one
result holds (or 500 entries) it drops the entries after the last that fits and sets `truncated`.
`list_todos` drops its oldest lists when they do not all fit (`truncated: true`, `omittedLists: n`);
a newest list too big on its own keeps the head of its body, marked `bodyTruncated: true` —
incomplete, never to be written back whole. `update_todo`, `toggle_todo_item` and `create_todo`
bound their results the same way (`fitBody`, `tools/todos.ts`): on a list too big for one result
the body is cut to its head and marked `bodyTruncated: true`, while the id, the name and a toggle's
item and new `checked` stay whole, so a successful write never reads as a failed one (a retried
flip would undo it); only a name or item of tens of KB that leaves no room even for an empty body is
cut too, to 200 code points. These write tools report the cut as `bodyTruncated` (inside `todo` for
`update_todo`, at the top level for the toggle), not as the §4.5 `truncated` flag. The write itself
is always whole. `update_todo`'s `body` says never to
send a body marked `bodyTruncated`. `toggle_todo_item` is not idempotent (omitting `checked` flips
the item; passing it makes a retry harmless), so its `idempotentHint` is `false`.*

### 7.10 Tool count and mapping to the GUI

29 tools: catalogue 3 · sessions 14 (`list_sessions`, `get_session`, `read_transcript`,
`get_turn_diff`, `create_session`, `update_session`, `interrupt_session`, `stop_session`,
`close_session`, `revert_session`, `compact_session`, `send_message`, `implement_plan`,
`wait_for_session`) · requests 3 · usage 2 · files 2 · todos 5. *Built: 30 — search 1
(`search_sessions`, the command palette's `?` search, added after v2 shipped, §7.2), listed in
`tools/list` between `compact_session` and `send_message`.* Every composer chip, banner
button, header action and `+`-menu action in the chat GUI maps to exactly one of them; the only
GUI-reachable chat action without a tool is Ctrl+B "run this command in the background"
(`/background`, Claude only) — omitted as YAGNI, trivially addable.

---

## 8. Attachments

### 8.1 Input shape

```
Attachment = { path: string }                                        // a file inside fsRoot; name = basename, mime by extension
           | { name: string, base64: string, mimeType?: string }     // inline bytes (mime by extension when omitted)
```

Accepted by `send_message.attachments` and `answer_question.attachments[question]`. There is no
separate upload tool and no reusable attachment id: "attach a screenshot to this message" is one
call.

### 8.2 Limits (the host's, re-checked here for a clear error)

≤ 8 per message and per question; images (`image/gif|jpeg|png|webp` by mime **or** by extension)
≤ 10 MiB; other files ≤ 50 MiB; `/mcp` body ≤ 16 MiB, so an inline attachment above ~12 MiB must
be passed by `path`. A `path` must realpath inside `fsRoot` (`PATH_NOT_ALLOWED` otherwise — the
same rule as `read_file`).

### 8.3 Upload

Each attachment is streamed through `DaemonApi.uploadAttachment` (the host claims the file into
the thread's attachment namespace and mints the id) and the returned `AttachmentRef` goes into
`turn.attachments` / `attachmentsByQuestionId` verbatim. Uploads happen before the command; a
failed upload fails the whole call before anything is sent.

### 8.4 Non-image files — one host fix, in scope

The audit found that the Claude, Codex and (for non-image/text/PDF) OpenCode adapters skip `file`
attachments on the assumption that the host "already flattened the path into the prompt", and that
no such flattening exists (`adapters/claude/session.ts:1533-1538`, `codex/session.ts:452-457`,
`opencode/session.ts:1630-1636`, `orchestration/slash.ts:55-57`); only Grok appends path lines.
So a PDF attached in the GUI today silently never reaches Claude. v2's attachment tool would
inherit that, so the host gains the missing step: for every attachment the adapter does not ingest
natively, the turn effect appends `Attached file: <name> (<absolute path>)` lines to the provider
input — the path form the native answer path already folds into an answer. It lives in the
host (one place, all clients benefit) rather than in the MCP; it needs the host's drain-restart on
deploy like any host change.
*Built: the same bug was fixed upstream in parallel (`98300bd`, "attachments name themselves in the
prompt"), and the merge keeps ONE mechanism. Each adapter appends the shared `Attached files:\n-
<name>: <path>` block for the refs it does not ingest natively, skipping a path the text already
names — the GUI composer inserts the path at upload time, so the block is the guarantee for an MCP
message, whose text never names it (`agent-host/adapters/attachment-lines.ts`). From this design
the host keeps the turn effect's resolve-and-STAT of every attachment on every sending path (the
bounds hold against the file on disk, and OpenCode's 20 MiB file-part cap judges the real size),
and the native answer's `Attached file: <name> (<absolute path>)` lines. The merge also made an
answer naming a file that no longer resolves a refusal before anything is committed (the card stays
open), and a multi-select answer with files keeps its selections as the array with the lines as one
more entry — joined into one string, Grok read the selections as free text. The adapter-level
`ingestsAttachment` predicate and `orchestration/attachment-lines.ts` were dropped as redundant.*

---

## 9. Waiting semantics

Both waits run on `DaemonApi.subscribe` (§4.3). Neither sleeps; both honour the request abort.

### 9.1 `send_message` / `implement_plan` with `wait:true`

1. Read the session's summary **before** posting (`baseline`: `latestTurn`, `chatSessionStatus`).
   *Built: immediately before the POST, after any attachment upload and plan read-back — a turn
   that settles during a long upload must not become this message's reply.*
2. Post the turn; keep `{seq}`.
3. On every bus event for the session (and every 10 s from a list re-read), evaluate the latest
   summary `S`, in this order:
   - `S.hasPendingApprovals || S.hasPendingUserInput` → `needs-input` (the snapshot's `pending`
     is returned; a `responseMode:"message"` question is reported the same way — the turn may still
     be running, and `session` says so).
   - plan-ready rung → `plan-ready`.
   - `S.chatSessionStatus === "error"` → `failed` (`lastError` in `session.chat`).
   - `S.latestTurn` settled (`completed` / `interrupted` / `failed` / `cancelled`) **and** it is not
     the baseline turn (a different `turnId`; or, for a steer into a running turn, the baseline's
     `turnId` with a `completedAt`) → outcome by state.
   - `session.closed` → `SESSION_NOT_FOUND` error.
   *Built: a `needs-input` verdict is confirmed against the snapshot — no pending approval or
   question there means the summary lagged, and the wait continues until the next bus event or a
   2 s re-check. A verdict driven by a turn that was already over at the POST also continues.*
   - `timeoutMs` elapsed → `timeout`; the turn continues; the caller uses `wait_for_session` or
     `get_session` next.
4. Read `GET …/thread` once for `reply`, `pending`, `session`.

A turn the host never starts (an attachment rejected at effect time strands a `pending` turn row,
§14) ends in `timeout` with the error activity visible in `read_transcript`.

### 9.2 `wait_for_session`

Watched set: one session, every chat and terminal session of a project, or every session. A
session **qualifies** when `attention !== null && needsAttentionAt > after`. That is exactly the
Attention Center's `flaggedAt`: for a chat tab the daemon stamps `needsAttentionAt` when the
attention value changes — `needs-input` when an approval, question or plan opens, `finished` when
a turn settles (a new turn clears it and the next settle re-stamps it); for a terminal tab, a bell
or an exit. *Built: while the attention is raised the stamp also moves, with the value unchanged,
when a request opens whose id the previous host poll did not have (approval A answered and
approval B raised inside one 1.5 s poll) and when the latest turn settled since the previous poll
(its `completedAt` is later than that poll — a turn that starts and fails inside one poll, or two
turns that fail before the provider names them). A rewind or a history replay, which moves the
latest turn onto turns that settled long ago, does not move the stamp.
A request that stays open, one that closes while another stays open, and a turn that stays settled
keep the stamp. A restamp is published as `session.activity` but never pushes: Web Push stays gated
on the attention value changing.* `after` defaults to the call time, so a bare call waits for the *next* thing;
passing the previous result's `cursor` returns anything that happened in between.

1. Evaluate the current list; if any session qualifies, go to 4.
2. Wait for a qualifying bus event (or the 10 s re-read), or the timeout.
3. On the first qualifying event, hold a **300 ms settle window** — the host poll stamps every
   session it touches in one pass with the same `needsAttentionAt`, and their events arrive
   microseconds apart — then re-read the list.
4. Return every qualifying session (Attention Center order) and `cursor = max(needsAttentionAt)`
   of the returned rows. On timeout: `{sessions: [], cursor: after, timedOut: true}`.

Because a chat tab's `finished` is sticky server-side, v1's "already-flagged tabs return
instantly" rule is what busy-looped; the `after` cursor is what replaces it. A session with an
open request that the caller has already been told about is not returned again until its stamp
moves (a newly opened request, or a turn that settled since the previous poll, moves it; a rewind
does not) — the caller acts on it through `get_session` / `answer_question`.
*Built: a wait scoped to one `sessionId` fails with `SESSION_NOT_FOUND` at once when that session
closes or is already absent from the first read, instead of running to the timeout; a project or
unscoped wait just drops a closed session and a late `session.exited` cannot bring it back. Activity
that arrives while a list read is in flight is merged into that read (the later stamp wins), so an
attention stamp published mid-read is seen at once rather than at the 10 s re-read.*

---

## 10. Transport, auth and limits

- **Transport/auth unchanged**: `POST /mcp`, Streamable HTTP, stateless, JSON responses; HTTP
  transport only; `Authorization: Bearer base64("<user>:<bcryptHash>")` via the global hook; per-IP
  login throttle applies. `GET`/`DELETE /mcp` → 405. Body limit 16 MiB.
- **Blocking calls** hold the POST open up to `timeoutMs` (max 600 s), as v1's waits did; a client
  disconnect aborts the wait and releases the bus listener.
- **The in-process client** forwards the caller's bearer to `app.inject`, so the throttle and the
  constant-time check run once more per daemon call, cheaply, on `127.0.0.1` (no `X-Forwarded-For`
  is synthesised).
- **Security posture is v1's**: the MCP is full drive of every session, reads flow to the driving
  model, and a prompt-injected line in a repository can steer it. The documentation keeps that
  section verbatim. `create_session`'s 24-running-sessions cap and the sandbox checks on `project`,
  `cwd` and `path` are the only guards that are stricter than the GUI's.

---

## 11. Migration and documentation

| v1 tool | v2 |
|---|---|
| `list_workspaces`, `list_projects` | `list_projects` (flat, with workspace) |
| `list_tabs` | `list_sessions` |
| `list_launchers` | `list_agents` |
| `create_tab` (terminal) | `create_session` (chat only) |
| `close_tab` | `close_session` |
| `read_terminal` | `read_transcript` / `get_session` |
| `write_input`, `send_keys` | `send_message`, `answer_question`, `resolve_approval` |
| `send_and_wait` | `send_message {wait:true}` |
| `wait_for_idle`, `wait_for_attention` | `wait_for_session` |
| `get_usage` | `get_usage` (per account, per window) + `get_cost` |
| todo ×5, `list_files`, `read_file` | kept (todo scope params per §5) |

Docs: `docs/terminal-control-mcp.md` is replaced by `docs/orquester-mcp.md` — install (unchanged:
`claude mcp add --transport http …`, `compute-bearer.mjs`), addressing, the tool table, the waiting
model, attachments, safety, troubleshooting (the "stale tool guidance until a fresh `claude`
session" entry stays). AGENTS.md gains an "MCP" subsection under the agent chat GUI section and a
"Where to look first" row; README pointers move. The v1 doc's TUI prompt guide (§7) is deleted, not
migrated: v2 has no surface it applies to.

Removed code (§4.4) takes its tests with it. `packages/ui/src/lib/session-kind.ts:14-16`'s note
that nothing creates a legacy `agent` tab becomes true.

---

## 12. Testing

`pnpm --filter @orquester/daemon test` (node test runner, tests beside sources, no sleeps).

- **Tool unit tests** with `FakeDaemonApi` (records every call; answers from a table): argument
  validation and every `INVALID_ARGUMENT` message; exact request bodies (`create_session`'s
  `POST /api/sessions` body for claude, claudex and a resume; `update_session`'s single `/mode`
  body and merge rules; `answer_question`'s encodings for single, multi, custom, index keys,
  attachments-only, missing question; `resolve_approval`'s decision gate); pass-through of daemon
  error codes; the retry rule on 503.
- **Projection tests** on hand-written thread snapshot fixtures (`apps/daemon/test/fixtures/mcp/`):
  `SessionView.reason` for every ladder rung plus `new`/`exited`; `SessionDetail` pending views
  incl. `tool.input` and `isSecret`; `read_transcript` entries, drill-in, shedding order; `reply`
  extraction; `UsageView` against a recorded `UsageResponse`.
- **Wait tests** with a fake bus: `send_message` outcomes for completed / needs-input / plan-ready
  / failed / steer / timeout / closed; `wait_for_session` cursor semantics, settle window (fake
  timers), immediate return, timeout.
- **Mount test** through a real Fastify instance built with `registerMcp` and stubbed services (the
  pattern of `project-create-routes.test.ts`): `tools/list` snapshot (names, required params,
  annotations — a regression guard against drift), `GET /mcp` → 405, a `list_sessions` and a
  `get_usage` call end-to-end, and the 401 path.
- **Host fix (§8.4)**: adapter-level test that a `file` attachment yields the path line in the
  provider input for Claude and Codex.
- `pnpm check` clean. A manual smoke against a live daemon (`npx @modelcontextprotocol/inspector --cli
  <url> --method tools/list`, then one `create_session` + `send_message`) only when explicitly
  allowed to drive one, never against this checkout's daemon (AGENTS.md rule).

---

## 13. Phase 2 (deferred, not designed here)

Registering the MCP into the agents Orquester launches, so an orchestrating chat session gets it
without a hand-pasted master credential: per-thread 32-byte tokens stored hashed with a scope
record and liveness expiry (T3's `McpSessionRegistry`), injected through Claude's SDK
`mcpServers {type:"http", url, headers}`, Codex's `-c mcp_servers.<n>.url` +
`bearer_token_env_var` (token in the child env, never argv), Grok's ACP `mcpServers[]`; OpenCode
excluded (one server per project, no per-thread registration by invariant). With identity comes a
`get_self` tool (own session, project). The v2 tool surface needs no change for it: only
`DaemonApi`'s authorisation source does.

---

## 14. Collateral findings (out of scope, reported for triage)

1. **Claude-family chats always run `bypassPermissions`.** The registry's terminal args carry
   `--dangerously-skip-permissions` (`packages/registry/src/index.ts:68,153,167`); the host passes
   them into every chat launch (`agent-host/main.ts:161-175,499`), and the Claude adapter maps that
   flag to `bypassPermissions` *before* the runtime mode (`adapters/claude/launch.ts:120-122,190-194`;
   `lifecycle.test.ts:1532-1545` asserts exactly this). The permission chip is a no-op for
   `claude`/`claudex`/`claudemix`; Codex, OpenCode and Grok honour it. Effort is probably overridden
   the same way by the catalogue's trailing `--effort` arg. Not verified on a live session.
2. `RESUME_UNAVAILABLE` from the host rides `error.detail.code`, the daemon reads `error.code`, so
   "already open in tab X" and over-long ids surface as `SESSION_UNAVAILABLE`
   (`orchestrator.ts:2354-2379`, `service.ts:574-580`).
3. Non-image `file` attachments never reach Claude/Codex (fixed in scope, §8.4).
4. `PendingApproval.toolUseId` is never populated (`pending.ts:300-302` vs `activities.ts:211-219`).
5. `/mode` has no idle gate; a live turn can be cut by a chip change (v2 adds `force`).
6. The browser element picker delivering into a chat composer reads the terminal upload shape
   (`path`/`size`) and produces attachment refs without an `id` (`PickComposeSheet.tsx:76-130`).
7. Native `/answer` with attachments replaces a multi-select array by the path string
   (`orchestrator.ts:1556-1569`).
8. The attachment read-back route claims a `?token=` carve-out it does not have (`wire.ts:79-80`
   vs `index.ts:1833`).
9. `POST /api/sessions` does not confine `projectPath`/`cwd` to `fsRoot` (v2 checks; the route
   should).
10. A bad `accountId` at create silently falls back to the system home (v2 checks; the route should
    refuse like `/account` does).
11. Grok chat's `mcpServers: []` comment says the thread inherits no MCP fleet; fixtures show it
    boots the host's `~/.claude.json` servers anyway (`grok/session.ts:405-409` vs
    `test/fixtures/grok/README.md` obs. 30).
12. On a `claudex` thread the composer's model chip lists the Claude catalogue and a pick is saved
    as the claudex *launch* preference, which the `+` menu then sends as the proxy model.
13. A brand-new chat tab reads `idle` + `finished` in the Attention Center (the ladder's
    `ready|idle` fallback); v2 reports `reason:"new"`.
14. The daemon's JSON body limit (1 MiB default) is below the host's 4 MiB; `GET /events` has no
    replay cursor; `agentChat.turn.tokenUsage` is declared and never set.

---

## 15. Decisions taken without asking (please confirm or overturn)

1. **Terminal I/O is gone, not modernised.** Shell tabs are listed and closable only. If a
   "run a command in a fresh terminal tab" tool is wanted, it is one `create_session {kind:
   "terminal", command}` on top of the typed `initialCommand` — not a keystroke tool.
2. **In-process REST client via `fastify.inject`** rather than extracting route logic into services.
3. **`send_message` defaults to `wait:true`, 120 s.** A fan-out caller passes `wait:false` and one
   `wait_for_session {project}`.
4. **`update_session` refuses live model/permission changes without `force`** — stricter than the
   GUI, on purpose.
5. **24 running sessions per project** cap on `create_session` (MCP-only).
6. **Todos, files and a `get_cost` tool are kept/added**; `/background` is not exposed.
7. **The non-image attachment host fix (§8.4) is in scope**; every other collateral finding is not.
8. **Phase 2 (auto-registration, scoped tokens) is deferred.**
9. **`effort` is the canonical option name** across adapters; real ids are still accepted.
10. This spec is written but **not committed** (no commit was asked for).
