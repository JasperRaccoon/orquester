# T3 Code vs Orquester: orchestration, thread model, multi-agent

Analyst 03 of 9. Scope: T3's orchestration-v2 (graph, IDs, lineage and context transfer, provider switching, feature lifecycles, orchestrator MCP), context and portable handoffs, thread migration, outside agents, activity log, event sourcing and persistence, fork/merge/checkpoints/rollback, and agents driving agents. Compared against Orquester's agent host, its MCP catalog, `agent-chat` lineage, delegates and replies, continue-in-another-agent, goals, and workflows.

T3 paths are relative to `t3code_codebase/`. Orquester paths are relative to the repo root. T3 was read at `ed9b7ca9`. "(new)" marks something that landed in `e8d87689..ed9b7ca9`.

## Where the two models line up

Both products now have most of the same building blocks, and several Orquester pieces are direct ports from T3 (`apps/daemon/src/agent-chat/activity-ladder.ts`, `packages/ui/src/lib/agent-chat/queue.logic.ts`, `packages/api/src/agent-chat/handoff.ts` all say "Ported from / after T3 Code"). Before listing gaps, here is the mapping, so similar features with different names are not reported as missing.

| T3 concept | Orquester equivalent |
|---|---|
| AppThread / Run / ProviderThread (`docs/orchestration-v2/core-graph-and-data-model.md`) | Chat session = thread (`sessionId`), turns, provider-session binding (`apps/daemon/src/agent-host/store/binding.ts`) |
| V2 event store + projections in SQLite (`apps/server/src/orchestration-v2/EventStore.ts`, `ProjectionStore.ts`, `persistence/OrchestrationEventStore.ts`) | Per-thread `events.ndjson` (durable) + fold snapshot + host-wide SQLite thread index with FTS5 (`apps/daemon/src/agent-host/store/**`, `index/**`) |
| Command receipts (`CommandReceiptStore.ts`) | Host receipts ring, `commandId` on every command (`agent-host/store/**`, AGENTS.md rules) |
| `thread.fork` + `ContextTransfer(fork)` (`ThreadForkService.ts`) | `POST /api/sessions/:id/fork`, `fork_session` (`apps/daemon/src/agent-host/orchestration/fork.ts`, `apps/daemon/src/mcp/tools/lineage.ts:133`) |
| `merge_back` transfer, `t3_thread_merge_back` | `merge_back_session`, persisted merge outbox (`packages/api/src/agent-chat/lineage.ts:256-345`, `packages/config/src/index.ts:1551-1566`) |
| Portable provider handoff (`ContextHandoffService.ts`, `packages/provider-core/src/server/handoffBudget.ts`) | "Continue in another agent": a fork with a budgeted transcript (`packages/api/src/agent-chat/handoff.ts`, `packages/ui/src/components/agent-chat/ContinueInAgentDialog.tsx`) |
| `delegate_task` / `task_status` / `task_cancel` | `create_session {delegate:true}`, `wait_for_session`, `control_session`, delegate stop cascade (`apps/daemon/src/mcp/tools/messages.ts:886`, `apps/daemon/src/agent-chat/delegates.ts`) |
| `create_threads`, `t3_thread_send/wait/interrupt/read/list/search` | `create_session`, `send_message` (reply `wait`/`none`/`notify`), `wait_for_session`, `control_session`, `read_transcript`, `list_sessions`, `search_sessions` |
| `orchestrator_capabilities` | `list_agents` |
| `t3_pending_request_*` | `respond_to_request` (`apps/daemon/src/mcp/tools/requests.ts:215`) |
| `DelegatedTaskQuestionReactor.ts` (child question wakes the parent) | `replies.ts` "attention" notices (`apps/daemon/src/agent-chat/replies.ts:962-1060`) |
| Runtime/interaction-mode escalation denial | "never broader" rule and planning turn policy (`apps/daemon/src/mcp/tools/sessions.ts:451-460`, `apps/daemon/src/mcp/gate/turn-policy.ts`) |
| Thread relationships UI / Lineage (`apps/web/src/components/chat/ThreadRelationshipsControl.tsx`) | `ThreadLineageBar.tsx`, `LineageMark.tsx`, agent roster with drill-in (`packages/ui/src/components/agent-chat/roster/**`) |
| Provider goal banner (Codex, Claude) | Agent goals for Claude, Codex and Grok (`docs/superpowers/specs/2026-09-24-agent-goals-design.md`) |
| Usage-limit recovery (`UsageLimitRecoveryWorker.ts`) | `apps/daemon/src/agent-chat/limit-recovery.ts`, workflow failover chain (`apps/daemon/src/workflows/agent/failover.ts`) |

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (with evidence) | User value | Port effort |
|---|---|---|---|---|
| **Switching provider inside the same thread.** The model picker unlocks other providers, and the same thread continues on another agent. Returning to an earlier provider resumes its old native thread and injects only the delta it missed. | `apps/server/src/orchestration-v2/ProviderSwitchService.ts`; `apps/web/src/components/ChatView.tsx:748,1172` (`threadSupportsProviderHandoff` unlocks `modelPickerLockedProvider`); `docs/orchestration-v2/provider-switching-and-context.md`; `ContextHandoffService.ts:84,424` (`delta_since_target_last_seen` / `full_thread_summary`) | **Partial.** The agent is fixed for each tab. "Continue in another agent" always forks into a **new** tab (`ForkSessionRequest.refId`, `packages/api/src/agent-chat/lineage.ts:190-235`). `update_session` changes only model, options, mode and account inside the same agent (`apps/daemon/src/mcp/tools/sessions.ts:433-436`). There is no return-to-provider delta. | H | L |
| **Context-window-aware handoff budget with anchors.** The budget comes from the model window minus current native usage, attachments and a reserve (16k or a quarter of the window). It always keeps the first user request plus the latest user and assistant messages, then fills newest-first. The cap is configurable with `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`. | `packages/provider-core/src/server/handoffBudget.ts:14-19, 109-136, 223-264`; `docs/user/portable-handoffs.md` | **Partial.** Fixed 64 KB, one unbroken newest-first stretch, with no anchoring of the original request and no window awareness (`packages/api/src/agent-chat/handoff.ts:27, 206-236`). Context usage with `maxTokens` exists but is not used (`packages/api/src/agent-chat/runtime-events.ts:492-498`). | H | S |
| **Native history injection for Codex.** Handoff messages go in as real conversation items through `thread/inject_items`, not as a prompt preamble. | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:1757, 6743-6766` | **Missing.** The binding is generated but unused (`apps/daemon/src/agent-host/adapters/codex/_generated/protocol/v2/ThreadInjectItemsParams.ts`; no caller outside `_generated`). | M | S |
| **File restore on rollback, with a shared-workspace safety guard.** `rollback` can restore the checkpoint's files, and refuses when the checkout may hold another thread's changes. | `apps/server/src/orchestration-v2/CheckpointRollbackService.ts:96, 222, 276`; `CheckpointRestoreSafety.ts:9-10` (`SHARED_WORKSPACE_RESTORE_MESSAGE`); web `useTimelineRewind` (commit `9f087f78`, (new) refactor) | **Missing by design.** "There is no restore path at all … reverts the conversation only" (`apps/daemon/src/agent-host/checkpoints/service.ts:1-11`). `control_session rewind` is conversation-only (`apps/daemon/src/mcp/tools/sessions.ts:737`). | H | M |
| **Idle Claude compaction before the prompt cache expires** (beta). When a completed Claude thread is over about 100k tokens and idle, `/compact` is sent as a visible turn about 2 minutes before the 5m or 1h cache TTL runs out. There is a global default plus per-instance overrides. | (new) `apps/server/src/orchestration-v2/IdleCompaction.ts`, `IdleCompactionService.ts` (commits `5d3875d7`, `d13fc846`); TTL capture in `Adapters/ClaudeAdapterV2.ts:240-272` (`promptCacheExpiresAt`) | **Missing.** Only manual `control_session compact` (`apps/daemon/src/mcp/tools/sessions.ts:800-804`). The Claude usage parser reads `cache_creation_input_tokens` but not the TTL split or expiry (`apps/daemon/src/agent-host/adapters/claude/usage.ts:55, 291`). The subagent 1h/5m TTL tuner exists, but it is a different feature (`apps/daemon/src/subagent-cache-ttl.ts`). | M-H | M |
| **Server-side durable message queue that agents can edit.** Queued runs live in the projection (`status:"queued"`, `queuePosition`), are visible from every client, and agents can list, read, edit, cancel, reorder and promote-to-steer them over MCP. A Stop holds the queue. | `apps/server/src/orchestration-v2/QueuedRunOrder.ts`; `apps/server/src/mcp/toolkits/thread/tools.ts:80-130` (`t3_queue_*`); `docs/orchestration-v2/feature-lifecycles.md` "Steering And Queueing"; (new) `96f09c65` "send selected held messages when a thread is stopped" | **Partial.** The queue is client-side, per browser tab in `sessionStorage` (`packages/ui/src/lib/agent-chat/queue.logic.ts:1-30`, `packages/ui/src/components/agent-chat/composer/composer-outbox.ts:1-30`). Another device or the PWA does not see it, and no MCP tool touches it. The host queue holds turns only behind a compaction. | M-H | L |
| **Scoped sign-in for outside agents.** OAuth MCP sign-in with a pairing code. The user picks Read only, Supervised or Full access, and the grant expires after 30 days and can be revoked in Settings → Connections. | `apps/server/src/auth/McpOAuth.ts`, `mcpOAuthHttp.ts`, `mcpOAuthHtml.ts`; `apps/server/src/mcp/McpHttpServer.ts`; `docs/user/outside-agents.md` ((new) doc update `9c6523d5`) | **Partial.** A bearer-authenticated `POST /mcp` exists, but it is "this full-trust endpoint" (`README.md:91`). There is no OAuth discovery (`/.well-known/oauth-*` not found under `apps/daemon/src`) and no per-credential read-only or supervised tier for external callers (`apps/daemon/src/mcp/gate/policy.ts:5`: external callers never reach the gate). | M-H | M |
| **`t3 thread` CLI for scripts on the host:** `start`, `send --wait`, `show`, `list`, with stdin input and exit codes 1 (failed) and 2 (waiting for the user). | (new) `apps/server/src/cli/thread.ts` (710 lines, commit `955b4cc8`), reusing `mcp/AcpMcpStdioBridge.ts` | **Missing.** `apps/daemon/src/cli.ts` (35 lines) only starts the daemon. There is no thread CLI, and `/mcp` is not served on the unix socket (`README.md:219`). | M | S |
| **An agent can wake itself on a schedule or on a PR.** `schedule_task` with `bindToCurrentThread` (default true) posts each run into the calling thread. `watch_pull_request` wakes the thread when checks fail or pass, on review comments, or when the branch starts to conflict. | `apps/server/src/mcp/toolkits/orchestrator/tools.ts:119-170`; `packages/contracts/src/orchestratorMcp.ts:595-611`; `apps/server/src/mcp/toolkits/pullRequests/tools.ts:317-331`; `orchestration-v2/PullRequestWatchReactor.ts`; webhook filters and dedupe are (new) (`0c85b0d9`, `2ebe280e`) | **Partial.** Workflows have `trigger.schedule` and a polled `trigger.git` (`packages/api/src/workflows/block-types.ts:52-79`), but an agent block opens a **new** session. Nothing posts into the calling chat, there is no PR-watch wake, and there is no webhook trigger ("Polled, never a webhook", `block-types.ts:72`). | M | M |
| **Orchestration-aware activity summaries,** such as "Sent 5 messages to 2 threads" or "Created 3 threads". Failed calls are not counted, and a wait or interrupt is not reported as finished. | `packages/client-runtime/src/t3ToolSummary.ts`; `packages/shared/src/t3McpToolPresentation.ts`; `docs/user/activity-log.md` | **Partial.** Each tool row links to the thread it touched (`packages/ui/src/components/agent-chat/thread-link.render.test.ts`), but the grouped summary buckets Orquester MCP calls as "other" (`packages/ui/src/lib/agent-chat/presentation.logic.ts:206-245, 392`). | L-M | S |
| **Durable effect outbox.** Provider side effects (`provider-turn.start/steer/restart/interrupt`, `provider-thread.rollback`, `checkpoint.capture`, `delegated-tasks.stop`, cleanups) are committed in the same transaction as the events, and a worker claims and retries them. | `apps/server/src/orchestration-v2/EffectOutbox.ts:33-141`, `EffectWorker.ts`; `docs/internals/glossary.md` "Outbox effect" | **Partial (separate solutions per feature).** Receipts for commands, a persisted merge outbox (`packages/config/src/index.ts:1551`), persisted reply notices (`apps/daemon/src/agent-chat/replies.ts:962-972`), and persisted workflow wait state. There is no generic outbox. | L (to users) | L |
| **Batch thread creation.** `create_threads` takes 1 to 20 entries per call, and one `clientRequestId` gives stable IDs on retry. | `apps/server/src/mcp/toolkits/orchestrator/tools.ts:182`; `docs/orchestration-v2/orchestrator-mcp-server.md` "create_threads" | **Missing (by policy).** `create_session` opens one chat, with at most 6 open children and depth 2 (`apps/daemon/src/mcp/tools/messages.ts:358-360, 1045`). | L | S |
| **Moving a thread into a worktree.** `t3_worktree_handoff` moves the calling thread into a new worktree. `t3_thread_launch` with `workspaceStrategy` binds a new agent to a worktree, an existing checkout, or the project root. | `apps/server/src/mcp/toolkits/worktree/tools.ts:28-61`; `orchestration-v2/ThreadLaunchService.ts` | **Missing** for worktrees (no worktree-per-chat anywhere under `apps/daemon/src/agent-chat`, `mcp`, or `packages/api/src/agent-chat`). Isolation comes from **boxes** (temporary agent VMs) instead (`apps/daemon/src/boxes/temporary/tools.ts`). | M | M (mostly the source-control analyst's domain) |
| **"Waiting" status while a turn waits on another thread.** | (new) commit `b0ed393c`; `packages/client-runtime/src/t3ToolSummary.ts` | **Missing.** A parent blocked in `send_message {reply:"wait"}` shows as working (no "waiting on" state in `packages/ui/src/lib/agent-chat/status.logic.ts`). | L | S |
| **Thread snooze, settle and pin, also driven by agents** (`t3_thread_organize`). | `apps/server/src/mcp/toolkits/thread/tools.ts:31`; `ThreadSettlementService.ts` | **Missing.** "Orquester has no snooze" (`packages/ui/src/lib/agent-chat/status.logic.ts:75-76`). | L | M (sidebar analyst's domain) |

## 2. They do it better

1. **One lineage primitive for every kind of context transfer.** T3 models forks, provider switches, merge-back and subagents as `ContextTransfer` (relationship + source point + lazy resolution) plus an optional `ContextHandoff` artifact (`docs/orchestration-v2/thread-lineage-and-context-transfer.md`). The records can be audited (`t3_thread_transfers`, `apps/server/src/mcp/toolkits/thread/tools.ts:225`), they are superseded on rollback, and one hook resolves them at run start. Orquester handles the same cases with separate mechanisms: the fork handoff record (`packages/config/src/index.ts:1532-1549`), the merge outbox, reply subscriptions, and a delegate's first prompt. Each works on its own, but there is no single audit view of what context reached which agent, and "transferred context" cannot be invalidated by a rewind.

2. **Lazy choice of agent when forking.** A T3 fork records lineage only; the first message picks the provider, then tries a native fork and falls back to portable context (`docs/orchestration-v2/feature-lifecycles.md` "Forking Threads"; `ThreadForkService.ts`). Orquester asks for the agent when the fork is created (`fork_session.agent`, `ContinueInAgentDialog`). A user who forks to explore and later wants a different agent has to fork again.

3. **Handoff quality.** Beyond the budget gap in section 1, T3 handoffs:
   - point the new agent at exact retrieval coordinates (`t3_thread_read` with `itemId`/`textOffset`; `ContextHandoffDelivery.ts:45-53`);
   - never shorten the user's new request;
   - fail explicitly when not even the retrieval references fit (`docs/user/portable-handoffs.md` "Context limits").

   Orquester also names `read_transcript` and the last omitted turn (`handoff.ts:186-192`), which is good. But when one message is over budget, Orquester keeps the tail of the newest message, while T3 keeps whole items and reports what it left out.

4. **Rollback reconciles with the provider and the files.** T3 rolls back by app run count, calls the provider's rollback where it exists (Codex `thread/rollback`, including the paginated-history guard), marks later handoffs as superseded, and can restore files (`CheckpointRollbackService.ts`). Orquester's two-phase conversation rollback is solid (`apps/daemon/src/agent-host/adapter.ts:239-241`), but the files stay as they are. Users have to undo edits by hand or with git.

5. **Queue behaviour across devices.** See section 1. Because T3's queue is server state, mobile, desktop and agents all see and reorder the same queue. Orquester's tab-local outbox is carefully engineered (reload replay, drain generation, hold-at-front), but it cannot be shared.

6. **Architecture docs.** `docs/orchestration-v2/*` (about 3,200 lines) describes one target model with stated invariants ("Child execution completion never closes the parent run", "Provider switches create explicit context handoff artifacts"). Orquester's equivalent is spread across several specs (`2026-09-21-agent-chat-gui-design.md`, `2026-10-14-agent-visuals-and-session-tools-design.md` §6, `2026-10-15-unified-orquester-mcp-design.md`). That is not a product gap, but a single lineage chapter would help new contributors.

## 3. Worth copying (ranked by value ÷ effort)

MIT allows reuse with attribution. Keep the existing "Ported from T3 Code (MIT): <path>" header convention.

1. **Window-aware, anchored handoff budget (H/S).**
   - Land in `packages/api/src/agent-chat/handoff.ts`. Change `selectHandoffMessages` to accept a budget computed as `min(cap, window − usedTokens − reserve(max(16k, window/4)) − currentInput)`, with the window taken from the parent's latest `thread.token-usage` `maxTokens` (`runtime-events.ts:492-498`) or the 128k fallback.
   - Before the newest-first fill, add the anchors: newest user, newest assistant, then the first user message.
   - Keep whole messages only, and render a "Selected N of M; omitted K" line.
   - Crib `packages/provider-core/src/server/handoffBudget.ts:109-264` (`handoffBudget`, `selectHistory`).
   - Update the picker preview in `packages/ui/src/lib/agent-chat/continue-in.logic.ts`, which shares the function.
   - Tests: `packages/api` handoff tests.

2. **Activity summaries for Orquester MCP calls (M/S).**
   - Land in `packages/ui/src/lib/agent-chat/presentation.logic.ts`: add an `orchestration` bucket in `toolGroupAction` for `mcp__orquester__{send_message,create_session,fork_session,merge_back_session,control_session,wait_for_session}`.
   - Count distinct targets from `threadRef` (`apps/daemon/src/mcp/tools/session-access.ts:101`).
   - Crib `packages/client-runtime/src/t3ToolSummary.ts` and its rules from `docs/user/activity-log.md`: failed calls do not count, and a wait or interrupt is never reported as done.

3. **`orq thread` CLI (M/S, (new) in T3).**
   - Add a subcommand to `apps/daemon/src/cli.ts`, or a bin in `apps/daemon/package.json`, that talks to the unix socket with the existing REST routes (create session, `/turn`, reply wait, transcript), reusing `apps/daemon/src/chat-client/index.ts` helpers (`listSessions`, `readThread`, `sendCommand`, `assistantTextForTurn`).
   - Copy the UX and exit codes of `apps/server/src/cli/thread.ts` (`--wait`, `-` for stdin, `--json`, exit 2 when waiting for the user).
   - The socket is trusted local control, so no new auth is needed.

4. **Idle Claude compaction before cache expiry (M-H/M, (new) in T3).**
   - Claude adapter: in `apps/daemon/src/agent-host/adapters/claude/usage.ts`, read `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` to derive TTL and `promptCacheExpiresAt` (from the request start).
   - Host scheduler: add `apps/daemon/src/agent-host/orchestration/idle-compaction.ts`. On turn settle, schedule one compaction per (thread, turn) with a deterministic `commandId` (`idle-compact:<thread>:<turn>`), and skip it when any of these hold:
     - a pending request;
     - a queued merge or reply for that thread;
     - background liveness;
     - an active goal;
     - a delegate child;
     - usage below 100k.
   - Setting: a global setting and a per-agent-account override in `packages/config`.
   - Crib `IdleCompaction.ts` (window predicate) and `IdleCompactionService.ts`. Note that T3 keeps timers in memory. Orquester's host survives daemon restarts, so in-memory timers are acceptable at first.

5. **Scoped external MCP access (M-H/M).**
   - Add an access level to the external credential (read / supervised / full). Enforce it in the catalog executor by tool `tier` (`apps/daemon/src/mcp/catalog/contract.ts`, `executor.ts`). Mint and revoke credentials in the existing device-link and credentials UI.
   - OAuth discovery and authorization-code flow for `claude mcp login` / `codex mcp login` / ChatGPT can follow later. Crib `apps/server/src/auth/McpOAuth.ts`, `mcpOAuthHttp.ts`, `mcpOAuthHtml.ts`.
   - Keep auth decisions server-side, as AGENTS.md requires.

6. **File restore on rewind, isolation-gated (H/M).**
   - Land in `apps/daemon/src/agent-host/checkpoints/` with a new `restore.ts`: `git read-tree` + `checkout-index` from `refs/orquester/checkpoints/<thread>/turn/<n>`.
   - Allow it only when no other chat in the same project has captured a checkpoint since turn n, and the working tree's current diff equals the thread's own diff chain. Otherwise refuse with T3's message.
   - Expose it as `control_session rewind {restoreFiles:true}` and as a checkbox in the GUI rewind.
   - Crib `CheckpointRestoreSafety.ts` and `CheckpointRollbackService.ts:200-290`.
   - This reverses a deliberate spec decision (§5.5), so it needs an owner decision first.

7. **Server-side queue (M-H/L).**
   - Move queued composer messages into the host as `turn.queued` events with a `queuePosition`, released at the boundary rule already in `queue.logic.ts`.
   - Routes for edit, cancel, reorder and promote-to-steer go into `packages/api/src/agent-chat/wire.ts` (`agentChatRoutes`). Add MCP tools for agents.
   - Crib `QueuedRunOrder.ts`, `ThreadMessageIntake.ts` and the `t3_queue_*` handlers.
   - Keep the client outbox only for sends in flight.

8. **Switching agent inside one chat (H/L).**
   - Let a chat hold several provider bindings (one per agent and account home, preserving resume identity per AGENTS.md).
   - On the switch turn, send a handoff (item 1). When returning to an earlier agent, resume its binding and inject only the turns since it last took part.
   - Crib `ProviderSwitchService.ts`, `ProviderSessionTransitionPolicy.ts`, `ContextHandoffService.ts` (delta selection), and the coverage model in `provider-switching-and-context.md`.
   - Lands in `apps/daemon/src/agent-host/orchestration/orchestrator.ts`, `store/binding.ts` and the composer agent picker.
   - Large because the agent (`refId`, account home, adapter) is fixed per tab today. "Continue in another agent" already covers most of the user need.

Further candidates if capacity allows: agent self-wake (`schedule_task` bound to the calling chat, which could be a workflow `agent` block option "post into session X"), PR-watch wakes, and Codex `thread/inject_items` for handoffs into Codex (small, after item 1).

## 4. We do it better / they lack

- **The agent host survives daemon restarts.** Adapters and provider children run in a separate tmux-hosted process, so a deploy does not interrupt turns (`apps/daemon/src/agent-host/README.md` intro). T3's server owns provider processes and needs `RestartContinuation.ts` / `ProviderRuntimeRecoveryService.ts` to recover.
- **Agents can approve tool calls; T3 tried and reverted.** External clients can decide provider tool approvals (`respond_to_request`, `apps/daemon/src/mcp/tools/requests.ts:215-230`). T3 shipped "MCP agents respond to approvals" and reverted it in the same window ((new) `44f977f4` → `2bc2d80e`).
- **A parent hears about every kind of blocked child.** Orquester notifies the parent about a delegated child's questions, approvals **and** secret requests, persisted before hand-off (`replies.ts:962-1060`). T3 routes questions only: "Approvals are not routed" (`docs/orchestration-v2/orchestrator-mcp-server.md`).
- **Approval cards and tiers for agent actions.** Every in-chat MCP tool is Read, Act or Admin, and Admin calls wait for the user's approval card (`apps/daemon/src/mcp/gate/policy.ts`, `README.md:91`). There are also hard caps (6 open children, depth 2, `messages.ts:358-360`). T3 relies on privilege ceilings and has no per-call user approval.
- **Merge-back carries the actual result and the user controls delivery.** Orquester sends the fork's final reply, or a text the agent writes, verbatim. The delivery queue has Deliver now / Discard and survives restarts (`lineage.ts:256-345`). T3's merge-back delta compacts each item to 240 characters (`docs/internals/context-handoffs.md`).
- **Account continuation.** Orquester can fork into another account of the same agent, and the workflow failover chain switches accounts in-session (`ForkSessionRequest.accountId`; `apps/daemon/src/workflows/agent/failover.ts`). T3 has no counterpart.
- **Workflows as orchestration.** Orquester has a graph engine with agent, code, shell, http, if/switch/merge, wait and sub-workflow blocks, git and schedule triggers, persisted wait state, secrets, and an MCP authoring surface (`apps/daemon/src/workflows/**`, `packages/api/src/workflows/block-types.ts`). T3 has scheduled prompts and webhooks only.
- **Search.** Orquester uses an FTS5 index over all thread logs (`agent-host/index/**`). T3's `ThreadSearch.ts:98` uses `LIKE` over `json_extract(payload_json)`.
- **Goals on more providers.** Orquester has goals for Claude, Codex and Grok, with goal-aware interrupt, update and session policies (`docs/superpowers/specs/2026-09-24-agent-goals-design.md`; `sessions.ts:506-512`). T3 shows goal banners for Codex and Claude only (`packages/contracts/src/orchestrationV2.ts:857-907`).
- **Durability without migration pain.** Orquester's append-only per-thread NDJSON is the record, and its caches can be rebuilt. T3 needed a one-time V1→V2 database copy that imports only user and assistant text, losing checkpoints, tool activity, approvals and plans (`docs/internals/legacy-orchestration-migration.md`, `docs/user/thread-migration.md`). T3 also has no whole-thread export.
- **Isolation.** Boxes (temporary agent VMs) give delegated work real machine isolation (`apps/daemon/src/boxes/**`). T3 offers git worktrees only.
