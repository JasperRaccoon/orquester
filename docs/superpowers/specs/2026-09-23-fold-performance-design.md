# Fold performance: batch retention, incremental caches, and the history bridge

Status: approved by the owner 2026-09-23 ("hagamos ambas cosas", plus the A+C client fix).
Companion to `2026-09-23-thread-index-and-lazy-boot-design.md`. The fold is shared by the host
and the browser (`packages/api/src/agent-chat/fold.ts`), so everything here runs on both sides.

## Why

Measured on the owner's VPS with copies of real thread logs (2026-09-23):

| Log | Events | Read + parse | Fold (`applyDomainEvent` over the log) |
|---|---|---|---|
| 55 MB subagent-fleet thread | 29 191 | 0.9 s | 54 s |
| 69 MB thread | | | 29 s |
| 28 MB thread | | | 8.6 s |

The SQLite index processes the same 55 MB log in 1.8 s. The fold costs ~1.8 ms per event because
per event it does work proportional to the whole retained window (~5 000 rows). CPU profile of the
55 MB fold, inclusive: `applyRetention` 42 % (`activitiesToDrop` rescans and groups every activity
and sorts the agent rows with `localeCompare`; when anything is dropped, both lists are filtered and
`indexItems` rebuilds the id→position map), `reduceActivityAppended` 20 % self (`new Map(itemIndex)`
per appended row), `foldSubagentActivities` 10 % (the whole roster refolded from every activity on
every task row and on every retention drop). A thread that stays over its limits pays all of it on
every event.

Consequences: the first open of a big chat after a deploy (no `state.json` yet) takes 9–52 s; a
history page over a fleet stretch takes ~10 s; "load full output" on a message refolds the whole
log; and the browser pays the same per-event cost for every live frame of a big chat.

## B — batch retention (changes the fold's output: `FOLD_SNAPSHOT_VERSION` 1 → 2)

The drop rules are today's, unchanged, applied at the exact limits
(`ACTIVITY_RETENTION_LIMIT` 500 parent rows, `AGENT_ACTIVITY_RETENTION_LIMIT` 200 per agent,
`AGENT_ACTIVITY_TOTAL_LIMIT` 2 000 across agents, `MESSAGE_RETENTION_LIMIT` 2 000 messages, with
the same exemptions: open message-mode questions, agent anchors, compaction markers). What changes
is WHEN they run:

- **Droppable counts** (a pure function of the retained arrays): parent rows that are neither an
  agent anchor nor a compaction marker; per agent, its rows that are not agent anchors; the sum of
  those across agents; messages. Open questions are counted as droppable for the trigger only
  (they stay exempt in the trim) — worst case, more than a slack's worth of open questions in the
  old zone makes the trim run without dropping them, which costs time, never correctness.
- **Trigger** after any step that changed `items`/`activities`:
  `activities.length > ACTIVITY_RETENTION_LIMIT` (today's gate, unchanged — it is what keeps a
  history page of ≤ 400 activities lossless) AND (parent droppable > 500 + `ACTIVITY_RETENTION_SLACK`
  (50) OR any agent's droppable > 200 + `AGENT_ACTIVITY_RETENTION_SLACK` (50) OR total agent
  droppable > 2 000 + `AGENT_ACTIVITY_TOTAL_SLACK` (200)); OR messages > 2 000 +
  `MESSAGE_RETENTION_SLACK` (200).
- **Trim**: one pass that applies EVERY rule at its exact limit (all activity classes and messages
  at once — "cut back in one go"): the trimmed window is today's `activitiesToDrop` + message cut
  applied to the pre-trim window. Between trims each class holds at most its limit + slack droppable
  rows (+ its exempt rows). Not identical to per-event retention in one edge: a stable-id row updated
  in place while in the slack band stays at its old position and leaves at the trim, where per-event
  retention would have evicted it earlier and re-appended its update at the end. Both drop such a
  row until its next update; only the moment differs.
