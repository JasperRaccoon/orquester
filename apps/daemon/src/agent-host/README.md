# `apps/daemon/src/agent-host` — module map

The agent host is a **separate long-lived Node process**, not part of the daemon. It hosts the
four adapters, owns every provider child process, owns the per-thread event logs, and serves a
small HTTP-over-unix-socket API at `<appdir>/daemon/agent-host.sock`.

Why separate: `deploy/orquester.service` uses `KillMode=process`, so on restart only the node
process is signalled and anything parented to the tmux server survives. Keeping adapters in the
daemon would kill every in-flight turn on each deploy. The host runs in a tmux service session
(`orqsvc-agent-host`) exactly as cliproxy does.

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
| `main.ts`, `server/**`, `orchestration/**` | **W1** | The host process entry, its unix-socket HTTP server, the readiness gate, the per-thread command lock, the §3.3 reconcile, the §3.4 session-restart policy. Since the lazy boot (A1/A2): `bootSettlePending` (an idle thread the reconcile did not fold gets its stale-`pending`-turn settle on its first `loadRuntime`, before the runtime is published), `foldFromDisk` (`state.json` + the log's tail, or the whole log on any doubt), the snapshot cadence (`writeFoldSnapshot`: on every head-shaped change in `commit`, inside a turn only once `FOLD_SNAPSHOT_EVENT_INTERVAL` 200 events **and** `FOLD_SNAPSHOT_MIN_INTERVAL_MS` 30 s have passed, and after a cold load that folded ≥ 200 events), `applyEventsChunked` (`fold-ops.ts`: the same reducer, a `setImmediate` yield every 500 events), `observeIndex` (the index is fed strictly after the append), and the index reads (C): `historyBoundsOf` (the snapshot's `history`), `readHistory` / `planHistoryBlock` / `windowBoundary` (its per-class windows count only once the fold's `state.evicted` says retention dropped an activity — under batch retention a class grows to its limit plus a slack before its first trim; design `2026-09-23-fold-performance-design.md`), `searchThreads`, with their routes `GET /threads/:id/history` and `GET /search` in `server/http-server.ts`. |
| `orchestration/provider-snapshots.ts` | **W1** | The §3.2 snapshot registry: the pending seed, the correlated on-disk cache, `startBootRefresh()`, the watcher-gated 5-minute top-up — **and the per-read bin-identity check**, one `realpath` + `stat` of the resolved bin (rate-limited per adapter) that kicks one background refresh when the CLI moved under the host. Nothing here ever spawns the CLI to decide that. |
| `adapters/attachment-lines.ts` | **F** | §4.1/§4.5 attachment delivery, pure: `appendAttachmentPathLines`, the `Attached files:` block every adapter appends AFTER the text for the refs it does not ingest natively — a suffix, never a prefix, so a `/command` still dispatches (§4.6.9) — skipping a path the text already names; its inverse `stripAttachmentPathLines` for a replayed native history; and `attachedFileLine`, the line a question answer names a file with. Before any adapter sees a turn, `sendTurnEffect` resolves and STATs every attachment on every sending path (§6.3), so an adapter only ever gets refs that resolved, carrying their real size. |
| `store/**` | **W2** | `ThreadStore` (§5.1): the NDJSON logs, the atomic head, the **provider-session binding** (`binding.ts` — the resume cursor's durable home, merged field-wise), the receipts ring, attachments. Also the shared fold implementations in `@orquester/api`'s `agent-chat` module (with `fold-snapshot.ts`, the `state.json` format, and `history-cursor.ts`). Since A2: `state.json`, the **fold snapshot** (`loadFoldSnapshot` → null on any doubt, never throws; `saveFoldSnapshot` → atomic, 0600, on the thread's write queue, refusing `state.seq !== seq`), and every line's byte **position** — `append` answers `positions` + `logBytes`, `readEventsFrom` reads from a cursor (answering `mismatch` unless the line there carries `afterSeq + 1`), `readEventRange` reads a history block, `lastSeq`/`logLength` answer without a fold. A torn trailing line is cut at first load and a failed append is rolled back (length and `seq`), so position reads and `readAll` agree. The attachment sweep folds snapshot + tail, and only for a thread with a stored attachment. |
| `index/**` | **TI-C** | The **thread index** (C): one host-wide SQLite file of rows derived from the logs — turn byte ranges, activity positions, message spans, compaction markers, FTS5 text — serving the host's `GET /threads/:id/history` and `GET /search`. A cache: behind the log after a crash, never ahead; deleted and rebuilt on any doubt. See the section below. |
| `ingestion/**` | **W3** | `Ingestion` (§5.1 rules, §5.6 batching/coalescing/slimming). The runtime→domain hop. |
| `checkpoints/**` | **W4** | `CheckpointService` (§5.4, §5.5): the hidden per-turn git refs, the diff read, revert pruning. |
| `adapters/claude/**` | **W6** | The Claude adapter (§4.5 Claude) + `apps/daemon/test/fixtures/claude/**`. |
| `adapters/codex/**` | **W7** | The Codex adapter (§4.5 Codex); `_generated/**` comes from **X2**. |
| `adapters/opencode/**` | **W8** | The OpenCode adapter (§4.5 OpenCode). |
| `adapters/grok/**` | **W9** | The Grok adapter + the ACP client (§4.5 Grok); `acp/_generated/**` comes from **X4**. |

The daemon-side half — proxying `/api/sessions/:id/*` onto the socket, spawning and adopting the
host, the kill guard, the tab records — is **W10** and lives in `apps/daemon/src/agent-chat/**`,
not here. **TI-x** is task x of `docs/superpowers/plans/2026-09-23-thread-index-and-lazy-boot.md`.

## `support/` — what is already implemented

Tests sit beside each file as `*.test.ts` and run through `pnpm --filter @orquester/daemon test`.

| File | What it gives you |
|---|---|
| `spawn.ts` | `spawnProviderChild()` — an **explicit** env (never a spread of `process.env`), all three stdio piped, a recorded pid, an `exited` promise that never rejects, and `kill()` escalating SIGTERM→SIGKILL on a grace deadline, signalling the whole **process group** for a `detached` child. Plus `exitOutcome()`, the §3.1 exit rule in one place. |
| `env.ts` | `buildProviderEnv()` per §3.1 "Launch environment": session PATH, `TMPDIR`, `HOME`, `ORQUESTER_SESSION_ID`, the per-adapter account-home variable (`ACCOUNT_HOME_ENV_VAR`), and extra launcher env — with ambient vendor credentials stripped unless explicitly allowed. `needsShellExpansion()` is the assertion that a value is already absolute. |
| `stderr.ts` | `StderrCapture` — line split with a carried remainder, ANSI strip, classification (drop / warning / error) and the §3.1 **redaction** (home paths → `~`, `Authorization`/`x-api-key` values, `Bearer`, `sk-`/`ghp_`/`xox*` shapes), plus a bounded 4 KiB rolling tail that only ever holds redacted text. |
| `deadline.ts` | `withDeadline()` and `DeadlineExceededError`, plus `AGENT_HOST_DEADLINES` and `TURN_LIVENESS_WINDOWS` — every bounded window §3.1 and §4.5 name, in one object. |
| `ndjson.ts` | `NdjsonLineReader` (partial chunks, `\r\n`, BOM), `parseNdjsonLine()` (skips blanks and `:` comments) and `NdjsonWriter`, a backpressure-aware writer that queues on `drain` and **drops** past its budget rather than growing host memory. |

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
| `index.ts` | `createThreadIndex()` → `ThreadIndex`: per-thread write lanes (`observe` returns at once and coalesces queued batches into one transaction; `catchUp` rides the same lane, so a live append and a catch-up read never interleave; `drain()` waits for both; `stop()` — the host's shutdown — applies what is queued, ends a catch-up at its next check and closes), every read wrapped to answer empty on a driver error, and `createUnavailableThreadIndex()` — what a host without an index runs with: writes are no-ops, reads are empty, `available === false`. |
| `sqlite.ts` | The driver, resolved ONCE at module load (`createRequire` inside try/catch, then one `:memory:` open to probe the native binding — never a lazy `import()`), and the file lifecycle: created 0600 before SQLite touches it, WAL + `synchronous=NORMAL`, `quick_check` and the schema version on every open; anything wrong deletes `index.sqlite` + `-wal`/`-shm`/`-journal` and starts empty (once — after that the index runs unavailable). |
| `schema.ts` | The tables (`INDEX_SCHEMA_VERSION` — bump it for ANY statement change, and for any change to which rows the indexer derives: an old file fits the statements, so only the version rebuilds it): `threads` (the per-thread cursor `last_seq`/`last_byte`, plus `open_turn_id`, `revert_seq` and `inflight` — the requested-but-unstarted turns and unclaimed prompts no `turns` row can hold, JSON), `turns` (ordinal + `[first_byte, end_byte)`), `items` (each activity's latest line), `message_docs` (each message's span and the keyed side of `messages_fts`), `markers` (the phase of each compaction marker of the conversation itself — `@orquester/api`'s `compaction.ts` rule, which the MCP calls too and the UI's window gates compose from the same parts: either spelling, never a subagent's own), and the two FTS5 tables (`unicode61 remove_diacritics 2`). |
| `indexer.ts` | Events → rows, one transaction per batch together with the cursor. Keeps a per-thread turn fold (`applyTurnEvent`, the fold's own reducer, so ordinals are `/revert`'s count) and byte ranges that **tile the log**: a turn starts at its prompt and does not stop at its settling `session-set` (the turn-end checkpoint lines are its); a `thread.reverted` seals every range and truncates everything from the first removed turn's first line. Text is indexed when a message finishes and on every activity write (summary/title/detail), capped at `MAX_INDEXED_TEXT_CHARS` (128 K). A batch that does not continue the cursor is dropped — only a catch-up fills a hole. Per-thread memory is an LRU of 16 threads (`MAX_RESIDENT_THREADS`) that never evicts one with a pending turn or a message mid-stream; a reload rebuilds turns from `turns` and the in-flight part from `threads.inflight`. |
| `queries.ts` | Turn lookups, the activity-paging primitives the host's `readHistory` plans with (`activitySeqBefore`, `itemPosition(BySeq)`, `eventPositionBySeq`, `messagesSpanning`, `turnOfSeq`, `turnsInSeqRange`, `hasItemsBefore`), `rewindable` (no `compacted` marker after the turn's first line) and `search` (`toFtsQuery` quotes every whitespace token — never raw FTS syntax; `bm25` over both tables, `«…»` snippets, `limit` ≤ 50). |
| `testing.ts` | Test scaffolding only: `TestLog` (an in-memory log with REAL byte positions, multi-byte text included, and the store's `mismatch` semantics) plus event builders. |

## Boot order (`main.ts`)

1. `snapshots.load()`, then every adapter acquired (one ingestion consumer each).
2. `host.reconcile()` — §3.3, lazily (A1): every thread's `meta.json` is read, only orphans are
   folded (then continued or settled); the rest wait in `bootSettlePending` for their first load.
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
   Until the open, that handle is unavailable: an `observe` is dropped (the catch-up reads the log
   instead) and a `deleteThread` is remembered and replayed.

`stop()` (an intentional `/stop` starts it only once its reply has flushed — `afterStopResponse`):
server close → every adapter's `stopAll()` → orchestrator stop → index `stop()` (after
the orchestrator, whose last commits still feed it: every queued observe is applied, a boot
catch-up in flight ends at its next check with its cursor left behind the log, then the file
closes — so indexing never holds a deploy's stop) → store close.

## Rules that apply to everything under this directory

- **No lazy dynamic `import()`** (§8). A host that survives a deploy runs old code until the
  drain-restart; loading changed source into it is a correctness bug, not a nicety.
- **Every step that waits on a child has a deadline** (§3.1), and an expired deadline kills the
  child rather than leaving the thread `starting` forever.
- **A running state never outlives its process** (§3.1/§4.1). Before `session.exited` the adapter
  settles the turn, closes every live task `stopped`, and fails every parked request.
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
  next `/turn`. `orchestrator.setIdentity` refuses unless the thread is idle, refuses OpenCode, and
  refuses any move across the cliproxy boundary.
- **`state.json` and `index.sqlite` are caches of `events.ndjson`, never authorities** (invariant
  1). Any doubt — another version, a seq or byte offset that does not line up, a file that does not
  parse — discards the cache and re-derives from the log, never the reverse. Bump
  `FOLD_SNAPSHOT_VERSION` (`@orquester/api`'s `fold-snapshot.ts`) whenever the fold's output changes
  for the same log, and `INDEX_SCHEMA_VERSION` for any change to the index's statements or to the
  rows the indexer derives into them (the compaction-marker rule moved it to 3). The index
  is fed strictly AFTER the append, so a crash leaves it behind the log, never ahead (invariant 4).
- **Nothing new blocks readiness, and the loop must breathe** (invariants 2 and 7). The reconcile
  folds orphans only; the index opens after the gate and catches up unawaited; a fold over a whole
  log yields to the loop every 500 events (`applyEventsChunked`; the store's sweep has its own
  `foldForward`), and the index's catch-up yields every `INDEX_CATCH_UP_CHUNK` (500) events — a
  multi-second stretch of synchronous work lets the daemon's 15 s health probe (5 s timeout) miss
  twice and restart a healthy host.
