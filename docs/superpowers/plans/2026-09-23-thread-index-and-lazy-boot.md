# Thread index and lazy boot — implementation plan

> **For agentic workers:** executed as parallel waves of subagents with **disjoint file
> ownership**. Every task lists the files it owns; touch nothing else. Interfaces below are the
> contract between tasks — implement them verbatim, do not "improve" a signature another task
> depends on. TDD per task (`superpowers:test-driven-development`): failing test → minimal code →
> green. `node:test` via tsx, tests under `src/`, nothing waits on a sleep.

**Spec:** `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` (read it first).

**Goal:** the agent host answers within ~1–2 s of spawn regardless of thread log size (A1 + A2),
and the client can page older history and search across threads through a disposable SQLite index
(C).

## Global constraints (AGENTS.md)

- ⛔ Never start/restart the daemon or the agent host in this checkout. Verify with typecheck and
  tests only.
- Commit nothing; the orchestrating session commits.
- No lazy dynamic `import()` under `apps/daemon/src/agent-host/`. The SQLite driver is resolved
  once at module load with `createRequire(import.meta.url)` inside try/catch.
- zod only in `packages/config`. Payloads read from disk are validated field-wise.
- Code highlighting/markdown rules, CSP, etc. are unaffected — no new client dependencies.
- Commands to run: `pnpm --filter @orquester/<pkg> typecheck`; one test file:
  `node --import tsx --test src/<file>.test.ts` from the package dir (from `packages/ui` add
  `--import ./test/svg-loader.mjs`).

## Shared contracts already in place (do not change)

- `packages/config/src/index.ts`: `agentChatThreadStatePath(baseDir, threadId)` →
  `threads/<id>/state.json`; `agentChatIndexPath(baseDir)` → `daemon/agent/index.sqlite`.
- `packages/api/src/agent-chat/wire.ts`: `agentChatRoutes.history(sessionId)`,
  `agentChatRoutes.search`, `ThreadHistoryQuery`, `THREAD_HISTORY_DEFAULT_TURNS` (20),
  `THREAD_HISTORY_MAX_TURNS` (100), `ThreadHistoryTurn`, `ThreadHistoryPage`,
  `ThreadSearchQuery`, `THREAD_SEARCH_MAX_RESULTS` (50), `THREAD_SEARCH_MAX_QUERY_CHARS` (200),
  `ThreadSearchHit`, `ThreadSearchResponse`, error code `INDEX_UNAVAILABLE` (503).
- `packages/api/src/agent-chat/thread.ts`: `ThreadSnapshotPayload.history?: ThreadHistoryBounds`
  and `ThreadHistoryBounds { indexed, hasOlder, beforeCursor, oldestRetainedOrdinal, totalTurns }`.
- `apps/daemon/src/agent-host/host-protocol.ts`: `agentHostRoutes.history(threadId)` =
  `/threads/:id/history`, `agentHostRoutes.search` = `/search`.

## Interfaces owned by Task B (store) — consumed by D and C