- The cross-agent ceiling sorts by `createdAt` with a plain string comparison (`<`), not
  `localeCompare` (ISO-8601 stamps order lexicographically; ties keep list order — `sort` is stable).
- The trigger must be a function of the state alone — never of history such as "rows since the last
  trim" — so a snapshot at any seq folded forward through the tail equals the whole-log fold.
- **`state.evicted`** (`FoldEvictions {activities, messages}`, absent until the first drop):
  serialized in `state.json`, never cleared. Set by the trim that first drops an activity / a message.
- **`itemsDroppedByRetention(state)`**: the rows the trim of the step that produced `state` removed,
  in list order (a side table, empty for any other state). The client uses it (see "Client").

Contract pieces already in the tree: the four `*_SLACK` constants, `FoldEvictions`,
`ThreadFoldState.evicted`, `itemsDroppedByRetention`, `itemPositionOf`, the snapshot's version 2 and
its `evicted` field (`fold-snapshot.ts`, validated field-wise).

## A — the same results, less work per event

1. **No derived structure on the state that needs copying per event.** `itemIndex` is removed from
   `ThreadFoldState`. Per-state caches live in a module-level `WeakMap<ThreadFoldState, caches>`:
   an id→position index that is persistent (a shared, never-mutated base map plus a small
   copy-on-write overlay, compacted into a new base when it outgrows a bound, rebuilt on trims and
   reverts), the droppable counters, and the roster engine. A state without caches (a snapshot,
   `deserializeFoldState`, the client's `foldStateFromSnapshot`, a hand-built test state) gets them
   built lazily from its arrays on first use. Caches are never enumerable state, so `deepEqual`
   between states, `serializeFoldState` and the wire shape are unaffected.
2. **Invariants.** The maintained caches always equal the caches rebuilt from the state's arrays.
   Nothing a returned state can reach is ever mutated, so folding two different events onto the same
   state (a test, a speculative fold) gives two independent correct results. Every existing fold
   rule is preserved apart from B.
3. **The roster, per task.** The roster fold's arms touch only their own task (`taskId`), so the
   roster is the per-task fold of each task's rows in list order, plus post-passes (workflow
   cascade, session-death interruption, the `ROSTER_LIMIT` cap, output copies). `roster.ts` exports
   the engine API (`createRosterEngine`, `rosterEngineAppend`, `rosterEngineReplace` → `null` when it
   cannot apply a change incrementally, `rosterFromEngine`) with a naive placeholder behind it; the
   real engine keeps each task's rows and folded state, refolds only the task a replacement touches,
   orders tasks by the list position of the row that created them, runs the post-passes without
   mutating its cached per-task folds, and reuses the previous output object of every agent whose
   row did not change. `foldSubagentActivities(list, o)` becomes
   `rosterFromEngine(createRosterEngine(list), o)`, so the invariant
   `rosterFromEngine(engine, o)` ≡ `foldSubagentActivities(list, o)` holds by construction for a
   fresh engine and is property-tested for every append/replace sequence.
4. When the roster is re-derived does not change: a task row, a session-liveness change, or a trim
   that dropped rows. Otherwise the previous `roster` array is kept by identity.

Budget: the 55 MB fleet log folds in ≤ 2.5 s on the owner's VPS (from 54 s), and no function in its
profile does work proportional to the window on every event.

## Host

`windowBoundary` (`orchestrator.ts`) keeps its positional per-class windows (the newest `limit` rows
of each full class — conservative under batching: at or after the true cut) but considers the
activity classes only when `state.evicted?.activities` is true. Without that, a thread holding
501–550 parent rows that has never trimmed would report `hasOlder` and serve a first page of rows
the window already shows. Page folds stay lossless: ≤ 400 activities never pass the gate.

## Client — the history bridge (fixes an A+C defect)

