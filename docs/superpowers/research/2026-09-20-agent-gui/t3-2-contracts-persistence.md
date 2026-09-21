# T3 Code — Data model, wire contracts, event sourcing, persistence

Scope: `packages/contracts/**`, `apps/server/src/orchestration/**`, `apps/server/src/persistence/**`,
`apps/server/src/checkpointing/**`, `apps/server/src/{server,http,ws}.ts`, and the data/sync half of
`packages/client-runtime/**`. Provider adapters, React UI, terminals/MCP are other agents' slices.

Repo root for all paths below:
`/var/lib/orquester/tmp/claude-999/-var-lib-orquester-workspaces-jaspersito-orquester/1ea82399-6588-4318-8820-ff116327f08f/scratchpad/t3code`

Everything is Effect + `effect/Schema` (not zod). Contracts are *codecs*, not just types: they encode
wire compat rules (decoding defaults, legacy field promotion, forward-compatible unions) directly in
the schema, and the same schemas are used for the WebSocket RPC, the HTTP API, the SQLite row
encodings, and the persisted event payloads.

---

## 1. The domain model

### 1.1 Shape of the hierarchy

```
Environment (one server process + its machine/creds/state — NOT a persisted entity)
└── Project            aggregate "project"   — a directory + defaults + scripts
    └── Thread         aggregate "thread"    — durable conversation & work history
        ├── Message    (user | assistant | system | reasoning)
        ├── Activity   (open-kinded non-message timeline item: tool call, approval, task, error…)
        ├── Turn       (latestTurn on the read model; full rows in projection_turns)
        ├── ProposedPlan
        ├── Checkpoint (one per completed turn, a hidden git ref)
        ├── Session    (0..1 live provider runtime attached to the thread)
        └── PullRequestLink[]
```

Only two aggregates exist in the event log: `project` and `thread`
(`packages/contracts/src/orchestration.ts:1691`). Everything below a thread is a *projection* of
thread events, not an aggregate. **Environment is not modeled at all server-side** — it exists only
client-side, as "which server am I talking to" (`EnvironmentId` is minted by the client registry).

### 1.2 Branded ids

`packages/contracts/src/baseSchemas.ts:104-170`. All are branded trimmed non-empty strings:
`ThreadId`, `ProjectId`, `EnvironmentId`, `CommandId`, `EventId`, `MessageId`, `TurnId`,
`ApprovalRequestId`, `CheckpointRef`, `ProviderItemId`, `RuntimeSessionId`, `RuntimeItemId`,
`RuntimeRequestId`, `RuntimeTaskId`, `AuthSessionId`. `IsoDateTime` is a bare `Schema.String`
(`baseSchemas.ts:35`) — timestamps are ISO strings everywhere, compared lexicographically.

Notable forward-compat helpers used across the contracts:
`ForwardCompatibleOptional` / `ForwardCompatibleNullable` / `ForwardCompatibleArray`
(`baseSchemas.ts:51-99`) — a union member this build doesn't know decodes as absent/null/dropped
instead of failing the enclosing struct. This is the mechanism that lets an old client stay
connected to a newer server.

### 1.3 Entity schemas

**Project** — `orchestration.ts:521-541`

| field | type | notes |
|---|---|---|
| `id` | `ProjectId` | |
| `title` | `TrimmedNonEmptyString` | |
| `workspaceRoot` | `TrimmedNonEmptyString` | absolute dir on the environment |
| `repositoryIdentity` | `RepositoryIdentity \| null` (optional) | |
| `defaultModelSelection` | `ModelSelection \| null` | **provider-specific** |
| `defaultThreadEnvMode` | `ThreadEnvMode \| null` (optional) | worktree-vs-main default |
| `autoPull` | `boolean` (optional) | |
| `faviconPath`, `projectIcon` | optional | `ProjectIconOverride` is lucide/emoji/monogram with an encode-side downgrade for old peers (`:492-518`) |
| `scripts` | `ProjectScript[]` | `{id,name,command,icon,runOnWorktreeCreate,async?,previewUrl?,autoOpenPreview?}` (`:402-425`) |
| `createdAt`/`updatedAt`/`deletedAt` | `IsoDateTime` / nullable | soft delete |

**Thread** — `orchestration.ts:773-833`. The "detail" projection: carries its whole body.

Identity/config: `id`, `projectId`, `title`, `modelSelection` (**provider-specific**),
`runtimeMode` (`approval-required | auto-accept-edits | auto | full-access`, `:128-135`),
`interactionMode` (`default | plan`, `:136-138`), `branch`, `worktreePath`.

Lifecycle: `createdAt`, `updatedAt`, `deletedAt`, `archivedAt`, `settledOverride`
(`"settled"|"active"|null`), `settledAt`, `unsettledAt`, `snoozedUntil`, `snoozedAt`, `pinnedAt`,
`pinOrderKey`, `activeOrderKey`. Pin/active order keys are **fractional indexes compared as
strings**, so one drag writes exactly one key and no neighbour is touched — deliberately chosen so
threads on different servers never have to agree on a merged list (`:813-820`, `:1190-1206`).

Title: `titleState {source: manual|generated, version: CommandId, needsRefinement}`
(`:673-678`) and `titleRegeneration {requestId, startedAt}` (`:680-684`).

PRs: `linkedPullRequest` (legacy single-link, derived), `pullRequests: ThreadPullRequestLink[]`
(`:763-771`), `branchPullRequest`.

Body: `messages[]`, `proposedPlans[]`, `activities[]`, `checkpoints[]`, `latestTurn`, `session`.

**ThreadShell** — `orchestration.ts:860-919`. Same head fields **minus the body**, plus derived
summary columns the sidebar needs: `latestUserMessageAt`, `hasPendingApprovals`,
`hasPendingUserInput`, `hasActionableProposedPlan`, `backgroundLiveness`
(`"working"|"monitoring"|null`), `planProgress {step, completedSteps, totalSteps}`.
This shell/detail split is *the* central performance decision: the sidebar subscription never pays
for any thread's history.

**Message** — `orchestration.ts:554-565`

```
{ id: MessageId, role: "user"|"assistant"|"system"|"reasoning",
  text: string, attachments?: ChatAttachment[], context?: OrchestrationMessageContext,
  turnId: TurnId|null, streaming: boolean, createdAt, updatedAt }
```

There are no "parts". A reasoning trace is a *sibling message* with `role: "reasoning"`, not a part
of the assistant message (`:543-552`). Streaming is modeled as repeated deltas appended onto one
message id, with `streaming: true` until a `*.complete` command lands.

`ChatAttachment` = `image | file | unknown` (`:302-372`). The `ChatUnknownAttachment` member
(`:341-351`) is an explicit catch-all whose `type` pattern *excludes* the known discriminators, so a
future attachment type survives an old decoder while a malformed image still fails its own schema.
Attachments carry metadata only — `{id, name, mimeType, sizeBytes}` — **never bytes**; bytes live in
the server attachment store (§4.4). Limits: 8 attachments/turn, 10 MB image, 50 MB file, 120 000
input chars (`:165-168`).

`OrchestrationMessageContext` (`packages/contracts/src/composerContext.ts`) is the composer-chip
model: `records[]` keyed by `contextId`, kinds `image|file|terminal|element|preview-annotation|
review-comment|mention|skill` plus an open string kind (`:19-34`, `:61-64`). Position lives in the
message text as `[label](t3-context://v1/<kind>/<contextId>)`. Image/file records **bind by
`attachmentId`**, never hold bytes (`:95-114`).

**Activity** — `orchestration.ts:641-651`

```
{ id: EventId, tone: "info"|"tool"|"approval"|"error",
  kind: TrimmedNonEmptyString,   // OPEN — deliberately not a literal union
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,        // OPEN
  turnId: TurnId|null, sequence?: NonNegativeInt, createdAt }
```

`kind` and `payload` are intentionally untyped on the wire so a newer server can emit new activity
kinds without breaking any client decoder. The kinds actually emitted (grepped across
`apps/server/src/orchestration/**`):