```ts
// apps/daemon/src/agent-host/services.ts (ThreadStore + AppendResult live THERE; store/index.ts implements)
export interface EventPosition { seq: number; byteOffset: number; byteLength: number }

export interface AppendResult {
  seq: number;
  events: DomainEvent[];
  /** positions[i] describes events[i]'s line in events.ndjson. */
  positions: EventPosition[];
  /** Byte length of events.ndjson right after this append. */
  logBytes: number;
}

export interface EventsFromResult {
  events: DomainEvent[];
  positions: EventPosition[];
  /** The log was cut at a malformed line (same meaning as ThreadTail.truncated). */
  truncated: boolean;
  /** Highest seq decoded. */
  seq: number;
  /** Byte length of the log consumed (offset just past the last decoded line). */
  logBytes: number;
  /**
   * True when the log at `byteOffset` does not start with seq `afterSeq + 1`
   * (or is shorter than `byteOffset`): the caller's cursor is stale and it must
   * re-read from byte 0. `events` is then empty.
   */
  mismatch: boolean;
}

interface ThreadStore {
  // existing: append/readTail/readAll/loadHead/saveHead/loadBinding/upsertSessionBinding/listThreads/deleteThread/…
  append(input): Promise<AppendResult>;                           // now returns positions + logBytes
  readEventsFrom(threadId: string, input: { byteOffset: number; afterSeq: number }): Promise<EventsFromResult>;
  /** Events whose lines lie in [fromByte, toByte). Both are line boundaries the index recorded. */
  readEventRange(threadId: string, input: { fromByte: number; toByte: number }): Promise<{ events: DomainEvent[]; truncated: boolean }>;
  /** entry.seq after ensureLoaded — meta.json + the log's last line, no fold. */
  lastSeq(threadId: string): Promise<number>;
  /** Current byte length of events.ndjson (0 when absent). */
  logLength(threadId: string): Promise<number>;
  /** Parsed and validated; null when missing/corrupt/other version/other thread. Never throws. */
  loadFoldSnapshot(threadId: string): Promise<FoldSnapshotFile | null>;
  /** Atomic (tmp + rename), 0600, on the thread's write queue. */
  saveFoldSnapshot(input: { threadId: string; seq: number; logBytes: number; state: ThreadFoldState; extras?: Record<string, unknown> }): Promise<void>;
}
```

`readAll` keeps its shape. `positions` are computed from the encoded line lengths
(`Buffer.byteLength(line, "utf8")`) and the file length before the append (tracked on the entry
after `ensureLoaded` via `stat`, then advanced per append — never re-`stat` per event).
`readEventsFrom` opens the file, reads from `byteOffset` to the end, splits complete lines
(`splitCompleteLines`), decodes, and checks the first decoded seq. The fake store
(`orchestration/testing/fakes.ts`) gains the same methods over its in-memory log (positions =
synthetic monotonically increasing offsets, e.g. line index × 1 000).

## Interfaces owned by Task A (api) — consumed by B, C, D, F

```ts
// packages/api/src/agent-chat/fold-snapshot.ts
export const FOLD_SNAPSHOT_VERSION = 1;
export interface SerializedFoldState { /* JSON-safe mirror of ThreadFoldState without itemIndex; Sets/Maps as arrays */ }
export interface FoldSnapshotFile { version: number; threadId: string; seq: number; logBytes: number; writtenAt: string; state: SerializedFoldState; extras?: Record<string, unknown> }
export function serializeFoldState(state: ThreadFoldState): SerializedFoldState;
/** Field-wise validation; null when the shape is not a fold state. Rebuilds itemIndex from items. */
export function deserializeFoldState(value: unknown): ThreadFoldState | null;
/** Validates the whole file; null unless version === FOLD_SNAPSHOT_VERSION and threadId matches. */
export function parseFoldSnapshotFile(value: unknown, threadId: string): FoldSnapshotFile | null;

// packages/api/src/agent-chat/history-cursor.ts
export interface HistoryCursor { threadId: string; beforeAnchorAt: string; beforeTurnId: string }
export function encodeHistoryCursor(cursor: HistoryCursor): string;   // base64url(JSON {t,a,i})
export function decodeHistoryCursor(encoded: string, threadId: string): HistoryCursor | null; // null: malformed or foreign thread

// packages/api/src/agent-chat/fold.ts (extraction, no behaviour change)
/** The turn-only reducer: exactly the turn mutations foldThread applies for `event`. */
export function applyTurnEvent(turns: readonly Turn[], event: DomainEvent): Turn[];
// Pinned by a test: for any event list, foldThread(events).turns deep-equals events.reduce(applyTurnEvent, []).
```

## Interfaces owned by Task C (index) — consumed by D

