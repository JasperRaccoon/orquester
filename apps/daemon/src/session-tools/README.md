# `apps/daemon/src/session-tools` — session tools

Every agent-chat agent (Claude, Codex, Grok, OpenCode) gets an MCP server named `orquester`,
scoped to its own thread, whose tools run **in the daemon**. Design:
`docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md` §1.

## How a call travels

```
provider ──► agent host ──► daemon unix socket ──► handler
             (thread known)  POST /api/agent-host/session-tools/call
```

- **Claude**: an in-process SDK server bound to the thread at launch
  (`agent-host/adapters/claude/session-tools.ts`). No network, no credential.
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
| `testing.ts` | tests | a test-only toolkit (`echo`, `wait_for_cancel`, `pixel`, `fail`) — never in `index.ts` |
| `secrets/` | both | the `secrets` toolkit: `request_secret` (spec §5 "Secrets", below) |

**The agent host imports this tree statically** (it advertises the definitions), so a toolkit
module must not import a daemon service: reach the daemon through `ctx.api` (the daemon's own REST
API in-process, `../mcp/daemon-api.ts`). Whatever a toolkit imports, the host loads. No dynamic
`import()` here either.

## Adding a toolkit

1. **A directory** `session-tools/<toolkit>/index.ts` exporting one `SessionToolkit`:

   ```ts
   import { z } from "zod";
   import { defineSessionTool, defineSessionToolkit, SESSION_TOOL_READ_ONLY } from "../contract.ts";
   import { jsonResult, ToolError } from "../results.ts";

   export const threadsToolkit = defineSessionToolkit({
     id: "threads",
     // ≤ one short paragraph; the whole block stays under 1 536 bytes (the registry throws past it).
     instructions: "Use `thread_list` to see the other chats in this project.",
     tools: [
       defineSessionTool({
         name: "thread_list",                 // bare name, ^[a-z][a-z0-9_]{0,47}$
         title: "List threads",
         description: "Lists the chat threads of the caller's project, newest first. …the full rules…",
         input: { limit: z.number().int().min(1).max(50).default(20) },
         annotations: SESSION_TOOL_READ_ONLY,
         resultKind: "json",
         run: async (args, ctx) => {
           const res = await ctx.api.request("GET", "/api/sessions", {
             query: { projectPath: ctx.projectPath }
           });
           if (res.status !== 200) throw new ToolError("UNAVAILABLE", "Could not list threads.");
           return jsonResult({ threads: (res.body as unknown[]).slice(0, args.limit) });
         }
       })
     ]
   });
   ```

2. **One line** in `index.ts`: `SESSION_TOOLKITS = [threadsToolkit]`.
3. **A presentation label** per tool in `packages/ui/src/lib/agent-chat/presentation.logic.ts`
   `SESSION_TOOL_LABELS` (`thread_list: "Listed threads"`). Without one a row reads
   "Orquester: Thread list" — never its raw arguments.
4. **Reference fields** the UI renders from (e.g. `htmlRender`): add the key to
   `SESSION_TOOL_REFERENCE_KEYS` in `packages/api/src/agent-chat/session-tools.ts`. Slimming then
   keeps it at `data.sessionTool.references.<key>` (≤ 4 KiB each) on every provider's row; the
   rest of a result is summarised as usual.
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
  one to the requesting agent (and then say where it goes): list the result's secret keys in the
  definition's `secretResultKeys`, and the host masks those values in everything of the thread
  it persists (`agent-host/session-tools/secret-redaction.ts`).
- **Long waits end themselves.** `SESSION_TOOL_CALL_TIMEOUT_MS` (65 min) is the transport ceiling
  every provider gets for an `orquester` call (Codex and OpenCode are given it explicitly; their
  defaults are 60 s). It is not a tool's wait: a tool that waits (for the user, another thread) has
  its own, shorter deadline, documented in its description, and ends with an outcome the agent can
  read before the ceiling is reached — `request_secret` waits 10 minutes
  (`SECRET_REQUEST_TIMEOUT_MS`) and then answers `timed_out`.

## `request_secret` — where the value goes

The agent asks (`name`, `prompt`, `purpose?`); the daemon's `SecretRequestRegistry`
(`agent-chat/secret-requests.ts`, reached through `ctx.secretRequests`, the one port besides
`ctx.api`) holds the request **in memory** and publishes `agentChat.secretRequest` (name, prompt,
purpose — never a value) on the `sessions` bus channel. The user's card (the chat's banner dock)
answers through `POST /api/sessions/:id/secret-requests/:requestId` (daemon-owned, never proxied,
response = outcome only). The value goes straight to the waiting call — the only response that
carries it — and the registry forgets it. The call ends `provided`, `declined`, `cancelled` (the
provider cancelled, Stop, the session ended — `ctx.signal`) or `timed_out` (10 min).