`approval.requested`, `approval.resolved`, `user-input.requested`, `user-input.resolved`,
`user-input.answer-submitted`, `tool.started`, `tool.updated`, `tool.completed`, `tool.progress`,
`tool.denied`, `task.started`, `task.progress`, `task.updated`, `task.completed`,
`turn.plan.updated`, `context-compaction`, `context-window.updated`, `runtime.error`,
`runtime.warning`, `runtime.note`, `checkpoint.captured`, `checkpoint.capture.failed`,
`checkpoint.revert.failed`, `setup-script.requested|started|failed`,
`provider.turn.start.failed`, `provider.turn.interrupt.failed`, `provider.session.stop.failed`,
`provider.approval.respond.failed`, `provider.user-input.respond.failed`,
`provider.auth.signed-out`.

**Turn**. There is no `Turn` contract type — only `OrchestrationLatestTurn` on the read model
(`:661-670`): `{turnId, state: running|interrupted|completed|error, requestedAt, startedAt,
completedAt, assistantMessageId, sourceProposedPlan?}`. Full turn rows live only in SQLite
(`projection_turns`, §4.1). **`TurnId` is the provider's own turn id**, not server-minted:
`ProviderRuntimeIngestion.ts:147-148` does `TurnId.make(String(event.turnId))` straight off the
normalized provider event. Between "turn start requested" and the provider's first `turn.started`,
the turn exists as a row with `turn_id IS NULL` and `state='pending'`
(`apps/server/src/persistence/Layers/ProjectionTurns.ts:99-131`).

**Checkpoint** — `orchestration.ts:611-631`

```
{ turnId, checkpointTurnCount: NonNegativeInt, checkpointRef: CheckpointRef,
  status: "ready"|"missing"|"error",
  files: {path, kind, additions, deletions}[],
  assistantMessageId: MessageId|null, completedAt }
```
`checkpointTurnCount` is a monotonic per-thread counter (1, 2, 3…) and is what the revert command
addresses; `checkpointRef` is the git ref.

**Session** — `orchestration.ts:588-609`

```
{ threadId, status: idle|starting|running|ready|interrupted|stopped|error,
  providerName: string|null,              // provider-specific
  providerInstanceId?: ProviderInstanceId, // provider-specific
  runtimeMode, activeTurnId: TurnId|null, lastError: string|null, updatedAt }
```

**ProposedPlan** — `:570-581`: `{id, turnId|null, planMarkdown, implementedAt|null,
implementationThreadId|null, createdAt, updatedAt}`.

**PullRequestLink** — `:756-771`: host-level key `{host, repository, number}` + `url`, `source`
(`manual|created|agent|stack|stack-dismissed` — the last is a tombstone), `linkedAt`,
`snapshot` (server-refreshed host state, `:716-734`), `stack` (`:744-752`).

### 1.4 Provider-agnostic vs provider-specific

**Provider-agnostic** (the whole orchestration contract): project/thread/message/activity/turn/
checkpoint/approval/question shapes, `RuntimeMode`, `ProviderInteractionMode`,
`ProviderApprovalDecision` (`accept|acceptForSession|acceptAlways|decline|cancel`, `:147-154`),
`ProviderRequestKind` (`command|file-read|file-change|mcp-elicitation|permission`, `:139-146`).

**Provider-specific, but confined to opaque leaves:**

- `ModelSelection = {instanceId: ProviderInstanceId, model: string, options?: ProviderOptionSelections}`
  (`:75-126`). The routing key is a *configured instance slug*, not a driver name; everything else
  (driver, credentials, cwd binding) is recovered from the runtime registry. It carries a
  pre-decoding transform that promotes the legacy `{provider, model}` shape — the *only* compat
  surface, with no post-decode branching anywhere in the runtime.
- `OrchestrationSession.providerName` / `providerInstanceId`.
- `Activity.payload` (`Schema.Unknown`).
- `OrchestrationEventMetadata.{providerTurnId, providerItemId, adapterKey}` (`:1971-1986`).
- The **provider thread/session id is not in the orchestration contract at all**. It lives in
  `provider_session_runtime.resume_cursor_json` as an opaque blob (§4.5).
- `ProviderApprovalPolicy`/`ProviderSandboxMode` (`:46-58`) exist but are Codex-flavoured leftovers.

---

## 2. The wire protocol

### 2.1 Transport

One authenticated WebSocket per environment at `GET /ws`, carrying **Effect RPC** with JSON
serialization: `apps/server/src/ws.ts:3730-3812`, specifically
`RpcServer.makeProtocolWithHttpEffectWebsocket` (`:3754`), `RpcServer.make(WsRpcGroup)` (`:3755`),
`RpcSerialization.layerJson` (`:3769`). Auth happens once at socket upgrade (`:3739-3750`); scope
checks are per-method (e.g. `requireEnvironmentScope(AuthOrchestrationOperateScope)` in
`orchestration/http.ts:100`) — "authenticating a socket does not authorize every method on it".

The RPC group is `packages/contracts/src/rpc.ts:1384-1528` (~140 methods). Each method is
`Rpc.make(name, {payload, success, error, stream?})`. `stream: true` makes the method a *server
stream* — that is the subscription primitive; there is no separate pub/sub channel.

A **second transport** exists for bulk reads: the Effect HttpApi at
`packages/contracts/src/environmentHttp.ts:508-540`
(`GET /api/orchestration/snapshot`, `GET /api/orchestration/shell`,
`GET /api/orchestration/threads/:threadId`, `POST /api/orchestration/dispatch`), served by
`apps/server/src/orchestration/http.ts`. Large, compressible payloads (thread snapshot, PR diffs)
go over HTTP so they can be gzipped and so they don't occupy the RPC socket; the socket is then
resumed with `afterSequence` (§3.5). `environmentHttp.ts:541-542` says this explicitly for PRs.

### 2.2 Agent-thread method families

`ORCHESTRATION_WS_METHODS` — `packages/contracts/src/orchestration.ts:35-44`:

| method | shape | schemas |
|---|---|---|
| `orchestration.dispatchCommand` | unary | in `ClientOrchestrationCommand`, out `{sequence}` (`:2218-2221`) |
| `orchestration.subscribeShell` | **stream** | in `{afterSequence?, requestCompletionMarker?}` (`:965-981`), out `OrchestrationShellStreamItem` |
| `orchestration.subscribeThread` | **stream** | in `{threadId, reasoningMessages?, afterSequence?, requestCompletionMarker?, turnLimit?}` (`:983-1009`), out `OrchestrationThreadStreamItem` |
| `orchestration.getArchivedShellSnapshot` | unary | out `OrchestrationShellSnapshot` |
| `orchestration.getTurnDiff` | unary | `{threadId, fromTurnCount, toTurnCount, ignoreWhitespace?}` → `{threadId, from, to, diff}` (`:2223-2233`) |
| `orchestration.getFullThreadDiff` | unary | `{threadId, toTurnCount, ignoreWhitespace?}` |
| `orchestration.searchThreads` | unary | `{query (2..200 chars), limit ≤ 50}` → matches with 240-char snippets (`:2250-2268`) |
| `orchestration.getWorkflowScript` | unary | read a workflow script by absolute path, re-validated server-side |

Bound explicitly in `rpc.ts:1265-1316`.

**There is no "sendMessage" method, no "interrupt" method, no "approve" method.** Every mutation is
one command through `dispatchCommand`. `ClientOrchestrationCommand`
(`orchestration.ts:1427-1457`) is a 28-member tagged union:

- projects: `project.create`, `project.meta.update`, `project.delete`
- thread lifecycle: `thread.create`, `thread.delete`, `thread.archive`, `thread.unarchive`,
  `thread.settle`, `thread.unsettle`, `thread.snooze`, `thread.unsnooze`, `thread.pin`,
  `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder`, `thread.meta.update`
