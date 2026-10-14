# `apps/daemon/src/session-tools` — session tools

Every agent-chat agent (Claude, Codex, Grok, OpenCode) gets an MCP server named `orquester`,
scoped to its own thread, whose tools run **in the daemon**. Design:
`docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md` §1.

## How a call travels

```
provider ──► agent host ──► daemon unix socket ──► handler
             (thread known)  POST /api/agent-host/session-tools/call
```

- **Claude**: in process, bound to the thread at launch: the host's own `orquester` MCP server
  instance (`agent-host/session-tools/mcp-server.ts`) handed to the SDK as
  `mcpServers.orquester = {type: "sdk", name, instance}`
  (`agent-host/adapters/claude/session-tools.ts`). It forwards the arguments raw — not
  `createSdkMcpServer`/`tool()`, whose zod parse would rewrite them first — so the daemon is the
  one validator on every provider. No network, no credential.
- **Codex, Grok, OpenCode**: the host's loopback endpoint `http://127.0.0.1:<port>/mcp`
  (`agent-host/session-tools/endpoint.ts`). Each provider session gets its own credential; the
  thread a call acts as is the credential's thread.
- **The daemon** (`route.ts`, socket-only, agent-host bearer required) derives the
  `SessionToolContext` from the thread's tab record, validates the arguments strictly, runs the
  handler and returns its `CallToolResult`. A daemon that cannot be reached is the error result
  "Orquester is restarting; retry in a few seconds." — never a throw or a hang.
- Session tools never raise an approval card (§1.3). The UI labels their rows (§1.5).

## Files

| File | Imported by | What |
|---|---|---|
| `contract.ts` | both | `SessionToolkit`, `SessionTool`, `SessionToolDefinition`, `SessionToolContext`, `defineSessionTool`, annotation presets |
| `results.ts` | both | `jsonResult`, `textResult`, `imageResult`, `errorResult`, `ToolError`, the daemon-down result |
| `registry.ts` | both | `createSessionToolRegistry` (validation, lookup), `composeSessionToolInstructions` |
| `index.ts` | both | `SESSION_TOOLKITS`, the one list; `sessionToolRegistry()` |
| `executor.ts`, `route.ts` | daemon | strict argument parse, run, error mapping; the socket-only route |
| `turn-policy.ts` | both | the turn policy every tool that causes a turn in a thread follows (below) |
| `testing.ts` | tests | a test-only toolkit (`echo`, `wait_for_cancel`, `pixel`, `fail`) — never in `index.ts` |

**The agent host imports this tree statically** (it advertises the definitions), so a toolkit
module must not import a daemon service: reach the daemon through `ctx.api` (the daemon's own REST
API in-process, `../mcp/daemon-api.ts`). Whatever a toolkit imports, the host loads. No dynamic
`import()` here either.

## The turn policy (`turn-policy.ts`)

Session tools are pre-approved in every permission and interaction mode (§1.3), so a tool that
causes a turn in a thread — `thread_send`, `thread_create`, `delegate_task`, `thread_merge_back`,
and next the scheduling toolkit — follows one rule, so a supervised or planning agent cannot get
unsupervised or editing work done by asking another thread for it:

- **(a) Never broader.** `assertTargetModeNotBroader(caller, {threadId, runtimeMode})` refuses a
  target whose permission mode (approval-required < auto-accept-edits < auto < full-access) is
  broader than the caller's (`PERMISSION_DENIED`). A thread a tool opens runs in
  `caller.runtimeMode`.
- **(b) Plan carries on.** `interactionModeFor(caller, {agent, supportsPlanMode})` is `"plan"` while
  the caller's running turn is in plan mode (`Turn.interactionMode`), refusing an agent with no plan
  mode; else `"default"`. Pass it as the caused turn's `interactionMode` (`MergeBackRequest` and the
  merge outbox carry it for a merge).