```ts
// apps/daemon/src/agent-host/index/index.ts (module barrel)
export interface ThreadIndexOptions {
  filePath: string;                       // agentChatIndexPath(appdir)
  logger: AdapterLogger;                  // agent-host/adapter.ts logger shape
  clock?: Clock;                          // runtime-seams
  /** Test seam: inject the driver constructor; default resolves better-sqlite3 via createRequire. */
  driver?: SqliteDriver | null;
}
export interface IndexedThreadMeta { threadId: string; projectPath: string; title: string }
export interface IndexedTurn {
  turnId: string; ordinal: number; userMessageId: string | null;
  requestedAt: string; startedAt: string | null; completedAt: string | null;
  firstSeq: number; lastSeq: number; firstByte: number; endByte: number;
}
export interface ThreadIndex {
  /** False when the driver could not be loaded or the file could not be opened/rebuilt. */
  readonly available: boolean;
  /**
   * Feed appended events (with the positions the store returned). Never throws,
   * never blocks the caller: applied in order per thread on an internal queue.
   * Events with seq <= the thread's cursor are ignored (idempotent).
   */
  observe(input: IndexedThreadMeta & { events: readonly DomainEvent[]; positions: readonly EventPosition[] }): void;
  /** Wait for every queued observe to be applied (tests, shutdown). */
  drain(): Promise<void>;
  /**
   * Bring one thread's rows up to the log. `read` is the store's readEventsFrom bound to the
   * thread; on `mismatch` the thread is re-indexed from byte 0 (rows deleted first).
   * Chunked with setImmediate yields every 500 events.
   */
  catchUp(input: IndexedThreadMeta & { logSeq: number; read: (cursor: { byteOffset: number; afterSeq: number }) => Promise<EventsFromResult> }): Promise<void>;
  deleteThread(threadId: string): void;
  cursor(threadId: string): { lastSeq: number; lastByte: number } | null;
  /** Ordinal of the oldest started turn ≥ … helpers for the host: */
  turnByOrdinal(threadId: string, ordinal: number): IndexedTurn | null;
  turnById(threadId: string, turnId: string): IndexedTurn | null;
  totalTurns(threadId: string): number;
  /** The `n` turns strictly older than the cursor (or than `beforeTurn` when the cursor is null), oldest first. */
  turnsBefore(threadId: string, input: { before: HistoryCursor | null; beforeTurn?: IndexedTurn | null; limit: number }): IndexedTurn[];
  /** True when no context-compaction marker has seq > turn.lastSeq. */
  rewindable(threadId: string, turn: IndexedTurn): boolean;
  search(input: { q: string; limit: number; projectPath?: string }): ThreadSearchHit[];
  close(): void;
}
export function createThreadIndex(options: ThreadIndexOptions): ThreadIndex;
/** Test seam type: the subset of better-sqlite3's Database the module uses. */
export interface SqliteDriver { open(filePath: string): SqliteDatabase }
```

Turn rows are derived with `applyTurnEvent` (Task A) over the thread's events; `ordinal` = 1-based
position among turns with a non-null `turnId` (`startedTurns` order). `first_seq`/`first_byte` =
the `thread.turn-start-requested` (or the `session-set` that created the turn) position;
`last_seq`/`end_byte` advance with every event while the turn is the thread's latest started turn
and freeze at its settling `session-set`. Message text: accumulate `payload.text` of
`thread.message-sent` per `messageId` while `streaming === true`; insert into `messages_fts` when
`streaming === false` (text = accumulated + this row's text; skip `role === "reasoning"`? — index
reasoning too, with its role). Activities: every `thread.activity-appended` upserts `items` (last
write wins) and inserts/replaces its `activities_fts` row (text = `summary` + `detail`/`title` if
present); `activityKind === "context-compaction"` also inserts a `markers` row.
`thread.reverted {turnCount}` → delete `turns` with `ordinal > turnCount`, and `messages_fts`,
`activities_fts`, `items`, `markers` rows with `seq >= first_seq` of the first removed turn.
`thread.deleted` → `deleteThread`. Query text is split on whitespace, each token wrapped in
double quotes with inner quotes doubled, joined with a space (implicit AND) — never raw.

## Tasks

