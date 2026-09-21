# Orquester — wire contracts, event bus, persistence & cross-cutting services

Scope: what a new **`agent-chat` session kind** (a chat-style GUI driving Claude Code / Codex /
Grok / OpenCode over their *programmatic* protocols, not a PTY) would have to plug into. All
citations are `path:line` against the working tree at commit `07683b2`.

Everything below is derived from the repo only; t3code is another agent's brief.

---

## 0. One-paragraph orientation

The daemon owns **one abstraction today: a PTY session**. `ISessionManager`
(`apps/daemon/src/sessions.ts:72-105`) is the entire backend contract; two implementations exist
(tmux-backed `SessionManager:276`, direct node-pty `LocalSessionManager:896`). Every client-facing
surface — the tab strip, the Attention Center, Web Push, the recent-projects list, the system-status
kill guard, MCP terminal control — is wired to that one abstraction through three seams:

1. **HTTP/JSON routes** under `/api/sessions*` (`apps/daemon/src/index.ts:3527-3910`),
2. **A byte stream** — chunked `GET /api/sessions/:id/output` (`index.ts:3871`) or the multiplexed
   `/ws` (`index.ts:4072-4192`),
3. **A fan-out NDJSON event bus** — `Broadcaster` (`apps/daemon/src/broadcaster.ts:12`) served at
   `GET /events` (`index.ts:3988-4053`).

The session record is **bytes-in/bytes-out plus tab metadata**. There is no notion of a turn, a
message, a tool call, or an approval anywhere in `packages/api` — the closest thing is the
*heuristic* `SessionActivity` state machine (`apps/daemon/src/ansi-activity.ts:223`) that infers
working/waiting/idle from ANSI bells, OSC titles and hook pings. An `agent-chat` kind is therefore
an **additive** third citizen, not a refactor: the existing bytes path stays, and a parallel
structured path is added beside it, exactly the way **browser tabs** were added (own record file,
own `/ws-browser` channel, own event channel, own `BrowserSummary`) — that is the template to copy.

---

## 1. Inventory: session wire contract and events

Legend: **[PTY]** = meaningless for a non-PTY chat session · **[GEN]** = generic session/tab
metadata, reusable as-is · **[AGT]** = already agent-semantic, directly relevant.

### 1.1 `SessionSummary` — `packages/api/src/index.ts:1161-1195`

| Field | Class | Notes for `agent-chat` |
|---|---|---|
| `id: string` | **[GEN]** | uuid, assigned in `sessions.ts:317` (`randomUUID()`). |
| `kind: RegistryKind` | **[GEN]** | `RegistryKind = "shell"\|"agent"\|"ide"\|"file-explorer"\|"browser"` (`api:786`). `SessionKind = Extract<RegistryKind,"shell"\|"agent">` (`api:789`) is the "launches a persistent PTY" subset. **This is the single enum an `agent-chat` kind would have to widen** — and it is mirrored in the zod `sessionRecordSchema.kind` (`packages/config/src/index.ts:594`) and in the client's tab-bucketing/Attention filters (`packages/ui/src/components/attention/agent-sessions.ts:78` filters `session.kind !== "agent"`). |
| `refId: string` | **[GEN]** | registry entry id. A chat session still needs one (which CLI/harness is driving it). |
| `accountId?: string` | **[AGT]** | *Effective* managed account (explicit → per-agent default), resolved by the env hook, not the raw request (`sessions.ts:303-323`). Feeds `liveAccountIds()` so the idle-token refresher doesn't rotate a live account's single-use refresh token. **A chat session must set this identically** or it will silently break token refresh. |
| `title` | **[GEN]** | renamable; `PUT /api/sessions/:id` (`index.ts:3646`). |
| `projectPath` | **[GEN]** | `""` = not bound. Drives tab grouping, the git watcher, recent-projects marking and the Attention Center (entries with `projectPath === ""` are dropped: `agent-sessions.ts:78`). |
| `cwd` | **[GEN]** | |
| `cols`, `rows` | **[PTY]** | Persisted only so reattach restores the pre-restart TUI size (`config:604-608`). A chat session would carry them as vestigial `0`/absent — better: make them optional in a widened record. |
| `status: "running"\|"exited"` | **[GEN]** | |
| `exitCode?` | **[GEN]** | |
| `order: number` | **[GEN]** | per-project tab sort key, daemon-assigned (`sessions.ts:312-315`). |
| `createdAt` | **[GEN]** | |
| `model?: string` | **[AGT]** | Today claudex/claudemix only, resolved to a concrete catalog string before `create` (`index.ts:3555-3560`). Directly reusable — a chat session's model pick is the same concept and should ride the same field. |
| `missingModels?: string[]` | **[AGT]** | One-time launch-preflight snapshot, advisory (`index.ts:3617-3635`). Reusable. |
| `activity?: SessionActivity` | **[AGT]** | Live snapshot, never persisted, absent for exited sessions (`sessions.ts:584-591`). |

### 1.2 `CreateSessionRequest` — `packages/api/src/index.ts:1197-1228`

| Field | Class | Notes |
|---|---|---|
| `kind`, `refId` | **[GEN]** | |
| `projectPath`, `cwd` | **[GEN]** | |
| `cols`, `rows` | **[PTY]** | default 80×24 (`sessions.ts:309-310`). |
| `title`, `accountId` | **[GEN]/[AGT]** | |
| `model?` | **[AGT]** | Rejected with 400 for any refId other than claudex/claudemix (`resolveLaunchModel`, `index.ts:3556`). |
| `resumeConversationId?` | **[AGT]** | **The most important existing field for a chat GUI.** Double-checked: `resumeLaunchArgs` (`sessions.ts:208`) rejects anything outside `/^[\w.][\w.\-/]*$/` or containing `..`; the route 400s `RESUME_UNAVAILABLE` when the id is unusable *or* the agent carries no `resumeArgs` (`index.ts:3563-3573`). `resumeArgs` per agent lives in `packages/registry/src/index.ts:71` (claude `--resume {id}`), `:83` (codex `resume {id}` — a subcommand, must go last), `:155` (opencode `--session`), `:170` (grok `--resume`), `:183` (agy `--conversation`). |
| `initialCommand?` | **[PTY]** | Typed as keystrokes, never executed; ≤ `MAX_INITIAL_COMMAND` = 4096 (`api:1231`) and **no control bytes** (`index.ts:3538-3552`). A chat session's first user message is *not* this — it is a structured turn — but the design precedent (bound + validated at the route, delivered to the process as data) is the one to copy. |

### 1.3 Session I/O frames

