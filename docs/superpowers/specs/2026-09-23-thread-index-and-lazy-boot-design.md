# Thread index and lazy boot — design

*Companion to `2026-09-21-agent-chat-gui-design.md` (§3.1, §3.3, §5.1, §5.6, §6.3). This
document is authoritative for the two features it describes; the main spec's sections it touches
carry a `*Built: …*` note pointing here.*

## Problem

The agent host rebuilds every thread's state at boot by reading and folding its whole
`events.ndjson`, and it serves a thread only after that reconcile has finished. Measured on the
owner's VPS on 2026-09-23 with 78 MB of logs across eight threads: 16 s of folding (9 s for one
48 MB thread), an 18 s "connecting" window on every host replacement, growing super-linearly with
thread size. Separately, the client can only ever show the fold's retained window (500 activities,
2 000 messages) — everything older is in the log but unreachable from the UI, and there is no way
to search across conversations.

T3 Code (MIT) has neither problem because its event log lives in SQLite next to **persisted
projections** updated in the same transaction (`projection_*` tables, `projection_state` cursors),
its boot resumes projectors from their cursor ("never a full replay"), and its thread detail reads
are **windowed** by turns with a content-derived cursor
(`apps/server/src/orchestration/threadDetailCursor.ts`, `ProjectionSnapshotQuery.ts`,
`packages/client-runtime/src/state/threads.ts:49-50` — 10 user turns first, 20 per older page).

Orquester keeps "JSON, not a database" for the durable record. This design takes the three ideas
and keeps the files:

- **A1 — lazy reconcile.** Boot decides "orphaned or not" from the head alone and folds only
  orphaned threads. Idle threads fold on first use.
- **A2 — fold snapshot.** `state.json` beside `meta.json`: the folded state as of one `seq`,
  rewritten every N events, so a cold load folds only the log's tail. A cache, never an authority.
- **C — thread index.** One host-wide SQLite file of *derived* tables (turn boundaries with byte
  ranges, activity positions, full text) maintained from the same events after they land in the
  log, with a per-thread cursor for catch-up. Disposable and rebuildable, so it is outside the
  rollback boundary. It serves paged history (`GET …/history`) and cross-thread search
  (`GET /api/agent/search`).

## Invariants

1. **`events.ndjson` stays the only authority.** The snapshot and the index are caches. Any
   mismatch (version, seq, byte offset, corruption) is resolved by discarding the cache and
   re-deriving from the log — never the reverse.
2. **Nothing new blocks readiness.** The gate opens after a head-only reconcile. Index catch-up and
   rebuild run after the gate, chunked, lowest priority.
3. **A folded state is bounded by retention** (`fold.ts` limits), so `state.json` is bounded
   regardless of log size — but the bound is tens of MB for a subagent-heavy thread (measured:
   22 MiB for the 48 MB thread, 89 % of it the 2 000 agent-owned activity rows; ~160 ms to
   serialize, ~75 ms to parse), which is why the write cadence below is time-gated, never
   per-event. The index grows with the log, on disk, not in memory.
4. **The index is written strictly after the log.** A crash leaves the index behind, never ahead.
   Catch-up compares the index cursor with the log's last seq (already read cheaply at load) and
   consumes only the missing tail; a tail whose first line does not carry `cursor.seq + 1` means
   the log was rewritten → that thread is re-indexed from byte 0.
5. **No lazy dynamic `import()` under `agent-host/`** (AGENTS.md). The SQLite driver is resolved
   once at module load through `createRequire` inside a try/catch; a host without the native
   binding runs with `index.available === false`: history answers 503 `INDEX_UNAVAILABLE`, search
   answers `indexed: false`. Nothing else changes.
6. **Ordinals are by ORDER of started turns** (`startedTurns`, §5.5 rewind rule) — the same count
   `/revert` takes. `thread.reverted {turnCount}` deletes indexed turns with `ordinal > turnCount`
   and their text rows.
7. **The host's event loop must breathe.** A cold fold of a big thread yields to the loop every
   500 events (`setImmediate`), so the 15 s health probe (5 s timeout) cannot miss twice during a
   load and kill a healthy host.
8. **Search text is as sensitive as `raw.ndjson`.** `index.sqlite` is 0600 under the appdir and is
   never served as a file.

## A1 — lazy reconcile (host, `orchestration/orchestrator.ts`)

`reconcile()` lists thread dirs and, for each thread the host does not see running:

1. `head = store.loadHead(id)` — `meta.json` alone, milliseconds. `binding.json` is not read
   here: the resume cursor is needed only by the orphan path, whose `loadRuntime` reads it.
2. `orphaned = status ∈ {starting, running} || activeTurnId !== null || (status === "ready" &&
   continueAfterRestart.prepared === true)` — the same predicate as today, read off the head.
3. Not orphaned → remember the id in `bootSettlePending` and return. **No fold.**
4. Orphaned → `loadRuntime(id)` (full build, see A2) and the existing continuation logic,
   unchanged.

`settleStalePendingTurns` (the §3.4 grace-window settle that today runs at boot for every idle
thread) runs instead on the thread's **first load** after boot: `loadRuntime` → `buildRuntime` →
if `bootSettlePending.delete(id)` → settle. Every read and command goes through `loadRuntime`, so
the first thing anyone can see of the thread is already settled, and the daemon's summary poll
(which loads open tabs within 1.5 s of readiness, in parallel, after the gate) triggers it for
open tabs without blocking readiness.

## A2 — fold snapshot (`store/index.ts`, `packages/api/src/agent-chat/fold-snapshot.ts`)

File: `agentChatThreadStatePath(appdir, id)` = `threads/<id>/state.json`, atomic rename, 0600.

```ts
interface FoldSnapshotFile {
  version: number;          // FOLD_SNAPSHOT_VERSION (1)
  threadId: string;
  seq: number;              // state.seq at write time
  logBytes: number;         // byte length of events.ndjson right after the last folded event
  writtenAt: string;
  state: SerializedFoldState;
  extras?: Record<string, unknown>;   // orchestrator-owned derivations (revertedTo, titleManual)
}
```

`serializeFoldState` drops `itemIndex` (rebuilt on load from `items`) and turns `Set`/`Map` fields
into arrays; `deserializeFoldState` is its inverse and validates shape field-wise (never trust
the file). Round-trip and "fold from snapshot + tail ≡ fold from scratch" are tested.

Write cadence: the orchestrator's `commit` writes a snapshot (fire-and-forget on the store's
per-thread queue) on every **session transition** (turn settle, session stop — the
`HEAD_WRITING_EVENTS`), so a restart right after a long turn finds a fresh one; and, inside a long
turn, when at least `FOLD_SNAPSHOT_EVENT_INTERVAL` (200) events **and** at least
`FOLD_SNAPSHOT_MIN_INTERVAL_MS` (30 s) have passed since the last write. Serializing a big state
blocks the host's loop for ~160 ms, so the time gate is what keeps a busy subagent turn (hundreds
of events a minute) from turning into a disk-churning, loop-stalling loop. `serializeFoldState`
drops `itemIndex` **and** `activities` (both rebuilt from `items` on load: the fold relies on
`activities` holding the very same objects as `items`, so a copy would break in-place updates
and retention).