- PRs: `thread.pull-request.link`, `thread.pull-request.unlink`
- config: `thread.runtime-mode.set`, `thread.interaction-mode.set`
- **agent work**: `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
  `thread.user-input.respond`, `thread.user-input.dismiss`, `thread.checkpoint.revert`,
  `thread.conversation.revert`, `thread.session.stop`

Key command shapes:

- `thread.turn.start` (`:1286-1326`) — `{commandId, threadId, message: {messageId, role:"user",
  text, attachments[], context?}, modelSelection?, titleSeed?, runtimeMode, interactionMode,
  bootstrap?, sourceProposedPlan?, createdAt}`. The *client* variant additionally accepts
  `UploadChatImageAttachment` with an inline `dataUrl` (`:1308-1326`); the server normalizer strips
  it to a stored attachment before the command reaches the decider (§4.4).
  `bootstrap` (`:1278-1284`) lets one command create the thread, prepare a worktree and run a setup
  script — so "new thread from the composer" is a *single* idempotent dispatch, not a 3-call dance.
- `thread.turn.interrupt` (`:1328-1334`) — `{threadId, turnId?}`.
- `thread.approval.respond` (`:1336-1343`) — `{requestId, decision}`.
- `thread.user-input.respond` (`:1345-1353`) — `{requestId, answers: Record<string,unknown>,
  attachmentsByQuestionId?}`; `thread.user-input.dismiss` closes an async question without
  answering (native callback questions can't be dismissed — the provider is blocked).
- `thread.checkpoint.revert` vs `thread.conversation.revert` (`:1366-1379`) — a *separate command
  type* for history-only rewind, deliberately, "so older servers reject history-only rewinds rather
  than ignoring an unfamiliar option and restoring files."
- `thread.session.stop` carries `onlyIfSettled?` so the decider can drop a stale settle-cleanup stop
  (`:1381-1392`).

**Models are not listed through an orchestration method.** The model catalog rides the
`server.subscribeServerConfig` stream (`rpc.ts:1332-1354`), which negotiates capability flags
(`environmentThemes`, `usageLimitSources`, `usageLimitsCommand`) because already-shipped clients
would die on an unknown stream-event member.

### 2.3 Envelopes

Thread stream item (`orchestration.ts:2164-2177`):
```ts
| { kind: "snapshot",  snapshot: OrchestrationThreadDetailSnapshot }
| { kind: "event",     event: OrchestrationEvent }
| { kind: "synchronized" }
```
Shell stream item (`:953-963`):
```ts
| { kind: "snapshot", snapshot: OrchestrationShellSnapshot }
| { kind: "project-upserted"|"project-removed"|"thread-upserted"|"thread-removed", sequence, … }
| { kind: "synchronized" }
```
Note the asymmetry: **the thread stream ships raw domain events; the shell stream ships
re-projected entities.** The shell never replays deltas — each event is turned back into a fresh
`OrchestrationThreadShell` row read from the projection (`ws.ts:940-967`).

`OrchestrationEvent` (`:2000-2162`) is a union of `{...EventBaseFields, type, payload}`, base being
(`:1988-1998`):
```ts
{ sequence: NonNegativeInt, eventId: EventId,
  aggregateKind: "project"|"thread", aggregateId: ProjectId|ThreadId,
  occurredAt: IsoDateTime, commandId: CommandId|null,
  causationEventId: EventId|null, correlationId: CommandId|null,
  metadata: OrchestrationEventMetadata }
```
`correlationId` *is* the command id by construction (`:186`). Metadata (`:1971-1986`) carries
`providerTurnId`, `providerItemId`, `adapterKey`, `requestId`, `ingestedAt`, `historyImport`,
`deferredTurn`, and `origin: {surface, appVersion}` — the dispatching client's identity, stamped by
the engine, never by the decider (`OrchestrationEngine.ts:264-272`).

### 2.4 How streaming deltas are batched (the "too much data over websockets" answer)

Four independent mechanisms, all server-side:

**(a) Delta coalescing at ingestion** — `ProviderRuntimeIngestion.ts:117,122,1336-1367`.
Assistant/reasoning text is buffered per message id and flushed at most every
`MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400`, with a `MAX_BUFFERED_ASSISTANT_CHARS = 24_000` safety
valve. So a token-by-token provider stream becomes ≤2.5 persisted events/sec per message. This is
upstream of the event log: it reduces *writes*, not just wire bytes.

**(b) Per-subscription live coalescing window** — `ThreadLiveEventCoalescer.ts`.
A 50 ms window (`:18`) over which `tool.updated` activities are collapsed: only the latest update
per stable `toolCallId` per turn survives (`coalesceLiveToolUpdatedEvents`, `:56-94`). Anonymous
calls pass through (labels aren't unique under parallel tool use). Any non-update event closes the
run immediately so ordering is preserved (`:189-193`). Max 512 pending (`:19`).
The shell stream has its own equivalent: `Stream.groupedWithin(512, 50ms)` then "keep the last event
per aggregate, refetch its shell row at concurrency 8" (`ws.ts:981-1016`) — a burst of streaming
deltas on one thread collapses into one shell refetch, and an unrelated `thread.created` in the same
batch is never queued behind those DB reads.

**(c) Payload slimming before the wire** — `ActivityPayloadProjection.ts`.
`projectActivityEvent` / `projectThreadDetailSnapshot` (`:646-689`) rewrite every activity payload
before it leaves the server; the full payload stays in SQLite. Specifics: tool text output is
summarized to a single ≤84-char line or `"N lines"` (`summarizeToolTextOutput`, `:164-188`); MCP
tool-call items are reduced to eight rendered fields (`MCP_ITEM_KEPT_FIELDS`, `:196-207`) with the
result summarized; `dropSupersededToolUpdatedActivities` (`:608-648`) drops `tool.updated` rows that
a later `tool.completed` in the same turn already supersedes — the comment records measured impact:
"47k such rows exist in one real database, and a single thread carries 2,291 of them totalling ~1MB
post-slimming", and the supersession was verified across 49,515 rows to lose no client-rendered
field.

**(d) A hard per-subscription budget with backpressure-aware accounting** —
`LiveStreamBudget.ts`. 1 000 items / 8 MiB serialized per subscription (`:9-10`). Sizes are measured
once per event object via a `WeakMap` (`:19-29`) since events are shared across subscriptions.
Crucially, `deliver` (`:131-184`) only releases an item's charge **after the client ACKs the batch**
("RpcServer requests the next batch only after the client ACKs this one. Removing items from a queue
alone does not mean delivery ended."). On overflow the subscription fails with
*"The live event buffer is full. Resume from the last received sequence."* — i.e. a slow client is
cut and told to resume by cursor rather than being allowed to balloon server memory.

Two more wire-size levers: the **shell/detail split** (§1.3), and **turn-window pagination** —
`turnLimit` on the subscription/HTTP snapshot (`:1000-1007`, `:1020-1024`).

---

## 3. Event sourcing

### 3.1 The log

One table, `orchestration_events`, append-only, global `sequence INTEGER PRIMARY KEY AUTOINCREMENT`
plus a per-stream `stream_version` (`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-43`):

```sql
orchestration_events(
  sequence INTEGER PK AUTOINCREMENT, event_id TEXT UNIQUE,
  aggregate_kind TEXT, stream_id TEXT, stream_version INTEGER,
  event_type TEXT, occurred_at TEXT,
  command_id TEXT, causation_event_id TEXT, correlation_id TEXT,
  actor_kind TEXT, payload_json TEXT, metadata_json TEXT)