* **`SessionStreamMessage`** (`api:1276-1279`): `{type:"buffer"\|"output", data}` / `{type:"exit", exitCode}` — the chunked-HTTP form used by the desktop over the unix socket. **[PTY]**
* **`SessionInputMessage`** (`api:1282-1284`): `{type:"input",data}` / `{type:"resize",cols,rows}`. **[PTY]**
* **`/ws` wire protocol** — *not typed in `packages/api` at all*; it is an inline structural type in the handler (`index.ts:4093`): client→server `{t:"sub"|"unsub"|"input"|"resize"|"ping", id, …}`, server→client `{t:"out",id,data}` / `{t:"end",id}` / `{t:"pong"}`. Contrast with `/ws-browser`, which **is** fully typed in the API package (`BrowserClientMessage`/`BrowserServerJsonMessage`, `api:1359-1429`). **A new channel should follow the browser precedent (typed in `packages/api`), not the `/ws` precedent.**
* Upload side-channel: `POST /api/sessions/:id/upload`, raw octet-stream body + query metadata, `MAX_UPLOAD_BYTES = 500 MiB` (`api:401`), returns an absolute daemon-side path the agent can read (`api:1259-1273`, route `index.ts:3809-3857`). **[AGT]** — a chat GUI's file attachment maps 1:1 onto this: upload → get path → reference the path in the turn.

### 1.4 Activity / attention contract

* `SessionActivityState = "working"|"waiting"|"idle"` (`api:945`) **[AGT]**
* `SessionAttention = "bell"|"needs-input"|"finished"` (`api:951`) **[AGT]** — `"bell"` is the byte-stream fallback; the other two are structural (hook-derived).
* `SessionActivity { state, attention, lastOutputAt, needsAttentionAt? }` (`api:953-964`). `lastOutputAt` is **[PTY]**-flavoured (ISO of last PTY byte) but generalizes to "last event from the agent". `needsAttentionAt` is what the Attention Center sorts and cycles by.
* `SessionActivityEvent { id, activity }` (`api:967-970`), published on channel `sessions`, type `session.activity` (`index.ts:651-655`).
* The state machine is `ActivityTracker` (`ansi-activity.ts:223`): `noteOutput` (bell scan + OSC-title streak heuristics, `:243`), `noteInput` (`:284`), `noteHookSource` (`:311`), `applyHookEvent` (`:315`), `noteExit` (`:341`). Idle timeouts: `IDLE_MS=3000` (`:155`), `TITLE_DRIVEN_IDLE_MS=4500` (`:163`), echo graces `INPUT_ECHO_GRACE_MS=1500` (`:170`), `BELL_ECHO_GRACE_MS=250` (`:180`).
* **Key invariant** (`ansi-activity.ts:205-210`): structural hook events outrank byte heuristics — output never overrides `waiting`, a bell never downgrades a structural attention. A structured protocol would make the whole heuristic layer *unnecessary* for chat sessions: `applyHookEvent` is the right entry point, `noteOutput` is not.

### 1.5 Agent-event (hook) ingress

* `AgentEventSource = "claude"|"codex"|"opencode"|"grok"` (`api:973`), `AgentEventRequest {source, event, payload?}` (`api:976-980`).
* Route `POST /api/sessions/:id/agent-event` — **unix-socket only** (`index.ts:3775-3799`, guarded by `if (options.mode === "local")`), 204 fail-open on unknown events, 404 on unknown session.
* Delivery mechanism: the daemon writes a managed hook script into each agent family's config home (`apps/daemon/src/agent-hooks.ts`, `hookScript()` at `:83`), which `curl --unix-socket "$ORQUESTER_DAEMON_SOCK"` POSTs the hook stdin payload. The session env carries `ORQUESTER_SESSION_ID` + `ORQUESTER_DAEMON_SOCK` (`sessions.ts:373-378`). Family mapping (claudex/claudemix → `claude`) is `agentFamily()` (`agent-hooks.ts:16`).
* Classification: `classifyAgentEvent` (`apps/daemon/src/agent-status.ts:9`) → `HookEventClass = "working"|"waiting"|"done"`. Claude's `PreToolUse` with `tool_name === "AskUserQuestion"` is mapped to `waiting` (`agent-status.ts:48`) because Claude auto-allows it and it never reaches `PermissionRequest`. **This is the exact seam a structured protocol replaces:** it is a lossy projection of an event stream that the programmatic protocols already emit losslessly.

### 1.6 Event bus: channels and types (full inventory)

Envelope: `EventMessage {id, channel, type, createdAt, payload}` (`api:1431-1437`). `Broadcaster.publish` stringifies once and fans out to every sink, dropping a sink that throws (`broadcaster.ts:23-39`). **There is no per-channel subscription** — `SubscriptionRequest` (`api:1439`) exists in the types but is **not implemented** by `/events`; every client receives every event.

| Channel | Type | Payload | Wired at |
|---|---|---|---|
| `sessions` | `session.created` | `SessionSummary` | `index.ts:621-623` |
| `sessions` | `session.exited` | `SessionSummary` (no `activity`) | `index.ts:628-631` |
| `sessions` | `session.closed` | `{id}` | `index.ts:632-636` |
| `sessions` | `session.updated` | `SessionSummary` | `index.ts:636-638` |
| `sessions` | `session.activity` | `SessionActivityEvent` | `index.ts:651-655` |
| `projects` | `project.git.changed` | `GitStatusChangedPayload` (`api:600-604`) | `index.ts:436-438` |
| `projects` | `recentProjects.changed` | `RecentProjectSummary[]` | `index.ts:680-682` |
| `registry` | `registry.changed` | `RegistryEntry` | `index.ts:440` |
| `agent-accounts` | `agent-accounts.changed` | `AgentAccountsResponse` | `index.ts:441` |
| `usage` | `usage.changed` | `UsageResponse` | `index.ts:534` |
| `todos` | `todo.created/updated/deleted` | `TodoListRecord` | `index.ts:674-676` |
| `browser` | `browser.created/updated/closed` | `BrowserSummary` / `{id}` | `index.ts:694-696` |
| `cliproxy` | `cliproxy.changed`, `cliproxy.crashed` | status / `{reason, respawnAttempts}` | `cliproxy.ts:1360-1364` |
| `daemon` | `daemon.shutdown` | `{}` | `index.ts:1871` |
| `daemon` | `daemon.heartbeat` | `{daemonId}` | `index.ts:4034-4043`, every **15 s**, synthesized per-stream (not via `Broadcaster`) |

Client dispatch is a single `if/else` ladder in the store (`packages/ui/src/store/app.ts:2790-2896`); unknown channels fall through and are ignored (`:2853` `if (event.channel !== "sessions") return;`). **Adding a new channel is forward-compatible with old clients by construction.**

### 1.7 `/events` transport mechanics — `index.ts:3988-4053`

* `GET /events`, NDJSON (`content-type: application/x-ndjson`, `x-accel-buffering: no`), `reply.hijack()`.
* Optional `?project=<path>` is **realpath-sandboxed** against `fsRoot` before anything is registered (`:3997`), then `gitWatcher.subscribe(path)` refcounts a poll loop (`:4029`).
* Race guard: if the client already hung up during the sandbox check / auth hook, the handler hijacks and bails **before** registering the sink/heartbeat/watcher-refcount — otherwise all three leak for the daemon's lifetime (`:4005-4013`).
* `passesGitEventFilter(data, watchedProject)` (`apps/daemon/src/git.ts:1018-1028`) is applied *in the sink*: it parses the line and matches on the real `type` field, not a substring, so a status blob only reaches streams that asked for that project. Everything else passes through unfiltered.
* Teardown on `request.raw.on("close")`: clear heartbeat, remove sink, unsubscribe the watcher (`:4048-4053`).

