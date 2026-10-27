# `apps/daemon/src/session-tools` — the in-chat transport of the Orquester catalog

Every agent-chat agent (Claude, Codex, Grok, OpenCode) gets an MCP server named `orquester`,
scoped to its own thread. Its tools are the **Orquester catalog's** chat audience — the same tool
definitions the external `/mcp` serves (`../mcp/catalog/`, one module per family in
`../mcp/tools/`), run by the same executor (`../mcp/executor.ts`) — under **tiers and approval
cards**. Every chat gets every chat tool (no always-Admin one for a workflow-owned chat); there is
no per-agent or per-chat tool switch. This directory is the transport only: the socket route, the
per-thread manifest (tools, instruction block, denials), the manifest pushes and the legacy-name
aliases. Design:
`docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md` (cited as §n); the external
side: `docs/orquester-mcp.md`.

## How a call travels

```
provider ──► agent host ──► daemon unix socket ──► route ──► THE executor ──► catalog tool
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
- **The daemon** (`route.ts`, socket-only, agent-host bearer required) builds the caller
  (`ToolCaller` of kind `thread`) from the thread's own tab and head (`GET …/head`, never the whole snapshot) — title, canonical project
  and workspace, permission mode, whether its running turn plans, the workflow-owned trait (owner +
  lineage walk), the exchange (`causedBy` of its running turn) — never from the arguments, and
  hands the call to the executor: strict parse of the chat schema, the tool's scope claim, the gate (allow / card / deny), the turn policy and
  exchange, then the tool's `run`. A daemon that cannot be reached is the error result "Orquester
  is restarting; retry in a few seconds." — never a throw or a hang.

## Files

| File | Imported by | What |
|---|---|---|
| `contract.ts` | both | `SessionSecretRequests` (the one port besides `DaemonApi`), `SESSION_TOOL_CALL_TIMEOUT_MS`, the result type |
| `results.ts` | both | `jsonResult`, `imageResult`, `errorResult`, `ToolError`, the daemon-down and cancelled results |
| `instructions.ts` | both | the per-thread "Orquester" instruction block (§10) |
| `manifest.ts` | daemon | the manifest of one thread: advertised tools, block, denials |
| `session-tools-refresh.ts` | daemon | the manifest route, the daemon-pointing reads behind its denials, and the manifests pushed to the host |
| `route.ts` | daemon | the socket-only call route; builds the thread caller |
| `legacy-aliases.ts` | daemon | an old agent host's 13 legacy names mapped onto their catalog tools (below) |
| `testing.ts` | tests | test-only chat tools (`echo`, `wait_for_cancel`, `pixel`, `fail`) and `executeTestChatCall` |

**The agent host loads the catalog statically** (it advertises the definitions:
`agent-host/session-tools/definitions.ts`), so a tool module never imports a daemon service: it
reaches the daemon through `ctx.api` (the daemon's own REST API in-process, `../mcp/daemon-api.ts`).
`mcp/catalog/registry.test.ts` walks the import graph from `catalog/index.ts` against an allow-list.
No dynamic `import()` either.

## Toolsets: groups, never switches (§9.1, §9.5)

| Toolset | Tools |
|---|---|
| `core` | `list_projects`, `list_agents`, `list_sessions`, `get_session`, `read_transcript`, `search_sessions`, `create_session`, `send_message`, `wait_for_session`, `control_session`, `fork_session`, `merge_back_session`, `get_usage`, `html_preview`, `html_render`, `request_secret` (16) |
| `reads` | `list_workflows`, `get_workflow`, `get_workflow_runs`, `get_agent_profile`, `list_saved_prompts` (5) |
| `notes` | `list_todos`, `update_todos`, `update_saved_prompts` (3) |
| `chat-extras` | `update_session`, `respond_to_request`, `get_turn_diff`, `read_tool_output`, `list_conversations`, `notify_user` (6) |
| `files-git` | `read_file`, `get_git_state` (2) |
| `workflow-authoring` | `list_workflow_block_types`, `create_workflow`, `update_workflow`, `delete_workflow`, `preview_expression`, `run_workflow`, `cancel_workflow_run`, `list_workflow_secrets`, `set_workflow_secret` (9) |
| `agent-profile-editing` | `edit_agent_profile` (1) |
| `desktops` | `get_desktops`, `control_desktop` (2) |
| `secret-files` | `secret_files_status`, `push_secret_files` (2) |
| `boxes` | the temporary-box tools (8), advertised only while a box can be rented |
| `knowledge` | `knowledge_search`, `knowledge_get`, `knowledge_save`, `knowledge_update`, `knowledge_delete`, `knowledge_merge`, `knowledge_collections`, `knowledge_worker_next_task`, `knowledge_worker_submit` (9), advertised only while the Knowledge Graph plugin is on — search, get, update, delete and merge only to a chat that sees a collection, the worker tools only (and alone) to the plugin's own indexing sessions |

46 chat tools (the 42 external ones plus `html_preview`, `html_render`, `request_secret`, `push_secret_files`), **all
advertised to every chat** of every agent. A toolset is only a group: a label in `@orquester/api`
`TOOLSETS` and the `orquester/toolset` tag external clients see. There is no master switch, no
per-agent default and no per-chat override, and no `request_toolset`. Older builds kept such
switches in `agent-tools.json`; this build keeps those keys verbatim and never reads them
(`@orquester/config` `agent-tools.ts`), and still renders their `toolset` cards and automatic
continue turns in old transcripts.

**Measured** (`mcp/catalog/registry.test.ts` serialises `tools/list` as the host does, and asserts
the budgets): all 46 chat tools are 54 399 bytes (≤ 73 728, the one chat budget); the external set
59 101 bytes for 42 tools (≤ 81 920). Every
tool is ≤ 3 000 bytes but `html_render` (2 755, ≤ 3 100) and `create_workflow`, `update_workflow`,
`edit_agent_profile` (≤ 6 500); every description ≤ 1 000 bytes (`html_*` ≤ 2 000), every field
text ≤ 160.

## Tiers, the gate and cards (§5, §6, §7)

Every tool (or action) is **Read**, **Act** or **Admin**; external callers are full trust and meet
none of this.

- **Read** runs freely in the chat's own project and its workspace's other projects
  (content reads there from `auto`), everywhere in Full access; other reads raise a **boundary
  card** (`cross-project-read`, `cross-workspace-read`).
- **Act** runs freely in the chat's own project; in another project of its workspace only in Full
  access, else a boundary card (`cross-project`); in another workspace always a card. Act tools
  that only stop work (`control_session` `interrupt`, `stop_task`) reach any chat but the caller;
  the destructive controls (`stop_process`, `compact`, `rewind`, `close`, settings changes,
  answering questions) reach only the caller's **own children** — chats it created through a tool
  (lineage `agentCreated`), never a fork the user made.
- **Admin** — workflow create/update/enable/delete/run, workflow secrets, every agent-profile
  change, opening desktops and launching apps, editing a user-made or workflow-used saved prompt —
  is an **Admin card in every permission mode**: never while planning ("propose it in your plan"),
  never for a **workflow-owned** chat (`ADMIN_NOT_AVAILABLE` at once; a chat a workflow runs, or
  any chat descending from one, where nobody watches).
- **Cards** (`../agent-chat/tool-approvals.ts`; kinds `admin`, `boundary`; `toolset` only from
  older builds) show the
  complete preview the tool composes (`approval()`), freeze the arguments, and pin what the preview
  read (revisions, hashes, commits): `run` re-verifies and refuses `PREVIEW_STALE`. A card waits 30
  minutes (`APPROVAL_TIMEOUT`), at most 5 per chat (`APPROVAL_LIMIT`); a denial is
  `APPROVAL_DENIED` with the user's reason. Cards are answerable only on their own route, by the
  user — never through `respond_to_request` or a provider's request route.
- **Grants** (§7.6; `grantOptionsFor` in `@orquester/api` `agent-tools.ts`, `findGrant` in
  `@orquester/config`) let a Full-access chat skip later cards of one family: `workflows`,
  `saved-prompts` and `cross-project` for this chat, `desktops` for this chat or its project. They
  are offered and honoured only while the chat is Full access and not workflow-owned; agent-profile,
  workflow-secret, (legacy) toolset and cross-project/cross-workspace read cards are never grantable, nor is
  an edit of a workflow-referenced prompt. An Admin grant never covers another project (a card
  reaching one offers none); a cross-project grant names its one target project. A `workflows`
  grant covers only the workflows that chat created or was approved for.
- **Plan mode**: Reads run; turn-causing Acts run in plan mode too (plan carries on); data-changing
  Acts are refused; `planSafe` tools (`html_*`, `request_secret`, `notify_user`) run.

The executor attaches the `toolApproval` reference (card or grant, outcome, deny reason, grant
scope) to every gated call's result, which the tool row shows.

## The instruction block (§10)

Composed per thread by the manifest (`instructions.ts`): the fixed part (§10, 1 951 bytes), then,
for a workflow-owned chat, the workflow-owned line, then — Knowledge Graph plugin on, the chat sees at
least one collection — the knowledge line naming them (`Knowledge: SEO, Ads. Search it
(knowledge_search) before deciding on these topics.`, ≤ 256 bytes, extra names as "… (+N more)").
Every tool is on, so the block never lists tools that are off. Worst case ≤ 2 048 bytes, + 256 only
with the knowledge line (`instructions.test.ts`). A knowledge worker session gets a one-line block
naming its two tools instead. The line rides in `instructions`, so no host change was needed; it is
rebuilt with every manifest, and the daemon pushes new ones when the plugin, the collections or a
profile's `knowledgeCollections` change. Every tool
name the block, the descriptions and the daemon's answers mention exists for the chat audience
(`mcp/catalog/names.test.ts`).

## The conversation protocol (§8)

- **Reply modes.** `send_message {reply}` / `create_session {prompt, reply}`: `"wait"` (default)
  returns the final reply of **the turn this message causes**; `"notify"` returns at once and
  delivers that reply later as a new message; `"none"` is fire and forget (a working target is
  steered). `delegate: true` defaults to `notify`, and the delegate's final reply **is** its
  task's result (`get_session`'s `result`); merge-back is for forks only.
- **Queue, don't steer.** A `wait`/`notify` message to a working target (or one waiting for its
  user) is queued as its **next turn** (the target's delivery queue, `pendingDeliveries`), posted
  at its idle point under a fixed command id with the host's `ifIdle` precondition; the reply is
  bound to that command's turn through the host's receipt, never to someone else's running turn.
- **Persisted before posting, exactly one consumer.** The reply subscription is written to
  `agent-reply-outbox.json` before the turn is posted (`../agent-chat/replies.ts`); the reply router
  and a waiting call settle it by compare-and-set, so a reply is delivered once — to the waiter, or
  as a message — across a timeout edge and across a daemon restart (waiting subscriptions become
  `notify` on boot; a settled turn found then is delivered once). A `wait` cut short (its timeout,
  or the target asking its user something) goes on as `notify` (`willNotify: true`).
- **Deliveries** reach the requester when it is idle, oldest first, one per idle point, under the
  header `[Reply from thread "<title>" · session <id> · <ws/project>]`; the user can Deliver now or
  Discard them on the requester's tab. An empty final reply delivers a pointer to `read_transcript`.
- **Provenance header v2** on every caused turn: `[Sent by thread "<title>" · session <id> ·
  <ws/project>]` plus a line saying it is another agent's, and whether its final reply goes back by
  itself; the context chip, not the text, makes a message read as another chat's.
- **Exchanges and hops.** Every agent-caused turn carries `causedBy {threadId, exchangeId, hop}`,
  persisted with the turn; a tool causing a turn from a turn with `causedBy` continues that
  exchange at hop + 1, a user-authored turn starts a fresh one. At `MAX_EXCHANGE_HOPS` (8) the next
  agent-caused turn is refused `EXCHANGE_LIMIT` ("summarise for your user instead").
- **Never broader** (§5.3). An agent-initiated turn may not go into a chat whose permission mode is
  broader than the caller's (`PERMISSION_DENIED`): a narrower chat cannot drive a broader one. It
  answers a broader chat only through the reply that chat asked for (`reply: "wait"` or
  `"notify"` on the broader chat's own request): that reply is a delivery, not a new send. So in
  the review scenario (§8.7) the Codex reviewer's questions go into its final reply; it does not
  `send_message` its broader requester.
- **Waits** register in `../agent-chat/waits.ts`; a wait that would close a cycle — across
  projects — is `WAIT_CYCLE` at once ("answer it in your final reply instead").
- **Caps** (§5.6): 6 unfinished agent-created children per chat (a child with no turn yet counts
  for 60 s), agent depth 2 (`delegationDepth`, delegate and opened links), 24 open chats per
  project, 20 pending reply subscriptions per chat.

### Mixed versions during a deploy's handover

The daemon and the agent host are replaced separately (the host at its drain-restart, when no turn
or background work runs), so for a while a new daemon can drive an **old host**:

- **`causedBy` is dropped by an old host** (it does not know the field): turns it starts carry no
  exchange, so every caused turn reads as user-authored and the **hop cap does not hold** across
  such a turn until the host is replaced — each one starts a fresh exchange.
- **`ifIdle` is ignored by an old host**: a queued or reply-bound message posted in the instant the
  target starts a turn steers that turn instead of waiting (no `TURN_NOT_IDLE`), and its reply is
  that turn's. The daemon's own idle check keeps the window small; the new host closes it.
- An old host advertises the 16 pre-catalog names: they run through the aliases below.

## Legacy names and definitions (§14.1)

| Peers | What keeps them working |
|---|---|
| **Old host, new daemon** — a host that booted before the catalog still advertises `thread_*`, `task_*`, `delegate_task`, `agent_catalog` until its drain-restart | `legacy-aliases.ts`: each name runs its catalog tool with the **old semantics** — `thread_send` without `wait` → `send_message {reply: "none"}` (steer), with `wait` → `send_message {reply: "wait"}` without the queue rule's notify conversion (`CallContext.legacyAlias`: the old steer-and-await path, a timeout just returns); `thread_create` → `create_session {reply: "none"}`; `delegate_task` → `create_session {delegate: true, reply: "none"}`; `task_status` → `get_session`; `thread_wait`/`task_wait` → `wait_for_session`; `thread_interrupt`/`task_cancel` → `control_session {action: "interrupt"}`; `thread_list`, `thread_read`, `thread_fork`, `thread_merge_back`, `agent_catalog` → `list_sessions`, `read_transcript`, `fork_session`, `merge_back_session`, `list_agents`. `html_preview`, `html_render`, `request_secret` keep their names. The gate and cards judge an alias as its target. |
| **New host, old daemon** — a rollback | the manifest route answers its route-miss 404, and the host advertises the **frozen legacy definitions** (`agent-host/session-tools/legacy-definitions.ts`: the old server's 16 `tools/list` entries and instruction block, pinned by hash in its test) so the old daemon's handlers match every name and argument |

`session-tools/legacy-aliases.test.ts` proves every name an old host can send resolves here.

**Removal criterion.** The aliases (`legacy-aliases.ts`, `CallContext.legacyAlias` and the
steer-and-await path it selects in `mcp/tools/messages.ts`), the frozen definitions and the host's
`legacy` manifest branch go together, in a release such that **no supported upgrade or rollback
can pair it with a peer from before the unified catalog**: every install has run a release that
ships the catalog through a completed host drain-restart (so no pre-catalog host is alive), and
rolling back to a pre-catalog daemon is no longer supported. The handover reports no peer release
(`AGENT_HOST_PROTOCOL_VERSION` did not move for this additive change), so the decision is the
release manager's, not a date: the release notes of the removing release must state the oldest
version it can be upgraded from and rolled back to.

## Adding a chat tool

A chat tool is a catalog tool: add it to its family module in `../mcp/tools/` (or a new family
listed once in `../mcp/catalog/index.ts`) with `defineTool`:

1. **The contract** (`../mcp/catalog/contract.ts`): `name` (`^[a-z][a-z0-9_]{0,47}$`), `title`,
   `description` (≤ 1 000 bytes; the full rules live here — the instruction block is short),
   `chatNote` / `externalNote`, `input` (zod; `chatOnlyInput` / `externalOnlyInput` strip keys per
   audience), `audiences`, `toolset`, `tier` (fixed, or per call from the arguments and the scope),
   `adminFamily` and `approval()` when it can be Admin, `planSafe`, `scope()` (the projects,
   sessions, paths it reads or changes and the turns it causes — the gate judges this), annotations,
   `resultKind`, `secretResultKeys`, and `run(args, ctx)`.
2. **The toolset** in `@orquester/api` `TOOLSETS` (the registry test holds the two equal) and the
   counts and byte budgets of `mcp/catalog/registry.test.ts` (§9.5).
3. **A presentation label** in `packages/ui/src/lib/agent-chat/presentation.logic.ts`
   `SESSION_TOOL_LABELS` (`tab_count: "Counted tabs"`). Without one a row reads
   "Orquester: Tab count" — never its raw arguments.
4. **Reference fields** the UI renders from: add the key to `SESSION_TOOL_REFERENCE_KEYS` in
   `packages/api/src/agent-chat/session-tools.ts` (`htmlRender`, `threadRef`, `toolApproval`).
   Slimming keeps it at `data.sessionTool.references.<key>` (≤ 4 KiB each) on every provider's row.
5. **Tests** through the executor (`executeToolCall` with a thread caller and the approval-port
   double, `../mcp/catalog/approval-double.ts`), for both audiences where it serves both.

## The rules a tool owes

- **The caller is the identity.** `ctx.caller` comes from the daemon's records for the
  authenticated caller. Never accept a thread or project as an argument to act *as*; a tool that
  acts *on* another thread or project claims it in `scope()`, and the gate decides.
- **Honour `ctx.signal`.** It aborts when the provider cancels the call, the turn is interrupted,
  the provider session ends, or the host's connection drops. Every wait listens to it.
- **Fail with `ToolError(code, message)`.** It becomes an `isError` result with a safe message.
  Anything else thrown is `INTERNAL`, logged, never echoed. Name only catalog tools in messages.
- **Results are small.** Results cap at 60 000 bytes. Put large things (pages, files) in
  attachments and return a reference. The model gets an image result whole, but the thread's log
  does not: ingestion drops a session tool's image bytes and cuts any other result string past
  64 KiB (`boundSessionToolData`), so never put what the timeline needs in one.
- **Another chat's words** in a result start with `notice` (data, not instructions), and a result
  naming a session carries `threadRef`.
- **Secrets** never in a result, a log or `events.ndjson` unless the tool's whole point is handing
  one to the requesting agent: list the result's secret keys in `secretResultKeys`, and the host
  masks those values in everything of the thread it persists
  (`agent-host/session-tools/secret-redaction.ts`). Card secrets (workflow secrets, MCP
  `{ask: true}` values) go from the card to the store, never through the agent.
- **Long waits end themselves.** `SESSION_TOOL_CALL_TIMEOUT_MS` (65 min) is the transport ceiling
  every provider gets for an `orquester` call (Codex and OpenCode are given it explicitly; their
  defaults are 60 s). A tool that waits (for the user, another chat) has its own, shorter deadline
  (≤ 600 s for conversation waits, 30 min for a card, 10 min for `request_secret`) and ends with an
  outcome the agent can read before the ceiling.

## `request_secret` — where the value goes

The agent asks (`name`, `prompt`, `purpose?`); the daemon's `SecretRequestRegistry`
(`agent-chat/secret-requests.ts`, reached through `CallContext.secretRequests`, the one port
besides `ctx.api`) holds the request **in memory** and publishes `agentChat.secretRequest` (name, prompt,
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

Only that shape strip outlives the agent host process (S-M5). The by-value masking — the remembered
values, and a fork child's link to its parent's (`SessionSecretRedactor.link`, which masks the
child's replay of the parent's turns with the parent's values) — lives in the host's memory alone,
never on disk, so the value is never persisted to protect itself. It ends when the host restarts
(a deploy's handover included), and when the thread — or, for a child, its parent — is released
or deleted (`SessionSecretRedactor.forget`). After that, a value the agent echoes in new output,
or a child's history replayed for the first time (a restart before its eager start replayed it),
is written unmasked; the `request_secret` result itself is still stripped by shape.
The persisted row keeps `secretRequest` as its reference (the card's record). T3 instead keeps
the value in its secret store under a one-use `secretRef` that only its own tools accept;
Orquester has no tool that consumes such a ref, so the value goes to the agent — and the
provider's own transcript (in the thread's account home) and its model API keep the result as
the agent saw it, outside Orquester's reach.

## Wiring per provider

| Provider | Transport | Credential | Instructions | Pre-approval | Call timeout |
|---|---|---|---|---|---|
| Claude | the host's `McpServer` instance as `mcpServers.orquester = {type: "sdk", name, instance}`, raw arguments forwarded | none | system prompt `append` | `allowedTools`: each `mcp__orquester__<tool>` + `canUseTool` | CLI default (`MCP_TOOL_TIMEOUT`, ~27 h in 2.1.285) |
| Codex | thread `config["mcp_servers.orquester"]` on `thread/start` and `thread/resume` | env `ORQUESTER_SESSION_TOOLS_TOKEN` via `bearer_token_env_var` | `turn/start` `additionalContext` (`application`) | `default_tools_approval_mode = "approve"` | `tool_timeout_sec` = 3 900 |
| Grok | ACP `mcpServers` http entry on `session/new` / `session/load`; the model calls the tools through Grok's `use_tool` (`rawInput.tool_name = "orquester__<tool>"`, read only on a call Grok's vendor block names `use_tool`) | `Authorization` header in the frame (redacted from `raw.ndjson`) | `_meta.rules` | `allow_once` without a card | CLI default (6 000 s) |
| OpenCode | `POST /mcp` per thread, server `orquester-<16 hex>` on the shared server | `Authorization` header in the registration (memory only) | per-turn `system` addendum | session ruleset: deny `orquester-????????????????_*`, allow `orquester-<own key>_*` | registration `timeout` = 3 900 000 ms |

Where each credential lives. Codex: in the `codex app-server` child's env
(`ORQUESTER_SESSION_TOOLS_TOKEN`). Codex's default `shell_environment_policy` excludes variables
matching `*TOKEN*` from the commands its agent runs, so agent shells do not see it; a user policy
that passes it through exposes it to that thread's own shells only — it acts as that same thread
and nothing more, and dies with the app-server. Grok: in the ACP `session/new`/`session/load`
frame (masked in `raw.ndjson`). OpenCode: in the shared server's memory (`POST /mcp`). None in
argv or on disk.

Defence in depth only (S-M1): a process environment is readable by the same OS user through
`/proc/<pid>/environ`, so any process running as the daemon's user — including an agent's own
shell commands — can read the Codex app-server's credential (and every other secret in that
process's environment). It names one thread's grant, which dies with that app-server; the
boundary between agents of one OS user is not a security boundary, and Orquester does not claim
one.

Grok's file-backed `use_tool` forms (`{"file": …}`, `{"tool_name": …, "tool_input_file": …}`,
its `07-mcp-servers.md`) may never occur over ACP: those docs say an ACP client's filesystem
rejects file mode unless the agent has a local fallback. Should one occur, the `{file}` form
carries no `tool_name`, so the call names no session tool: it is neither pre-approved (the user
gets an approval card — fail closed) nor marked, and its row is an ordinary tool row.

Grok's shapes in shared code are deliberate. The provider-neutral readers — `@orquester/api`
`session-tools.ts` (`sessionToolNameFromProviderData`, the result walk through `rawOutput` /
`OkayOutput`) and the host's `secret-redaction.ts` (`isMcpCallEvent`: a `use_tool` row of a
third-party server is an MCP call) — know Grok's `use_tool` layout because that is the layout
Grok's rows are persisted in, and every consumer (slimming, the timeline, the index, masking)
reads persisted rows. Normalising them in the adapter instead would change the row shape of
every thread already on disk.

Pre-approval is always by registered tool name, never server-wide: a user may have installed
Orquester's own full-drive `/mcp` under the same name `orquester` (`docs/orquester-mcp.md` says
`orquester_remote`, but older installs keep the name), and such a server must never be waved
through. On top of that, every server that points at this daemon is denied in every chat (below),
and a user server named `orquester` is always denied in Claude chats (it races ours) and replaced by
ours in Codex and Grok (probed, below).
Grok's `session/request_permission` for a session tool carries the qualified title
`orquester__<tool>`, `rawInput.tool_name` and the `use_tool` vendor block (fixture 33, grok 1.0.46),
so the by-name match answers it `allow_once` without a card.

OpenCode isolation: each thread's session ruleset hides every other thread's `orquester-<key>_…`
tools (`OPENCODE_SESSION_TOOLS_DENY = "orquester-????????????????_*"`; OpenCode drops a tool whose
last matching rule is a `*` deny) and allows its own; the deny is sent whenever the host has session
tools, even for a thread whose own grant failed. Subagents inherit only the deny, so they get no
session tools. See `agent-host/adapters/opencode/session-tools.ts`.

## Per-thread lists, denials, pushes (§9.3, §9.4, §12.1)

- **Manifest.** At every provider-session start the host asks the daemon (`POST
  /api/agent-host/session-tools/manifest`, socket-only, host bearer; `session-tools-refresh.ts`) for
  `{tools, instructions, deny}`: every tool of `catalogFor("chat")`, no always-Admin tool for a
  workflow-owned chat (older daemons also sent a `toolsets` field; the host ignores it), the per-thread instruction block (`instructions.ts`,
  worst case ≤ 2 048 bytes) and the daemon-pointing MCP servers of the thread's agent in its own
  account home or project — the project root's configs and, for a chat started in a directory
  inside it, every directory's on the way down to its cwd (`GET
  /api/agent-profile/daemon-mcp-servers`, and `?projectPath=&cwd=` for such a chat). The host
  filters its static catalog by the names (`agent-host/session-tools/definitions.ts`); a daemon
  without the route (404) gets the frozen legacy definitions
  (`agent-host/session-tools/legacy-definitions.ts`).
- **Unknown denials never launch (§12.1).** The daemon reads the daemon-pointing servers once per
  scope at a time (concurrent manifests share the read), bounded at 5 s per manifest, reused for
  30 s, the last good list kept after a failure. With no good read ever, the manifest route answers
  503 and remembers the chat. The host then launches with the denials it last read for the same
  agent, account home and project (the thread's own, else another thread's), with a
  `runtime.warning` row on the thread. With none, it waits — at most 15 s from the launch's start
  (`DENIALS_WAIT_MS`) — for a manifest: the daemon pushes one to every chat it refused once a read
  lands, and another launch of the same key may read one. Still none: the session is not started;
  the turn fails with the row "Orquester could not check your MCP servers yet…" (send again; the
  daemon's log names a check that keeps failing), and the next message tries again. A chat whose
  cwd's real path leaves its project (a symlink out), or whose project's real path leaves the
  workspaces root (the detection refuses it: 400 `PATH_NOT_CONTAINED`; any other 400 is a failed
  read), cannot be told what its CLI loads: it is denied EVERY daemon-pointing server of its
  agent known in any scope or home, by name, plus what its real cwd's own location configures
  when that is inside the workspaces root — over-denying a same-named unrelated server, never a
  refusal. The
  daemon's manifest is bounded (4 s pointing read + 3 s session list) below the host's 10 s bound
  on asking for it; a refused chat stays remembered until a push actually reached the host.
  Exception: a daemon that predates the manifest route (a handover to an older daemon) gets the
  legacy definitions, and those chats start without per-chat denials.
- **Detection reads and containment.** Detection only READS agent configs and returns flagged
  servers' names, reasons and directories — never a value. Every file it opens is lstat'd after
  realpath, a regular file, at most 8 MiB. Two deliberate exceptions to realpath containment, for
  these reads only: the all-projects scan follows ONE level of project symlinks (a project that is
  a link to a directory is read through its link path; a workspace link is not followed), and a
  Codex read takes `.codex/config.toml` from every ancestor of a project — its real path's and its
  link path's — up to the filesystem root, since Codex starts at its own project root. A scoped
  read (`?projectPath=&cwd=`) still refuses a path whose real path leaves the workspaces root
  (`PATH_NOT_CONTAINED`). Every other file operation stays contained.
- **Ordering across daemons.** Manifests carry `{seq, epoch}`; the host orders epochs by when it
  first saw them, so an old daemon's late push never retires the new one. An epoch the host has
  never seen counts as the newest: a host that first hears from a new daemon and only then from
  an old one it never saw (a host started mid-handover) takes the old one's push as newer — the
  epochs are opaque ids, and nothing else orders them. The next relaunch puts it right: a
  manifest the host ASKS for comes from the daemon its socket reaches now, so its epoch counts as
  the newest again — only when that socket is still the one the host names when the answer
  arrives; an answer from a socket the host moved away from meanwhile is used for that launch, its
  stamp never recorded.
- **Denials per provider.** Claude: `disallowedTools` `mcp__<name>` and flag-settings
  `deniedMcpServers: [{serverName}]` — and always `orquester`. Codex: denials are harmless by construction (probes below). The session reads the
  thread's effective config first (`config/read` with its cwd: the account home and every
  trusted project layer); a defined server gets `mcp_servers.<name>.enabled = false` (merged:
  keeps its transport), one the config does not define a complete disabled stub `{url:
  http://127.0.0.1:9/orquester-denied, enabled: false}` (never contacted). So the daemon denies
  every daemon-pointing Codex server whatever Codex's trust (`loadedByHomes` is display only), and
  reads `.codex/config.toml` in every ancestor of a chat's project up to the filesystem root (Codex
  starts at its project root — the git root, or what `project_root_markers` names). Without the
  read, `enabled = false` is sent, and a refusal names the server and what to check. `config/read`
  with `cwd` is in the bindings captured from 0.154.0 and on 0.159.0 (probed); Orquester sets no
  minimum Codex version (`MINIMUM_CLI_VERSIONS.codex` is null), so an older Codex that lacks it
  answers -32601 and fails closed: ours keeps the name `orquester`, every denial is sent as
  `enabled = false`, and a denial Codex cannot apply fails the start with that message — never a
  launch without it. A fork's short-lived app-server switches every server its config defines off
  (`fork.ts`; the override is not persisted, probed), so none starts there. Where the
  config already has an `orquester` of the user's, ours is registered as `orquester_session`
  (`_2`, … while taken), the user's is denied by name only when it points at this daemon (a
  Codex `orquester` is not flagged by name alone), rows say which server is ours
  (`data.sessionToolsServer`) and the instruction block names ours. A name containing `.` cannot
  be a dotted key, so the override is then sent as one `mcp_servers` table (merged into the
  config, probed). Grok: a same-named ACP entry on the host's inert `/mcp/denied`. OpenCode: each denied
  server is disconnected on the shared instance and gets a last ruleset rule `<name>_*` deny —
  except where that rule would also hide another server whose name extends it; there the
  disconnect alone denies it, and it is disconnected again at every turn start (the rule is added
  once a disconnect fails).