Defect: with older history pages loaded, a row the window evicts disappears from the screen — the
pages hold only what was older than the window when they were fetched, and the window no longer has
it — so a hole opens between the pages and the recent rows until the chat is reloaded. It happens
today one row at a time and would happen in blocks under B.

Fix: while at least one history page is loaded, the reducer appends `itemsDroppedByRetention(fold)`
of every live step to a **bridge** kept with the history (`packages/ui/src/lib/agent-chat/`), and the
bridge renders between the newest page and the window through the same projection and the same
dedupe rules as the pages. Requirements: pages + bridge + window always cover a contiguous range (no
row lost, none twice); nothing changes when no page is loaded; a snapshot clears pages and bridge (as
it clears pages today); a revert that reaches a page or a bridge row clears both; memory is bounded
— past a cap, drop the oldest pages first (their `beforeCursor` chain keeps "load older" exact), and
if the bridge alone passes the cap, drop pages and bridge and reload the thread's snapshot so the
bounds are fresh.

## As built (2026-09-23)

Measured on the owner's VPS, fold only (read + parse is ~1 s more), before → after:

| Log | Events | Before | After |
|---|---|---|---|
| Real 80 MB thread, first 28 503 events | 28 503 | 45.5 s | 1.2–1.4 s |
| Real 69 MB thread, first 34 489 events | 34 489 | 81.0 s | 1.3–1.6 s |
| Synthetic fleet (56 agents, 31 205 events) | 31 205 | 50.0 s | 1.0–1.2 s |

On the whole current logs (83 MB / 32 161 events, 72 MB / 38 237, 34 MB / 20 620) the fold takes
1.0 s, 1.3 s and 0.5 s; the roster checked against a fresh fold at ~400 points per log, and
against the pre-change roster fold at ~900 points per log (all three `sessionLive` values), with no
difference; snapshot + tail equalled the whole fold at every split tried.

Where the build departs from the text above, and why:
- **The index's overlay is the tail of `items`**, not a separate copied map: a shared base map plus
  the rows appended since, walked newest-first (at most 256) before being folded into a new base.
  Same invariants; the separate map measured 1.55 s against ~1.05 s.
- **Row classes as built:** an agent anchor counts in no class; an agent-owned row counts for its
  agent; a parent compaction marker — either spelling since the follow-up below — counts in no
  class; every other parent row counts as parent, open questions included. The message count is
  `items.length − activities.length`.
- **Reducers tell `commit` how the window changed** (a row appended, a row replaced in place, or
  "rebuild"), so the counters and the index move by one row; a trim decrements the counters over
  the dropped rows; a revert rebuilds everything.
- **The roster engine** keeps created tasks in an array (the index IS the creation ordinal), tasks
  seen only through `tool.progress` apart, and each task's rows plus a folded agent that is never
  written after it is stored; `rosterEngineReplace` also answers `null` for a `previous` the engine
  holds twice. The cap's ranking reuses the previous read's order as a starting point, with a
  comparator that has exactly one sorted order (it tiebreaks on roster position), so the result is
  the old stable sort's. **Roster rows are shared objects** between reads and engines — a caller
  must never write one; no current consumer does.
- **Determinism tests:** the two small-window logs go through serialize → JSON → deserialize at
  every split; the three large ones (fleet, cross-agent ceiling, messages) use a cache-less restore
  at every split and a JSON restore around every trim and rewind and every 500th split. Every split
  must reach the same state, with consistent caches, on its first step.
- **Unchanged on purpose:** the roster and the pending set still re-derive on the incoming row's
  kind, as before; a task row replaced in place by a non-task row leaves them stale until the next
  re-derive, exactly as it did.
