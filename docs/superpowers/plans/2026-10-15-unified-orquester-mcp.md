# Unified Orquester MCP — implementation plan

Design (binding): `docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md` (cited as
"spec §n"). This plan splits it into tasks that run in parallel in separate git worktrees, in
dependency waves, with explicit file ownership so parallel branches rarely touch the same file.

---

## Global constraints (every task)

- Follow `AGENTS.md` in full. In particular: transport contracts in `packages/api` first;
  persisted-data schemas in `packages/config`, tolerant (unknown fields and records preserved on
  rewrite); MCP tools reach the daemon only through `DaemonApi`; socket-only routes are registered
  only on the unix-socket app; no secrets in arguments, logs, API responses, bus events or
  `events.ndjson`; agent-host protocol changes stay handover-compatible (additive, older peer
  answers 404 or ignores a field); no dynamic `import()` under `apps/daemon/src/agent-host`; no
  sleep-based timing in tests (fake clocks, the broadcaster, drains, receipts).
- **Never run the daemon** (`pnpm dev*`, the daemon CLI, binding its port or socket,
  `systemctl restart orquester`) in this checkout or a worktree of it. Verify with typechecks,
  tests and review. Provider probes (Task 6) use throwaway HOME/config dirs and stub MCP servers,
  never a live Orquester session, and record their evidence in the task report.
- **Branches and worktrees.** Each task works on `feat/umcp-t<N>-<slug>` in
  `.claude/worktrees/umcp-t<N>`, branched from `feat/unified-mcp` (the integration branch, created
  in Task 0 from `main`). Merge back into `feat/unified-mcp` only; never push; never commit to
  `main`. Rebase on `feat/unified-mcp` before merging; resolve conflicts only in files you own or
  in the shared registration blocks below.
- **File ownership.** A task edits only the files it owns (listed per task) plus, where named,
  one marked block in a shared file. A file owned by no task is read-only. If a task needs a change
  in a file it does not own, it records the request in its report and the owner (or the
  coordinator, after the owner merged) applies it.
- **Shared files and their rules.**
  - `apps/daemon/src/index.ts` (route and service wiring): Tasks 3, 5, 6 and 9 each add one block
    delimited by `// umcp:t<N> begin` / `// umcp:t<N> end` with their service construction and
    `register…(app, deps)` calls, nothing else. Conflicts are mechanical; keep both blocks.
  - `apps/daemon/src/mcp/catalog/index.ts`: written once by Task 2 (one import per family module,
    in final catalog order); family tasks never edit it.
  - `packages/api/src/agent-chat/wire.ts`, `packages/api/src/agent-chat/session-tools.ts`,
    `packages/api/src/index.ts`, `packages/config/src/index.ts`: Task 1 only (every route, event
    name, reference key and re-export the plan needs is added there up front).
  - `packages/ui/src/lib/agent-chat/presentation.logic.ts`: Task 4 only (labels for all 44 tools
    and every legacy name, from spec §4).
- **Gate per task**: `pnpm check` and the touched packages' tests
  (`pnpm --filter @orquester/daemon test`, `--filter @orquester/ui test`, …) before every commit;
  `git diff --check`; `pnpm build` for tasks that touch `packages/ui` or web/desktop assets. A
  report lists what ran, what could not and why, the files changed, and any request for another
  owner.
- **Behaviour parity.** A tool whose name is unchanged keeps its behaviour, error codes and caps
  except where spec §4/§11 says otherwise. Port existing tests rather than deleting them.
- **Descriptions** follow spec §4.3 and the existing style: imperative, the rule the model must
  follow in the description of the tool it governs, ≤ 1 200 bytes, bare tool names.

---

## Waves

| Wave | Tasks | Starts when |
|---|---|---|
| 0 | 0 | now (serial, coordinator) |
| 1 | 1 | Task 0 merged |
| 2 | 2, 3, 4, 5 (parallel) | Task 1 merged |
| 3 | 6, 7, 8, 9, 10, 11, 12, 13 (parallel) | Tasks 2 and 3 merged (8 also needs 5) |
| 4 | 14, then 15 | every Wave 3 task merged |

---

### Task 0: Baseline and integration branch

Owner: coordinator. Serial.