Load (`buildRuntime`): `snapshot = store.loadFoldSnapshot(id)` (null when missing, corrupt,
another version or another thread id). If present:
`tail = store.readEventsFrom(id, { byteOffset: snapshot.logBytes, afterSeq: snapshot.seq })`; a
`mismatch` (first line's seq ≠ `afterSeq + 1`, or the file is shorter) discards the snapshot and
reads from byte 0. State = deserialized snapshot folded forward through the tail in chunks of 500
events with a `setImmediate` yield between chunks. `revertedTo` and `titleManual` are carried in
`extras` and advanced from the tail.

Rollback: an older host does not know `state.json` and folds the log as before; a newer host
discards an older `version`. `deleteThread` removes the directory, snapshot included.
**`FOLD_SNAPSHOT_VERSION` must be bumped whenever the fold's output changes for the same log** —
otherwise an old snapshot keeps the old result for every event before its `seq` while the tail
folds with the new rules, and the two never reconcile until the thread is deleted.

`applyTurnEvent` (the turn-only reducer the index uses) deliberately has no access to the rest
of the fold state, so it differs from `foldThread(...).turns` in four arms that read state outside
`turns` (a turn start that names no model takes the head's model; a streamed message stamps the
turn's anchor using the row it merges into; a `missing` checkpoint placeholder over a `ready` one;
a revert on a legacy log with no started turns). Every field the index reads — ids, order,
prompts, timestamps, state — matches after every event on the owner's real logs; `model` is the
only observed difference, and the index does not store it.

## C — thread index (`agent-host/index/`)

Driver: `better-sqlite3@^12` (Node 20/22 prebuilt binaries; FTS5 built in), a native addon
handled exactly like `node-pty` (root `pnpm.onlyBuiltDependencies`, desktop `external` +
dependency). File: `agentChatIndexPath(appdir)` = `daemon/agent/index.sqlite`, WAL, 0600.

Schema (all derived; `meta.schema_version` = 2, `INDEX_SCHEMA_VERSION` — bumped for ANY statement
change; any mismatch or `PRAGMA quick_check` failure → delete `index.sqlite`, `-wal`, `-shm`,
recreate, rebuild in the background):

```
meta(key TEXT PRIMARY KEY, value TEXT)
threads(thread_id TEXT PRIMARY KEY, project_path TEXT, title TEXT, last_seq INTEGER, last_byte INTEGER, updated_at TEXT,
        open_turn_id TEXT, revert_seq INTEGER, inflight TEXT)
turns(thread_id TEXT, turn_id TEXT, ordinal INTEGER, user_message_id TEXT, requested_at TEXT,
      started_at TEXT, completed_at TEXT, first_seq INTEGER, last_seq INTEGER,
      first_byte INTEGER, end_byte INTEGER, PRIMARY KEY(thread_id, turn_id))
      INDEX (thread_id, ordinal)
items(thread_id TEXT, item_id TEXT, seq INTEGER, byte_offset INTEGER, byte_length INTEGER, PRIMARY KEY(thread_id, item_id))
message_docs(thread_id TEXT, message_id TEXT, seq INTEGER, first_seq INTEGER, first_byte INTEGER,
             first_length INTEGER, PRIMARY KEY(thread_id, message_id))   -- keyed side of messages_fts + span
markers(thread_id TEXT, seq INTEGER, kind TEXT, PRIMARY KEY(thread_id, seq))          -- context-compaction rows
messages_fts   FTS5(text, thread_id UNINDEXED, message_id UNINDEXED, turn_id UNINDEXED, role UNINDEXED, seq UNINDEXED, at UNINDEXED)
activities_fts FTS5(text, thread_id UNINDEXED, activity_id UNINDEXED, turn_id UNINDEXED, kind UNINDEXED, seq UNINDEXED, at UNINDEXED)
```

*Built:* three columns and a table beyond the list above, all in `schema.ts`'s header.
`threads.open_turn_id` names the started turn whose range still grows, and `threads.revert_seq`
the latest `thread.reverted`, which seals every range that began before it. `threads.inflight`
holds what a thread has in flight that no `turns` row can (`turn_id` is NOT NULL, and a turn has no
id until the provider starts it): the requested-but-unstarted turns with their prompt-anchored
ranges and their place among the started turns (`startedBefore` — a resumed thread's first message
is requested before the provider's history is replayed, so its turn precedes the replayed ones in
the fold's order, and a reload that appended it last would shift every ordinal `/revert` counts),
and the prompts no turn has claimed yet, as JSON rewritten with the cursor in every batch. Anything
in it that does not read back field by field is dropped whole.
Without it, a restart (or a driver error, which drops the thread's memory) between a prompt and its
turn's start re-anchored the turn at the adopting `session-set`, so the turn lost its
`userMessageId` and the previous turn's range swallowed the prompt line. `message_docs` is the keyed
side of `messages_fts` (an FTS5 table has no index on its UNINDEXED columns) and every message's
span, which history paging uses so a page never cuts a streamed message in two. The per-thread
memory is an LRU of 16 threads that never evicts one with a pending turn or a message mid-stream.
Known gap of a disposable cache: text a message streamed before its thread's memory was lost is
missing from that message's search row; its span is intact.

*Built (schema 3):* `markers` holds one row per compaction marker of the conversation itself, by
the rule in `packages/api/src/agent-chat/compaction.ts` (`isConversationCompactionActivity`, and
`isSettledConversationCompaction` for the settled one): a `context-compaction` row or the legacy
`thread.state.changed {state: "compacted"}` an older log recorded, and never one a subagent owns
(a non-blank `agentId` on the row or on its payload — a subagent compacting its own context leaves
the parent's untouched). The MCP's `revert_session` calls the same rule; the UI's window gates
(`rows.logic.ts` `isCompactedMarkerEntry`, `history.logic.ts` `hasSettledCompaction`) compose it
from the same parts (`isCompactionActivity`, `compactionMarkerState`) over the parent timeline,
whose filter also drops `timelineBypass` rows, and must follow any change to it. Its `kind` is
`compactionMarkerState`'s phase, so `rewindable` (a
`compacted` row after the turn's prompt) reads the same markers the window's gate stops at. The first
build indexed every `context-compaction` row, a subagent's own included, and never the legacy
spelling. No statement changed, but `INDEX_SCHEMA_VERSION` went 2 → 3: a version-2 file fits every
statement, so the version is the only thing that keeps its rows from being trusted. It is deleted
and rebuilt from the logs by the ordinary version-mismatch path — the version is bumped for a
change to what the indexer derives as much as for a statement change.

Maintenance. The orchestrator's `commit` hands every appended event, with the byte position the
store returns for it, to `index.observe(...)`. The indexer keeps, per thread, a tiny **turn fold**
(`applyTurnEvent` exported from `fold.ts` — the existing turn reducer, unchanged in behaviour) to
derive turn rows and ordinals, and accumulates streamed message text per message id until
`streaming: false`. Text rows are inserted at message end and on every activity row (last write
wins, like `readItem`). Everything is applied per thread in order inside one transaction per
batch; failures are logged and never fail a command.

Catch-up. After `openGate()`, for every thread dir: if `threads.last_seq` < the log's last seq, read
`readEventsFrom(last_byte, last_seq)` and index the tail; on `mismatch` re-index from 0. One thread
at a time, chunked with yields. A thread missing from the index is indexed from 0. Deletion of a
thread deletes its rows; `thread.reverted {turnCount}` deletes turns with `ordinal > turnCount`,
their `messages_fts`/`activities_fts` rows (`seq >= first_seq` of the first removed turn) and
`items` rows in that range.

Stop. `ThreadIndex.stop()` is the host's shutdown step, after the orchestrator's: it applies every
observe already queued (the orchestrator's last commits), ends a catch-up in flight at its next
check, leaving its cursor behind the log for the next boot's catch-up, and then closes the file. So
a deploy's stop never waits for one big thread's catch-up (the supervisor bounds the host's exit at
30 s).

History page (`GET /threads/:id/history?before&turns`, host; proxied as
`GET /api/sessions/:id/history`). **Pages are blocks of the log, walked backwards by activity
count; turns are information about the block, not its unit.** The reason is the owner's actual
usage: one user turn that fans out a subagent fleet runs to thousands of events, larger than the
fold's 500-activity retention window, so a "page = N turns" model would hand back exactly the rows
the window already shows and never the fleet's early work. Cursors therefore carry an optional
in-turn sequence bound (`beforeSeq`, `history-cursor.ts`).

1. Load the runtime. `A` = the oldest activity in `state.activities` the index knows the position
   of (`index.itemPosition(threadId, A.id)`); if there is none (a tiny thread, or the index has
   not caught up) → `history = { indexed, hasOlder: false, … }`.
2. `hasOlder = index.hasItemsBefore(threadId, A.seq)` — any indexed activity older than the
   window's oldest one. `beforeCursor = { t, a: turnOf(A).requestedAt, i: turnOf(A).turnId,
   s: A.seq }`; `oldestRetainedOrdinal` = `turnOf(A)`'s ordinal (informational);
   `totalTurns` from the index.
3. A page request resolves its END: `endSeq = cursor.beforeSeq ?? turnById(cursor.i).firstSeq`
   (a malformed or foreign cursor degrades to the first page — the snapshot's cursor). Its START:
   `startSeq = index.activitySeqBefore(threadId, { beforeSeq: endSeq, count:
   HISTORY_PAGE_ACTIVITIES (400) })` — the seq of the activity 400 activities back, or the oldest
   indexed activity when fewer remain. The `turns` query parameter is a soft cap: the page never
   starts earlier than the first activity of the `turns`-th started turn back from the end
   (`turnsBefore`), and always covers at least one activity.
4. Bytes: `fromByte = itemPositionBySeq(startSeq).byteOffset`, `toByte =
   itemPositionBySeq(endSeq).byteOffset` when the end is an in-turn bound (the boundary activity's
   own line is excluded — it began the previous page), or the turn's `firstByte` when the end is a
   turn start. Pages are contiguous: every boundary is an activity's line start, so nothing is
   skipped and only boundary rows can repeat. `readEventRange` → `foldThread` over the slice →
   `items` (snapshot-time slimming as `snapshotOf`) and `checkpoints`. 400 activities never trip
   retention, so a page's fold is lossless. *Built: retention is batched since the fold-performance
   change (`2026-09-23-fold-performance-design.md`) — a class trims only past its limit plus a slack
   — and its gate is unchanged (no activity trim while the fold holds ≤ 500 activities), so this
   still holds. `windowBoundary` now considers the activity classes only once `state.evicted` says
   the fold dropped one, and its positional windows are conservative under batching: the first
   page may repeat up to a slack's worth of the window's oldest rows, which the client renders
   once.*
5. `turns` in the response = the index's turns whose `[firstSeq, lastSeq]` intersects
   `[startSeq, endSeq)` (`turnsInSeqRange`), mapped to `ThreadHistoryTurn` with `rewindable`; a
   turn may therefore appear on two consecutive pages — the client dedupes turn rows by id.
6. `page.beforeCursor` = `{ t, a: turnOf(startSeq).requestedAt, i: turnOf(startSeq).turnId, s:
   startSeq }`, or null when nothing indexed precedes `startSeq`.

Cursors are `base64url(JSON {t, a, i, s?})` = thread id, anchor `requested_at`, turn id, optional
sequence bound — derived from content, never from row ids, so they survive a rebuild and a revert
(T3's rule). A malformed or foreign-thread cursor degrades to a first-page request.

Search (`GET /search?q&limit&projectPath`, host; proxied as `GET /api/agent/search`): FTS5 `MATCH`
over both text tables, ranked by `bm25`, `limit` clamped to 50, `q` clamped to 200 chars and
quoted as a phrase per whitespace token (never passed raw to the FTS parser), snippet via
`snippet()` with `«`/`»` marks, joined with `threads` for project and title and with `turns` for
the ordinal. Only threads with a tab exist on disk, so the corpus is every open chat on the host.

Unavailable index: `observe` is a no-op; `GET …/history` answers 503 `INDEX_UNAVAILABLE`;
`GET /search` answers 200 `{ query, hits: [], truncated: false, indexed: false }` (the client renders
"Search is unavailable on this host" off `indexed`, and the daemon answers the same shape when an
older host has no `/search` route at all during a rollout); the snapshot's `history` is
`{ indexed: false, hasOlder: false, … }`. A search that matches nothing is a 200 with empty `hits`,
never a 404.

## Client (`packages/ui`)

- `AgentChatTransport.readHistory(sessionId, query)` and `.search(query)`.
- Thread store: `history: { bounds, pages, loading, error }`; `loadOlderHistory()` fetches the
  next page and prepends it; a `snapshot` frame (resync, host restart) resets the pages, because
  they are a cache of a log that may have been reverted.
- Timeline: a "Load older turns" row above the first row while `hasOlder`; page items are
  projected with the same row logic as the window — over the CONCATENATION of every loaded page,
  memoised by the pages array's identity, never page by page, because a page boundary can fall
  inside a turn and per-page projection would open that turn's group twice — deduplicated by item
  id against the window, and the viewport is kept stable across a prepend (scroll anchoring).
- Rewind on a history row: `targetTurnCount = ordinal − 1`, withheld when `rewindable === false`
  or the thread is not idle — the same gates as inside the window.
- Command palette: a "Search conversations" mode (query prefixed with `?`, or the mode toggle)
  with a 250 ms debounce; a hit opens the tab (`activateTab`) and reveals the turn: scroll to it if
  present, otherwise load older pages until it is (bounded at 25 pages).

## Testing

Every unit under `src/` with `node:test`; nothing waits on a sleep. Store: positions, ranged
reads, mismatch detection, snapshot round-trip. Index: real `better-sqlite3` in a temp dir —
schema bootstrap, observe/catch-up/rebuild, revert truncation, paging cursors, search escaping,
unavailable mode. Orchestrator: boot folds only orphaned threads (spy on reads), stale pending
turn settled on first load, snapshot load with a good and a mismatched tail, history page equals
the same slice folded from scratch. HTTP: routes, clamps, 503 when unavailable. Proxy: forwarding
and 503. UI: transport, store paging/dedupe/reset, rows with history pages, palette search mode.
Gate: `pnpm check`, `pnpm test`, `pnpm build`.

## Out of scope

Paging the live window itself (the first paint still carries the retained window); usage
analytics over the index; a migration of the raw provider logs. All three fit later on the same
index.