### 1.8 Auth, transports, and which surfaces exist where

* One Fastify factory `createServer(...)` (`index.ts:1595-1604`), instantiated twice: unix socket `{authRequired:false, mode:"local"}` (`index.ts:821-826`) and HTTP `{authRequired:true, mode:"remote", serveWeb}` (`index.ts:833-846`).
* `onRequest` hook (`index.ts:1631-1677`): `/ws` is skipped entirely (browsers cannot set WS headers — it authenticates via `?token=`); auth is required for `/api*`, `/events*`, `/mcp*` except `/api/auth/info`; `/api/fs/download` additionally accepts `?token=`. Per-IP `LoginThrottle` keyed on the rightmost `X-Forwarded-For` hop via `trustProxy: "127.0.0.1"` (`index.ts:1612`).
* `/ws` and `/ws-browser` do their own `authorizeCredential(token, …)` and `socket.close(1008,"unauthorized")` (`index.ts:4073-4079`, `:4196-4201`).
* `@fastify/websocket` is registered **once** at the root (`index.ts:4070`) with routes in encapsulated child scopes purely for load ordering — registering the plugin per scope caused N upgrade listeners and `ERR_HTTP_SOCKET_ASSIGNED` spam. **A `/ws-agent` route must reuse that single registration**, i.e. another `void app.register(async (instance) => { instance.get("/ws-agent", {websocket:true}, …) })` after line 4070.
* Mode-gated surfaces: `PUT /api/config/daemon` is socket-only (`index.ts:1715-1720`); `POST /api/sessions/:id/agent-event` is socket-only (`:3775`); `/mcp`, `/devtools-frontend/*`, `/ws-devtools/*` are **remote-only** (`index.ts:4400-4419`, `:3725`, `:4299`).
* SPA fallback (`index.ts:4432-4447`): `@fastify/static` with `wildcard:true`, then `setNotFoundHandler` returns `index.html` for any GET that is **not** under `/api`, `/health`, `/events`, `/mcp`, `/devtools-frontend`, `/ws-devtools`. **A new `/agent-*` HTTP path outside `/api` would be swallowed by the SPA fallback** — put everything under `/api/...`, or add the prefix to that `isApi` list.
* Service-worker bypass list mirrors it: `BYPASS_PREFIXES = ["/api","/events","/ws","/health","/mcp","/devtools-frontend","/ws-devtools"]` (`apps/web/public/sw.js:25`), `VERSION = "v5"` (`:16`). `/ws-agent` starts with `/ws` so it is bypassed for free; a `/agent-chat` prefix would **not** be, and would need `VERSION` bumped + a `pnpm build`.

---

## 2. Proposed minimal extension surface for `agent-chat`

Design constraints taken from the codebase, not invented:

* **Wire contracts live in `packages/api/src/index.ts`, one flat file, grouped by comment banner** (see `// Sessions —` at `:939`, `// Browsers —` at `:1286`, `// Web Push —` at `:727`). The file is 1886 lines and already heterogeneous; a new banner section is the idiomatic move. A *separate file* is only justified if the chat protocol is large (>~400 lines of types) — in which case `packages/api/src/agent-chat.ts` re-exported from `index.ts` keeps `@orquester/api`'s single entry point (`exports: "./src/index.ts"`, no build step between packages).
* **Zod schemas live only in `@orquester/config`** (AGENTS.md "Schemas | zod | only in `@orquester/config`"). Anything persisted must get a schema there.
* **A second multiplexed WS channel is an established pattern**: `/ws-browser` exists specifically so the terminal channel's text-only fast path stays untouched (`index.ts:4193-4195`), with its own client-side `WsBrowserChannel` (`packages/ui/src/lib/transporters/ws-browser-channel.ts:25`) exposed through an optional `Transporter.browserChannel?()` method (`packages/ui/src/lib/transporter.ts:112`).

### 2.1 Recommended shape

**(a) A new `RegistryKind` member vs. a new `refId` convention.**
Prefer **widening `RegistryKind` to include `"agent-chat"`** and making `SessionKind = "shell"|"agent"|"agent-chat"` (`api:786-789`). Rationale: `kind` already drives the push gate (`index.ts:643` `if (event.kind !== "agent") return;`), the Attention Center filter (`agent-sessions.ts:78`) and the system-status labelling. A distinct kind lets every one of those opt in explicitly instead of sniffing `refId`. Cost: the zod `sessionRecordSchema.kind` enum (`config:594`) and any exhaustive switch must be widened — grep shows the enum is duplicated in exactly those two places plus the registry catalog types.

*Alternative considered and rejected*: reuse `kind:"agent"` and distinguish by a new `protocol?: "pty"|"acp"|"stream-json"` field. It is less invasive but makes every existing `kind === "agent"` consumer silently wrong (they would try to open a PTY stream for a chat session).

**(b) HTTP surface — reuse `/api/sessions` for lifecycle, add one sub-resource for turns.**

```
POST   /api/sessions                      # unchanged; kind:"agent-chat", refId, projectPath,
                                          # accountId, model, resumeConversationId
DELETE /api/sessions/:id                  # unchanged
PUT    /api/sessions/:id                  # unchanged (rename)
POST   /api/sessions/reorder              # unchanged
POST   /api/sessions/:id/upload           # unchanged — attachment → absolute path
GET    /api/sessions/:id/turns?after=<seq> # NEW: replay/backfill (the chat analogue of
                                          # GET /api/sessions/:id/output + scrollback)
POST   /api/sessions/:id/turn             # NEW: submit a user turn (idempotency key)
POST   /api/sessions/:id/decision         # NEW: answer an approval / question
POST   /api/sessions/:id/interrupt        # NEW: cancel the in-flight turn
```
Keeping create/close/rename/reorder on the *existing* routes is what makes chat tabs appear in the
tab strip, the command palette, the Attention Center and `sessions.json` with zero new plumbing.

**(c) Streaming — a new `/ws-agent` channel, typed in `packages/api`.**
Copy the `/ws-browser` precedent exactly (`index.ts:4193`, typed at `api:1359-1429`):

```ts
// packages/api — new banner section
export type AgentChatClientMessage =
  | { t: "sub"; id: string; afterSeq?: number }   // replay from a sequence number
  | { t: "unsub"; id: string }
  | { t: "turn"; id: string; clientTurnId: string; parts: AgentMessagePart[] }
  | { t: "decision"; id: string; requestId: string; decision: AgentDecision }
  | { t: "interrupt"; id: string }
  | { t: "ping" };

export type AgentChatServerMessage =
  | { t: "event"; id: string; seq: number; event: AgentChatEvent }
  | { t: "end"; id: string; exitCode?: number }
  | { t: "pong" };
```