- **`__foldCacheConsistency(state)`** is a test-only export (it rides the barrel's `export *`).

### Client, as built

- **State** (`AgentChatHistoryState`): `bridge` (oldest first), `windowCut`, `windowEvicted`.
- **Collection** (`historyAfterEvent`): each live step's `itemsDroppedByRetention`, parent-visible
  rows only, while a page is loaded or the first page is in flight; with none of that the step
  reads nothing (the old fast path). A bridge whose first page failed or was superseded, or a
  remounted tab, drops it (`withoutOrphanBridge`).
- **Order.** Every window row written before the end of the loaded history renders in the history
  section: the end is the newest page's end or the newest bridge row, whichever is later. A page's
  end is `page.endItemId` — added to the wire (`ThreadHistoryPage.page.endItemId`, optional, filled
  by the host from the log line at the page's upper boundary) — or, from an older host, the last
  row the page shares with the window. List order is log order (first emission); timestamps are
  not, because rows replaced in place carry a fresh `createdAt` at their first position.
- **Dedupe:** one id, one row, at the oldest position, with the newest content, across pages,
  bridge and window; a spawn batch split by a boundary stays one row.
- **Live turn:** the history projection receives the running turn's state (`continuesBelow`,
  `activeTurnHeader`, `liveActivityAbove`), so a turn split across the sections renders exactly as
  one window would.
- **Cap:** `HISTORY_ROW_CAP = 20 000` rows across pages and bridge, checked where the bridge grows.
  The oldest pages go first; the newest page is never dropped alone (nothing else names the cursor
  below the bridge), so "bridge plus newest page past the cap" resets the history and re-reads the
  snapshot through a guarded copy of the resync path that keeps the stream cursor and the
  connection state and refuses a snapshot older than the fold.
- **"Load older" after live evictions:** `windowEvicted` offers it as soon as the window evicts a
  visible row, and that first request goes without a cursor (a snapshot's cursor predates the
  evictions and would leave a gap).
- **Revert** clears pages and bridge when it removes a turn a page or a bridge row belongs to;
  **reveal** (`planReveal`) finds a turn the bridge already shows without loading a page.
- Left as documented: each bridge change re-projects pages + bridge (bounded by the cap and rare
  under batching); the store's plain `refresh()` keeps its existing stale-snapshot race on a host
  restart.

### Follow-up: the legacy compaction marker (`FOLD_SNAPSHOT_VERSION` 2 → 3)

B's exemptions name "compaction markers", but the fold recognised only a `context-compaction` row:
the `thread.state.changed {state: "compacted"}` an older log wrote for a settled compaction was
evicted like any parent row, and counted toward the parent's trigger. The parent window's exemption
and the row class now read `isCompactionActivity` (`packages/api/src/agent-chat/compaction.ts`), the
rule the UI's window gates, the MCP and the thread index already share: both spellings are kept
whatever their age, a `thread.state.changed` in any other state is still an ordinary row, and an
agent's own marker is still an ordinary row of its agent's window. Nothing else about retention
changed. A state folded by version 2 may already have evicted the marker (and trimmed at other
steps), so `FOLD_SNAPSHOT_VERSION` went to 3: a version-2 `state.json` is discarded through the
existing version-mismatch path and its log re-folded once, lazily, on the thread's next load. The
reference model in `fold.retention.test.ts` reads both spellings; a log with legacy rows is checked
against it, and through JSON at every split point in `fold.determinism-legacy.test.ts`.

## Ownership (parallel implementation)

| Task | Owns |
|---|---|
| Fold core | `packages/api/src/agent-chat/{fold.ts,fold-snapshot.ts,index.ts}`, `fold.test.ts`, `fold-snapshot.test.ts`, `turn-fold.test.ts`, new fold tests |
| Roster engine | `packages/api/src/agent-chat/roster.ts`, `roster.test.ts`, new roster tests |
| Client | `packages/ui/src/lib/agent-chat/**` (incl. dropping `itemIndex` from `foldStateFromSnapshot`) |
| Host | `apps/daemon/src/agent-host/orchestration/orchestrator.ts` (`windowBoundary`, comments), `orchestrator.test.ts` |
| Docs | `AGENTS.md`, `apps/daemon/src/agent-host/README.md`, the specs |