The answer is reported `provided` only once the call's result left the daemon (the route's
`ctx.delivered`); if the agent stopped waiting in between, the answer route says 409
`SECRET_NOT_DELIVERED` and the card closes `cancelled`; if the route says nothing within 30 s
(a stalled socket) the answer is `unconfirmed` (200; the call received it, the agent may not have),
which the UI says in those words. The value is passed on exactly as typed
(an all-whitespace answer is refused). A pending card is a pending question for the thread's
attention: `hasPendingUserInput`, the needs-input rung and push, and an `agentChat.pending`
"question" titled "Secret requested: <name>" (`AgentChatSummaryService.setSecretRequests`).

The result is `{secretRequest: {name, purpose?, outcome}, value?, note}`. On its way back the
agent host remembers `value` for the thread (`secretResultKeys`) and masks it (by value, exact
occurrences) in every runtime event, raw frame and — after ingestion joins them — streamed
message and tool-output text of that thread, holding back a tail that could begin the value
across chunks and flushes, released only when the stream ends (a terminal row, the thread's flush,
the host's teardown). Policy: any value is masked inside MCP call rows; elsewhere only a
distinctive one (≥ 8 characters of two or more classes, or ≥ 16 of any). Ingestion also strips
`value` from any `secretRequest` result by shape (`@orquester/api` `stripSecretRequestValues`,
once or twice serialised), which holds across a host restart. MCP rows and raw frames that cannot
be walked are replaced, never kept (fail closed).
The persisted row keeps `secretRequest` as its reference (the card's record). T3 instead keeps
the value in its secret store under a one-use `secretRef` that only its own tools accept;
Orquester has no tool that consumes such a ref, so the value goes to the agent — and the
provider's own transcript (in the thread's account home) and its model API keep the result as
the agent saw it, outside Orquester's reach.

## Wiring per provider (§1.2–§1.4)

| Provider | Transport | Credential | Instructions | Pre-approval | Call timeout |
|---|---|---|---|---|---|
| Claude | `createSdkMcpServer`, `mcpServers.orquester` (`type: "sdk"`) | none | system prompt `append` | `allowedTools`: each `mcp__orquester__<tool>` + `canUseTool` | CLI default (`MCP_TOOL_TIMEOUT`, ~27 h in 2.1.285) |
| Codex | thread `config["mcp_servers.orquester"]` on `thread/start` and `thread/resume` | env `ORQUESTER_SESSION_TOOLS_TOKEN` via `bearer_token_env_var` | `turn/start` `additionalContext` (`application`) | `default_tools_approval_mode = "approve"` | `tool_timeout_sec` = 3 900 |
| Grok | ACP `mcpServers` http entry on `session/new` / `session/load` | `Authorization` header in the frame (redacted from `raw.ndjson`) | `_meta.rules` | `allow_once` without a card | CLI default (6 000 s) |
| OpenCode | `POST /mcp` per thread, server `orquester-<16 hex>` on the shared server | `Authorization` header in the registration (memory only) | per-turn `system` addendum | session ruleset: deny `orquester-*`, allow own | registration `timeout` = 3 900 000 ms |

Where each credential lives. Codex: in the `codex app-server` child's env
(`ORQUESTER_SESSION_TOOLS_TOKEN`). Codex's default `shell_environment_policy` excludes variables
matching `*TOKEN*` from the commands its agent runs, so agent shells do not see it; a user policy
that passes it through exposes it to that thread's own shells only — it acts as that same thread
and nothing more, and dies with the app-server. Grok: in the ACP `session/new`/`session/load`
frame (masked in `raw.ndjson`). OpenCode: in the shared server's memory (`POST /mcp`). None in
argv or on disk.

Pre-approval is always by registered tool name, never server-wide: `docs/orquester-mcp.md` tells
users to install Orquester's own full-drive `/mcp` under the same name `orquester`, and such a
server must never be waved through. (Codex's thread override replaces a user's same-named entry
outright — verified on 0.159.0; Claude's and Grok's precedence between the two is unverified.)

OpenCode isolation: each thread's session ruleset hides every other thread's `orquester-…` tools
(OpenCode drops a tool whose last matching rule is a `*` deny) and allows its own; subagents
inherit only the deny, so they get no session tools. See `agent-host/adapters/opencode/session-tools.ts`.