- **Pushes.** The daemon pushes a chat's manifest to the host (`POST
  /threads/:id/session-tools/refresh`) once a refused launch's denials become known, and every
  open chat's once at boot (a session the host kept across a daemon restart may have been launched
  with an older list). Claude takes a new list in-session (`list_changed`); any other live session
  restarts with resume at its next idle point (the orchestrator's ensure step, never under a
  running turn); an equal list is `unchanged`.
- **Tool rows.** The executor attaches the `toolApproval` reference (card or grant, outcome, deny
  reason, grant scope) to every gated call's result.

### Codex denial probes (fix wave A, codex-cli 0.159.0 `app-server`; scratch 0700 `CODEX_HOME`, no auth needed, no prompts, `rm -rf` after)

| Thread override for server X | X not defined | X a user URL server | X a user stdio server |
|---|---|---|---|
| `mcp_servers.X.enabled = false` | fails: "invalid transport in `mcp_servers.X`" | disabled | disabled |
| `{command: "false", enabled: false}` | disabled | fails: "url is not supported for stdio" | disabled |
| `{url: <stub>, enabled: false}` | disabled | disabled | fails: "url is not supported for stdio" |
| `{command, url: null}` / `{url, command: null}` / both | fails | fails | fails |

No single form fits all three, so the session matches the form to the thread's effective config
(`config/read {cwd}` lists every server of the home and of each trusted project layer); the
generated configs (ours as `orquester_session` beside a user stdio `orquester`, denials of a
defined URL server, a defined stdio one, an undefined one, `orquester` and a dotted name) started
and showed every denied server `disabled`, other servers untouched. Codex trust: in a git repo
each directory from the root down to the cwd loads by its own `[projects."<dir>"] trust_level`,
else the root's (an explicit `untrusted` wins, keys match exactly); outside a repo the cwd alone.

### Probe evidence (Task 6, 2026-10-15; scratch HOME/config dirs, stub MCP servers, no prompts)

| Probe | Claude Code 2.1.285 (SDK 0.3.278) | Codex 0.159.0 (`app-server`) | Grok 1.0.46 (ACP) | OpenCode 1.18.34 (`serve`) |
|---|---|---|---|---|
| `tools/list_changed` | re-lists at once, in-process SDK server and HTTP server alike | delivered on the session's stream, no `tools/list` follows; `config/mcpServer/reload` does not reconnect the thread's server | delivered, no `tools/list` follows | re-lists at once (the host's stateless endpoint cannot push it) |
| Deny a user server | `disallowedTools: ["mcp__ext"]` (and `mcp__ext__*`) remove its tools from the context; `deniedMcpServers: [{serverName}]` keeps it from connecting at all | `mcp_servers.ext.enabled = false` (thread config): never contacted; for a name the config lacks `thread/start` fails "invalid transport" | overlay `disabled_mcp_servers` / `enabled = false`: ignored; `--deny MCPTool(ext__*)`: still connects; a same-named ACP entry replaces it (never contacted) | `<name>_*` deny rule (OpenCode's own `Permission.disabled`) |
| A user server named `orquester` | RACES ours: in 2 of 6 runs its tools merged into `mcp__orquester__*`; `deniedMcpServers` stops it (3/3) | the thread entry is merged into it field by field: an HTTP one is replaced; a stdio one (`command`) fails `thread/start` ("url is not supported for stdio") — so ours takes `orquester_session` there (fix wave A: both start, `config/read {cwd}` lists theirs) | the ACP entry replaces it (2/2) | distinct name (`orquester-<16 hex>` is ours) |
| MCP tool search | every MCP tool deferred (`isLoaded: false`), the in-process server's too | — | — | — |
