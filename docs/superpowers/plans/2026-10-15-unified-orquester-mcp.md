# Unified Orquester MCP — implementation plan

Design (binding): `docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md`, revision 2
(cited as "spec §n"). Sixteen tasks in five waves, each in its own worktree, with explicit file
ownership so parallel branches rarely touch the same file.

---

## Global constraints (every task)

- Follow `AGENTS.md` in full: contracts in `packages/api` first; persisted schemas in
  `packages/config`, tolerant (unknown fields and records preserved on rewrite); MCP tools reach
  the daemon only through `DaemonApi`; socket-only routes only on the unix-socket app; no secrets
  in arguments, logs, API responses, bus events or `events.ndjson`; agent-host protocol changes
  additive and handover-compatible; no dynamic `import()` under `apps/daemon/src/agent-host`; no
  sleep-based timing in tests (fake clocks, the broadcaster, drains, receipts).
- **Never run the daemon** (`pnpm dev*`, the daemon CLI, its port or socket, `systemctl restart
  orquester`). Provider probes (Task 6) use throwaway HOME/config dirs and stub MCP servers, never
  an Orquester session, and record evidence in the report and the session-tools README.
- **Branches.** Task 0 creates the integration branch `feat/unified-mcp` from `main`. Each task
  works on `feat/umcp-t<N>-<slug>` in `.claude/worktrees/umcp-t<N>`, branched from the
  integration branch at its wave's start, and merges back into it only. Never push; never commit
  to `main`.
- **File ownership.** A task edits only the files it owns, plus the one marked block it is given in
  a shared file. Files owned by no task are read-only. A needed change elsewhere is a request in
  the report, applied by the owner (or the coordinator after the owner merged).
- **Shared files.**
  - `apps/daemon/src/index.ts` (wiring): Tasks 2, 3, 5, 6 and 9 each own one block
    `// umcp:t<N> begin` … `// umcp:t<N> end` (service construction + `register…` calls only).
    Conflicts are mechanical; keep both blocks.
  - `apps/daemon/src/mcp/catalog/index.ts`: written once by Task 2 (one import per family module in
    final catalog order); never edited by family tasks.
  - `packages/api/src/agent-chat/wire.ts`, `agent-chat/session-tools.ts`, `agent-chat/lineage.ts`,
    `agent-chat/thread-tools.ts`, `packages/api/src/index.ts`, `packages/config/src/index.ts`:
    Task 1 only — every route, event, field and re-export the plan needs is added up front.
  - `packages/ui/src/lib/agent-chat/presentation.logic.ts`: Task 4 only (labels for all 45 tools
    and every legacy name).
- **Gate per task**: `pnpm check` and the touched packages' tests before every commit;
  `git diff --check`; `pnpm build` when `packages/ui` or web/desktop assets change. Tests live
  under each package's `src/` (the daemon's test script runs `find src -name '*.test.ts'`).
- **Parity**: an unchanged name keeps its behaviour, codes and caps except where spec §4/§11 says
  otherwise; port tests, don't delete them.
- **Descriptions and budgets**: spec §9.5 targets (per-tool bytes, description ≤ 1 000 bytes,
  `.describe()` ≤ 160 bytes); each family task reports its measured bytes.
- **Deletions** of old code (`session-tools/threads|html|secrets`, `mcp/tool-names.ts`,
  `catalog/legacy.ts`, re-export shims) happen only in Task 14.

---

## Waves

| Wave | Tasks | Starts when |
|---|---|---|
| 0 | 0 | now (coordinator) |
| 1 | 1 | Task 0 merged |
| 2 | 2, 3, 4, 5 (parallel) | Task 1 merged |
| 3 | 6, 7, 8, 9, 10, 11, 12, 13 (parallel) | Tasks 2 and 3 merged; Task 8 also needs Task 5 |
| 4 | 14, then 15 | every Wave 3 task merged |