**Deliverables**
- Confirm `feat/remove-pr-watch` and `feat/thread-create-options` are merged into `main` (or merge
  them into the integration branch if the coordinator decides to land them together); create
  `feat/unified-mcp` from that point.
- Record in the integration branch's first commit message the baseline SHAs and the measured
  byte size of today's chat `tools/list` (16 tools) — Task 2's budget test uses it.

**Tests**: `pnpm check`, `pnpm test` on the baseline.

---

### Task 1: Shared contracts and persisted schemas

Wave 1. Small and first: everything later compiles against it.

**Owns**
- `packages/api/src/agent-tools.ts` (new): `TOOLSET_IDS`, `TOOLSETS` (id, label, description,
  tool names, default per agent, `locked`), `ADMIN_FAMILIES`, `GRANTABLE` table (spec §7.6),
  settings/grant wire types, `GET /api/agent-tools` / `PUT /api/agent-tools/settings` /
  `PUT /api/sessions/:id/agent-tools` / `DELETE /api/agent-tools/grants/:id` request/response
  types, the `agent-tools` bus channel and `agentTools.changed` event.
- `packages/api/src/agent-chat/tool-approvals.ts` (new): spec §7.3 types, `TOOL_APPROVAL_EVENT_TYPE`,
  `ADMIN_APPROVAL_TIMEOUT_MS = 30 * 60_000`, size caps (64 KiB summary, 1 MiB full preview), an
  answer-body validator, `stripToolApprovalSecrets` (by shape, like `stripSecretRequestValues`).
- `packages/api/src/agent-chat/thread-tools.ts`: header v2 (`buildThreadMessage` gains `sessionId`,
  `projectLabel`, `replyMode`; origin `reply`), `parseThreadMessage` accepting v1 and v2,
  `THREAD_MESSAGE_OVERHEAD_CHARS = 768`, `replyDeliveryContext()` chip, `UNTRUSTED_NOTICE` wording
  from spec §4.3 (exported here so daemon and tests share it).
- `packages/api/src/agent-chat/wire.ts`: `agentChatRoutes.toolApprovals`, `toolApproval`,
  `replySubscriptions` (socket-only), `agentTools(sessionId)`; `TurnCommandBody.causedBy?:
  {threadId, maxRuntimeMode}`; `PendingMergeBack.kind?: "merge" | "reply"`; event type union adds
  `agentChat.toolApproval`.