UNIQUE(aggregate_kind, stream_id, stream_version)
```
`stream_version` is computed inside the INSERT with a `COALESCE((SELECT max+1 …), 0)` subquery
(`Layers/OrchestrationEventStore.ts:147-157`) — optimistic concurrency by unique-index violation,
not by read-then-write. `actor_kind` (`client|server|provider`) is *inferred*, not supplied:
`inferActorKind` (`:92-112`) keys off `commandId` prefixes (`provider:`, `server:`) and the presence
of provider metadata.

32 event types (`orchestration.ts:1655-1688`), all `thread.*` / `project.*` past-tense facts.

### 3.2 The decider (pure)

`apps/server/src/orchestration/decider.ts` — `decideOrchestrationCommand({command, readModel,
userInputActivity?})` returns one event or an array, or fails with a typed rejection. No I/O, no
filesystem, no provider. Example: `thread.turn.start` (`:1368-1470`) emits `thread.message-sent`
(skipped if a worktree bootstrap already appended the message) + `thread.turn-start-requested` +
lifecycle-reset events (`thread.unsettled` / `thread.unsnoozed`) when the thread had an override.
`thread.revert.complete` → `thread.reverted` (`:2122-2141`).

### 3.3 The engine: one serialized command queue, one transaction

`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`:

1. Commands are `Queue.offer`ed with a `Deferred` result (`:438-448`); a single `Effect.forever`
   worker fiber takes them one at a time (`:416-417`). **All command handling is serial.**
2. Receipt check first (`:144-172`): if a receipt for `commandId` exists and is `accepted`, return
   its `resultSequence` — **retries are idempotent and free**. If the receipt's aggregate doesn't
   match the command's, it's a hard `OrchestrationCommandIdConflictError` ("a receipt only proves
   this exact command was handled").
3. Optimistic-concurrency guards for specific internal commands via `eventStore.hasEventAfter`
   (`:174-213`): `thread.auto-settle` is rejected if the thread changed after its snapshot sequence;
   `thread.pull-request.sync` is rejected if the thread was *recreated*.
4. Decide against the in-memory `commandReadModel` (`:245-262`).
5. **One SQL transaction** (`:273-320`) appends every event, folds it into the in-memory read model,
   runs *all* projectors (`projectionPipeline.projectEventDeferred`), and upserts the command
   receipt. Events, projections and the receipt commit atomically.
6. Only after commit: run deferred attachment side effects, then `PubSub.publish` each event
   (`:322-340`). Subscribers can never observe an event before its projection.
7. On failure: reconcile the in-memory read model by re-reading persisted events from the dispatch
   start sequence (`:119-132`) and persist a `rejected` receipt (`:392-404`).

`latestSequence` is a plain read of `commandReadModel.snapshotSequence`, safe because reassignment
is atomic on the single-threaded event loop (`:462-466`).

### 3.4 Projections / read models

Two layers of read model:

**(a) In-memory `OrchestrationReadModel`** (`orchestration.ts:835-841`) — `{snapshotSequence,
projects[], threads[], updatedAt}`, folded by `apps/server/src/orchestration/projector.ts`
(`projectEvent`). This is the decider's input only. It's capped: `MAX_THREAD_MESSAGES = 2_000`,
`MAX_THREAD_CHECKPOINTS = 500` (`projector.ts:59-60`).

**(b) Persisted SQLite projections** — nine projectors, each with its own name and cursor
(`Layers/ProjectionPipeline.ts:67-77`): `projection.projects`, `.threads`, `.thread-messages`,
`.thread-proposed-plans`, `.thread-activities`, `.thread-sessions`, `.thread-turns`, `.checkpoints`,
`.pending-approvals`. At runtime all nine apply inside the engine's transaction and their cursors are
upserted together (`:2076-2097`); at bootstrap each replays independently from its own cursor
(`:2059-2074`), so a single reset projector can be rebuilt without replaying the others.

Cursors live in `projection_state(projector, last_applied_sequence, updated_at)`
(`Migrations/005_Projections.ts:106-112`). A snapshot's `snapshotSequence` is the **minimum** cursor
across the required projectors (`ProjectionSnapshotQuery.ts:276-284`, `computeSnapshotSequence` at
`:318`) — so a snapshot never claims to be newer than its least-advanced constituent table.

A tenth pseudo-projector, `projection.attachment-cleanup`, has its own cursor so file deletions are
retried without replaying committed text (`ProjectionPipeline.ts:2119-2169`).

### 3.5 Client catch-up after reconnect

Both subscriptions are **snapshot-or-replay, chosen by the server from the client's cursor**.

`subscribeThread` (`ws.ts:2142-2305`):
1. Attach the live PubSub tail into a scope-bound coalescing buffer **before** any read — otherwise
   events published while the snapshot query runs are lost (`:2159-2169`).
2. If `afterSequence` given: capture `headSequence`, then measure the replay with
   `getThreadReplayStats` scoped to *this thread's rows* (global sequence gaps contain unrelated
   threads). Replay only if `eventCount ≤ 1 000` **and** `payloadBytes ≤ 8 MiB`
   (`:2189-2243`; constants at `ws.ts:373,377`).
3. If the range contains a `thread.created`, the thread was recreated → fall back to a snapshot
   (`:2244-2251`).
4. Otherwise send a snapshot frame, optionally windowed to `turnLimit` recent user-anchored turns.
5. `requestCompletionMarker` inserts a `{kind:"synchronized"}` marker into the *same queue* as live
   events, so anything buffered during the snapshot is delivered before the client is told it's
   synchronized (`:2235-2242`, `:2285-2292`).

`subscribeShell` (`ws.ts:1969-2124`) is the same pattern with `SHELL_RESUME_MAX_GAP = 1_000`
(`ws.ts:369`) and the note that "replaying every intervening event (each a shell refetch) is far
more expensive than a single O(active-threads) snapshot".

Client side (`packages/client-runtime/src/state/threads.ts`): the cursor is seeded from the cached
snapshot's `snapshotSequence` (`:218-222`), so a warm cache resumes by replay instead of
re-downloading. Events with `sequence <= lastSequence` are dropped (`:460-464`), which is what makes
the overlapping snapshot/replay/live windows safe. A `snapshot` item bumps a `historyEpoch` and
discards any in-flight older-page fetch (`:446-458`).

**Pagination.** `OrchestrationThreadDetailPage` (`orchestration.ts:1033-1048`) carries
`{beforeCursor, hasMore, snapshotSequence, threadSequence?}`. `threadSequence` is a *thread-scoped*
watermark, because the global `snapshotSequence` advances with every thread's events and a client
could never wait for it on a per-thread subscription — merging an older page before applying live
events up to that watermark would let a streaming delta be replayed onto page content that already
contains it. The cursor itself (`threadDetailCursor.ts:20-62`) is base64url
`{threadId, beforeAnchorAt, beforeTurnId}` — deliberately *not* a `row_id`, because revert
(delete + re-upsert) and projection rebuilds rewrite row ids and would silently invalidate every
persisted cursor with no event emitted. Client window sizes: 10 user turns initially, 20 per
"load earlier" (`client-runtime/src/state/threads.ts:49-50`).

### 3.6 Receipts — two different things

**Command receipts (durable, production).** `orchestration_command_receipts(command_id PK,
aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)`
(`Migrations/002_OrchestrationCommandReceipts.ts:8-18`). Written in the same transaction as the
events (`OrchestrationEngine.ts:296-304`). They make dispatch idempotent: the client mints
`commandId` (a UUID, `client-runtime/src/operations/commands.ts:68-76`) and a retry after a dropped
socket replays the receipt's `sequence` instead of double-sending a turn.

**Runtime receipts (test-only).** `orchestration/Services/RuntimeReceiptBus.ts:23-57` defines three:
`checkpoint.baseline.captured`, `checkpoint.diff.finalized`, `turn.processing.quiesced`. The
production layer is a **no-op** (`Layers/RuntimeReceiptBus.ts:22-25,38`); only
`RuntimeReceiptBusTest` retains them in a PubSub. AGENTS.md's "wait on receipts and worker drains,
never on sleeps" refers to these — they exist purely so integration tests can await an exact async
milestone without polling. Production must use persisted state and events.

### 3.7 Worker drain

`packages/shared/src/DrainableWorker.ts` — an unbounded `TxQueue` plus a transactional `outstanding`
counter. `drain` is `TxRef.get(outstanding)` + `txRetry` while `n > 0` (`:58-61`), so it resolves
only when the queue is empty **and** the in-flight item finished ("an empty queue alone does not
prove the worker is idle"). Every reactor exposes `drain`: `ProviderCommandReactor.ts:1866,1935-1938`,
`ThreadSettlementReactor.ts:36-38`, `StorageCleanup` (`storageCleanup.ts:42-43`).

### 3.8 Reactors (side effects, post-commit)

Started together by `OrchestrationReactor` (`Layers/OrchestrationReactor.ts:29-39`):
`ProviderRuntimeIngestion`, `ProviderCommandReactor`, `CheckpointReactor`, `ThreadDeletionReactor`,
`ThreadPullRequestReactor`, `ThreadSettlementReactor`, `PullRequestSyncReactor`,
`AgentAwarenessRelay`, `StorageCleanup`.

`ProviderCommandReactor` is the intent→provider bridge: it subscribes to domain events, filters to
nine intent types and enqueues them on a drainable worker (`:1880-1896`, `:1768-1843`).
`thread.turn-start-requested` → start/resume a provider session and send the turn, under a
workspace lease when a worktree is involved. `thread.settled` → dispatch a conditional
`thread.session.stop`. Failures become `provider.*.failed` activities, not exceptions.

`ProviderRuntimeIngestion` is the opposite direction (§7).

---

## 4. Persistence

### 4.1 SQLite schema

One file, `state.sqlite`, under `<T3 home>/userdata`. Opened by
`apps/server/src/persistence/Layers/Sqlite.ts:11-20` with `busy_timeout=5000`, `foreign_keys=ON`,
`journal_mode=WAL` (CLI and server write from separate processes). Migrations run at startup, before
the app starts.

Tables (post-migration-53):

| table | key columns |
|---|---|
| `orchestration_events` | §3.1 — the log |
| `orchestration_command_receipts` | `command_id` PK, `result_sequence`, `status`, `error` |
| `projection_projects` | `project_id` PK; title, workspace_root, `default_model_selection_json`, `scripts_json`, `auto_pull`, `default_thread_env_mode`, `favicon_path`, `project_icon_json`, timestamps, `deleted_at` |
| `projection_threads` | `thread_id` PK; project_id, title, `model_selection_json`, branch, worktree_path, latest_turn_id, runtime_mode, interaction_mode, archived_at, settled_override/settled_at/unsettled_at, snoozed_until/snoozed_at, pinned_at/pin_order_key/active_order_key, title_regeneration_*, `title_state_json`, `linked_pull_request_json`, `branch_pull_request_json`, **shell summary columns**: latest_user_message_at, pending_approval_count, pending_user_input_count, has_actionable_proposed_plan |
| `projection_thread_messages` | `message_id` PK; thread_id, turn_id, role, text, is_streaming, `attachments_json`, `context_json`, timestamps |
| `projection_thread_activities` | `activity_id` PK; thread_id, turn_id, tone, kind, summary, `payload_json`, `sequence`, created_at |
| `projection_thread_sessions` | `thread_id` PK; status, provider_name, provider_session_id, provider_thread_id, provider_instance_id, runtime_mode, active_turn_id, last_error, updated_at |
| `projection_turns` | `row_id` autoinc; thread_id, turn_id (nullable), pending_message_id, assistant_message_id, state, requested_at/started_at/completed_at, checkpoint_turn_count/ref/status/`checkpoint_files_json`, source_proposed_plan_*; `UNIQUE(thread_id,turn_id)`, `UNIQUE(thread_id,checkpoint_turn_count)` |
| `projection_thread_proposed_plans` | + implemented_at, implementation_thread_id |
| `projection_thread_pull_requests` | link rows (mig. 050) |
| `projection_pending_approvals` | `request_id` PK; thread_id, turn_id, status, decision, created_at, resolved_at |
| `projection_state` | `projector` PK, `last_applied_sequence`, `updated_at` |
| `provider_session_runtime` | `thread_id` PK; provider_name, provider_instance_id, adapter_key, runtime_mode, status, last_seen_at, **`resume_cursor_json`**, `runtime_payload_json` |
| `checkpoint_diff_blobs` | `(thread_id, from_turn_count, to_turn_count)` UNIQUE, `diff TEXT` — a diff cache |
| `auth_pairing_links`, `auth_sessions` | device pairing / sessions |
| `pull_request_files_viewed` | mig. 053 |

Sources: `Migrations/001..005_*.ts` for the base, plus the `ALTER TABLE … ADD COLUMN` set across
006–053.

### 4.2 Migrations

`apps/server/src/persistence/Migrations.ts` — 53 numbered migrations, **statically imported** into a
`[id, name, effect]` tuple array (`:79-133`) and fed to `Migrator.fromRecord`; no dynamic filesystem
loading (works inside a bundled/packaged binary). Forward-only; no down migrations. Several are pure
data repairs, e.g. `016_CanonicalizeModelSelections`, `025_CleanupInvalidProjectionPendingApprovals`,
`044_ClearAutomaticProjectModelDefaults`, `046_RepairAutomaticSettlementTimestamps`. The migration
manifest is exported (`:135`) and can be truncated with `toMigrationInclusive` — used by tests to
construct old-schema databases.

**Persisted events must stay decodable forever** (overview.md: "Changing a schema affects old
environments at startup as well as live RPC traffic"). This is why so many payload fields are
`Schema.optional` with decoding defaults (e.g. `runtimeMode` on `ThreadCreatedPayload`,
`orchestration.ts:1733`) and why `ThreadMetaUpdatedPayload.linkedPullRequest` is explicitly retained
as "no longer produced; kept so persisted events from before `thread.pull-request-linked` still
decode and replay into the link table" (`:1825-1827`).

### 4.3 Stored vs. re-derived

**Stored (server-authoritative):** every domain event; every projection; the full un-slimmed activity
payload (clients get the slimmed version, §2.4d).

**Re-derived, never stored as truth:** diffs (`checkpoint_diff_blobs` is a cache keyed by turn range,
recomputable from git refs); the whole in-memory read model; the shell summary counters
(`023_ProjectionThreadShellSummary` + `024_BackfillProjectionThreadShellSummary` backfilled them,
and they are refreshed from the source tables on any activity that could change them —
`shouldRefreshThreadShellSummary`, `ProjectionPipeline.ts:143-159`).

**Not stored at all:** the provider's conversation transcript. See §4.5.

### 4.4 Attachments

Files on disk under `ServerConfig.attachmentsDir`, never in SQLite and never inline on the wire.
`apps/server/src/attachmentStore.ts` mints ids of the form
`<threadSegment>-<uuid>[-<ext>]` (`:83-89`), with a reserved `pending-` segment for uploads that
precede thread creation (`:24`, 24 h TTL).

Two upload paths, both ending with the same stored shape:
- Pre-upload via `attachments.createUploadUrl` RPC → the server later *claims* the pending file by
  copying it into the thread's namespace at dispatch (`Normalizer.ts:168-231`) — a copy, not a hard
  link, "an agent editing the delivered file in place must not mutate the retry source".
- Inline `dataUrl` on `thread.turn.start`, decoded and written at dispatch (`Normalizer.ts:233-293`).

Either way `normalizeDispatchCommand` (`Normalizer.ts:77-341`) validates size against the stat'd
file, lowercases the mime, rewrites composer `context.records[].attachmentId` to the final ids, and
returns a command carrying *metadata only*. Failures clean up the claimed copies
(`cleanupFailedUploadedAttachments`, `:343-381`).

Deletion is a **deferred, post-commit, cursor-tracked** side effect: the projection pipeline collects
`deletedThreadIds` / `prunedThreadRelativePaths`, then after the transaction re-checks whether the
thread was recreated later in the log and recomputes the retained-path set from current messages and
`user-input.answer-submitted` activities before unlinking anything (`ProjectionPipeline.ts:1976-2036`).

Serving is via short-lived signed relative URLs: `AssetResource` tagged union with an `attachment`
member carrying `{attachmentId, fileName?, mimeType?, disposition?}`
(`packages/contracts/src/assets.ts:14-60`), `assets.createUrl` RPC → `{relativeUrl, expiresAt, …}`
(`:63-82`). Bytes therefore never traverse the RPC socket in either direction.

### 4.5 Thread history hydration on resume — **the server does not replay the transcript**

The server relies entirely on the **provider's own session id**. `provider_session_runtime` stores an
opaque `resume_cursor_json` (`Migrations/004_ProviderSessionRuntime.ts:101-111`;
`persistence/ProviderSessionRuntime.ts:36-53` types it as `Schema.NullOr(Schema.Unknown)`;
`provider/Services/ProviderSessionDirectory.ts:29` as `unknown | null`). Every adapter writes and
parses its own shape, always `{schemaVersion, sessionId}`:
`OpenCodeAdapter.ts:2997,3987`, `CursorAdapter.ts:783`, `GrokAdapter.ts:1280`,
`AntigravityAdapter.ts:861`, `CodexAdapter.ts:2283`. `ProviderCommandReactor.ts:783-806` passes the
active session's cursor when resuming, and *clears* it when the model changed and a restart is
required.

Consequence: T3 Code's event log is the record for **rendering**, and the provider's own session file
is the record for **the model's context**. They are two parallel histories that can diverge; a revert
must coordinate both (§5), and a provider that can't roll back its conversation must reject the
revert before any file is touched (overview.md; `CheckpointReactor.ts:813`
`providerService.assertConversationRollbackSupported`).

The one place a transcript *is* imported is `thread.history.import`
(`orchestration.ts:1505-1517`) — a bulk `{messageId, role, text, createdAt}[]` used by the
agent-session importer that adopts pre-existing Claude/Codex CLI sessions as T3 threads
(`packages/contracts/src/agentSessions.ts`; imported message ids are namespaced `import:` and are
rejected by `thread.turn.start`, `decider.ts:1369-1374`).

---

## 5. Checkpointing

**What it is.** One hidden git ref per completed turn, capturing the workspace tree (tracked +
staged + untracked) without adding a commit to the user's branch.

**Ref naming** — `checkpointing/Utils.ts:4-10`:
`refs/t3/checkpoints/<base64url(threadId)>/turn/<turnCount>`.

**Capture** — `vcs/GitVcsDriver.ts:~960-1033`, via the `CheckpointStore` service
(`checkpointing/CheckpointStore.ts:51-99`, resolved through the VCS driver registry so non-git VCS
can decline with `VcsUnsupportedOperationError`). Mechanics: an **isolated temporary git index**
(`GIT_INDEX_FILE`), `git write-tree`, `git commit-tree -m "t3 checkpoint ref=<ref>"`,
`git update-ref <ref> <oid>`. No branch, no HEAD movement, nothing in reflog the user sees.

**Lifecycle** — `orchestration/Layers/CheckpointReactor.ts`:
- On `thread.turn-start-requested` / `thread.message-sent`, capture a **baseline** at
  `checkpointRefForThreadTurn(threadId, currentTurnCount)` if it doesn't already exist, and publish
  a `checkpoint.baseline.captured` receipt (`:484-508`, `:697-719`).
- On provider `turn.completed` / `turn.aborted`, capture the post-turn ref, diff it against the
  baseline (`--numstat` for the file list), and dispatch `thread.turn.diff.complete`
  (`orchestration.ts:1545-1557`) → `thread.turn-diff-completed` event, which is what populates
  `OrchestrationThread.checkpoints[]`. Then publish `checkpoint.diff.finalized` and
  `turn.processing.quiesced` receipts (`:352-370`).
- "A late checkpoint or diff must not extend the recorded turn duration" (overview.md): the turn is
  settled by the *projector* from session status (`ProjectionPipeline.ts:87-103`), independent of
  checkpoint completion.

**Diffs.** `getTurnDiff(threadId, fromTurnCount, toTurnCount, ignoreWhitespace?)` /
`getFullThreadDiff` (`orchestration.ts:2223-2243`) → `checkpointing/CheckpointDiffQuery.ts`, backed
by `git diff <fromRef> <toRef>` with the `checkpoint_diff_blobs` cache.

**Revert** — `CheckpointReactor.ts:771-915`, triggered by `thread.checkpoint-revert-requested`
(payload carries `restoreFiles?: boolean`, `orchestration.ts:1916-1921`; `thread.conversation.revert`
is the same command with `restoreFiles: false`):

1. Resolve thread + workspace cwd; reject if `turnCount > currentTurnCount`.
2. `providerService.assertConversationRollbackSupported(threadId)` — **before touching the
   filesystem** (`:813`).
3. If restoring files: require an **isolated worktree** (`isRestoreWorkspaceIsolated`, `:826-835`) —
   a shared main checkout may hold another thread's changes, so the user is told to rewind the
   conversation only.
4. `checkpointStore.restoreCheckpoint` → `git restore --source <oid> --worktree --staged -- .`,
   `git clean -fd`, `git reset --quiet -- .` (`GitVcsDriver.ts:1054-1114`). `turnCount === 0` falls
   back to HEAD.
5. `providerService.rollbackConversation({threadId, numTurns: current - target})`.
6. Delete the now-stale checkpoint refs (`:882-894`).
7. Dispatch `thread.revert.complete` → `thread.reverted` event.

The projector then truncates the read model (`projector.ts:986-1035`): keep checkpoints with
`checkpointTurnCount <= turnCount`, retain only messages/plans/activities belonging to the retained
turn ids, recompute `latestTurn` from the last surviving checkpoint. Failures at any step become a
`checkpoint.revert.failed` activity rather than an error — the user sees why in the timeline.

---

## 6. Multi-client / multi-device sync

The model is **server-authoritative, cursor-ordered, no CRDT, no client-side merge**.

- Every mutation is a command; the only reply is `{sequence}`. All clients learn about the change the
  same way, from the same event stream, in the same global order.
- The engine serializes commands on one fiber, so "last writer wins" is well-defined and races
  (e.g. two clients settling the same thread) resolve deterministically.
- Reconnect is cursor-based (§3.5); a client that was offline replays or re-snapshots and converges.
- Events are only published after the commit (`OrchestrationEngine.ts:322-340`), so two clients can
  never observe an event whose projection isn't visible to a snapshot read.
- Per-thread subscription scoping means device B watching thread X pays nothing for thread Y's
  traffic; `subscribeShell` gives every device the same sidebar.
- `OrchestrationClientOrigin` (`orchestration.ts:1965-1969`) is stamped on every client-dispatched
  event, so a client can tell "this came from my phone".
- Client-side per-thread subscription lifetime is decoupled from cache lifetime: one live stream is
  shared by all mounted consumers and stops when the last unmounts; a registry-local cache keeps
  state **and its replay cursor** for 5 idle minutes so back-navigation resumes without another
  snapshot (`connection-runtime.md`; `client-runtime/src/state/threadRetention.ts`,
  `threads.ts:178-230`).
- Cached snapshots are persisted (debounced 500 ms, `threads.ts:309-311`) but **only when the thread
  is not actively running** (`shouldPersistThread`, `:129-132`) — "the server remains the source of
  truth while a turn is active".

**Optimistic updates are deliberately narrow.** The only optimistic layer is
`createOptimisticThreadLifecycle` (`client-runtime/src/state/threadLifecycle.ts:18-99`), applied to
settle/unsettle/snooze/unsnooze/pin/unpin/reorder (`state/threadCommands.ts:258-330`) — i.e. sidebar
placement, where a round-trip is visible and a wrong guess is harmless. The pending update carries
the accepted `sequence` and is retired only when the shell snapshot's `snapshotSequence` reaches it
(`:83-90`); if the command fails, the pending entry is removed in a `finally` (`:94-96`).
**Message sends, approvals, answers and interrupts have no optimistic path** — the user's message
appears when `thread.message-sent` arrives. `connection-runtime.md` is explicit: "Reconnection does
not automatically replay mutations."

---

## 7. Provider-agnostic normalization

Two hops, not one.

**Hop 1 — adapter → `ProviderRuntimeEvent`** (`packages/contracts/src/providerRuntime.ts`).
Each provider adapter translates its native protocol into a **48-member normalized runtime event
union** (`:1177-1231`). Base fields (`:202-216`): `{eventId, provider, providerInstanceId?, threadId,
createdAt, turnId?, itemId?, requestId?, providerRefs?, raw?}`. `raw` (`:36-42`) keeps the original
frame, tagged with its source: `codex.app-server.notification|request`, `codex.eventmsg`,
`claude.sdk.message|permission`, `codex.sdk.thread-event`, `opencode.sdk.event`, `acp.jsonrpc`,
`acp.<vendor>.extension` (`:23-33`) — so debugging never loses the wire truth.

The normalized vocabulary:

| concern | event types | payload highlights |
|---|---|---|
| session | `session.started/configured/state.changed/exited` | `RuntimeSessionState = starting\|ready\|running\|waiting\|stopped\|error` |
| provider thread | `thread.started` (`{providerThreadId?}`), `thread.state.changed`, `thread.metadata.updated`, `thread.token-usage.updated` | `ThreadTokenUsageSnapshot` (`:263-281`) — used/max/input/cached/output/reasoning tokens, `compactsAutomatically`, `autoCompactThreshold` |
| turn | `turn.started`, `turn.completed`, `turn.aborted`, `turn.plan.updated`, `turn.proposed.delta/completed`, `turn.diff.updated` | `TurnTokenUsage` (`:332-346`) is a **union on `usageStatus`**: `complete` requires input+output, `partial\|unavailable` makes them optional — so "we don't know" is not silently 0 |
| items | `item.started/updated/completed` with `ItemLifecyclePayload` (`:432-449`) | `itemType: CanonicalItemType` (`:123-135`) |
| text | `content.delta` (`:451-457`) | `streamKind: assistant_text \| reasoning_text \| reasoning_summary_text \| plan_text \| command_output \| file_change_output \| unknown` |
| approvals | `request.opened` / `request.resolved` (`:459-473`) | `requestType: CanonicalRequestType` (`:137-150`), `options: ProviderApprovalOption[]` |
| questions | `user-input.requested` / `user-input.resolved` (`:482-503`) | `UserInputQuestion {id, header, question, options[], allowCustomAnswer?, multiSelect}` |
| subagents / background | `task.started/progress/updated/completed` (`:623-680`) | `TaskAgentLinkage` (`:580-620`) repeated on **every** row so a client fold can reconstruct an agent even if the start row aged out |
| tools/hooks | `tool.progress`, `tool.summary`, `tool.denied`, `hook.started/progress/completed` | |
| account | `auth.status`, `account.updated`, `account.rate-limits.updated`, `mcp.status.updated`, `mcp.oauth.completed`, `model.rerouted` | rate limits normalized at the adapter to `ProviderUsageLimitsUpdate` |
| diagnostics | `config.warning`, `deprecation.notice`, `runtime.warning`, `runtime.error` | `RuntimeErrorClass = provider_error\|transport_error\|permission_error\|validation_error\|unknown` |

`CanonicalItemType` is the one normalized item taxonomy:
`user_message | assistant_message | reasoning | plan | command_execution | file_change |
mcp_tool_call | dynamic_tool_call | collab_agent_tool_call | web_search | image_view |
review_entered | review_exited | context_compaction | error | unknown` (`:106-135`).
Note `unknown` is a first-class member, and `ToolLifecycleItemType` is a named subset so
"is this a tool call" is one predicate (`:116-121`).

**Hop 2 — runtime event → orchestration commands** (`Layers/ProviderRuntimeIngestion.ts`). The
mapping:

- `content.delta{assistant_text}` → buffered → `thread.message.assistant.delta`
  (`:2054-2070`, buffering at `:1336-1367`)
- `content.delta{reasoning_text|reasoning_summary_text}` → `thread.message.reasoning.delta`
  (`:1938-1953`, `:2006`)
- item completion / turn end → `thread.message.assistant.complete` /
  `thread.message.reasoning.complete` (`:1508-1520`)
- `turn.proposed.delta/completed` → buffered plan text → `thread.proposed-plan.upsert`
  (`:1606`, `:1739`)
- everything else → `runtimeEventToActivities(event)` (`:469-1010`) → `thread.activity.append`.
  Each branch produces `{id: event.eventId, tone, kind, summary, payload, turnId}`; e.g.
  `request.opened` → `approval.requested` with tone `approval` and a human summary chosen from the
  mapped `ProviderRequestKind` (`:480-516`); `item.updated/completed/started` →
  `tool.updated`/`tool.completed`/`tool.started` (`:909-1010`).
- session state → `thread.session.set` with `OrchestrationSession`
  (`orchestrationSessionStatusFromRuntimeState`, `:379-393`; dispatch at `:1917`, `:2417`)

So the answer to "how do heterogeneous providers map onto one item model": **they don't map onto a
closed item union at all.** They map onto (a) four message-ish commands with a 4-value role enum and
(b) an *open* `{tone, kind, summary, payload}` activity row. The typing lives one layer up, in
`ProviderRuntimeEvent`, which is where the adapter authors work; the persisted/wire thread model is
deliberately loose so new provider capabilities don't require a contract change, a migration and a
client release. The cost is that clients must defensively read `activity.payload` (which they do:
`client-runtime/src/pendingRequests.ts:29-46` decodes approval/question payloads with
`Schema.decodeUnknownOption` and tolerates older `requestType`-only rows, `:49-60`).

---

## 8. Essential vs. t3code-specific — and a minimal model for Orquester

### 8.1 What is essential to a GUI agent mode

1. **Server-authoritative append-only log of thread facts + a derived read model.** Not for
   audit — for three concrete wins you cannot get otherwise: multi-client convergence, resume after
   reconnect without re-sending history, and a truthful replay after a crash mid-turn.
2. **Monotonic sequence on every event + `afterSequence` resume.** This single number is what makes
   snapshot/replay/live overlap safe and lets clients dedupe. Cheap to add.
3. **Shell vs. detail split.** A sidebar list type carrying only head fields + derived flags. This is
   the biggest wire/memory win and costs one extra query.
4. **Client-minted `commandId` + a receipt table keyed by it.** Makes "did my turn actually send?"
   after a dropped socket answerable without double-sending. ~20 lines.
5. **Commands ≠ events.** `thread.turn.start` (intent) vs `thread.turn-start-requested` (fact).
   Keeps the pure decision separate from the I/O, and makes the reactor restartable.
6. **A normalized provider event vocabulary before anything touches the domain.** Even with one
   provider today, this is the seam that stops Codex/Claude/ACP shapes leaking into the UI. T3's
   `ProviderRuntimeEvent` union is a good shape to borrow wholesale.
7. **An open-kinded activity row** (`{tone, kind, summary, payload}`) rather than a closed union of
   tool-call types. It is the difference between "new provider capability = a UI patch" and
   "= a contract change + migration + coordinated release".
8. **Reasoning as a sibling message role**, not a nested part. Much simpler streaming.
9. **Server-side delta batching** (~200–400 ms / ~N chars). Per-token frames will melt a mobile
   client over a relay.
10. **Attachments by id, bytes over HTTP.** Orquester already has this instinct (raw binary upload
    streams, `/api/fs/download`); reuse it.
11. **Per-turn checkpoint via a hidden git ref** if you want diff + revert. `write-tree` +
    `commit-tree` + `update-ref` under an isolated `GIT_INDEX_FILE` is ~40 lines and touches nothing
    the user sees. The two hard-won rules: **ask the provider whether it can roll back its
    conversation before you touch the filesystem**, and **refuse a file restore in a shared
    checkout**.
12. **Provider session id as the resume cursor.** Do not replay transcripts into the provider.

### 8.2 What is t3code-specific complexity you can skip

- **SQLite + 53 migrations + 9 independently-cursored projectors.** This exists because t3code has
  200k users, multi-hundred-MB databases and threads with 2 000+ tool rows. Single-user Orquester
  does not need per-projector cursors, keyset pagination, or `projection_state` at all.
- **The whole pagination stack** — `turnLimit`, opaque `(anchor, turnId)` cursors, `threadSequence`
  watermarks, `historyEpoch`, parked older pages. Only needed once threads exceed what you can send
  at once. Add a dumb `?limit=N` later.
- **`LiveStreamBudget`'s ACK-aware byte accounting.** Effect RPC gives them per-batch ACKs for free;
  a plain WS doesn't. A simple "if the outbound buffer exceeds X, drop the subscription and make the
  client resume" is 95% of the value.
- **Settle / snooze / pin / archive / active-order fractional indexes** — an inbox product, not an
  agent runtime.
- **Pull-request links, stacks, sync reactors, `PullRequestFilesViewed`** — ~1 400 lines of contract
  alone.
- **Multi-environment client registry, relay, device pairing, DPoP, scopes.** Orquester's single
  password + Caddy is a different (and adequate) threat model.
- **Proposed plans as a first-class entity**, title generation/refinement reactors, background
  liveness, plan progress, subagent rosters.
- **The `ChatUnknownAttachment` / `ForwardCompatible*` / decoding-default machinery.** These exist
  because t3code ships web, desktop and mobile clients that upgrade independently against
  independently-upgraded servers. Orquester ships one bundle from one daemon; a version check at
  connect is enough. (Keep *one* habit though: Orquester's AGENTS.md already mandates schema-guarded
  loads for persisted client state — apply the same to persisted events.)
- **Effect everywhere.** The value here is `Layer`/`Scope` discipline and typed errors; none of the
  data model requires it.

### 8.3 Recommended minimal model (JSON files, single user)

Layout — one directory per thread, so writes are append-only and a corrupt thread can't take the
daemon down:

```
<appdir>/daemon/agent/
  projects.json                       # small, whole-file rewrite
  threads/<threadId>/
    meta.json                         # ThreadHead (see below), rewritten atomically
    events.ndjson                     # append-only, one JSON object per line
    attachments/<id>.<ext>
  receipts.json                       # commandId -> {sequence, status}, ring-buffered to ~500
