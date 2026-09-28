# `apps/daemon/src/agent-host` — module map

The agent host is a **separate long-lived Node process**, not part of the daemon. It hosts the
four adapters, owns every provider child process, owns the per-thread event logs, and serves a
small HTTP-over-unix-socket API at `<appdir>/daemon/agent-host.sock`.

Why separate: `deploy/orquester.service` uses `KillMode=process`, so on restart only the node
process is signalled and anything parented to the tmux server survives. Keeping adapters in the
daemon would kill every in-flight turn on each deploy. The host runs in a tmux service session
(`orqsvc-agent-host`), so it survives a daemon restart.

Spec: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`. Every section reference below
(`§n`) is to that file. The lazy boot, the fold snapshot and the thread index have their own
companion spec, `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`
(A1/A2/C and "invariant n" below refer to it).

## Directory map

| Path | Owner | Seam it implements |
|---|---|---|
| `adapter.ts` | **F** | `AgentAdapter` (§4.1) — operations, capabilities, and the interface rules as doc comments; `AdapterContext`, `AdapterFactory`, `Clock`, `IdGen`. |
| `services.ts` | **F** | The internal service interfaces the host packages code against: `ThreadStore`, `Ingestion`, `CheckpointService`, `LivenessRegistry`, `ProviderSnapshotRegistry`. |
| `host-protocol.ts` | **F** | `AGENT_HOST_PROTOCOL_VERSION`, socket/token path helpers, the daemon↔host route table, the auth header, `newHostInstanceId()`. Imported by **both** sides. Note `setThreadIdentity` (`POST /threads/:id/identity`): §3.4's account switch arrives here **already resolved** — the daemon owns the client-facing `POST /api/sessions/:id/account` because only it can apply the family and seeded-account gates and recompose the launch env. |
| `adapters/index.ts` | **F** | The static `id → AdapterFactory` registry. Imports are static by rule (§8: no lazy `import()` under the host). |
| `support/**` | **F** | Implemented, tested, dependency-free helpers every other package uses on day one. |
| `main.ts`, `server/**`, `orchestration/**` | **W1** | The host process entry, its unix-socket HTTP server, the readiness gate, the per-thread command lock, the §3.3 reconcile, the §3.4 session-restart policy. Since the lazy boot (A1/A2): `bootSettlePending` (an idle thread the reconcile did not fold gets its stale-`pending`-turn settle on its first `loadRuntime`, before the runtime is published — and `closeLeftoverWork`, below), `foldFromDisk` (`state.json` + the log's tail, or the whole log on any doubt), the snapshot cadence (`writeFoldSnapshot`: on every head-shaped change in `commit`, inside a turn only once `FOLD_SNAPSHOT_EVENT_INTERVAL` 200 events **and** `FOLD_SNAPSHOT_MIN_INTERVAL_MS` 30 s have passed, and after a cold load that folded ≥ 200 events), `applyEventsChunked` (`fold-ops.ts`: the same reducer, a `setImmediate` yield every 500 events), `observeIndex` (the index is fed strictly after the append), one closing row per request (`repeatsHostClosure`: at the ingestion sink, an adapter row that repeats as a cancellation a closure the host wrote itself — a Stop's cancel, a turn end's dismissal of a stranded question — is not written; `ThreadRuntime.hostClosedRequests`), and the index reads (C): `historyBoundsOf` (the snapshot's `history`), `readHistory` / `planHistoryBlock` (a block that holds a revert's gap folds out of it the rows the fold keeps — a kept turn's late rows, by the turn each names with the indexer's own `referencedTurnId`, turnless rows, rows written after the latest revert, a turnless checkpoint only from a block that holds the latest revert: `historyBlockEvents` / `keptOutOfGap` — and counts them against its 400 activities, `indexedActivityBudget`; a turnless user message written before the latest revert, in a gap or a range, only while the index still holds it — the revert's own rule, the fold's fallback pass included: `droppedByRevert`, `ThreadIndex.keepsUserMessage`) / `windowBoundary` (its per-class windows count only once the fold's `state.evicted` says retention dropped an activity — under batch retention a class grows to its limit plus a slack before its first trim; design `2026-09-23-fold-performance-design.md` — and once a rewound thread has evicted, it never lies before the first line the index positions past the latest revert, `pastLatestRevert`, which no cursor names), `searchThreads`, `readPrompts` / `readPromptText` (the right rail's History: the thread's own user prompts, newest first, from the index — served only once its `coverage` says it holds the thread's whole log: `indexed:false, catchingUp:true` while it catches up, `indexed:false` without a usable index or for a thread it will not catch up before a restart, 503 `INDEX_UNAVAILABLE` for a failed read; the text route's 404 only from an index that holds the whole thread), with their routes `GET /threads/:id/history`, `GET /search`, `GET /threads/:id/prompts` and `GET /threads/:id/prompts/:messageId` in `server/http-server.ts`. The host's teardown (`stop()` in `main.ts`: a deploy's `/stop`, a restart, a SIGTERM): `shutdown.abort()` starts each adapter's own `stopAll()`, `stop()` awaits each adapter's `stopAll()` again — which waits for every stop in flight, not only its own (Grok, Codex, OpenCode's server pool) — then lets the consumers read what the stops queued (bounded, `TEARDOWN_CONSUME_MS`, the one wait on them), and only then stops the orchestrator, whose stop ends consumption at once (`host-teardown.test.ts`). An intentional stop's marked turn that the teardown settles is still continued by the next host (`continuesSettledTurn`, §3.3) — under a marker this code stamped (`markedAt`) only: an older host's unstamped marker on a settled head is cleared, never continued. |
| `orchestration/leftover-work.ts` | **W1** | The requests, calls and tasks a dead process left open, derived from the folded window alone (`leftoverWorkClosings`): first every request the fold shows pending but a message-mode question, cancelled with the host's own Stop rows (`cancelledRequestActivity` in `events.ts`, shared with `settlePendingRequests`: "Request cancelled" / "Question cancelled", on the head's running turn — or, when the orphan reconcile settled that turn first, the one the head said was running, `runningTurnId`); a `tool.completed {status: "failed"}` for every open call (`openWorkOf`) on its latest lifecycle row's item type, title, turn, owner and data (`closerData`: data stored cut counts as cut only when it holds a cut output — an identity-only cut such as Claude's `{command, toolName}` rides unmarked; an output preview gives way to the opening row's whole data, else rides marked `truncated`) — but none for a call no row of the window anchors (`anchorsCall`, `@orquester/api`'s `call-anchor.ts`: every row of it turnless and ownerless, what a rewind leaves of a Claude parent call a later turn adopted, in a log written before 2026-09-28), which no view shows and a closer would bring back as a failed row; a `task.completed {status: "stopped"}` for every task the roster shows `pending`/`running`/`waiting` (never `idle`) on its start's owner and turn — calls before tasks, so a shell's item closes before its task, each closer in its opener's retention class. A message-mode question stays pending, and a message still streaming is left as the log has it (a settle would stretch its span in the index and cut rows out of "Load older"); its readers read it as settled by `isMessageStreaming` (`@orquester/api/agent-chat`) instead. A closer also carries the files its call's latest row names at its top level (`changedFiles`: a Codex patch update is stored as `data: {}` beside them). The orchestrator's `closeLeftoverWork` appends them on a thread's first load in a host lifetime (`settleOnFirstLoad`, and the reconcile — after it settles an orphaned turn, before it continues one), never for a thread an adapter lists as live, in passes (the roster lists 100 rows, live first). Then `legacyLaunchStarts`: one `task.started` naming `legacy-launch:<taskId>` for every settled OpenCode/Codex/Grok agent an older host launched with no launch id, so its next relaunch reopens it — on its first start's turn and owner, its latest row's linkage, the row's `createdAt`/`updatedAt` the roster's own `updatedAt` for it (the event is stamped with the load's time), so nothing the roster shows moves (`recordLegacyLaunches`). |
| `orchestration/provider-snapshots.ts` | **W1** | The §3.2 snapshot registry: the pending seed, the correlated on-disk cache, `startBootRefresh()`, the watcher-gated 5-minute top-up — **and the per-read bin-identity check**, one `realpath` + `stat` of the resolved bin (rate-limited per adapter) that kicks one background refresh when the CLI moved under the host. Nothing here ever spawns the CLI to decide that. Once `stop()` ran it writes nothing: a probe still in flight at the host's stop updates the in-memory snapshot only (its write recreated a removed appdir), and the host's stop awaits the write queued before (`flush()`). |
| `adapters/attachment-lines.ts` | **F** | §4.1/§4.5 attachment delivery, pure: `appendAttachmentPathLines`, the `Attached files:` block every adapter appends AFTER the text for the refs it does not ingest natively — a suffix, never a prefix, so a `/command` still dispatches (§4.6.9) — skipping a path the text already names; its inverse `stripAttachmentPathLines` for a replayed native history; and `attachedFileLine`, the line a question answer names a file with. Before any adapter sees a turn, `sendTurnEffect` resolves and STATs every attachment on every sending path (§6.3), so an adapter only ever gets refs that resolved, carrying their real size. |
| `store/**` | **W2** | `ThreadStore` (§5.1): the NDJSON logs, the atomic head, the **provider-session binding** (`binding.ts` — the resume cursor's durable home, merged field-wise), the receipts ring, attachments. Also the shared fold implementations in `@orquester/api`'s `agent-chat` module (with `fold-snapshot.ts`, the `state.json` format, and `history-cursor.ts`). Since A2: `state.json`, the **fold snapshot** (`loadFoldSnapshot` → null on any doubt, never throws; `saveFoldSnapshot` → atomic, 0600, on the thread's write queue, refusing `state.seq !== seq`), and every line's byte **position** — `append` answers `positions` + `logBytes`, `readEventsFrom` reads from a cursor (answering `mismatch` unless the line there — never an empty one, which the store never writes — carries `afterSeq + 1`), `readEventRange` reads a history block, `lastSeq`/`logLength` answer without a fold. A torn trailing line is cut at first load and a failed append is rolled back (length and `seq`), so position reads and `readAll` agree. The attachment sweep folds snapshot + tail, and only for a thread with a stored attachment. `readItem` serves §5.6's unslimmed item from the log, and `readToolOutput` (`tool-output.ts`) the streamed output of the tool call an item belongs to — its `tool.output` chunks joined in log order, ≤ 8 MiB (`GET …/items/:itemId/output`); `readToolOutputWindow` one UTF-8 window of that join (`?offset=&maxBytes=`). Both the windows and `readItem`'s activities come from the **tool-output cache** (`tool-output-cache.ts`, memory only): an item cursor per `(thread, item)` — its newest write's line and call, so an activity read is the log's tail plus one `pread` — and an incremental join per `(thread, call)` (`ToolOutputJoin`, the same step as `joinToolOutput`), each extended by the committed log past its cursor with `readLog`'s rules; any doubt rebuilds it from byte 0, `deleteThread` drops the thread's entries, a revert invalidates nothing; 32 MiB of join buffers, 1 024 item cursors, LRU, 10 minutes idle, no timer. |
| `index/**` | **TI-C** | The **thread index** (C): one host-wide SQLite file of rows derived from the logs — turn byte ranges, activity positions, message spans, compaction markers, FTS5 text — serving the host's `GET /threads/:id/history`, `GET /search` and `GET /threads/:id/prompts[/:messageId]`. A cache: behind the log after a crash, never ahead; deleted and rebuilt on any doubt. See the section below. |
| `ingestion/**` | **W3** | `Ingestion` (§5.1 rules, §5.6 batching/coalescing/slimming). The runtime→domain hop. A resolution an adapter marks `withdrawn` — nobody answered, and the wait on it has ended (a Codex card the server resolved itself, or a collab child's card at the end of the child's own turn or thread; any adapter's card its own session's teardown closed — Claude's, Codex's, Grok's or OpenCode's: an interrupt, a steer's cancel, a rewind, the process's exit) — is written as the host's own cancelled row, the one a Stop writes (`cancelledRequestActivity` in `orchestration/events.ts`). |
| `checkpoints/**` | **W4** | `CheckpointService` (§5.4, §5.5): the hidden per-turn git refs, the diff read, revert pruning. |
| `adapters/claude/**` | **W6** | The Claude adapter (§4.5 Claude) + `apps/daemon/test/fixtures/claude/**`. |
| `adapters/codex/**` | **W7** | The Codex adapter (§4.5 Codex); `_generated/**` comes from **X2**. |
| `adapters/opencode/**` | **W8** | The OpenCode adapter (§4.5 OpenCode). |
| `adapters/grok/**` | **W9** | The Grok adapter + the ACP client (§4.5 Grok); `acp/_generated/**` comes from **X4**. The normaliser (frames → runtime events) is `normalize.ts` — `GrokNormalizer`, the class `session.ts` and the replay tests drive, and the frame routing: the ACP `session/update` switch and the private channel's, a subagent's child session's frames included — over `normalizer-state.ts` (`GrokNormalizerState`, the state its functions share, and the envelope every row is built with), with one module of functions per concern: `segments.ts` (assistant text and reasoning), `tool-calls.ts` (a call's rows, finished calls, the plan card), `subagents.ts` (spawn calls, the `subagent_*` reports, child sessions and the joins held until their prompt echo decides them, `resume_from`), `background-tasks.ts` (shells and monitors: snapshots, the CLI's reports, poll and kill answers, ended-task memory and revival) and `loops.ts` (scheduled prompts); `goal.ts` (`GrokGoalTracker`: the session's goal as the thread's goal, goals §6.3; `goalCommandFromReminder` for the history projection). |

The daemon-side half — proxying `/api/sessions/:id/*` onto the socket, spawning and adopting the
host, the kill guard, the tab records — is **W10** and lives in `apps/daemon/src/agent-chat/**`,
not here. **TI-x** is task x of `docs/superpowers/plans/2026-09-23-thread-index-and-lazy-boot.md`.

## `support/` — what is already implemented

Tests sit beside each file as `*.test.ts` and run through `pnpm --filter @orquester/daemon test`.

| File | What it gives you |
|---|---|
| `spawn.ts` | `spawnProviderChild()` — an **explicit** env (never a spread of `process.env`), all three stdio piped, a recorded pid, an `exited` promise that never rejects, and `kill()` escalating SIGTERM→SIGKILL on a grace deadline, signalling the whole **process group** for a `detached` child. Plus `exitOutcome()`, the §3.1 exit rule in one place. |
| `env.ts` | `buildProviderEnv()` per §3.1 "Launch environment": session PATH, `TMPDIR`, `HOME`, `ORQUESTER_SESSION_ID`, the per-adapter account-home variable (`ACCOUNT_HOME_ENV_VAR`), the launch marker (`ORQUESTER_AGENT_LAUNCH`, the required `launchId`: one value per launch, which every adapter's provider and its descendants carry — Settings → System reads it, only Grok sweeps by it), and extra launcher env — with ambient vendor credentials stripped unless explicitly allowed. `needsShellExpansion()` is the assertion that a value is already absolute. |
| `stderr.ts` | `StderrCapture` — line split with a carried remainder, ANSI strip, classification (drop / warning / error) and the §3.1 **redaction** (home paths → `~`, `Authorization`/`x-api-key` values, `Bearer`, `sk-`/`ghp_`/`xox*` shapes), plus a bounded 4 KiB rolling tail that only ever holds redacted text. |
| `deadline.ts` | `withDeadline()` and `DeadlineExceededError`, plus `AGENT_HOST_DEADLINES` and `TURN_LIVENESS_WINDOWS` — every bounded window §3.1 and §4.5 name, in one object. |
| `ndjson.ts` | `NdjsonLineReader` (partial chunks, `\r\n`, BOM), `parseNdjsonLine()` (skips blanks and `:` comments) and `NdjsonWriter`, a backpressure-aware writer that queues on `drain` and **drops** past its budget rather than growing host memory. |
| `leftover-processes.ts` | What a provider CLI leaves behind: `AGENT_LAUNCH_ENV_VAR` (`ORQUESTER_AGENT_LAUNCH`, one value per launch, inherited by every descendant), `recordChildSessions()` (the sessions a CLI's children lead, recorded while it lives), `findLeftoverProcesses()` and `stopLeftoverProcesses()` — only processes carrying the marker IN a recorded session (a daemon that `setsid`s away is spared); SIGTERM, then SIGKILL past the grace to what a fresh scan still finds, each pid checked against its `/proc` starttime before every signal, a live session leader against the one recorded. The Grok CLI starts its shells and MCP servers in sessions of their own, so the group kill in `spawn.ts` reaches it alone; its session sweeps its helpers (the MCP servers, its children as the session opened — recorded as the CLI reports them booting, and at any end before the session is announced) at every end — the host's teardown waits for it, with a 1 s grace there (`HOST_TEARDOWN_SWEEP_GRACE_MS`, inside the SIGTERM path's 3 s backstop) — and the work its agent started only when the user ends the session, recorded first by the adapter's `prepareUserEnd`, which the orchestrator calls before it answers the session's cards — a deploy never kills running work (`GrokSession.stopLeftovers`). The daemon's kill guard reads the same marker (`system-status.ts`). Linux-only; a no-op elsewhere. |
| `leftover-work.ts` | The user's work earlier launches of a thread left running, remembered until the user ends its session: `recordLeftoverWork()` merges one launch's task sessions (SID, leader starttime) under its launch id into the thread's `leftover-work.json` (0600, atomic, the last 8 launches, 64 sessions each, one writer per file at a time); `sweepLeftoverWork()` stops each launch's work by its own marker in its own sessions (`stopLeftoverProcesses`'s identity checks) — every launch at once, one grace window for the lot — and forgets it. Read entry-wise tolerantly. Grok's `sweepEndedSession` is its only caller. |

Two deliberate non-`unref` decisions, both load-bearing and both covered by tests: the deadline
timer and the child process handle are **ref'd**, because `onTimeout` is what kills a wedged
child and the exit watcher is what settles the in-flight turn. A timer the loop is free to skip
would let the host exit with a child still running.

## `index/` — the thread index (C)

`<appdir>/daemon/agent/index.sqlite` (`agentChatIndexPath`), WAL, 0600. Every row is derived from
`events.ndjson`; there are no migrations — a file that is not exactly this build's schema is
deleted and rebuilt from the logs. Tests use the real driver in a temp dir.

| File | What it does |
|---|---|
| `index.ts` | `createThreadIndex()` → `ThreadIndex`: per-thread write lanes (`observe` returns at once and coalesces queued batches into one transaction; `catchUp` rides the same lane, so a live append and a catch-up read never interleave; `drain()` waits for both; `stop()` — the host's shutdown — applies what is queued, ends a catch-up at its next check and closes), every read wrapped to answer empty on a driver error, `coverage(threadId, logSeq)` — whether the index holds a thread's whole log (it waits for queued observes, never for a catch-up): `catching-up` from a catch-up's enqueue to its end and, while the boot sweep `main.ts` brackets with `beginCatchUpSweep` runs, for every thread it has not reached; `behind` when nothing will re-read the missing lines before a restart — and `createUnavailableThreadIndex()` — what a host without an index runs with: writes are no-ops, reads are empty, `available === false`. |
| `sqlite.ts` | The driver, resolved ONCE at module load (`createRequire` inside try/catch, then one `:memory:` open to probe the native binding — never a lazy `import()`), and the file lifecycle: created 0600 before SQLite touches it, WAL + `synchronous=NORMAL`, `quick_check` and the schema version on every open; anything wrong deletes `index.sqlite` + `-wal`/`-shm`/`-journal` and starts empty (once — after that the index runs unavailable). |
| `schema.ts` | The tables (`INDEX_SCHEMA_VERSION` — bump it for ANY statement change, and for any change to which rows the indexer derives: an old file fits the statements, so only the version rebuilds it): `threads` (the per-thread cursor `last_seq`/`last_byte`, plus `open_turn_id`, `revert_seq` and `inflight` — the requested-but-unstarted turns and unclaimed prompts no `turns` row can hold, JSON), `turns` (ordinal + `[first_byte, end_byte)`), `items` (each activity's latest line), `message_docs` (each message's span, its author — `role` and the owning subagent's `agent_id`, NULL for the parent, from its first line — its latest `turn_id` and first `created_at`, and the keyed side of `messages_fts`; the partial index `message_docs_prompts` walks a thread's parent user rows alone, and `messages_fts` is joined by rowid only for the rows a page reads), `markers` (the phase of each compaction marker of the conversation itself — `@orquester/api`'s `compaction.ts` rule, which the MCP calls too and the UI's window gates compose from the same parts: either spelling, never a subagent's own), and the two FTS5 tables (`unicode61 remove_diacritics 2`). |
| `indexer.ts` | Events → rows, one transaction per batch together with the cursor. Keeps a per-thread turn fold (`applyTurnEvent`, the fold's own reducer, so ordinals are `/revert`'s count) and byte ranges that **tile the log**: a turn starts at its prompt and does not stop at its settling `session-set` (the turn-end checkpoint lines are its); a late event naming an earlier turn grows that turn's range past the next one's start, within `MAX_LATE_REFERENCE_BYTES` (`extendReferenced`); a `thread.reverted` seals every range, clips every surviving one at the first removed turn's first line (`clipAtCut` — else a stretched survivor kept serving the removed turns' rows in "Load older") and truncates everything from that line on — but the user messages, which it drops by the fold's own `retainMessagesAfterRevert` rule (`dropRevertedUserMessages`: by turn and by claim, then the fold's restoring pass), so the prompt list drops what the timeline drops. Text is indexed when a message finishes and on every activity write (summary/title/detail), capped at `MAX_INDEXED_TEXT_CHARS` (128 K). A batch that does not continue the cursor is dropped — only a catch-up fills a hole. Per-thread memory is an LRU of 16 threads (`MAX_RESIDENT_THREADS`) that never evicts one with a pending turn or a message mid-stream; a reload rebuilds turns from `turns` and the in-flight part from `threads.inflight`. |
| `queries.ts` | Turn lookups, the activity-paging primitives the host's `readHistory` plans with (`activitySeqBefore`, `itemPosition(BySeq)`, `eventPositionBySeq`, `messagesSpanning`, `turnOfSeq`, `turnsInSeqRange`, `hasItemsBefore`, and past a revert `latestRevertSeq`, `firstBoundaryAfter`, `turnByPrompt`, `keepsUserMessage` — whether a revert kept a user message, the rule `dropRevertedUserMessages` applied), `rewindable` (no `compacted` marker after the turn's first line — one rule for history pages and prompts), `prompts` / `prompt` (the parent's `user` messages newest first through `message_docs_prompts`, filtered by `@orquester/api`'s `recallablePromptText`, each page filled to `limit` — `max(limit + 1, 256)` rows a read — or cut short with a cursor once it has walked `PROMPTS_SCAN_BUDGET` (2 000) rows; the cursor is `base64url({t, s})` on the log seq, so it survives a rebuild and a revert) and `search` (`toFtsQuery` quotes every whitespace token — never raw FTS syntax; `bm25` over both tables, `«…»` snippets, `limit` ≤ 50). |
| `turn-reference.ts` | `referencedTurnId`: the turn a line says it belongs to — an activity's, a message's or a checkpoint's `turnId`. The indexer grows a range over a late line by it (`extendReferenced`), and history planning folds a kept turn's late row out of a revert's cut by it (`historyBlockEvents` in `orchestration/orchestrator.ts`). Its own module, so the orchestrator reads it without loading the driver. |
| `testing.ts` | Test scaffolding only: `TestLog` (an in-memory log with REAL byte positions, multi-byte text included, and the store's `mismatch` semantics) plus event builders. |

## Boot order (`main.ts`)

1. `snapshots.load()`, then every adapter acquired (one ingestion consumer each).
2. `host.reconcile()` — §3.3, lazily (A1): every thread's `meta.json` is read, only orphans are
   folded — settled at the time their process last wrote (`crashSettleAt`), then their leftover
   work closed and their legacy agents' launches named (`repairLeftovers`), or those repaired
   first and then continued; the rest wait in `bootSettlePending` for their first load, which
   settles and repairs the same way.
3. `store.sweepStartup()` — fired, never awaited: stale partial uploads and the raw-log ceiling,
   no log read. The deep sweep (`sweepNow`: snapshot + tail, threads with stored attachments only)
   runs on the store's 6 h schedule.
4. `host.openGate()` — readiness. Queued commands and the daemon's health probe are released.
5. `snapshots.startBootRefresh()` — never awaited; probes only the providers that hydrated no
   correlated cache row.
6. `setImmediate(openThreadIndex)` — the index file opens on the NEXT loop turn (its `quick_check`
   reads every page), is plugged into the `deferredThreadIndex()` handle the orchestrator was built
   with, and `catchUpThreadIndex` then walks every thread sequentially — reading only the tail past
   each thread's index cursor, re-indexing from byte 0 on `mismatch` — never awaited by anything.
   The walk is bracketed by `beginCatchUpSweep()`, so a thread it has not reached reads
   `catching-up` (the prompt list's `catchingUp`) rather than complete or left behind.
   Until the open, that handle is unavailable: an `observe` is dropped (the catch-up reads the log
   instead), `coverage` answers `catching-up`, and a `deleteThread` is remembered and replayed.

`stop()` (an intentional `/stop` starts it only once its reply has flushed — `afterStopResponse`):
server close → every adapter's `stopAll()` (each call waits for every stop in flight, an earlier
call's included: the adapter's own abort listener runs one first) → the consumers read what the
stops queued, to each stream's end (bounded by `TEARDOWN_CONSUME_MS`, the one wait on them: the
orchestrator's stop ends consumption at once, and a row still queued then never reached the log)
→ orchestrator stop → index `stop()` (after the orchestrator, whose last commits still feed it:
every queued observe is applied, a boot catch-up in flight ends at its next check with its cursor
left behind the log, then the file closes — so indexing never holds a deploy's stop) → store
close → `snapshots.flush()` (the provider cache's last write, queued before the registry stopped;
a stopped registry writes nothing, so a probe still in flight never recreates the appdir).

Before that stop, a deploy's drain may ask for a **goal hold** (`POST /goals/hold`, agent goals
§5.7): while goals are all that blocks the drain, the orchestrator holds every continuing Codex
goal between its turns (`holdContinuingGoals`) — it marks the head `goalHeldForHandover` (a resume
mark the next host's reconcile acts on, written before the pause is sent), pauses the goal, and
keeps reporting it as continuing. The request is a lease (`GOAL_HOLD_LEASE_MS`) the daemon renews
while it waits; when it runs out with this host still up — or a held goal has sat idle behind
other work for `GOAL_HOLD_IDLE_MS` — the host resumes what it held itself. Every such resume, and
the next host's, is conditional (`onlyIfPaused`): the provider, not the fold, says whether the
goal is still paused. A host from before the hold cannot pause a goal, so the daemon stops such a
goal's session at a turn boundary instead, and this host resumes it without a turn when the daemon
hands it over (`POST /goals/resume-sessions` → `resumeGoalSessionsAfterHandover`).

## Rules that apply to everything under this directory

- **No lazy dynamic `import()`** (§8). A host that survives a deploy runs old code until the
  drain-restart; loading changed source into it is a correctness bug, not a nicety.
- **Every step that waits on a child has a deadline** (§3.1), and an expired deadline kills the
  child rather than leaving the thread `starting` forever.
- **A running state never outlives its process** (§3.1/§4.1). Before `session.exited` the adapter
  withdraws every parked request (one `withdrawn` row each, before the turn settles), settles the
  turn, and closes every live task `stopped` — and a CLI whose children escape its process group
  (Grok's) has its own helpers stopped as well, by the launch marker they inherited
  (`support/leftover-processes.ts`); the processes its agent's work started are stopped only when
  the user ends the session, and otherwise run on as marked orphans Settings → System can kill,
  because a deploy must never kill running work. A host that died without that teardown has it
  written for it: a thread's first load in the next host lifetime appends the rows that cancel every
  request (a message-mode question excepted) and close every call and task its window still shows
  open — but a call no row anchors (`anchorsCall`), which no view shows (`closeLeftoverWork`,
  `orchestration/leftover-work.ts`). A turn that process was running is settled at the time it last
  wrote, before anything else is appended (`crashSettleAt`: the log's last line, or a later start of
  a turn it settles): it ended when its process died, and the downtime is not part of it.
- **An unknown frame is surfaced, never dropped by a catch-all** (§10): a `satisfies never` at
  compile time, a `runtime.warning` at run time — which never ends an active turn.
- **Wait on receipts and drains, never on sleeps** (§9). `ThreadStore.drain()` and
  `Ingestion.drain()` exist for exactly that.
- `raw.ndjson` is **as sensitive as the repository** (§10): it records whatever the agent read.
  Redact before anything leaves the host. So is `index.sqlite`, which holds the full text of every
  conversation: 0600, and never served as a file (invariant 8).
- **Checkpoints and reverts count turns by ORDER; the checkpoint list is no longer the counter**
  (§5.4, §5.5). A turn's number is its position among the started turns — `startedTurns` /
  `turnOrdinal` in `@orquester/api`'s `agent-chat/turns.ts`, the same function the client's
  "rewind to here" uses. `/revert` validates `targetTurnCount` against it, names the cut to the
  adapter by turn id (`RollbackTarget`) and prunes the dropped turns' own checkpoint counts as well
  as everything above the target (older threads carry dense counts). Checkpoints are numbered by
  it too — the turn with ordinal N has its baseline at `turn/<N-1>` and its completion at
  `turn/<N>` — so ref numbers are sparse wherever git was absent, a capture failed or history was
  resumed, and that is expected. The late-capture guard a revert arms (`revertedTo`) is lifted by
  the next `turn.started`, or a genuinely new turn (`target + 1`) would be dropped with it.
- **An identity change writes `launch.json` before the head, and starts nothing** (§3.4).
  `buildEnv`/`resolveHome` in `main.ts` read the live launch config, so the order is what makes the
  next session start pick the new account up; the restart itself is the ordinary ensure step on the
  next `/turn`. `orchestrator.setIdentity` refuses unless the thread is idle, and refuses
  OpenCode.
- **`state.json`, `index.sqlite` and the store's tool-output cache are caches of `events.ndjson`,
  never authorities** (invariant 1). Any doubt — another version, a seq or byte offset that does not
  line up, a file that does not parse — discards the cache and re-derives from the log, never the
  reverse. The tool-output cache reads only the committed log (never an append in flight), extends
  an entry by the tail past its cursor only while the next line there is the cursor's `seq + 1`, and
  is dropped for a thread by `deleteThread` (a per-thread generation fences off a scan already
  running). Bump
  `FOLD_SNAPSHOT_VERSION` (`@orquester/api`'s `fold-snapshot.ts`) whenever the fold's output changes
  for the same log, and `INDEX_SCHEMA_VERSION` for any change to the index's statements or to the
  rows the indexer derives into them (the compaction-marker rule moved it to 3, the revert's clip
  of a surviving turn's range to 4). The index
  is fed strictly AFTER the append, so a crash leaves it behind the log, never ahead (invariant 4).
- **Nothing new blocks readiness, and the loop must breathe** (invariants 2 and 7). The reconcile
  folds orphans only; the index opens after the gate and catches up unawaited; a fold over a whole
  log yields to the loop every 500 events (`applyEventsChunked`; the store's sweep has its own
  `foldForward`), the index's catch-up yields every `INDEX_CATCH_UP_CHUNK` (500) events, and the
  tool-output cache is built on demand only (never at boot), streaming the log a window at a time
  and yielding every `DECODE_SLICE_MS` like `readLog` — a multi-second stretch of synchronous work
  lets the daemon's 15 s health probe (5 s timeout) miss twice and restart a healthy host.