`seq` is the one thing `/ws` lacks and a chat channel needs: terminals recover by re-capturing
scrollback (`sessions.scrollback()` → `tmux capture-pane`, `sessions.ts:529`), but a structured
stream must be resumable *without* replaying the whole conversation. `sub {afterSeq}` + a
monotonically increasing per-session `seq` gives exactly that, and mirrors how
`WsSessionChannel` already resets and re-subscribes on reconnect
(`packages/ui/src/lib/transporters/ws-session-channel.ts:15`).

**(d) The event vocabulary.** The minimum that covers all four target CLIs' protocols and,
critically, everything the existing `HookEventClass` projection needs:

```ts
export type AgentChatEvent =
  | { k: "turn.started";   turnId: string; role: "user" | "assistant" }
  | { k: "turn.finished";  turnId: string; stopReason: "end_turn" | "interrupted" | "error";
                           usage?: AgentTurnUsage }
  | { k: "part.delta";     turnId: string; partId: string; kind: "text" | "thinking";
                           text: string }                       // append-only token stream
  | { k: "part.final";     turnId: string; partId: string; part: AgentMessagePart }
  | { k: "tool.started";   turnId: string; toolCallId: string; name: string; input: unknown }
  | { k: "tool.progress";  toolCallId: string; text?: string }
  | { k: "tool.finished";  toolCallId: string; ok: boolean; output?: unknown; isError?: boolean }
  | { k: "approval.requested"; requestId: string; kind: "tool" | "edit" | "command";
                           title: string; detail: unknown; options: AgentDecisionOption[] }
  | { k: "approval.resolved";  requestId: string; decision: AgentDecision; by: "user" | "auto" }
  | { k: "question.asked";     requestId: string; question: string;
                           options: AgentDecisionOption[]; allowFreeText: boolean }
  | { k: "question.answered";  requestId: string; answer: string }
  | { k: "diff.produced";  turnId: string; files: string[] }     // hint for the git tab (see §5)
  | { k: "error";          message: string; fatal: boolean };

export interface AgentMessagePart {
  type: "text" | "thinking" | "image" | "file" | "tool_use" | "tool_result";
  /* text | path (from POST /api/sessions/:id/upload) | toolCallId | … */
}
export type AgentDecision = { action: "allow" | "allow_always" | "deny"; note?: string }
                          | { action: "answer"; value: string };
export interface AgentTurnUsage { inputTokens: number; outputTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number | null; model?: string }
```

`AgentTurnUsage` deliberately mirrors `UsageTokenRow` (`api:705-721`) field-for-field so the
existing token/cost aggregation (`apps/daemon/src/usage-tokens.ts`) can consume it directly instead
of re-scanning transcripts.

**(e) Event-bus additions (channel `sessions`, not a new channel).**
Per-token deltas must **never** go through `Broadcaster` — it fans out to *every* `/events` stream
with no channel filter (`broadcaster.ts:32`), and `/events` has no subscription mechanism. Deltas
ride `/ws-agent` only. What *does* belong on `/events` is the coarse, low-rate signal every client
needs even when not looking at the tab:

| new type | payload | why |
|---|---|---|
| `session.activity` | **unchanged** `SessionActivityEvent` | reuse — do not invent a parallel state |
| `agentChat.turn` | `{ id, turnId, state: "started"\|"finished", stopReason?, usage? }` | tab badges, usage bar, push |
| `agentChat.pending` | `{ id, requestId, kind: "approval"\|"question", title }` | Attention Center detail line |

Rate: at most a handful per turn. Anything higher-frequency must stay on the WS channel. Note the
`project.git.changed` precedent for why: it needed a *per-stream filter* (`git.ts:1018`) precisely
because a high-rate payload on an unfiltered bus is "useless noise to everyone else"
(`index.ts:3990-3994`).

**(f) Client-side placement.** Add `Transporter.agentChannel?()` beside `sessionChannel?()` and
`browserChannel?()` (`packages/ui/src/lib/transporter.ts:106-112`) and a
`packages/ui/src/lib/transporters/ws-agent-channel.ts` modelled on `ws-browser-channel.ts`
(auto-reconnect, re-subscribe, `wakeAgentChannels()` for the mobile-background case). The desktop
unix-socket transport omits `browserChannel` entirely; an agent channel can do the same at first
(HTTP-transport-only, which includes desktop-remote) and fall back to `openStream` later.

### 2.2 What deliberately does *not* need new API

* **Tab lifecycle, rename, reorder, close** — `/api/sessions*` covers it.
* **Attachment upload** — `/api/sessions/:id/upload` already returns a daemon-side absolute path.
* **Model pick / preflight** — `CreateSessionRequest.model` + `missingModels` already exist.
* **Account pinning** — `accountId` + `SYSTEM_ACCOUNT_ID` (`api:1159`) already exist, and the
  seeded-account gate (`index.ts:3585-3603`) already refuses an unseeded proxy pin.
* **Resume** — `resumeConversationId` + `GET /api/agents/conversations` already exist.

---

## 3. Persistence proposal

### 3.1 What the daemon persists today

| File | Path fn | Schema | Written how |
|---|---|---|---|
| `daemon.json` | `config:87` | `daemonConfigSchema` `config:193` | bcrypt hash migrated at rest |
| `sessions.json` | `config:122` | `sessionsConfigSchema` `config:616` | atomic tmp+rename, `sessions.ts:871` |
| `workspaces.json` | `config:100` | `workspaceMetaSchema` `config:554` | side-table keyed by workspace **name** |
| `recent-projects.json` | `config:139` | `recentProjectsConfigSchema` `config:709`, cap `MAX_RECENT_PROJECTS=30` `config:718` | **entry-wise tolerant parse** `config:729-745` |
| `todos.json` | `config:134` | `todoRecordSchema` `config:667` | |
| `browsers.json` | `config:126` | `browserRecordSchema` `config:627` | record survives, **process does not** |
| `push.json` | `config:144` | `pushConfigSchema` `config:751` | 0600, holds the VAPID private key |
| `agent-accounts.json` + `agent-accounts/<family>/<id>/home` | `config:382`, `:388` | `agentAccountSchema` `config:349` | |
| `cliproxy/state.json`, `secrets.json` | `config:1272`, `:1275` | `cliProxyStateSchema` `config:1105`, `cliProxySecretsSchema` `config:1161` | secrets 0600 |
| `app.json` | `config:79` | `appConfigSchema` `config:392` (incl. `agentPrefsSchema` `:335`) | |

`sessionRecordSchema` (`config:588-614`) persists exactly: `id, title, order, projectPath, refId,
kind, cwd, createdAt, accountId?, cols?, rows?, model?`. Note what it does **not** persist: activity,
status, exitCode, buffer. tmux is the source of truth for "is it still running"
(`config:583-587`); the file is only tab metadata.

### 3.2 Recommendation: persist an *index*, not the transcript

**Do not build a message store.** Two reasons grounded in the repo:

1. The daemon already reads every CLI's own on-disk transcript
   (`apps/daemon/src/agent-conversations.ts:65` `listAgentConversations`, with per-agent listers
   `listClaude:210`, `listCodex:315`, `listGrok:469`, `listKimi:517`, and hard caps
   `CLAUDE_MAX_FILES=500 :29`, `CODEX_MAX_FILES=500 :36`, `GROK_MAX_SESSIONS=500 :42`,
   `READ_CONCURRENCY=16 :51`). Every one of these CLIs writes its own durable, resumable transcript.
   Duplicating it makes Orquester the second source of truth for a format it does not own.