```

`events.ndjson` is the log; `meta.json` is the snapshot/checkpoint of the fold (write it every N
events or on turn end so startup doesn't replay from zero). `sequence` is per-thread and monotonic —
you do not need a global one if subscriptions are per-thread, which for Orquester they are.

**Entities** (deliberately 6, not 12):

```ts
type ThreadHead = {            // the sidebar row; also meta.json
  id: ThreadId; projectPath: string; title: string;
  agentRef: string;            // orquester registry id: "claude" | "codex" | ...
  model?: string;              // opaque to the domain
  runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
  cwd: string; branch: string | null;
  status: "idle" | "starting" | "running" | "waiting" | "stopped" | "error";
  activeTurnId: TurnId | null; lastError: string | null;
  needsAttention: boolean;     // reuse Orquester's existing attention model
  sequence: number;            // last applied event sequence
  createdAt: string; updatedAt: string;
};

type ThreadItem =              // the ONE timeline type
  | { kind: "message"; id: MessageId; role: "user"|"assistant"|"reasoning";
      text: string; attachments?: AttachmentRef[]; turnId: TurnId|null;
      streaming: boolean; createdAt: string; updatedAt: string }
  | { kind: "activity"; id: string; tone: "info"|"tool"|"approval"|"error";
      activityKind: string;    // OPEN string
      summary: string; payload: unknown; turnId: TurnId|null; createdAt: string };