- `packages/api/src/agent-chat/session-tools.ts`: `SESSION_TOOL_REFERENCE_KEYS` adds `toolApproval`.
- `packages/api/src/agent-chat/adapter-types.ts`: `RUNTIME_MODE_LABELS`, `RUNTIME_MODE_HINTS`
  (moved verbatim from `packages/ui/src/lib/chat-prefs.ts`; the UI switch to them is Task 9's).
- `packages/api/src/saved-prompts.ts`: `SavedPrompt.createdBy?: {kind: "agent" | "user", threadId?,
  title?}`, `CreateSavedPromptRequest.createdBy?`.
- `packages/api/src/index.ts`: `ThreadLineage.relation` adds `"opened"`, `agentDepth?`;
  `ProjectSummary`/workspace rows: `gitAccount?: {label, login, provider} | null` for
  `list_projects` (type only; the daemon fills it in Task 9); push notify request type
  (`POST /api/push/notify`); re-exports.
- `packages/config/src/agent-tools.ts` (new): `agentToolsConfigSchema` (spec §9.4), tolerant
  parse/serialize preserving unknown keys, `agentToolsFile(baseDir)`, and the pure resolver
  `resolveThreadToolsets(config, {agent, projectPath, threadId}) → Set<ToolsetId>` and
  `findGrant(config, {family, threadId, projectPath, targetProjectPath})`.
- `packages/config/src/index.ts`: reply outbox schema + `agentReplyOutboxFile(baseDir)`
  (`agent-reply-outbox.json`, tolerant like the merge outbox); `threadLineageRecordSchema`
  relation adds `"opened"`, `agentDepth` optional `.catch(undefined)`; saved-prompt record
  `createdBy` optional `.catch(undefined)`; re-exports.
- `apps/daemon/src/mcp/catalog/contract.ts` (new): the types of spec §3.2 (`OrquesterTool`,
  `Audience`, `Tier`, `ScopeClaim`, `ToolCaller`, `CallContext`, `ApprovalPreview`), `defineTool`,
  annotation presets. Types and the identity helper only — no logic.

**Tests**: header v1/v2 round trip and v1 compatibility; answer validator; secret stripping by
shape; config tolerance (unknown keys kept, corrupt → defaults, unknown toolset ids preserved);
resolver precedence (chat > project > agent default; `core` locked; master switch);
`findGrant` scope rules (never cross-project, chat vs project, non-grantable families).

---

### Task 2: Catalog, gate, executor, external server generation

Wave 2.

**Owns**
- `apps/daemon/src/mcp/catalog/index.ts`, `catalog/registry.test.ts`, `catalog/legacy.ts`
  (temporary adapter turning an existing `ToolDef` / `SessionTool` into an `OrquesterTool` with
  the audience, tier, toolset and scope from spec §4 — deleted by Task 14).
- `apps/daemon/src/mcp/gate/policy.ts`, `gate/scope.ts`, `gate/turn-policy.ts` (moved from
  `session-tools/turn-policy.ts`, which becomes a re-export until Task 14), their tests.
- `apps/daemon/src/mcp/executor.ts` (+ test), `apps/daemon/src/mcp/server.ts`,
  `apps/daemon/src/mcp/tool.ts` (re-export shim to the catalog contract),
  `apps/daemon/src/mcp/result.ts`, `errors.ts` (new codes).
- `apps/daemon/src/session-tools/executor.ts`, `session-tools/route.ts` (the chat route calls the
  shared executor with a `thread` caller; reads the caller's `runtimeMode`/`planning`/title from
  the thread snapshot once per call).
- Stub family modules, each exporting the legacy-adapted tools of its family so both servers keep
  working: `apps/daemon/src/mcp/tools/{discovery,sessions,conversation,usage,notify,files,git,todos,saved-prompts,workflows,agent-profile,desktops,visuals,secrets}.ts`
  — created here with a header comment naming the owning Wave 3 task; Task 2 never edits them
  again after merge.

**Deliverables**
- `gate()` exactly as spec §5.2 / §6 (table-driven), grants looked up through an injected
  `ApprovalPort` interface (Task 3 implements it; Task 2 ships a test double). Card requests go
  through the port; the executor freezes and hashes arguments (spec §7.2).
- Turn policy applied generically for `scope.causesTurnIn`; `ctx.turn` carries interaction mode,
  provenance builder (header v2) and `causedBy`.
- External `/mcp` built from `catalogFor("external")` with `_meta` tier/toolset, new
  `SERVER_INSTRUCTIONS` placeholder. Tool names change on the integration branch as each Wave 3
  family lands; the final `SERVER_INSTRUCTIONS` and server version `3.0.0` are Task 14's, and
  `main` only ever sees the finished set.
- Registry invariants of spec §13.1 (counts asserted against the target only once Wave 3 lands:
  the test reads expected counts from `TOOLSETS` and is marked to tighten in Task 14), import-graph
  purity test, "only the executor calls run" test, the default-set byte budget test (baseline from
  Task 0, +25 %).

**Tests**: gate matrix (spec §13.2); executor (parse strictness per audience, stripped keys,
`TOOL_NOT_ENABLED`, deny/card/allow paths with the port double, frozen-args hash); external server
smoke (tools/list, a call, an unknown tool → −32602) unchanged from today's `server.test.ts`.

---

### Task 3: Approval cards (daemon) and agent-tools settings store

Wave 2.

**Owns**
- `apps/daemon/src/agent-chat/tool-approvals.ts` (+ test): in-memory registry modelled on
  `secret-requests.ts`: open (publish `agentChat.toolApproval`), wait (deadline from an injected
  clock, `signal`, `delivered`), answer route (approve/deny/reason/grant/secrets; 409 when not
  pending), close events, one log line per decision without arguments.
- `apps/daemon/src/agent-tools/service.ts`, `agent-tools/routes.ts` (+ tests): the
  `agent-tools.json` store (atomic write, serialized, move-aside on corrupt, unknown fields kept),
  settings revision, grants create/revoke/touch `lastUsedAt`, chat grants deleted with their thread
  (subscribe to session close), routes of spec §9.4, `agentTools.changed` events.
- The `ApprovalPort` implementation (`agent-tools/approval-port.ts`) joining grants + registry.
- `apps/daemon/src/agent-chat/summary.ts`: pending approvals count as pending user input
  (`hasPendingUserInput`, needs-input rung, push "Approval needed: <title>", an `agentChat.pending`
  entry), next to `setSecretRequests`.
- `apps/daemon/src/index.ts` block `umcp:t3`.

**Tests**: spec §13.3 in full; store tolerance and corrupt-file handling; routes on both
transports with auth on HTTP; grant revocation effective for the next call; secrets never in
events, summaries, logs (assert on captured publish/log calls).

---

### Task 4: UI — approval card, Settings › Agent tools, Tools chip, labels

Wave 2. Codes against Task 1's contracts with mocked API responses.

**Owns**
- `packages/ui/src/components/agent-chat/banners/ToolApprovalCard.tsx`,
  `banners/tool-approval-preview.tsx` (section renderers: text, code, diff via the existing diff
  view, fields, changes, warning), `banners/use-tool-approvals.ts`, their render checks/tests;
  `banners/ChatBannerDock.tsx`, `banners/banner-model.ts` (ordering with secrets and questions).
- `packages/ui/src/components/settings/AgentToolsSettings.tsx` (+ logic module and tests),
  `settings/SettingsModal.tsx` (new section between Chat and Agents).
- `packages/ui/src/components/agent-chat/status/ToolsChip.tsx` (+ test),
  `status/ChatStatusLine.tsx` (mount it).
- `packages/ui/src/lib/agent-tools/{store,hooks}.ts` (settings, grants, live `agentTools.changed`),
  `packages/ui/src/lib/api-client.ts` (new calls), `packages/ui/src/store/app.ts` (slice).
- `packages/ui/src/lib/agent-chat/presentation.logic.ts`: labels for all 44 tools and every
  legacy name (old rows on disk keep their labels); `toolApproval` reference rendering on tool rows
  ("Approved by you", "Allowed by a project grant · Revoke", "Denied: …", "Expired", "Cancelled").

**Deliverables**: spec §7.1 and §9.2 UX, phones included (bottom-sheet preview), no agent text
rendered as markdown/HTML in a card, approve requires a focused click or ⌘/Ctrl+Enter, expiry
countdown, deny reason box, grant split menu only where `grantOptions` allow, secret fields masked
and never stored in client state after submit.

**Tests**: render checks for each preview section kind, secret fields, grant menu present/absent,
expiry; banner ordering; settings matrix logic (locked core, per-agent columns, project override
Inherit/On/Off, revoke); Tools chip resolution; labels for new and legacy names. `pnpm build`.

---

### Task 5: Conversation protocol services

Wave 2. Independent of the catalog; the tools that use it are Task 8's.

**Owns**
- `apps/daemon/src/agent-chat/replies.ts` (+ test): the ReplyRouter (spec §8.3–8.4): persisted
  subscriptions and deliveries in `agent-reply-outbox.json` (written before the caller is
  answered), bus-driven settle detection, failure/closed notices, exchange id and hop derived from
  the caller's active turn, `MAX_EXCHANGE_HOPS = 8`, `MAX_PENDING_REPLY_SUBSCRIPTIONS = 20`.
- `apps/daemon/src/agent-chat/lineage.ts`: generalise the merge delivery queue to a second entry
  kind (`reply`), same lane, receipts, idle-point delivery, `pendingMerges` entries with `kind`,
  Deliver now / Discard for replies; relation `opened` and `agentDepth` stamping at creation.
- `apps/daemon/src/agent-chat/lineage-routes.ts`: the socket-only `replySubscriptions` route
  (subscribe → `{subscriptionId, exchange: {id, hop}}` or `EXCHANGE_LIMIT`), actions on reply
  deliveries.
- `apps/daemon/src/agent-host/orchestration/validate.ts` (and the turn handler it serves in
  `orchestrator.ts`, only the `causedBy` check): refuse a turn whose `causedBy.maxRuntimeMode` is
  narrower than the target's current mode (`PERMISSION_DENIED`, the turn not started).
- `apps/daemon/src/mcp/wait.ts` / the `asWaiter` registry move to `apps/daemon/src/mcp/gate/waits.ts`
  is NOT this task's (Task 8) — this task only consumes it.
- `apps/daemon/src/index.ts` block `umcp:t5`.

**Tests**: spec §13.6 in full (restart survival via a fresh router over the same files and a
receipt-deduped re-post; no timers in assertions — drive bus events); host `causedBy` refusal and
older-host compatibility (field absent → unchanged behaviour).

---

### Task 6: Chat transport — manifest, host filtering, refresh, aliases, name collision, probes

Wave 3 (needs Tasks 2 and 3).

**Owns**
- `apps/daemon/src/session-tools/manifest.ts` (+ test), `session-tools/instructions.ts` (+ test;
  spec §10 text, worst case ≤ 2 048 bytes), `session-tools/registry.ts` (reduced to manifest
  composition), `session-tools/index.ts`, `session-tools/legacy-aliases.ts` (+ test).
- `apps/daemon/src/agent-host/host-protocol.ts` (additive: `daemonRoutesForHost.sessionToolManifest`,
  host route `/threads/:id/session-tools/refresh`), `agent-host/session-tools/**`
  (`index.ts`, `mcp-server.ts`, `endpoint.ts`, `forwarder.ts`: per-thread tool lists, refresh,
  `tools/list_changed` where proven), `agent-host/adapters/{claude,codex,grok,opencode}/session-tools.ts`
  (allowedTools / ruleset / registration from the manifest; `preapprove: false` → no by-name
  pre-approval), the restart-at-idle path for a changed tool set.
- `apps/daemon/src/index.ts` block `umcp:t6` (manifest route on the socket app only; refresh
  trigger on `agentTools.changed`).

**Deliverables**
- Manifest per spec §9.3 (toolsets resolved with Task 1's resolver; Admin-only tools removed below
  `auto`; `preapprove` false when Task 11's collision flag is set — read through a `DaemonApi`
  call to the agent-profile route, default true until Task 11 lands).
- Handover: older daemon 404 → static list; older host → daemon refuses non-manifest names with
  `TOOL_NOT_ENABLED`; legacy aliases map old chat names and arguments to the new tools.
- **Probes** (throwaway HOME/config, stub MCP server, recorded in the report and the session-tools
  README): does each CLI re-list on `notifications/tools/list_changed` (Claude in-process SDK
  server, Codex app-server, Grok ACP, OpenCode)? Claude's MCP tool search with an in-process
  server — deferred or not? Claude's and Grok's precedence between a user `orquester` server and
  Orquester's. Use `list_changed` only where proven.

**Tests**: spec §13.5; instruction block worst case; refresh applies at idle (driven by events);
aliases; collision fail-closed per adapter.

---

### Task 7: Sessions family — reads and lifecycle

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/sessions.ts`, `tools/output.ts`, `tools/requests.ts`,
`tools/search.ts` and their tests; `apps/daemon/src/mcp/views.ts`, `transcript.ts`, `history.ts`
(only as these tools need).

**Deliverables**: `list_sessions`, `get_session` (lineage, pending deliveries, task `result`),
`read_transcript`, `read_tool_output`, `get_turn_diff`, `search_sessions`, `list_conversations`,
`update_session`, `control_session`, `respond_to_request` per spec §4/§4.1, with scope claims
(content vs metadata, own children, self rules) and chat notes; `UNTRUSTED_NOTICE` on another
agent's words; `threadRef` references. Removes the merged tools from these modules.

**Tests**: ported external tests under the new names/inputs (spec §11 one test per mapping row of
this family); chat-caller scope cases (own project default, `project: "all"`, own-children
refusals, self rules, plan-mode data-change refusal).

---

### Task 8: Conversation and lineage family

Wave 3 (needs Tasks 2 and 5).

**Owns** `apps/daemon/src/mcp/tools/conversation.ts`, `tools/messages.ts`, `tools/lineage.ts`,
`tools/watch.ts`, `apps/daemon/src/mcp/wait.ts`, `apps/daemon/src/mcp/gate/waits.ts` (the
`asWaiter` registry moved from `session-tools/threads/shared.ts`), their tests; deletes
`apps/daemon/src/session-tools/threads/` once its behaviour lives here.

**Deliverables**: `create_session` (prompt, reply, delegate, chat defaults and caps, lineage
`opened`/`delegate`, `agentDepth`), `send_message` (reply modes incl. wait→notify conversion,
`implementPlan`, header v2 via `ctx.turn.provenance`, subscription through Task 5's route before
posting), `wait_for_session` (`sessionIds`, `timeoutSeconds`, single-session state + reply),
`fork_session` (chat default self), `merge_back_session` (send / deliver / discard).

**Tests**: spec §13.6 tool-level cases (the router itself is Task 5's), `WAIT_CYCLE` across
projects, caps, cross-project create/send under each mode (with the Task 3 port double), ported
external tests for `send_message`, `implement_plan`, `create_session`, lineage tools.

---

### Task 9: Discovery, usage, notify, files and git

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/{discovery,usage,notify,files,git}.ts` (+ tests),
`apps/daemon/src/mcp/agents.ts`, `mcp/fs-tools.ts`, `mcp/daemon-api.ts` (`listDirectory`,
`readFileRange`), `mcp/addressing.ts` (workspace of a project, `gitAccount` on project rows),
`apps/daemon/src/push.ts` (`notifyAgent`, rate limit) and its route,
`packages/ui/src/lib/chat-prefs.ts` and `packages/ui/src/components/agent-chat/composer/ComposerChips.tsx`
(switch to `@orquester/api` `RUNTIME_MODE_LABELS`/`HINTS`), `apps/daemon/src/index.ts` block
`umcp:t9`.

**Deliverables**: `list_projects` (git account label/login, `current`), `list_agents` with picker
parity (spec §4.1: subProvider, option defaults, mode labels/hints, status, `query`, chat
`thisThread`/`allowedRuntimeModes`), `get_usage` (`include`, session view with `partial`),
`notify_user`, `read_file` (directory listing merged), `get_git_state` (read-only views over the
existing git routes, capped).

**Tests**: the picker-parity test (spec §13.8); usage session sums and `partial`; notify rate
limits (fake clock) and payload deep link; file paging/sandbox (ported); git views capped.

---

### Task 10: Workflows family

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/workflows.ts`, `tools/workflows-guide.ts`,
`apps/daemon/src/mcp/tools/workflow-preview.ts` (new: approval previews — blocks list, code/shell
sources, HTTP targets, agent blocks, graph diff for ops), their tests.

**Deliverables**: the 12 workflow tools of spec §4 (`dryRun` replacing `validate_workflow`,
`get_workflow_runs` with `waitSeconds` on the bus, `set_workflow_secret` card-typed value for chat
callers with `delete`), Admin tiers and families (`workflows`, `workflow-secrets`), per-action
tiers (`dryRun` Read, `cancel_workflow_run` Act), previews ≤ caps with full preview behind GET.

**Tests**: ported workflow tests; preview builder (graph diff for each op kind, truncation);
chat secret flow (value only from `ctx.approval.secrets`, never in args, events, logs); grant
coverage for the create→run→fix loop.

---

### Task 11: Agent-profile family and the `orquester` name collision

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/agent-profile.ts`, `tools/agent-profile-preview.ts` (new),
their tests; `apps/daemon/src/agent-profile/` (only: the collision check and its warning, and the
read route field the manifest consumes); the agent-profile panel's warning row and rename action in
`packages/ui/src/components/agent-profile/` (only those components).

**Deliverables**: `get_agent_profile` (modes of spec §4) and `edit_agent_profile` (batch ≤ 10,
one card; per-action tiers: `import_scan` Act, the rest Admin; `{ask: true}` secret fields;
suspicious-value flags; revisions carried and checked); previews (SKILL.md/command text, MCP
definitions with masked values, hook command, plugin/marketplace source, instruction diff). The
collision detector (user-level server named exactly `orquester` that is not Orquester's) with the
"Rename to orquester_remote" fix.

**Tests**: ported agent-profile tests; batch semantics (all-or-nothing validation before the card;
per-change results after); secret values only from the card; preview contents; collision flag on
each CLI's config shape.

---

### Task 12: Notes and desktops

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/{todos,saved-prompts,desktops}.ts` (+ tests),
`apps/daemon/src/mcp/todo-tools.ts` (reduced to DaemonApi calls, then deleted if empty),
`apps/daemon/src/saved-prompts.ts` (persist `createdBy`), `apps/daemon/src/mcp/tools/desktop-preview.ts`.

**Deliverables**: `list_todos`, `update_todos` (through `/api/todos`), `list_saved_prompts`,
`update_saved_prompts` (`createdBy`, Admin for user-authored edits with a diff preview, global vs
project), `get_desktops`, `control_desktop` (Admin, `close_window` only of the window actions).

**Tests**: ported todo and desktop tests; saved prompt create/update/delete/pin for agent- vs
user-authored prompts; tolerance of `createdBy` on read/rewrite.

---

### Task 13: Visuals and secrets into the catalog

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/{visuals,secrets}.ts` (+ tests, moved from
`session-tools/html/` and `session-tools/secrets/`); deletes those two directories.

**Deliverables**: `html_preview`, `html_render`, `request_secret` as chat-only catalog tools,
behaviour and descriptions unchanged except the instruction paragraphs, which move into Task 6's
composed block (one line each).

**Tests**: the existing html and secrets tests, moved and passing unchanged.

---

### Task 14: Documentation, renames switch-over, cleanup

Wave 4.

**Owns** `docs/orquester-mcp.md` (rewrite to the 41-tool surface, spec §11 migration section,
`orquester_remote` requirement, approvals and cross-project safety notes in §10 "Safety"),
`apps/daemon/src/session-tools/README.md` (now the chat transport: manifest, toolsets, tiers,
cards, conversation protocol, probe evidence from Task 6), `apps/daemon/src/agent-host/README.md`
(module map lines for the moved files), `README.md` pointers if any name a removed tool,
`AGENTS.md` — only the one-line **MCP** term, which now says the catalog serves external clients
and in-chat agents; `apps/daemon/src/mcp/server.ts` final `SERVER_INSTRUCTIONS` and version
`3.0.0`; deletes `apps/daemon/src/mcp/tool-names.ts`, `mcp/catalog/legacy.ts`, the
`session-tools/turn-policy.ts` re-export, any now-empty modules; tightens registry counts (41 / 44
/ 20); marks `2026-10-14-agent-visuals-and-session-tools-design.md` §1.3/§5 superseded with one
line pointing to the new spec.

**Deliverables**: the legacy-alias removal criterion written into the session-tools README (host
protocol handover reports no host older than this release), not removed now.

**Tests**: `pnpm check`, `pnpm test`, `pnpm build`; a docs check that every tool name in
`docs/orquester-mcp.md` exists in `catalogFor("external")` and vice versa (a small test reading the
doc's tool table).

---

### Task 15: Scenario tests, full verification, review

Wave 4, after Task 14.

**Owns** `apps/daemon/test/umcp-scenarios.test.ts` (new) and any fixture it needs.

**Deliverables**: spec §13.10 scenarios over a fake host and the in-process daemon routes (no live
daemon): add a skill; saved prompt global and per project; workflow create → enable → run → watch →
debug → fix → delete with one chat grant; usage per session and per week; Claude opens Codex in
another project of the same workspace, two notify round trips, then `EXCHANGE_LIMIT`; a supervised
caller's cross-project read raises a boundary card; a cross-workspace send names both git
identities. A review pass over the integrated diff against spec §12 (security) and AGENTS.md;
findings fixed by the owning task's author or the coordinator.

**Tests**: the scenarios; `pnpm check`, `pnpm test`, `pnpm build`; `git diff --check` over the
integration branch.

---

## Dependency summary

```
T0 ─► T1 ─┬─► T2 ─┬─► T6 ─┐
          │       ├─► T7 ┤
          │       ├─► T9  ┤
          │       └─► T13 ┤
          ├─► T3 ─┼─► T6, T10, T11, T12 (with T2)
          ├─► T4 ─────────┤
          └─► T5 ─► T8 (with T2)
                          └─► T14 ─► T15
```

## Report template (every task)

- Branch and final SHA; files changed (must match the task's ownership list, plus its
  `index.ts` block where allowed).
- What ran (`pnpm check`, which test filters, `pnpm build`) and results; what could not run and why.
- Spec deviations (none expected; each one argued and flagged for the coordinator).
- Requests to other owners.