2. The "a conversation only exists inside the HOME that wrote it" rule
   (AGENTS.md; `AgentConversationSummary.home`/`accountId`/`proxyRefId`, `api:896-918`) means the
   *(home, conversationId)* pair already **is** the durable handle. A chat session that records
   that pair can be resumed by the same mechanism the resume picker uses.

**Minimum the daemon must persist to reattach a chat session after a restart** — extend
`sessionRecordSchema` (`config:588`) with an optional block rather than a new file, so one atomic
write keeps tabs and chat state consistent:

```ts
// packages/config/src/index.ts, inside sessionRecordSchema
chat: z.object({
  /** The agent's own conversation id — the resume handle. Absent until the
   *  harness reports one (first turn), which is exactly when resume becomes possible. */
  conversationId: z.string().optional(),
  /** Which HOME wrote it: "system" | "account" | "cliproxy" (mirrors AgentConversationHome). */
  home: z.enum(["system", "account", "cliproxy"]).default("system"),
  /** Last seq the daemon emitted, so a reattach restarts the counter above it
   *  and a reconnecting client's `sub {afterSeq}` is never ambiguous. */
  lastSeq: z.number().int().nonnegative().default(0),
  /** Protocol/transport the session was launched with (forward compat). */
  protocol: z.string().optional()
}).optional()
```

Everything else — message bodies, tool inputs/outputs, thinking blocks — comes from the CLI's own
transcript on reattach, read through the existing `agent-conversations.ts` machinery (extended with
a "read the full transcript of conversation X", which today only extracts a title/preview).

**Accepted gaps** (call them out, they are real):
* `listOpencode`/`listCline`/`listAntigravity` return `[]` today (`agent-conversations.ts:564`,
  `:569`, `:574`) — there is no transcript reader for them yet, so an OpenCode chat session would
  come back after a restart with an empty scrollback unless a reader is written.
* `cliproxy`-home rows are filtered out of both resume surfaces
  (`packages/ui/src/lib/resume-account.ts`, `isResumableConversation`) because claudex/claudemix
  carry no `resumeArgs` — so **chat sessions on the proxy launchers cannot be resumed today**; that
  is a known follow-up (resumeArgs on the launchers + routing on `proxyRefId`).
* A short **in-memory ring** of recent structured events per session (the analogue of
  `Session.buffer`, `sessions.ts:36`) is still worth keeping for the *same-process* reconnect case
  (page reload, mobile wake) so a client doesn't have to re-parse a transcript for the last 20
  messages. Do not persist it.

**Parse discipline** (AGENTS.md, and `parseRecentProjectsConfig` `config:729` is the model): the
chat block must use an **entry-wise tolerant parse** — a chat record a newer/older bundle wrote
must drop just that session, never take the whole `sessions.json` (and therefore every terminal
tab) down with it. This is load-bearing: `readIndex()` (`sessions.ts:843`) treats an unparseable
index as "unreliable" and **skips the orphan-reap pass entirely** (`sessions.ts:817-823`), so a
schema mistake in the chat block degrades reattach for *all* sessions.

---

## 4. Feeding push / attention / the Attention Center from structured events

### 4.1 Current path

```
PTY bytes → ActivityTracker.noteOutput (bell/OSC heuristics)   ─┐
hook POST → classifyAgentEvent → tracker.applyHookEvent        ─┼→ lifecycle "activity"
process exit → tracker.noteExit                                ─┘   {id, activity, cause,
                                                                     hasHookSource, kind}
                                                                            │
                     ┌──────────────────────────────────────────────────────┤
   broadcaster.publish("sessions","session.activity", {id,activity})        │
                                                            push policy (index.ts:643-668)
```

Push policy verbatim (`index.ts:643-668`):
* non-`agent` kinds: **no push at all** (`if (event.kind !== "agent") return;`).
* `cause === "hook" && attention === "needs-input"` → `push.notifyStructural(summary,"needs-input")`
* `cause === "hook" && attention === "finished"` → `push.notifyStructural(summary,"finished")`
* `cause === "bell" && !hasHookSource` → `push.notifyAttention(summary)` (the fallback)
* `cause === "exit"` deliberately pushes **nothing** (`ansi-activity.ts:335-340`) — a hook agent
  already pushed "finished", a bell agent already pushed its bell.

Debounce: `DEBOUNCE_MS = 30_000` keyed `"<sessionId>:<type>"`, with stale-entry eviction so the map
stays bounded (`apps/daemon/src/push.ts:16`, `:173-185`). Payload is
`{title, body:"", tag:"session-<id>", sessionId}` (`push.ts:203-208`); `tag` collapses repeats in
the browser. Endpoint validation is an SSRF guard (`push.ts:28-56`): https only, no loopback /
RFC1918 / link-local / metadata hosts. 404/410 subscriptions are dropped and persisted
(`push.ts:261-264`).

Attention Center consumption (`packages/ui/src/components/attention/agent-sessions.ts`):
`bucketOf` (`:49`) — exited → `finished`; `activity.attention || activity.state === "waiting"` →
`attention`; `working` → `active`; else `idle`. Sort key `flaggedAt = activity.needsAttentionAt ??
session.createdAt` (`:92`). `Ctrl+Shift+A` walks a cursor through the group
(`packages/ui/src/components/attention/GlobalShortcutListener.tsx`).

### 4.2 Recommendation

**Keep `SessionActivity` as the single attention contract and feed it from the protocol.** Do not
invent a second state for chat sessions — the Attention Center, the tab dots, the push gate and the
`Ctrl+Shift+A` cursor all read exactly `SessionActivity`, and a parallel model would have to be
plumbed into four independent consumers.

Concretely:

1. **Add a fifth `ActivityCause`.** `ActivityCause = "output"|"idle"|"bell"|"hook"|"input"|"exit"`
   (`ansi-activity.ts:201`) → add `"protocol"`. The push policy (`index.ts:643-668`) then becomes:
   treat `"protocol"` exactly like `"hook"` (structural → per-type push), and leave the
   `"bell"`/`hasHookSource` fallback branch untouched — a chat session never produces bells.
2. **Map protocol events to `HookEventClass` at the source**, reusing
   `ActivityTracker.applyHookEvent` (`ansi-activity.ts:315`) verbatim:
   * `turn.started(assistant)`, `tool.started`, `part.delta` → `working`
   * `approval.requested`, `question.asked` → `waiting` (sets `attention:"needs-input"` and clears
     the idle timer — `ansi-activity.ts:325-329`)
   * `turn.finished(end_turn)` → `done` (sets `attention:"finished"`)
   * `approval.resolved` / `question.answered` / a submitted user turn → `working`, which is the
     analogue of `noteInput` (`ansi-activity.ts:284`) optimistically clearing attention.
   * `error(fatal)` → `done` + a distinct attention would be nice but requires widening
     `SessionAttention` (`api:951`); **prefer not to** in v1 — reuse `"finished"` and let the
     detail line carry the error.