type Turn = { id: TurnId; state: "running"|"completed"|"interrupted"|"error";
              userMessageId: MessageId; assistantMessageId: MessageId|null;
              requestedAt: string; completedAt: string|null;
              checkpoint?: { turnCount: number; ref: string;
                             files: {path:string;additions:number;deletions:number}[] };
              usage?: { inputTokens?: number; outputTokens?: number; status: "complete"|"partial"|"unavailable" } };

type Approval = { requestId: string; kind: "command"|"file-read"|"file-change"|"permission";
                  detail?: string; options?: {decision: Decision; label: string}[];
                  createdAt: string; resolved: {decision: Decision; at: string} | null };

type Question = { requestId: string;
                  questions: {id:string;header:string;question:string;
                              options:{label:string;description:string;value?:string}[];
                              allowCustomAnswer?: boolean; multiSelect?: boolean}[];
                  dismissible: boolean; createdAt: string; answers: Record<string,unknown> | null };
```

Approvals and questions are *derived* from activities (`approval.requested`/`approval.resolved`,
`user-input.requested`/`user-input.resolved`) exactly as t3code does — do not give them their own
storage; the fold over the thread's activities produces the pending set.

**Events** — 12 types are enough:

`thread.created`, `thread.meta-updated`, `thread.deleted`, `thread.message-sent`,
`thread.message-delta`, `thread.message-completed`, `thread.turn-started`, `thread.turn-completed`,
`thread.activity-appended`, `thread.session-set`, `thread.turn-diff-completed`, `thread.reverted`.
Envelope: `{sequence, eventId, threadId, type, payload, occurredAt, commandId|null}`.

**Commands** — 8: `thread.create`, `thread.delete`, `thread.meta.update`, `thread.turn.start`,
`thread.turn.interrupt`, `thread.approval.respond`, `thread.user-input.respond`,
`thread.checkpoint.revert`. All carry a client-minted `commandId`. One `POST /api/agent/dispatch`
returning `{sequence}`, receipt-deduped.

**Transport** — reuse Orquester's existing two channels, don't add a third:
- `GET /events?thread=<id>&after=<sequence>` on the existing NDJSON bus, emitting the same three
  frames t3code uses: `{kind:"snapshot",…}` | `{kind:"event",…}` | `{kind:"synchronized"}`.
  On connect: if `after` is within N events of head, replay from the log; else send a snapshot.
  This maps 1:1 onto `GitWatcher`'s existing refcounted per-project subscription pattern.
- `GET /api/agent/threads/:id` for the snapshot (gzipped by Caddy), `?after=` for the tail.
- Attachments over the existing `POST /api/fs/upload` raw-binary path; reference by id.

**Batching** — one rule: buffer assistant/reasoning deltas per message and flush at most every
~250 ms or 8 KB, whichever first. Add the `tool.updated` coalescing (latest per tool-call id within a
50 ms window) only if you see tool-heavy threads saturate the stream.

**Checkpoints** — `refs/orq/checkpoints/<b64url(threadId)>/turn/<n>`, captured with
`GIT_INDEX_FILE=<tmp> git add -A && git write-tree && git commit-tree && git update-ref`. Store
`{turnCount, ref, files[]}` on the Turn. Revert = ask the agent adapter whether it supports rollback,
refuse if the thread runs in the shared checkout, then `git restore --source <oid> --worktree
--staged -- . && git clean -fd`, roll the agent back, delete stale refs, append `thread.reverted`,
truncate the fold.

**Resume** — store the agent CLI's own session id per thread (Orquester already discovers these via
`agent-conversations.ts`). Never replay the transcript into the agent.

**What to skip entirely for v1:** pagination, settle/snooze/pin, proposed plans, PR links, title
generation, subagent rosters, per-projector cursors, wire forward-compat unions, a live-stream byte
budget.

One warning from t3code's scars worth carrying over verbatim: **the full activity payload must stay
in persistence while a slimmed one goes on the wire** (`ActivityPayloadProjection.ts`). If you slim
at write time you lose the data you need the day someone asks "what did that tool actually return?",
and if you don't slim at all a single MCP-heavy thread will ship megabytes per reconnect.