```
T0 ─► T1 ─┬─► T2 ─┬──────────────► T6, T7, T9, T13
          ├─► T3 ─┼─(with T2)────► T6, T10, T11, T12
          ├─► T4 ─┤
          └─► T5 ─┴─(with T2)────► T8
                                   all ─► T14 ─► T15
```

---

### Task 0: Baseline and integration branch

Coordinator, serial.

**Deliverables**: confirm `feat/remove-pr-watch` and `feat/thread-create-options` are in `main`
(or merge them into the integration branch); create `feat/unified-mcp`; record the baseline SHAs
and the measured `tools/list` bytes (chat 24 981 / 16 tools; external 91 551 / 72 tools; spec §2)
in the first commit message — Task 2's budget test cites them.

**Tests**: `pnpm check`, `pnpm test` on the baseline.

---

### Task 1: Shared contracts, persisted schemas, picker logic

Wave 1. Everything later compiles against it.

**Owns**
- `packages/api/src/agent-tools.ts` (new): `TOOLSETS` (ids, labels, tools, per-agent defaults,
  `locked`), `ADMIN_FAMILIES`, the grant table (spec §7.6), settings/grant/toolset-request wire
  types, routes and the `agent-tools` channel / `agentTools.changed` event.
- `packages/api/src/agent-chat/tool-approvals.ts` (new): spec §7.3 types (kinds `admin |
  boundary | toolset`, `file` and `warning` sections), `ADMIN_APPROVAL_TIMEOUT_MS`, caps (64 KiB
  summary, 1 MiB full preview), answer validator, `stripToolApprovalSecrets`, the text sanitiser
  (bidi/control/zero-width stripping, single-line) shared by daemon and UI.
- `packages/api/src/agent-chat/thread-tools.ts`: header v2 build/parse (v1 still parsed), origin
  `reply`, mode-dependent second lines, `THREAD_MESSAGE_OVERHEAD_CHARS = 768`,
  `replyDeliveryContext()`, `toolsetContinueContext()`, `UNTRUSTED_NOTICE` wording.
- `packages/api/src/agent-chat/lineage.ts`: relation `opened`; `delegationDepth` documented as
  delegate + opened links; `parseThreadLineage` accepts `opened`.
- `packages/api/src/agent-chat/wire.ts`: `agentChatRoutes.toolApprovals`, `toolApproval`,
  `replySubscriptions` (socket-only), `agentTools(sessionId)`; `TurnCommandBody.causedBy?:
  {threadId, exchangeId, hop}`; `PendingMergeBack.kind?: "merge" | "reply" | "message"`;
  event union adds `agentChat.toolApproval`.