3. **Kill the idle timer for chat sessions.** `armIdleTimer` (`ansi-activity.ts:398`) exists only
   because a PTY gives no "I'm done" signal. A protocol does. Chat sessions should construct the
   tracker in a mode where `working → idle` happens only on `turn.finished`. Otherwise a 90-second
   tool call goes `idle` after 3 s and the dot lies.
4. **Richer push payloads become possible and cheap.** `PushService.notify` (`push.ts:197`) builds
   the title from `session.title` + project basename with an empty `body`. With
   `approval.requested {title}` in hand the body can become the actual ask ("Run `rm -rf build`?"),
   and `tag` can stay `session-<id>` so it still collapses. `notifyStructural`'s signature
   (`push.ts:193`) takes only a type — it would need an optional `detail?: string`.
5. **The `kind !== "agent"` push gate (`index.ts:644`) must be widened** to
   `kind !== "agent" && kind !== "agent-chat"`, and `agent-sessions.ts:78` likewise, or chat
   sessions will be silently invisible to both push and the Attention Center. These are the two
   one-line changes most likely to be missed.
6. **`needsAttentionAt` must keep its ordering guarantee.** On exit the daemon re-stamps
   `attention:"finished"` **after** the `session.exited` broadcast, because that summary carries no
   activity and a client resetting on exit must see the stamp land last (`index.ts:628-631`,
   `store/app.ts:2866-2884`). A chat session's `turn.finished` → `session.activity` ordering must
   respect the same rule relative to any `session.updated`/`session.exited` it emits.

---

## 5. Project-scoped services a chat session interacts with

### 5.1 Git watcher — showing diffs after an agent edit