### Task A — api contracts (owner: agent "api")
**Files:** `packages/api/src/agent-chat/fold-snapshot.ts` (+ `.test.ts`),
`packages/api/src/agent-chat/history-cursor.ts` (+ `.test.ts`),
`packages/api/src/agent-chat/fold.ts` (only the `applyTurnEvent` extraction + its test in
`fold.test.ts` or a new `turn-fold.test.ts`), `packages/api/src/agent-chat/index.ts` (exports).
**Tests:** round-trip of a state built from `test-helpers.ts` events (items, activities, turns,
checkpoints, pending, roster, closed sets/maps) — deserialize(serialize(s)) deep-equals s
(itemIndex rebuilt); fold from snapshot + tail equals fold from scratch; `parseFoldSnapshotFile`
rejects other version/other thread/malformed; cursor encode/decode/malformed/foreign;
`applyTurnEvent` parity with `foldThread` across: turn-start-requested, session-set adopt/settle,
message-sent assistant stamp, turn-diff-completed, reverted.

### Task B — store (owner: agent "store")
**Files:** `apps/daemon/src/agent-host/services.ts` (the `ThreadStore`/`AppendResult` interface
additions — Task B is the ONLY owner of services.ts), `apps/daemon/src/agent-host/store/index.ts`,
`apps/daemon/src/agent-host/store/files.ts` (if a helper is needed),
`apps/daemon/src/agent-host/store/store.test.ts` (extend),
`apps/daemon/src/agent-host/orchestration/testing/fakes.ts` (fake store parity — add the new
methods to `createFakeThreadStore`; do not touch anything else in that file).
**Tests:** positions match real byte offsets (multi-byte UTF-8 in payloads!); `readEventsFrom`
happy path, mismatch (offset past a rewritten log; first seq ≠ afterSeq+1), truncated tail;
`readEventRange` exact slice; `lastSeq`/`logLength` without folding; snapshot save/load, corrupt
file → null, other version → null; `deleteThread` removes state.json.

### Task C — index (owner: agent "index")
**Files:** `apps/daemon/src/agent-host/index/{index.ts,sqlite.ts,schema.ts,indexer.ts,queries.ts}`
(+ `*.test.ts`), `apps/daemon/package.json` (add `better-sqlite3@^12` + `@types/better-sqlite3`),
root `package.json` `pnpm.onlyBuiltDependencies` (+ `better-sqlite3`), `apps/desktop/package.json`
(dependency) and `apps/desktop/scripts/build-main.ts` (`external`). Run `pnpm install` at the repo
root after editing manifests (network is available). `pnpm-lock.yaml` changes are expected.
**Tests** (real driver, temp dir): bootstrap + version mismatch → file replaced; observe → turns
with correct ordinals/byte ranges; streamed message text assembled; catch-up from cursor; mismatch
→ re-index from 0; revert truncation; `turnsBefore` paging with cursor and with `beforeTurn`;
`rewindable`; search escaping (`"`, `*`, `NEAR`, unicode), limit, projectPath filter; driver
missing → `available === false`, all methods inert.

### Task D — orchestrator + host wiring (owner: agent "host")
**Files:** `apps/daemon/src/agent-host/orchestration/orchestrator.ts`,
`apps/daemon/src/agent-host/orchestration/fold-ops.ts`, `apps/daemon/src/agent-host/main.ts`,
`apps/daemon/src/agent-host/server/http-server.ts` (the index reaches the orchestrator through a
new `createOrchestrator` option `index?: ThreadIndex` declared in orchestrator.ts — do NOT edit
services.ts, Task B owns it), tests: `orchestration/reconcile.test.ts`,
`orchestration/orchestrator.test.ts`, `server/http-server.test.ts`,
`orchestration/testing/harness.ts` (inject a fake index / driver-less index).
**Work:**
1. Lazy reconcile per spec A1 (`bootSettlePending`; settle on first `buildRuntime`).
2. `buildRuntime` per spec A2: snapshot load, tail read, chunked fold (`applyEventsChunked` in
   `fold-ops.ts`, 500 events per `setImmediate` yield), `extras` carry `revertedTo`/`titleManual`
   (derive incrementally from the tail: a `thread.reverted` in the tail sets `revertedTo`, a later
   `turn.started`/turn start clears it as `revertGuardFromLog` does; `titleManual ||= tail has a
   commanded thread.meta-updated with title`).