- `packages/api/src/agent-chat/thread.ts`: `Turn.causedBy?` (type only; the fold is Task 5's).
- `packages/api/src/agent-chat/session-tools.ts`: reference key `toolApproval`.
- `packages/api/src/agent-chat/model-selection.ts` (new) + test: `resolveSelectedModel`,
  `modelChipLabel`, `currentOptionValue`, option-default resolution, `RUNTIME_MODE_LABELS` /
  `HINTS`, moved from the UI; **picker-parity test here** (one fixture snapshot → the picker
  view). `packages/ui/src/components/agent-chat/composer/composer-model.ts`,
  `packages/ui/src/lib/chat-prefs.ts` and the label/hint constants in
  `packages/ui/src/components/agent-chat/composer/ComposerChips.tsx` become re-exports (only those
  lines).
- `packages/api/src/saved-prompts.ts`: `createdBy?: {kind: "agent" | "user", threadId?, agent?,
  title?}`; `usedByWorkflows?` on list rows.
- `packages/api/src/index.ts`: push notify request type; `gitAccount` on workspace rows; the
  agent-profile `daemonPointingServers` read type (`GET /api/agent-profile/daemon-mcp-servers` →
  `{servers: [{agent, home, scope, name, reason}]}`); re-exports.
- `packages/config/src/agent-tools.ts` (new): `agent-tools.json` schema (spec §9.6), tolerant
  parse/serialize, `agentToolsFile()`, pure `resolveThreadToolsets()` (chat override → agent
  default; core locked; master switch) and `findGrant()` (full-access only, workflow ids, project
  union, non-grantable families).
- `packages/config/src/index.ts`: reply outbox schema (`agent-reply-outbox.json`: subscriptions
  with `state`, deliveries), lineage record relation `opened`, saved-prompt `createdBy`
  (`.catch(undefined)`), re-exports.
- `apps/daemon/src/mcp/catalog/contract.ts` (new): spec §3.2 types incl. `ApprovalPort`,
  `ToolCaller` (with `workflowOwned`, `exchange`), `defineTool`, annotation presets — types and the
  identity helper only.

**Tests**: header v1/v2 round trip; answer validator; secret stripping; text sanitiser; config
tolerance (unknown keys kept, corrupt → defaults, grants none); resolver precedence; `findGrant`
rules; picker parity; lineage `opened` parse.

---

### Task 2: Catalog, gate, executor, external server, addressing

Wave 2.

**Owns**
- `apps/daemon/src/mcp/catalog/index.ts`, `catalog/registry.test.ts`, `catalog/legacy.ts`
  (temporary adapter wrapping existing `ToolDef`/`SessionTool`s with spec §4's audience, tier,
  toolset and scope).
- `apps/daemon/src/mcp/gate/{policy,scope,turn-policy}.ts` + tests (`turn-policy.ts` moved;
  `session-tools/turn-policy.ts` becomes a re-export), including the workflow-owned trait (owner +
  lineage walk), path classification (inside a project or denied), own-children, workspace
  resolution, the project-union helper for workflows.
- `apps/daemon/src/mcp/addressing.ts`, `executor.ts` (+ test), `server.ts`, `tool.ts`
  (re-export shim), `result.ts`, `errors.ts`.
- `apps/daemon/src/session-tools/executor.ts`, `session-tools/route.ts` (the chat route uses the
  shared executor; builds the `thread` caller from the snapshot: mode, planning, title,
  workflow-owned, `exchange` from the running turn's `causedBy`).
- Stub family modules (each exports its family's legacy-adapted tools; header comment names the
  owning Wave 3 task; Task 2 never edits them after merge): `mcp/tools/{catalog,sessions,messages,lineage,watch,requests,output,search,usage,files,todos,workflows,agent-profile,desktops,notify,git,saved-prompts,visuals,secrets,toolsets}.ts`.
- `apps/daemon/src/index.ts` block `umcp:t2` (executor/approval-port wiring for both transports).

**Deliverables**: `gate()` as spec §5.2/§5.4/§6 (table-driven; cards and grants through the
`ApprovalPort` from Task 1 — Task 2 ships a test double); argument/pin freezing and the
`PREVIEW_TOO_LARGE` refusal in the executor; generic turn policy and exchange (`causedBy`
computed, `EXCHANGE_LIMIT`); external `/mcp` from `catalogFor("external")` with `_meta`;
registry invariants, import-graph allow-list, "only the executor runs tools", byte-budget tests
(spec §9.5; counts and budgets tighten in Task 14 when every family has landed).

**Tests**: gate matrix (spec §14.2.2); executor (strict parse per audience, stripped keys,
`TOOL_NOT_ENABLED`, deny/card/allow, pins); external server smoke unchanged.

---

### Task 3: Approval cards, toolset requests, settings and grants (daemon)

Wave 2.

**Owns**
- `apps/daemon/src/agent-chat/tool-approvals.ts` (+ test): in-memory registry modelled on
  `secret-requests.ts` for all three card kinds; deadline via injected clock; `signal`;
  `delivered`; answer route with server-side validation (`grant ∈ grantOptions`, sanitised
  strings); 409 for late/second answers; close events; one log line per decision without
  arguments.
- `apps/daemon/src/agent-tools/{service,routes,approval-port}.ts` (+ tests): the
  `agent-tools.json` store (atomic, serialized, move-aside on corrupt), settings with revision,
  chat toolset overrides, toolset declines (30 min), grants (full-access only, workflow ids
  appended on approved creates, chat grants deleted with the thread, `lastUsedAt`), the
  `ApprovalPort` implementation, toolset-request approval → chat override persisted + a
  `toolsetsChanged(threadId)` signal (consumed by Task 6).
- `apps/daemon/src/agent-chat/summary.ts`: pending cards count as pending user input; push
  "Approval needed: <title>" with no action buttons.
- `apps/daemon/src/index.ts` block `umcp:t3`.

**Tests**: spec §14.2.3 in full; store tolerance; both transports with auth on HTTP; revocation
effective next call; grants refused for non-full-access callers; secrets never in events, summaries
or logs (assert on captured publish/log calls).

---

### Task 4: UI — cards, Settings › Agent tools, Tools chip, labels, prompt badge

Wave 2 (against Task 1 contracts with mocked responses).

**Owns**
- `packages/ui/src/components/agent-chat/banners/{ToolApprovalCard.tsx,tool-approval-preview.tsx,use-tool-approvals.ts}`
  (+ render checks), `banners/ChatBannerDock.tsx`, `banners/banner-model.ts`.
- `packages/ui/src/components/settings/AgentToolsSettings.tsx` (+ logic, tests),
  `settings/SettingsModal.tsx`.
- `packages/ui/src/components/agent-chat/status/ToolsChip.tsx` (+ test),
  `status/ChatStatusLine.tsx`.
- `packages/ui/src/lib/agent-tools/{store,hooks}.ts`, `packages/ui/src/lib/api-client.ts`,
  `packages/ui/src/store/app.ts`.
- `packages/ui/src/lib/agent-chat/presentation.logic.ts` (labels; `toolApproval` row states).
- The saved-prompts rail components (only: the "by <agent>" badge and the disabled pin for
  agent-created prompts).

**Deliverables**: spec §7.1 and §9.2 — complete previews with per-section "View all" (full preview
fetched), `file` flags, no autofocus, keyboard approval ignored for 1.5 s after appear/change,
Enter alone never approves, sanitised plain-text rendering, grant menu only from `grantOptions`,
masked secret fields cleared after submit, phone bottom sheet, toolset cards with "Enable for this
chat"; Settings matrix (toolsets × agents, core locked, measured bytes), grants list; Tools chip.

**Tests**: section kinds, flags, View all, autofocus absent, delayed keyboard approval, sanitising,
grant menu presence, expiry; banner ordering; settings logic; chip resolution; **every catalog chat
tool has a `SESSION_TOOL_LABELS` entry** (reads the tool names from `TOOLSETS`); legacy labels;
prompt badge/pin. `pnpm build`.

---

### Task 5: Conversation protocol services, waits, lineage stamping

Wave 2.

**Owns**
- `apps/daemon/src/agent-chat/replies.ts` (+ test): ReplyRouter — subscriptions persisted before
  posting, states and CAS transitions (spec §8.3), restart turns `waiting` into `notify`,
  bus-driven settle detection, failure/closed notices, deliveries with fixed command ids.
- `apps/daemon/src/agent-chat/waits.ts` (+ test): the wait registry moved from
  `session-tools/threads/shared.ts` (which this task edits only to re-export it).
- `apps/daemon/src/agent-chat/lineage.ts`, `lineage-routes.ts`: the delivery queue generalised to
  kinds `merge | reply | message` (queue-not-steer messages), `pendingMerges` with `kind`,
  Deliver now / Discard rules (parent or that child), the socket-only `replySubscriptions` route
  (subscribe → `{subscriptionId, commandId}`), exchange notices at the cap.
- `apps/daemon/src/agent-chat/service.ts`, `apps/daemon/src/agent-chat/chat-sessions.ts`: lineage
  stamping at creation (`opened` relation, `delegationDepth` counting delegate + opened links),
  `causedBy` passed on turn commands.
- `packages/api/src/agent-chat/fold.ts`, `agent-chat/domain-events.ts` (only `causedBy`: additive
  optional field on the turn-start event, folded onto `Turn.causedBy`), and the host's turn command
  pass-through in `apps/daemon/src/agent-host/orchestration/orchestrator.ts` (only `causedBy`).
- `apps/daemon/src/index.ts` block `umcp:t5`.

**Tests**: spec §14.2.6 service-level cases: queue binding by command id, persisted-before-post,
CAS races in both orders, restart conversion and receipt-deduped re-post, notices, hop carried on
merges/replies/messages and reset only by a user turn, `causedBy` fold round trip and older logs
without it.

---

### Task 6: Chat transport — manifest, deny lists, toolset application, aliases, probes

Wave 3 (needs Tasks 2 and 3).

**Owns**
- `apps/daemon/src/session-tools/{manifest,instructions,legacy-aliases,registry,index}.ts` (+ tests).
- `apps/daemon/src/agent-host/host-protocol.ts` (additive: manifest route, host
  `/threads/:id/session-tools/refresh`), `apps/daemon/src/agent-host/session-tools/**` (per-thread
  lists, refresh, `list_changed` where proven, `legacy-definitions.ts` for an old daemon).
- Provider launch wiring, only the session-tools and deny parts:
  `agent-host/adapters/claude/{launch.ts,session-tools.ts}` (`allowedTools`, `disallowedTools`
  `mcp__<name>`), `adapters/codex/{session-tools.ts,session.ts}` (thread config
  `mcp_servers.<name>.enabled = false`), `adapters/grok/{session-tools.ts,launch.ts}` (overlay
  drops the server), `adapters/opencode/session-tools.ts` (ruleset deny `<name>_*`); the
  restart-at-idle path and the automatic continue turn for `request_toolset`.
- `apps/daemon/src/index.ts` block `umcp:t6` (manifest route on the socket app; refresh on
  `toolsetsChanged`/`agentTools.changed`).

**Deliverables**: manifest `{tools, instructions, deny}` (spec §9.4): toolsets resolved, Admin
removed for workflow-owned threads, `deny` from Task 11's `daemon-mcp-servers` read (empty until
Task 11 lands; the route contract is Task 1's); instruction block (spec §10, worst case ≤ 2 048);
`request_toolset` application both ways (spec §9.3); aliases with old semantics and legacy
definitions on a 404 (spec §14.1). **Probes** (recorded): `tools/list_changed` per CLI; Claude's
server-level `disallowedTools` rule form on the bundled CLI (fallback: per-tool names); Claude's
MCP tool search with an in-process server; Claude/Grok precedence for a user `orquester` server.

**Tests**: spec §14.2.5; deny entries per provider; instruction block budget; automatic continue
skipped when the user spoke first.

---

### Task 7: Sessions family — reads and lifecycle

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/{sessions,output,requests,search}.ts` (+ tests),
`apps/daemon/src/mcp/{views,transcript,history}.ts` (as these tools need).

**Deliverables**: `list_sessions`, `get_session` (lineage, pending deliveries, delegate `result`),
`read_transcript`, `read_tool_output`, `get_turn_diff`, `search_sessions`, `update_session`, `control_session` (own-children rules,
spec §4.1), `respond_to_request` (provider requests only; never Orquester cards). Scope claims and
chat notes; `notice` and `threadRef`.

**Tests**: ported external tests; one per spec §11 row of this family; chat scope cases (own
project default, `"all"`, own-children, self, plan-mode data-change refusal); a card id passed to
`respond_to_request` is not found.

---

### Task 8: Conversation and lineage tools

Wave 3 (needs Tasks 2 and 5).

**Owns** `apps/daemon/src/mcp/tools/{messages,lineage,watch}.ts` (+ tests),
`apps/daemon/src/mcp/wait.ts`.

**Deliverables**: `create_session` (prompt/reply/delegate, defaults, caps, account source, legacy
models marked), `send_message` (reply modes, queue-not-steer via Task 5's route, subscription
before posting, wait→notify on timeout/needs-input, `implementPlan` refused while planning, header
v2), `wait_for_session` (`sessionIds`, `timeoutSeconds`), `fork_session`, `merge_back_session`
(forks only; deliver/discard by parent or child).

**Tests**: tool-level spec §14.2.6 cases, `WAIT_CYCLE` across projects, caps, cross-project
create/send per mode (port double), delegates refusing merge-back, ported tests for
`send_message`, `implement_plan`, `create_session`, lineage tools.

---

### Task 9: Discovery, usage, notify, files, git

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/{catalog,usage,notify,files,git}.ts` (+ tests),
`apps/daemon/src/mcp/{agents,usage-view,fs-tools,daemon-api}.ts`, `apps/daemon/src/push.ts` and
its notify route, `apps/daemon/src/index.ts` block `umcp:t9`.

**Deliverables**: `list_projects` (`repoId`, `gitAccount`, chat `current`/`sameRepo`),
`list_agents` (picker view from Task 1's `model-selection.ts`; chat `thisThread`,
`allowedRuntimeModes`, accounts without email; legacy rules), `list_conversations` (stays in
`catalog.ts`), `get_usage` (`include`, `bucket: day|week`, session view with estimated Codex cost
from the cost table, `costSource`, `partial`), `notify_user`, `read_file` (directories; project
paths only for chat), `get_git_state`; `DaemonApi.listDirectory`/`readFileRange`.

**Tests**: usage session sums/estimates/week buckets; notify rate limits (fake clock) and payload;
file paging and path classification; git views capped; `sameRepo`.

---

### Task 10: Workflows family

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/{workflows,workflows-guide,workflow-preview}.ts` (+ tests).

**Deliverables**: the 12 workflow tools of spec §4 with tiers and toolsets (`reads`:
`list_workflows`, `get_workflow`, `get_workflow_runs`; the rest `workflow-authoring`); scope =
project union (workflow project, `set_project`, `projectOverride`, temp-project workspace);
previews (blocks, full code/shell, HTTP, agent prompts in full incl. referenced saved-prompt
bodies, union with identities, graph diff); revision pin on `run_workflow`/`update_workflow`
(`PREVIEW_STALE`); `set_workflow_secret` card value for chat callers; grants scoped to approved
workflow ids.

**Tests**: ported workflow tests; union computation; preview completeness and
`PREVIEW_TOO_LARGE`; revision pin; chat secret flow; grant coverage for the create → run → fix
loop and its refusal for a workflow not approved in the chat.

---

### Task 11: Agent-profile family and daemon-pointing MCP detection

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/{agent-profile,agent-profile-preview}.ts` (+ tests);
`apps/daemon/src/agent-profile/` (only the detection module, its route
`GET /api/agent-profile/daemon-mcp-servers`, and the plugin `provides`/commit reads previews
need); the agent-profile panel's flagged-server row in `packages/ui/src/components/agent-profile/`
(only that component).

**Deliverables**: `get_agent_profile` (all read modes), `edit_agent_profile` (batch ≤ 10, every
action Admin incl. `import_scan`, `{ask: true}` secret fields, suspicious-value flags,
daemon-pointing flag); complete previews (whole skill/command files, text files in full,
binaries/executables flagged with hashes, plugin `provides` with commands, marketplace/plugin
commits, instruction diffs); pins (item revisions, file hashes, commits) with `PREVIEW_STALE`.
Detection over user configs, **every managed account home**, and project-level configs, by bearer
verification (through an auth-verifier port injected by the daemon, never exposing the bearer) or
URL match; `orquester`-named servers flagged.

**Tests**: ported agent-profile tests; batch validation before the card; secret values only from
the card; preview completeness per item kind; TOCTOU refusals; detection per CLI config shape and
per home.

---

### Task 12: Notes and desktops

Wave 3 (needs Tasks 2 and 3).

**Owns** `apps/daemon/src/mcp/tools/{todos,saved-prompts,desktops,desktop-preview}.ts` (+ tests),
`apps/daemon/src/mcp/todo-tools.ts` (reduced to DaemonApi calls), `apps/daemon/src/saved-prompts.ts`
(persist `createdBy`; refuse pinning agent-created prompts from tools; `usedByWorkflows` on list
rows via the workflow store read).

**Deliverables**: `list_todos`, `update_todos` (through `/api/todos`), `list_saved_prompts`,
`update_saved_prompts` (Act / Admin `saved-prompts` / Admin `workflows` per spec §4.1, diff
previews naming referencing workflows), `get_desktops`, `control_desktop` (open/launch Admin;
stop/close Act).

**Tests**: ported todo and desktop tests; prompt tiers for agent-created, user-created and
workflow-referenced prompts; no pinning; `createdBy` tolerance on read/rewrite.

---

### Task 13: Visuals, secrets and `request_toolset` tools

Wave 3 (needs Task 2).

**Owns** `apps/daemon/src/mcp/tools/{visuals,secrets,toolsets}.ts` (+ tests; visuals and secrets
copied from `session-tools/html/` and `session-tools/secrets/`, which Task 14 deletes).

**Deliverables**: `html_preview`, `html_render`, `request_secret` as chat-only catalog tools
(trimmed to spec §9.5 targets, behaviour unchanged); `request_toolset` (card via the port; already
on → immediate; declines; workflow-owned → denied; results per spec §9.3).

**Tests**: existing html and secrets tests moved and passing; `request_toolset` paths.

---

### Task 14: Documentation, switch-over, deletions

Wave 4.

**Owns** `docs/orquester-mcp.md` (41-tool surface, spec §11 migration section, the in-chat
denial of this server, safety notes); `apps/daemon/src/session-tools/README.md` (chat transport:
manifest, toolsets, tiers, cards, conversation protocol, probe evidence); `apps/daemon/src/agent-host/README.md`
(module map); `README.md` pointers; `AGENTS.md` — only the one-line **MCP** term (the catalog
serves external clients and in-chat agents); final `SERVER_INSTRUCTIONS` and version `3.0.0` in
`mcp/server.ts`; deletes `session-tools/threads/`, `session-tools/html/`,
`session-tools/secrets/`, `mcp/tool-names.ts`, `mcp/catalog/legacy.ts`, the turn-policy re-export,
empty modules; tightens registry counts (41 / 45 / 22) and budgets; marks the 2026-10-14 spec's
§1.3/§5 superseded (one line); documents the alias/legacy-definition removal criterion.

**Tests**: `pnpm check`, `pnpm test`, `pnpm build`; a test that the tool table in
`docs/orquester-mcp.md` equals `catalogFor("external")`.

---

### Task 15: Scenario tests, verification, review

Wave 4, after Task 14.

**Owns** `apps/daemon/src/mcp/scenarios.test.ts` (new) and fixtures it needs under
`apps/daemon/src/`.

**Deliverables**: spec §14.2.11 scenarios over in-process routes and a fake host; a review pass of
the integrated diff against spec §12 and AGENTS.md; findings fixed by the owning author or the
coordinator.

**Tests**: the scenarios; `pnpm check`, `pnpm test`, `pnpm build`; `git diff --check`.

---

## Report template (every task)

- Branch, final SHA, files changed (= ownership list + its `index.ts` block).
- Measured `tools/list` bytes of the tools it owns vs spec §9.5 targets.
- What ran and results; what could not run and why.
- Spec deviations (each argued and flagged) and requests to other owners.