* `GitWatcher` (`git.ts:1058`) polls `git status` at `WATCH_INTERVAL_MS = 2000` (`git.ts:1031`)
  **only** for projects with ≥1 live `/events?project=<path>` subscriber, refcounted
  (`subscribe:1071`, `unsubscribe:1083`, self-rescheduling unref'd timeout `poll:1102-1121`).
* Change key excludes `lastFetched` (`watchKey`, `git.ts:1039`) so the Git tab's own 60 s auto-fetch
  doesn't fake a change.
* First poll only seeds the baseline — it never emits (`git.ts:1108-1113`).

**Implication for a chat GUI:** an inline "the agent changed these files" affordance gets the
status **for free** if the client is already holding an `/events?project=<path>` stream — which it
is, since that is how the Git tab works. Latency is ≤ 2 s. The proposed
`diff.produced {turnId, files}` event is an *optimization* (it names the files immediately, before
the poll), not a replacement: the authoritative status still comes from `project.git.changed`.
Do **not** add a per-turn `git status` shell-out — polling was chosen over `fs.watch` deliberately
(`git.ts:1050-1053`: recursive watches are unportable and a build writing into the tree fires
thousands of times per second).

Git mutations a chat UI would want (stage/unstage/commit/discard/diff/history/stashes) are all
already HTTP routes at `index.ts:3044-3330`, with the stash safety contract (index + expected `sha`,
409 on mismatch — `api:581-592`).

### 5.2 Recent projects

* Daemon-owned, atomic tmp+rename, cap 30 (`apps/daemon/src/recent-projects.ts:56`,
  `config:718`). Path shape is validated to be exactly `<workspacesDir>/<ws>/<project>` via
  `describeProjectPath` (`recent-projects.ts:22-34`) — anything else is silently ignored.
* **The daemon marks on session create itself** rather than trusting clients
  (`markRecentProject`, `index.ts:1996-2006`, called at `index.ts:3610`). A chat session created
  through `POST /api/sessions` inherits this with **zero work**.
* `recentProjects.changed` carries the whole list; the client replaces its copy and guards the shape
  (`store/app.ts:2831-2842`).

### 5.3 Workspaces side-table

`workspaces.json` (`config:554`) carries `gitAccountId`, `createdAt`, `isArchived`,
`archivedProjects`. Relevance to chat: the Attention Center **must not** leak sessions in archived
projects (the "Protect archived data" curtain) — `deriveAgentSessions` drops them via
`isProjectRefVisible` (`agent-sessions.ts:82`) and a second narrowing pass for workspaces whose
project list isn't loaded (`:110+`). A chat session inherits this only if it goes through the same
`SessionSummary.projectPath` path.

### 5.4 Usage / cost

`AgentUsage`/`UsageWindow`/`UsageAccount` (`api:639-701`) + `UsageTokenRow` (`api:705-721`) are
fed by `usage-sources.ts` (quota APIs) and `usage-tokens.ts` (transcript scanning, watched with a
5 s debounce over the transcript roots — `index.ts:556-598`). A chat session's `AgentTurnUsage`
should be *additive input* to `usage-tokens`, not a replacement: the transcript scanner is the
cross-session source of truth and already handles the proxy homes' launcher-id attribution
(`index.ts:545-553`).

---

## 6. `system-status.ts` kill guard and non-tmux agent children

### 6.1 How the guard works today

`SystemStatusService.kill(pid)` (`system-status.ts:640`):

1. Platform gate (`SYSTEM_STATUS_SUPPORTED`, Linux-only — everything is `/proc`).
2. `pid <= 1` → `INVALID_PID`.
3. `pid === process.pid` → `PROCESS_PROTECTED` (`:653`).
4. `pid === tmux.serverPid()` → `PROCESS_PROTECTED` (`:658-664`) — killing it takes down every
   terminal on the box.
5. `protectedPids()` (`:618-625`, supplied at `index.ts:3328-3331` as the cliproxy's
   `directChildPid()`) → `PROCESS_PROTECTED`.
6. **`descendsFromRoot(procs, roots, pid)`** (`:675`) — else `PROCESS_NOT_MANAGED`. The snapshot is
   taken with `force=true` so the shared 2 s cache is never used for a kill.
7. Two-pass starttime verification (`:686-720`): pass one records each target's `/proc/<pid>/stat`
   starttime while the tree is intact; pass two re-checks it immediately before `SIGTERM`, because
   once the first signal lands children reparent and `ppid` stops being an identity.

**`rootPids()` (`system-status.ts:822-832`) is the crux:** roots = `{ process.pid }` ∪ every pid
returned by `tmux.panePids()`, labelled with the owning session id when known. **Service sessions
(`orqsvc-`) are deliberately excluded** — the `orq-`/`orqsvc-` namespace split is enforced at
`tmux.ts:17` and `newServiceSession` throws unless the name carries the service prefix
(`tmux.ts:501-505`).

### 6.2 What this means for a non-PTY agent child

Three cases, and the answer differs:

**(a) The chat agent runs inside a tmux `orq-<uuid>` session (recommended).**
Nothing changes. `panePids()` already returns its pane pid, it becomes a root, its whole subtree is
killable and labelled with `sessionId` in `SystemProcessInfo.sessionId` (`api:1477`) and
`SystemPortInfo.sessionId` (`api:1522`). Works even though the process has no interactive UI — tmux
does not care whether the pane's program reads the tty.

**(b) The chat agent is a direct child of the daemon (no-tmux hosts, or a deliberate `spawn`).**
It is under `process.pid`, so `descendsFromRoot` already allows killing it — but it gets **no
`sessionId` label** (roots map only pane pids to session ids, `:826`), so the process table shows it
as an anonymous daemon child. Worse, it is **a legitimate kill target by default**, which for
infrastructure is exactly the bug `protectedPids` was introduced to fix for the cliproxy
(`index.ts:3324-3331`). Two options:
  * label it — extend `rootPids()` / `collectTree` to accept extra `(pid → sessionId)` pairs from the
    session manager, so a chat child shows up attributed to its tab; **and**
  * decide explicitly whether it is protected. A *user-owned agent process* should stay killable
    (killing it is "stop this agent", which is legitimate); only daemon infrastructure belongs in
    `protectedPids`.

**(c) The chat agent runs in a tmux `orqsvc-` service session.**
It becomes **invisible to `/api/system/processes` and unkillable** by construction (service sessions
are filtered from `listSessions()` and `panePids()`, `tmux.ts:418`). That is correct for the
cliproxy (one shared daemon-owned process) and *wrong* for a per-session agent, which the user must
be able to see and stop.

**Recommendation:** run per-session chat agents in the normal `orq-<uuid>` namespace (case a) even
though there is no terminal, and only use `orqsvc-` if the design ends up with one shared
multiplexing broker process (in which case add its pid to `protectedPids`).

---

## 7. Graceful shutdown, reattach, and surviving `systemctl restart`

### 7.1 What exists

* `cli.ts:10-29` — SIGINT/SIGTERM → `daemon.stop()` with a **3 s hard-exit backstop** (`setTimeout(
  () => process.exit(0), 3000).unref()`), so a connection that refuses to drain can't stall systemd.
* `stop()` (`index.ts:869-885`): stop usage polling, clear the cliproxy health timer, stop the
  account refresher, `gitWatcher.stop()`, **`sessions.shutdown()`**, `browsers.shutdown()`,
  `stopHttp()`, then `unixServer.close()` **+ `closeAllConnections?.()`** — the force-drop is what
  makes `close()` resolve immediately despite long-lived WS/NDJSON sockets (`index.ts:850-858`,
  `:882-884`).
* `SessionManager.shutdown()` (`sessions.ts:726-736`): kills only the **attach PTYs** and nulls
  them. The tmux sessions keep running.
* `SessionManager.reattach()` (`sessions.ts:756-828`): list live `orq-*`, read the index, then
  * in index **and** alive → rebuild the summary (restoring `accountId`, `model`, `cols/rows`) and
    re-attach a streaming PTY;
  * in index, not alive → forget;
  * alive, not in index → reap — **but only if the index parsed** (`indexLoaded`, `:817`), because an
    unreadable index makes every live session look orphaned.
  * Also `scrubGlobalSecrets()` (`:774`) and `setWindowSizeLatest()` (`:772`).
* systemd `KillMode=process` (`deploy/orquester.service:44`) — **only the node process is signalled**,
  so the detached tmux server and every pane survive.
* Boot order in `startDaemon` (`index.ts:335`): `registry.init()` → `sessions.reattach()` →
  `agentAccounts.init()` → `usage.start()` → orphan-upload sweep → **lifecycle listeners attached
  after reattach** (`index.ts:621+`) → `cliproxy.init()` (`:803`, deliberately after reattach so
  adoption sees the final session set) → transports listen (`:821`, `:869`).

### 7.2 The guarantee, precisely

**A session survives `systemctl restart` iff its command's process tree is parented to the tmux
server, not to the daemon.** Everything else dies with the node process because `KillMode=process`
signals only node, and node's exit orphans its children into PID 1's reaper. `LocalSessionManager`
is explicit about this (`sessions.ts:884-895`: "these sessions do NOT survive a daemon restart"),
and so is `browserRecordSchema` (`config:624-626`: "The Chromium PROCESS does not survive a daemon
restart — it is a daemon child, unlike tmux — only the tab record does").

### 7.3 A long-lived non-PTY agent subprocess (`codex app-server`, `claude --input-format stream-json`)

Three viable strategies, in descending order of fidelity:

**Strategy A — run it in tmux anyway (survives).**
`tmux new-session -d -- <bin> <args>` works for a non-interactive program; the pane's stdin/stdout
are a tty, which is the catch: a stdio JSON-RPC protocol over a **tty** is hazardous (the line
discipline echoes input, mangles `\r\n`, and the pane applies a width). Mitigations that already
exist in this repo: the daemon writes a **one-shot wrapper script** for launch credentials
(`writeAddonEnvLaunchScript`, `sessions.ts:225`) — the same trick can wrap the agent so it runs with
stdio redirected to **FIFOs or Unix sockets** under `<appdir>/daemon/`, with the tmux pane holding
only the process (and its stderr for diagnostics). The daemon then connects to the FIFO/socket after
a restart and the protocol stream resumes. This is the only design that genuinely preserves an
in-flight turn across a restart. Cost: real complexity (FIFO lifecycle, back-pressure, partial-frame
recovery at the reconnect point, `stty raw -echo` on the pane).

**Strategy B — `orqsvc-` service session (survives, but shared).**
Exactly what the cliproxy does: `newServiceSession` (`tmux.ts:501`), boot adoption by
**authenticated probe first** (`cliproxy.ts:1378-1428`): owned session exists → probe → adopt if
healthy, else restart; no owned session but port answers → key accepted = our own out-of-tmux
survivor ("persistence-lost", warn-only) / key rejected = foreign listener → hard error, **never
kill or adopt**; nothing on the port → spawn + poll readiness. Health supervision is a 15 s unref'd
interval (`index.ts:805-807`) with bounded backoff, and re-parenting of a persistence-lost proxy
waits for dependent sessions to drain (`cliproxy.ts:1280-1310`). This is the **best-documented
survival pattern in the repo** and is the right model if the chat backend is one broker process
speaking to many conversations over a local HTTP/WS port (which is how `codex app-server` and
ACP-style servers are usually deployed anyway).

**Strategy C — accept death, restart + resume (simplest, and probably correct for v1).**
The daemon does **not** try to keep the subprocess alive. On boot, for each persisted chat record
with a `chat.conversationId`, it re-spawns the harness with the agent's own `resumeArgs`
(`registry:369` `resumeArgsFor`, `sessions.ts:208` `resumeLaunchArgs`) under the recorded `home`,
and marks the tab "reconnecting". What is lost is exactly one thing: **a turn that was in flight at
restart**. Emit `turn.finished {stopReason:"error"}` (or a dedicated
`error {message:"daemon restarted mid-turn", fatal:false}`) so the UI can offer "retry this turn"
rather than hanging.

**Strategy C is recommended for v1** because it is honest about the failure mode, needs no FIFO
plumbing, and matches the repo's existing stance for browser tabs (record survives, process doesn't,
relaunch on first subscribe — `config:624`, `index.ts:4194+`). The `chat.conversationId` +
`chat.home` persistence in §3.2 is exactly what it needs. Strategy B is the upgrade path if
per-turn durability ever becomes a requirement.

**Non-negotiable regardless of strategy:** the session record must be written **atomically**
(`persistIndex`, `sessions.ts:871-880`) and the chat block must be parsed entry-wise-tolerantly, or
a bad chat record poisons `readIndex()` and reattach stops reaping orphans for *terminals* too
(`sessions.ts:817-823`).

---

## 8. Deployment constraints for long-lived agent subprocesses

From `deploy/orquester.service`:

| Directive | Line | Consequence for a chat subprocess |
|---|---|---|
| `User=orquester`, `WorkingDirectory=/opt/orquester` | `:7-9` | code tree is `root:root` and read-only to the daemon. |
| `EnvironmentFile=/etc/orquester/daemon.env` | `:10` | carries `HOME=/var/lib/orquester` — without it git/ssh and the tsx cache resolve nowhere. |
| `Environment=TMPDIR=/var/lib/orquester/tmp` + `ExecStartPre mkdir` | `:13-14` | **`/tmp` is unavailable under `ProtectSystem=strict`.** Any agent that writes temp files (most of them: lockfiles, sockets, IPC pipes) must inherit `TMPDIR`. `sessionEnvBase()` passes the daemon's env minus `ORQUESTER_*`, so it inherits by default — but a chat subprocess spawned with a hand-built env (the tmux `-e` path deliberately does **not** spread `process.env`, `sessions.ts:365-370`) will silently lose it. **Explicitly set `TMPDIR` in the chat launch env.** |
| `NPM_CONFIG_PREFIX=/var/lib/orquester/.npm-global` | `:20` | `npm i -g` from a session lands here; the default `/usr` prefix is unwritable. |
| `PATH=/var/lib/orquester/.local/bin:/var/lib/orquester/.npm-global/bin:/usr/local/sbin:…` | `:26` | `~/.local/bin` **first** so Claude Code's native-installer symlink (atomic version flip) wins over an npm-rewritten binary. Note `sessionPath()` (used by `Tmux.run` and `newServiceSession`) is *wider* than the daemon's own PATH — this is why `/api/templates` probes `requires` against `sessionPath()`, not `process.env.PATH` (`index.ts:3393`). **A chat subprocess must be launched with `sessionPath()`**, or agents installed from a terminal tab will be unresolvable. |
| `ExecStart=/usr/bin/node --import tsx …/cli.ts --appdir /var/lib/orquester` | `:29` | no dist; daemon code changes need only a restart. |
| `Restart=always`, `RestartSec=2` | `:30-31` | a crashed daemon comes back in 2 s and re-runs `reattach()`. |
| **`KillMode=process`** | `:34` | **the single most important line for this project.** Only node is signalled. Children **not** in the tmux tree die (orphaned to PID 1 when node exits). |
| `NoNewPrivileges=false` | `:37` | required for scoped `sudo` in sessions; a chat subprocess inherits the same ability. |
| `ProtectSystem=strict` + `ReadWritePaths=/var/lib/orquester /usr /etc /var /run /tmp` | `:42-43` | `/opt` (code), `/boot`, `/root`, `/home` stay read-only **even to a root session**. A chat agent writing anywhere but the appdir/workspaces will EROFS. |
| `ProtectHome=true` | `:44` | real `/home` is hidden; `HOME` is the appdir. |
| `PrivateTmp=false` | `:46` | the tmux socket lives under the appdir, and this keeps it reachable across restarts. |

**Unit changes require `systemctl daemon-reload`** — a plain `systemctl restart` does not re-read it
(AGENTS.md, "Unit changes need `daemon-reload`").

### Caddy / CSP constraints on new routes

`deploy/Caddyfile`:
* `reverse_proxy 127.0.0.1:47831` handles WS upgrade automatically — **a `/ws-agent` route needs no
  Caddy change**.
* The `@app` CSP is `connect-src 'self' wss:` — same-origin WS is allowed; anything cross-origin is
  not. `script-src 'self'` (no inline) is why `theme-boot.js` is a separate file.
* `frame-ancestors 'none'` + `X-Frame-Options: DENY` on `@app`; the `/devtools-frontend/*` island is
  the sole carve-out.
* `/etc/caddy/Caddyfile` is reconciled **by hand** on the VPS — any new path that needs a header
  exception is a manual deploy step and will silently not apply otherwise.

### Other deploy gotchas that bite

* **SPA fallback** (`index.ts:4437-4444`): a non-`/api` GET path returns `index.html`. Keep chat
  HTTP routes under `/api/`.
* **Service worker** (`apps/web/public/sw.js:25`): `/ws-agent` is covered by the `/ws` prefix;
  anything else new needs the list **and** `VERSION` bumped (`:16`, currently `v5`) **and**
  `pnpm build`.
* `CI=1 pnpm install --frozen-lockfile </dev/null` and never piping the build through `| tail`
  (AGENTS.md) — unchanged, but a new runtime dep (an SDK for a programmatic protocol) makes the
  install step load-bearing again.
* **Daemon code changes need no rebuild** (tsx); only `apps/web/dist` does. A chat feature touching
  both means a `pnpm build` + the mandatory `node scripts/smoke-web.mjs https://<domain>` browser
  smoke test.

---

## 9. Summary of concrete edit points

| What | Where |
|---|---|
| Widen `RegistryKind`/`SessionKind` | `packages/api/src/index.ts:786-789` |
| Widen persisted `kind` enum | `packages/config/src/index.ts:594` |
| New chat wire types (banner section or `agent-chat.ts` re-export) | `packages/api/src/index.ts` after `:1284` |
| Extend `sessionRecordSchema` with a tolerant `chat` block | `packages/config/src/index.ts:588-614` |
| New `/ws-agent` route (after the single `websocketPlugin` registration) | `apps/daemon/src/index.ts:4070+` |
| New `/api/sessions/:id/{turns,turn,decision,interrupt}` | `apps/daemon/src/index.ts:3666+` |
| New `ActivityCause: "protocol"` + protocol→`HookEventClass` map | `apps/daemon/src/ansi-activity.ts:201`, `:315`; new file beside `agent-status.ts:9` |
| Push gate widening | `apps/daemon/src/index.ts:643-644` |
| Attention Center kind filter | `packages/ui/src/components/attention/agent-sessions.ts:78` |
| Store event dispatch for `agentChat.*` | `packages/ui/src/store/app.ts:2790-2896` |
| `Transporter.agentChannel?()` + `ws-agent-channel.ts` | `packages/ui/src/lib/transporter.ts:106-112`, `packages/ui/src/lib/transporters/` |
| Reattach: spawn-with-resume for persisted chat records | `apps/daemon/src/sessions.ts:756-828` |
| Kill-guard labelling for non-tmux chat children (if strategy (b)) | `apps/daemon/src/system-status.ts:822-832` |
| SW bypass list (only if a non-`/ws`, non-`/api` prefix is added) | `apps/web/public/sw.js:16,25` |