- **(c) Provenance.** `withProvenance(caller, origin, text)` (`origin`: `sent` / `opened` /
  `delegated`) prefixes `[Sent by thread "<title>"]` and one sentence saying it is not from the
  user (`buildThreadMessage`, `@orquester/api`); the GUI shows the header as a caption and the
  message alone (`parseThreadMessage`). A slash command in such a text is plain text. Keep a tool's
  input `TURN_PROVENANCE_OVERHEAD_CHARS` under the turn cap. A merge back carries its own header.
- The caller: `readTurnPolicyCaller(ctx)`, or `turnPolicyCallerFrom(tab, snapshot)` when both are
  read already → `{threadId, title, runtimeMode, planning}`.

Not under the rule, by design: `thread_interrupt` / `task_cancel` (they stop work, never start it:
at worst a nuisance, which project scope bounds) and `thread_fork` (the fork starts idle, in the
caller's own settings).

## Toolkits

| Directory | Tools | Daemon side |
|---|---|---|
| `pull-requests/` | `watch_pull_request`, `unwatch_pull_request`, `list_pull_request_watches` | `../pr-watch/` (service, routes `agentChatRoutes.prWatches`/`prWatch`, change detection); store `pr-watches.json` (`@orquester/config`) |
| `threads/` | `thread_list`, `thread_read`, `thread_create`, `thread_send`, `thread_wait`, `thread_interrupt`, `thread_fork`, `thread_merge_back`; `delegate_task`, `task_status`, `task_wait`, `task_cancel` | the daemon's own routes: `/api/sessions` (create, with `chat.lineage` for a delegate), the §6.2 `turn`/`interrupt` commands, Task 4's `fork`/`mergeBack`; reuses the external `/mcp`'s `read_transcript`, `send_message` and turn wait (`../mcp/tools/messages.ts`, `../mcp/wait.ts`) — pure modules the host loads with the toolkit |

### `threads/`: scope and caps

- **Scope.** Every tool acts on chat threads of the caller's project only, compared after resolving
  both paths as the daemon does (realpath inside the sandbox). Another project's thread, a terminal
  or a closed tab is `THREAD_NOT_FOUND`; `task_*` take only the caller's own delegates
  (`TASK_NOT_FOUND` otherwise). A thread bound to no project sees only itself.
- **Self.** `thread_wait`, `thread_send` and `thread_interrupt` refuse the caller (a wait on
  yourself never ends; an interrupt would cut the very call).
- **Turn policy.** `thread_send`, `thread_create`, `delegate_task` and `thread_merge_back` follow
  the turn policy above (never broader, plan carries on, provenance).
- **Wait cycles.** A wait (`thread_wait`, `task_wait`, `thread_send` with `wait`) on a thread that
  is itself waiting — directly or through others — on the caller is refused at once
  (`WAIT_CYCLE`), from an in-daemon registry of active waits, instead of both sides running out
  their timeouts.
- **Caps.** Delegates nest at most `MAX_DELEGATION_DEPTH` (2) deep — the daemon stamps every
  lineage with `delegationDepth` at creation (a fork carries its parent's), so neither forking nor
  closing a thread in the middle resets it — a thread has at most `MAX_OPEN_TASKS` (6) unfinished
  tasks (a task with no turn yet counts for `NEW_TASK_GRACE_MS`, 60 s), and every new thread meets
  the project's open-chat limit (24, the external `/mcp`'s). `delegate_task` / `thread_create` have
  no retry key: their descriptions tell the agent to check `thread_list` after a "restarting" error.
- **Waits** (`thread_wait`, `task_wait`, `thread_send` with `wait`) ride the daemon bus through
  the external `/mcp`'s turn wait, end at once on `ctx.signal`, and are bounded to 600 s, inside
  the providers' MCP call timeouts once the secrets toolkit's raise them (Codex `tool_timeout_sec`,
  OpenCode `timeout`: 3 900 s; Claude's is 1e8 ms; Grok's per-tool fallback `tool_timeout_sec` is
  6 000 s — the ACP `McpServerHttp` entry has no timeout field, so the fallback applies (grok 1.0.46
  bundled docs `07-mcp-servers.md`, the same text in the binary). Without the raise, Codex and
  OpenCode cut a call at 60 s, which then cancels the wait. A timeout never stops the other thread.
  Grok inlines at most 20 000 bytes of an MCP result (`GROK_MAX_MCP_OUTPUT_BYTES`), spilling the
  rest to a file under its session folder: a large `thread_read` reaches a Grok agent that way.
- **Untrusted content.** A result carrying another thread's words (`thread_read`, a reply, a Codex
  `/goal` answer, a task's `result`, a session's `error`) starts with a `notice` saying it is data,
  not instructions. What it reads is the
  thread's stored record, with whatever the host masked there.
- **Timeline.** A result naming one thread carries `threadRef` (`@orquester/api` `thread-tools.ts`,
  a reference key): the row links to that thread's tab. A delegate's own tab shows "Delegated by"
  through its lineage (Task 4's lineage bar).

## Adding a toolkit

1. **A directory** `session-tools/<toolkit>/index.ts` exporting one `SessionToolkit`:

   ```ts
   import { z } from "zod";
   import { defineSessionTool, defineSessionToolkit, SESSION_TOOL_READ_ONLY } from "../contract.ts";
   import { jsonResult, ToolError } from "../results.ts";

   export const tabsToolkit = defineSessionToolkit({
     id: "tabs",
     // ≤ one short paragraph; the whole block stays under 1 536 bytes (the registry throws past it).
     instructions: "Use `tab_count` to see how many tabs this project has open.",
     tools: [
       defineSessionTool({
         name: "tab_count",                   // bare name, ^[a-z][a-z0-9_]{0,47}$
         title: "Count tabs",
         description: "Counts the open tabs of the caller's project. …the full rules…",
         input: { kind: z.enum(["chat", "terminal", "all"]).default("all") },
         annotations: SESSION_TOOL_READ_ONLY,
         resultKind: "json",
         run: async (args, ctx) => {
           const res = await ctx.api.request("GET", "/api/sessions", {
             query: { projectPath: ctx.projectPath }
           });
           if (res.status !== 200) throw new ToolError("UNAVAILABLE", "Could not list tabs.");
           const tabs = res.body as { kind: string }[];
           const chat = (t: { kind: string }) => t.kind === "agent-chat";
           return jsonResult({
             count: tabs.filter((t) => args.kind === "all" || (args.kind === "chat") === chat(t)).length
           });
         }
       })
     ]
   });
   ```

2. **One line** in `index.ts`: `SESSION_TOOLKITS = [..., tabsToolkit]`.
3. **A presentation label** per tool in `packages/ui/src/lib/agent-chat/presentation.logic.ts`
   `SESSION_TOOL_LABELS` (`tab_count: "Counted tabs"`). Without one a row reads
   "Orquester: Tab count" — never its raw arguments.
4. **Reference fields** the UI renders from: add the key to `SESSION_TOOL_REFERENCE_KEYS` in
   `packages/api/src/agent-chat/session-tools.ts` (`htmlRender`, the visual replies' page;
   `threadRef`, the thread a thread or delegation tool acted on). Slimming then keeps it at `data.sessionTool.references.<key>` (≤ 4 KiB each) on every
   provider's row — also through a second slim — and the rest of a result is summarised as usual.
   Read it back with `sessionToolReferences(data, [key])` on a row whose `sessionTool` marker
   names your tool (`htmlRenderReferenceOfActivityPayload` is the pattern); never by spelling.
5. **Tests** beside the toolkit, driving `run` with a fake `ctx` (`testing.ts` shows the shape).

## The rules a handler owes

- **The context is the identity.** `ctx.threadId`, `ctx.projectPath`, `ctx.cwd`, `ctx.agentId` come
  from the daemon's records for the authenticated caller. Never accept a thread or project as an
  argument to act *as*; a tool that acts *on* another thread checks it belongs to `ctx.projectPath`.
- **Honour `ctx.signal`.** It aborts when the provider cancels the call, the turn is interrupted,
  the provider session ends, or the host's connection drops. Every wait listens to it.
- **Fail with `ToolError(code, message)`.** It becomes an `isError` result with a safe message.
  Anything else thrown is `INTERNAL`, logged, never echoed.
- **Results are small.** `jsonResult` caps at 60 000 bytes. Put large things (pages, files) in
  attachments and return a reference.
- **Secrets** never in a result, a log or `events.ndjson` unless the tool's whole point is handing
  one to the requesting agent (and then say where it goes).

## Wiring per provider (§1.2–§1.4)

| Provider | Transport | Credential | Instructions | Pre-approval |
|---|---|---|---|---|
| Claude | the host's `McpServer` instance as `mcpServers.orquester = {type: "sdk", name, instance}`, raw arguments forwarded | none | system prompt `append` | `allowedTools`: each `mcp__orquester__<tool>` + `canUseTool` |
| Codex | thread `config["mcp_servers.orquester"]` on `thread/start` and `thread/resume` | env `ORQUESTER_SESSION_TOOLS_TOKEN` via `bearer_token_env_var` | `turn/start` `additionalContext` (`application`) | `default_tools_approval_mode = "approve"` |
| Grok | ACP `mcpServers` http entry on `session/new` / `session/load`; the model calls the tools through Grok's `use_tool` (`rawInput.tool_name = "orquester__<tool>"`, read only on a call Grok's vendor block names `use_tool`) | `Authorization` header in the frame (redacted from `raw.ndjson`) | `_meta.rules` | `allow_once` without a card |
| OpenCode | `POST /mcp` per thread, server `orquester-<16 hex>` on the shared server | `Authorization` header in the registration (memory only) | per-turn `system` addendum | session ruleset: deny `orquester-????????????????_*`, allow `orquester-<own key>_*` |

Where each credential lives. Codex: in the `codex app-server` child's env
(`ORQUESTER_SESSION_TOOLS_TOKEN`). Codex's default `shell_environment_policy` excludes variables
matching `*TOKEN*` from the commands its agent runs, so agent shells do not see it; a user policy
that passes it through exposes it to that thread's own shells only — it acts as that same thread
and nothing more, and dies with the app-server. Grok: in the ACP `session/new`/`session/load`
frame (masked in `raw.ndjson`). OpenCode: in the shared server's memory (`POST /mcp`). None in
argv or on disk.

Grok's file-backed `use_tool` forms (`{"file": …}`, `{"tool_name": …, "tool_input_file": …}`,
its `07-mcp-servers.md`) may not occur over ACP at all — those docs say ACP client filesystems
reject file mode without an agent-local fallback — but the `{file}` form carries no `tool_name`: such a call names no session tool, so it is neither
pre-approved (the user gets an approval card — fail closed) nor marked, and its row is an ordinary
tool row.

Pre-approval is always by registered tool name, never server-wide: `docs/orquester-mcp.md` tells
users to install Orquester's own full-drive `/mcp` under the same name `orquester`, and such a
server must never be waved through. (Codex's thread override replaces a user's same-named entry
outright — verified on 0.159.0; Claude's and Grok's precedence between the two is unverified.)
Grok's `session/request_permission` for a session tool carries the qualified title
`orquester__<tool>`, `rawInput.tool_name` and the `use_tool` vendor block (fixture 33, grok 1.0.46),
so the by-name match answers it `allow_once` without a card.

OpenCode isolation: each thread's session ruleset hides every other thread's `orquester-<key>_…`
tools (`OPENCODE_SESSION_TOOLS_DENY = "orquester-????????????????_*"`; OpenCode drops a tool whose
last matching rule is a `*` deny) and allows its own; the deny is sent whenever the host has session
tools, even for a thread whose own grant failed. Subagents inherit only the deny, so they get no
session tools. See `agent-host/adapters/opencode/session-tools.ts`.