3. `commit`: snapshot cadence (`FOLD_SNAPSHOT_EVENT_INTERVAL = 200`, plus on `HEAD_WRITING_EVENTS`),
   fire-and-forget with logged failure; `index.observe(...)` with the store's positions and the
   thread's `projectPath`/`title` from the head.
4. Boot: after `host.openGate()` in `main.ts`, `void index catch-up for every store.listThreads()`
   (sequential, never awaited by readiness), and on `deleteThread` → `index.deleteThread`.
5. `readThread` snapshot: `history` bounds (`indexed`, `hasOlder`, `beforeCursor` of the oldest
   retained turn, `oldestRetainedOrdinal`, `totalTurns`).
6. `readHistory(threadId, query)` per spec (page turns → byte range → `readEventRange` →
   `foldThread` → slimmed items + checkpoints; turns from the index with `rewindable`); route
   `GET /threads/:id/history` (clamp `turns`, decode cursor, 503 `INDEX_UNAVAILABLE`), route
   `GET /search` (clamp, 503 when unavailable) in `http-server.ts`.
**Tests:** boot folds only orphaned threads (count fake-store reads); stale pending turn settled on
first load; snapshot happy path and mismatch fallback (fake store snapshot methods); history page
equals slice fold; bounds; routes and clamps; unavailable index → 503 and `history.indexed=false`.

### Task E — daemon proxy (owner: agent "proxy")
**Files:** `apps/daemon/src/agent-chat/proxy-routes.ts` (+ `proxy-routes.test.ts`).
**Work:** `GET /api/sessions/:id/history` → forward GET with `before`/`turns` to
`agentHostRoutes.history(id)` (404 when not a chat tab, 503 when host unhealthy, envelope passthrough
incl. `INDEX_UNAVAILABLE` → 503 in `statusForChatError`); `GET /api/agent/search` → forward
`q`/`limit`/`projectPath` to `agentHostRoutes.search`.

### Task F — client (owner: agent "ui")
**Files:** `packages/ui/src/lib/agent-chat/transport.ts` (+ test), `contracts.ts` (actions +
slice fields), `store.ts` (+ a new `store.history.test.ts`), new `history.logic.ts` (+ test: page
merge/dedupe/reset, reveal-turn planning), `rows.logic.ts`/`entries.logic.ts` only if needed for
page rows, `packages/ui/src/components/agent-chat/timeline/ChatTimeline.tsx` (+ a "load older"
row component under `timeline/rows/`), `packages/ui/src/components/agent-chat/AgentChatView.tsx`
(wire props), `packages/ui/src/components/command-palette/CommandPalette.tsx` (search mode),
`packages/ui/src/lib/api-client.ts` (if a method is needed).
**Work:** per spec "Client". Keep the layer-2 fast path intact: page rows are projected once per
page and cached by page identity; live rows are untouched. Scroll anchoring on prepend. Search
mode: `?` prefix or a toggle chip; debounce 250 ms; results list; Enter opens the tab and reveals
the turn; `indexed:false` shows "Search is unavailable on this host". Rewind on page rows:
`targetTurnCount = ordinal - 1`, withheld when `rewindable === false`.
**Tests:** logic-file tests for merge/dedupe/reset/reveal; transport request shapes; store action
behaviour with a fake transport; `*.check.ts` render checks where the repo already uses them.

### Task G — docs (wave 2, owner: agent "docs")
`AGENTS.md` (appdir layout: `state.json`, `index.sqlite`; two new gotchas: "the index is a cache,
never an authority" and "boot folds only orphaned threads"; native dep note beside node-pty),
`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` (`*Built:*` notes in §3.3 reconcile,
§5.1 store layout, §6.3 reads), `apps/daemon/src/agent-host/README.md` (module map: `index/`,
`fold-snapshot`).

## Waves

1. A, B, C, D, E, F in parallel (D codes against B/C interfaces above; integration fixes follow).
2. Integration: `pnpm check`; fix seams; G docs.
3. Reviewers per task in parallel (spec compliance + code quality), fix wave, then full
   verification: `pnpm check`, `pnpm test`, `pnpm build`.
