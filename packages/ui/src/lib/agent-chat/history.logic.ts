/**
 * Agent chat — the history below the retained window (design 2026-09-23
 * "thread index and lazy boot", §C "History page" and "Client"; design
 * 2026-09-23 "fold performance", "Client — the history bridge").
 *
 * The first paint of a thread is the fold's retained window (500 parent
 * activities, 2 000 messages); everything older is in the log and reachable
 * through the host's thread index as **blocks of the log by activity count**
 * (400 per page, `HISTORY_PAGE_ACTIVITIES`, so a boundary may fall inside a
 * turn), `GET …/history`, newest block first. The timeline shows three
 * sources, oldest first — the loaded **pages**, the **bridge**, the
 * **window** — and together they must always cover ONE contiguous stretch of
 * the log: no row lost, none twice. This module is the pure half of that:
 *
 * - the page cache (`mergeHistoryPage`, `historyWithPage`, `resetHistory`,
 *   `historyAfterRevert`) and the cursor that asks for the next older page
 *   (`nextHistoryCursor`) — without the snapshot's own once the window has
 *   evicted a row since it (`windowEvicted`), which also offers older history
 *   whatever that snapshot's `hasOlder` said;
 * - the bridge (`historyAfterEvent`). A page holds only what was older than
 *   the window when it was fetched, and the window keeps evicting, so every
 *   row retention drops (`itemsDroppedByRetention`) while a page is loaded —
 *   or the first one is on its way — is kept here, or a hole opens between
 *   the pages and the window. With nothing loaded nothing is kept;
 * - the **window cut**, which keeps the timeline in the log's order: every
 *   window item that lies below the history's END — the newest page's end
 *   (`pageEndCut`: up to the row the page names as its end, `endItemId`, or
 *   through the last window row a page also holds) or the newest bridge row,
 *   whichever is later, in the log's first-emission order — renders with the
 *   history, in its place, and never below it. A message
 *   outlives the tool rows around it (2 000 against 500), and an agent's
 *   launch row or a compaction marker outlives everything, so there are such
 *   rows, bridge or no bridge;
 * - the memory bound (`historyWithinCap`, {@link HISTORY_ROW_CAP}): past it
 *   the oldest pages go — their cursor chain keeps "load older" exact — and a
 *   bridge that no longer fits beside the newest page takes everything with
 *   it, for a fresh snapshot;
 * - the reveal planner the command palette's search hit drives
 *   (`planReveal`, bounded at {@link HISTORY_REVEAL_PAGE_CAP} pages);
 * - the history rows (`projectHistoryRows`): ONE projection over every page's
 *   items and the bridge, through the very same row derivation as the
 *   window, memoised by the `pages` and `bridge` arrays' identities — never
 *   source by source, because a boundary can fall inside a turn — so the
 *   window's own streaming fast path is never touched. It is told what the
 *   window knows of a running turn, so that turn's rows up here render live
 *   exactly as the window renders them (unfolded, no settled metadata, a call
 *   in flight live, its "Working…" header after its prompt), while the live
 *   tail stays the window's (`continuesBelow`);
 * - one dedupe rule across all three sources (`collectHistoryItems`,
 *   `splitLiveItems`, `mergeTimelineRows`): an id renders ONCE, at its OLDEST
 *   place, with its NEWEST content — a row the first page repeats from the
 *   window, a row the window then hands the bridge, a stable-id row evicted
 *   and re-appended by an update — and a window row that continues a call, a
 *   task or a spawn batch the history began joins the history's one row for
 *   it, so a turn split across a boundary reads prompt → early work → later
 *   work.
 *
 * Pages and bridge are a cache of a log that may since have been reverted,
 * never an authority. No React, no zustand.
 */

import {
  itemsDroppedByRetention,
  startedTurns,
  type Checkpoint,
  type DomainEvent,
  type ThreadFoldState,
  type ThreadHistoryBounds,
  type ThreadHistoryPage,
  type ThreadHistoryTurn,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type Turn
} from "@orquester/api/agent-chat";

import type { AgentChatHistoryState, AgentChatTimelineRow, WorkLogEntry } from "./contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  isAgentInternalActivity,
  type ThreadTimelineProjection
} from "./entries.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";
import { AgentChatCommandError } from "./transport";

/**
 * How many older pages a reveal may pull in before it gives up (the design's
 * "bounded at 25 pages" — 500 turns at the default page size).
 */
export const HISTORY_REVEAL_PAGE_CAP = 25;

/**
 * The most rows the pages and the bridge may hold together
 * ({@link historyWithinCap}).
 *
 * About four windows' worth. The window itself retains up to ~4 500 rows
 * (500 parent activities, 2 000 agent activities, 2 000 messages, plus
 * their slack); a page is at most 400 activities and the messages among them
 * — a few hundred rows on an ordinary thread — so the cap holds a whole
 * reveal ({@link HISTORY_REVEAL_PAGE_CAP} pages) with room for hours of a busy
 * thread's evictions beside it, the bridge keeping only rows the parent
 * timeline renders. What it bounds is a tab left open with history loaded
 * under a subagent fleet: that would otherwise keep, and re-project on every
 * trim, everything the window ever evicted.
 */
export const HISTORY_ROW_CAP = 20_000;

const NO_ITEMS: readonly ThreadItem[] = [];

export const EMPTY_HISTORY: AgentChatHistoryState = {
  bounds: null,
  pages: [],
  bridge: NO_ITEMS,
  windowCut: 0,
  windowEvicted: false,
  loading: false,
  error: null
};

// ---------------------------------------------------------------------------
// Bounds and resets
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));

/**
 * The snapshot's history bounds, validated field-wise.
 *
 * A host that predates the index sends no `history` at all, and a host
 * mid-rollout could send a shape this bundle does not know; either way the
 * client offers nothing older rather than a "Load older turns" row that can
 * only fail.
 */
export function historyBoundsFromSnapshot(snapshot: ThreadSnapshotPayload): ThreadHistoryBounds | null {
  const raw: unknown = snapshot.history;
  if (!isRecord(raw)) {
    return null;
  }
  const { indexed, hasOlder, beforeCursor, oldestRetainedOrdinal, totalTurns } = raw;
  if (
    typeof indexed !== "boolean" ||
    typeof hasOlder !== "boolean" ||
    !isNullableString(beforeCursor) ||
    !isNullableNumber(oldestRetainedOrdinal) ||
    typeof totalTurns !== "number" ||
    !Number.isFinite(totalTurns)
  ) {
    return null;
  }
  return { indexed, hasOlder, beforeCursor, oldestRetainedOrdinal, totalTurns };
}

/**
 * The history after a `snapshot` frame: the new bounds, no pages, no bridge,
 * no error. The snapshot's window is a new one, so nothing the old window
 * handed the bridge — nor the cut into it, nor what it evicted since its own
 * snapshot — means anything any more.
 *
 * **Always a fresh `pages` array**, even when the previous one was already
 * empty: an in-flight `GET …/history` compares the pages it was asked
 * against with the ones it lands on, and a reset must be observable to it or
 * a page of a superseded log would be merged into the new one. `loading` is
 * left to the request that set it — it settles it either way.
 */
export function resetHistory(
  bounds: ThreadHistoryBounds | null,
  previous: AgentChatHistoryState = EMPTY_HISTORY
): AgentChatHistoryState {
  return {
    bounds,
    pages: [],
    bridge: NO_ITEMS,
    windowCut: 0,
    windowEvicted: false,
    loading: previous.loading,
    error: null
  };
}

/**
 * The history after `thread.reverted {turnCount}`; `turns` are the fold's
 * turns BEFORE the rewind, whose order numbers it.
 *
 * A rewind inside the live window leaves every page and every bridge row
 * valid — they only hold turns older than it — so nothing moves (the window
 * cut is recounted where the window's items are known, `historyAfterEvent`).
 * A rewind that reaches into a loaded page, or removes the turn of a bridge
 * row, drops **all** of both: keeping the older ones would leave a gap
 * between them and the truncated window that "load older" (which only ever
 * pages further back) could never fill. The bounds stay: the cursor is
 * content-derived, so it still pages from just below where the window was —
 * and when the window has evicted since, the next load asks without one
 * (`nextHistoryCursor`).
 */
export function historyAfterRevert(
  history: AgentChatHistoryState,
  turnCount: number,
  turns: readonly Turn[]
): AgentChatHistoryState {
  if (history.pages.length === 0 && history.bridge.length === 0) {
    return history;
  }
  const reaches =
    historyTurns(history.pages).some((turn) => turn.ordinal > turnCount) ||
    bridgeReachedByRevert(history.bridge, turnCount, turns);
  return reaches
    ? { ...history, pages: [], bridge: NO_ITEMS, windowCut: 0, error: null }
    : history;
}

/**
 * A bridge row belongs to a turn the rewind removes — mirroring the fold's own
 * cut (`reduceReverted`): a row keeps its place only with its turn among the
 * first `turnCount` STARTED turns, and a turn-less prompt goes with the turn
 * that names it as its `userMessageId`.
 */
function bridgeReachedByRevert(
  bridge: readonly ThreadItem[],
  turnCount: number,
  turns: readonly Turn[]
): boolean {
  if (bridge.length === 0) {
    return false;
  }
  const kept = new Set<string>();
  const removedPrompts = new Set<string>();
  startedTurns(turns).forEach((turn, index) => {
    if (index < Math.max(0, turnCount)) {
      kept.add(turn.turnId);
    } else if (turn.userMessageId !== undefined) {
      removedPrompts.add(turn.userMessageId);
    }
  });
  return bridge.some((item) =>
    item.turnId !== null
      ? !kept.has(item.turnId)
      : item.kind === "message" && removedPrompts.has(item.id)
  );
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Whether an evicted row is kept on the bridge: only what the PARENT timeline
 * renders. A subagent's own rows show in its drill-in, which reads the
 * window, never the history; kept here they would only fill the cap.
 */
function bridgeAdmits(item: ThreadItem): boolean {
  if (item.kind === "message") {
    return item.agentId === undefined || item.agentId.length === 0;
  }
  return !isAgentInternalActivity(item);
}

/** One fold step, as `historyAfterEvent` reads it. */
export interface HistoryFoldStep {
  /** The event the fold just applied. */
  readonly event: DomainEvent;
  /** The fold before it. */
  readonly before: ThreadFoldState;
  /** The fold after it — the state `itemsDroppedByRetention` describes. */
  readonly after: ThreadFoldState;
}

/**
 * The history after one live fold step: the reducer's hook for the bridge.
 *
 * - **Nothing loaded and nothing on its way** (no page, no bridge, no request
 *   in flight): nothing is kept. The one thing noted is the FIRST row the
 *   window drops since its snapshot (`windowEvicted`): from then on there is
 *   older history to offer whatever the snapshot's `hasOlder` said, asked for
 *   without its stale cursor. Once noted — or with no index to page — nothing
 *   is even read, so a thread without history keeps its old fast path.
 * - A `thread.reverted` first: one that reaches a page or a bridge row drops
 *   both (`historyAfterRevert`).
 * - Then the rows retention dropped in this step, oldest first, onto the end
 *   of the bridge — whatever their number: one at a time at the exact limits,
 *   or a whole batch once a class outgrows its slack. Also while the FIRST
 *   page is still on its way: that page ends where the window stood when it
 *   was asked for, and a row evicted before it lands would be in neither.
 * - And the window cut, recounted whenever the step took rows OUT of the
 *   window (`windowCutAfter`).
 */
export function historyAfterEvent(
  history: AgentChatHistoryState,
  step: HistoryFoldStep
): AgentChatHistoryState {
  if (history.pages.length === 0 && history.bridge.length === 0 && !history.loading) {
    if (history.windowEvicted || history.bounds?.indexed !== true) {
      return history;
    }
    return itemsDroppedByRetention(step.after).some(bridgeAdmits)
      ? { ...history, windowEvicted: true }
      : history;
  }
  const event = step.event;
  const reverted = event.type === "thread.reverted";
  if (event.type === "thread.reverted") {
    const next = historyAfterRevert(history, event.payload.turnCount, step.before.turns);
    if (next !== history) {
      // Pages and bridge went, and the cut with them.
      return next;
    }
  }
  const dropped = itemsDroppedByRetention(step.after);
  if (dropped.length === 0 && !reverted) {
    return history;
  }
  const admitted = dropped.filter(bridgeAdmits);
  const bridge = admitted.length === 0 ? history.bridge : [...history.bridge, ...admitted];
  const windowCut =
    history.pages.length === 0 && bridge.length === 0
      ? 0
      : windowCutAfter(step.before.items, step.after.items, history.windowCut, admitted);
  const windowEvicted = history.windowEvicted || admitted.length > 0;
  return bridge === history.bridge &&
    windowCut === history.windowCut &&
    windowEvicted === history.windowEvicted
    ? history
    : { ...history, bridge, windowCut, windowEvicted };
}

/**
 * Two rows are the same row across one fold step: the same object, or — for
 * the row the step replaced in place — the same id and kind (a message and an
 * activity may share an id).
 */
const sameRow = (left: ThreadItem, right: ThreadItem): boolean =>
  left === right || (left.id === right.id && left.kind === right.kind);

const rowKey = (item: ThreadItem): string => `${item.kind}\u0000${item.id}`;

/**
 * The window cut after a step that took rows out of the window: how many of
 * the surviving items lie before the history's end — the old cut, or the
 * newest row this step handed the bridge — in the log.
 *
 * The cut's end in the old list is the old cut, or just past the newest row
 * this step handed the bridge, whichever is further; the answer is how many
 * rows of the old list up to there survive. Retention and a revert only ever
 * remove rows and an append lands at the end, so the survivors keep their
 * order and are exactly the new list's first rows — a two-pointer walk, no
 * index needed. A handed row the old list never held was appended by this
 * very step and is newer than every survivor.
 */
function windowCutAfter(
  before: readonly ThreadItem[],
  after: readonly ThreadItem[],
  cut: number,
  admitted: readonly ThreadItem[]
): number {
  let end = Math.min(cut, before.length);
  if (admitted.length > 0) {
    const handed = new Set(admitted.map(rowKey));
    let found = 0;
    for (let index = 0; index < before.length; index += 1) {
      if (handed.has(rowKey(before[index]!))) {
        found += 1;
        end = Math.max(end, index + 1);
      }
    }
    if (found < handed.size) {
      end = before.length;
    }
  }
  let count = 0;
  for (let index = 0; index < end && count < after.length; index += 1) {
    if (sameRow(after[count]!, before[index]!)) {
      count += 1;
    }
  }
  return count;
}

/** How many rows the pages and the bridge hold together. */
export function historyRowCount(history: AgentChatHistoryState): number {
  let total = history.bridge.length;
  for (const page of history.pages) {
    total += page.items.length;
  }
  return total;
}

/**
 * Hold the pages and the bridge to `cap` rows ({@link HISTORY_ROW_CAP}).
 * Checked where the bridge grows — the one part that grows without the user
 * asking; a page the user asked for always lands.
 *
 * Past the cap the OLDEST pages go first: "load older" then asks by the
 * oldest remaining page's cursor, which names exactly the block just dropped.
 * The newest page never goes on its own — it is where the bridge meets the
 * cursor chain, and nothing else the client holds is sure to name the block
 * beneath the bridge — so when the bridge and that page alone still pass the
 * cap (the bridge alone passing it is the case in point), pages, bridge and
 * cut all go and `resync` asks for a fresh snapshot: its bounds, and the
 * cursor in them, are computed by the host for the window as it now stands.
 */
export function historyWithinCap(
  history: AgentChatHistoryState,
  cap: number = HISTORY_ROW_CAP
): { history: AgentChatHistoryState; resync: boolean } {
  let total = historyRowCount(history);
  if (total <= cap) {
    return { history, resync: false };
  }
  let dropped = 0;
  while (total > cap && history.pages.length - dropped > 1) {
    total -= history.pages[dropped]!.items.length;
    dropped += 1;
  }
  if (total <= cap) {
    return { history: { ...history, pages: history.pages.slice(dropped) }, resync: false };
  }
  return {
    history: { ...history, pages: [], bridge: NO_ITEMS, windowCut: 0, error: null },
    resync: true
  };
}

/**
 * The history once a request settled with nothing loaded — it failed, or a
 * snapshot or a rewind superseded it, or its generation is gone: a bridge
 * collected while that first page was on its way has nothing to join, and
 * goes with its cut. Anything else is handed back as it is.
 */
export function withoutOrphanBridge(history: AgentChatHistoryState): AgentChatHistoryState {
  return history.pages.length === 0 && (history.bridge.length > 0 || history.windowCut !== 0)
    ? { ...history, bridge: NO_ITEMS, windowCut: 0 }
    : history;
}

// ---------------------------------------------------------------------------
// The page cache
// ---------------------------------------------------------------------------

/**
 * Prepend an older page, **oldest first**, exactly as the host sent it.
 *
 * Nothing is filtered on the way in: a row two pages share, and a row a page
 * shares with the bridge or the window, are each resolved ONCE where the rows
 * are built (`collectHistoryItems`, `splitLiveItems`) — a page is a block of
 * the log by activity count, so both are expected at its boundaries.
 */
export function mergeHistoryPage(
  pages: readonly ThreadHistoryPage[],
  page: ThreadHistoryPage
): ThreadHistoryPage[] {
  return [page, ...pages];
}

/**
 * The page's `endItemId` — the id of the first row of the log the page does
 * NOT hold — validated field-wise: a string or `null` exactly as the host sent
 * it; anything else, and a host that predates the field, reads as absent.
 * The transport casts a page rather than parsing it, so this is where the
 * field is checked.
 */
export function pageEndItemId(page: ThreadHistoryPage): string | null | undefined {
  const block: unknown = (page as { page?: unknown }).page;
  if (!isRecord(block)) {
    return undefined;
  }
  const value = block.endItemId;
  return typeof value === "string" || value === null ? value : undefined;
}

/**
 * The window cut a page's end sets: every window item before the row the
 * page ends at lies below that end in the log, and renders with the history.
 *
 * A page is a block of the log, `[start, end)`; the window's list is the
 * log's first-emission order. Two rules, the larger answer wins:
 *
 * - **The row the page names as its end** (`endItemId`, the first row it does
 *   not hold): every window item before it in the list was first written
 *   before it. Exact, whatever the page shares with the window. When the
 *   window no longer holds that row it evicted it since — onto the bridge,
 *   whose cut already covers it — and this rule says nothing.
 * - **The last window item the page also holds**, the fallback for a host
 *   that predates the field: a window item the page holds was first written
 *   inside the block (or, rewritten in it, before it), so it lies below the
 *   end — and so does every window item before it; one first written between
 *   it and the end would lie inside the block and be held too. With nothing
 *   shared it moves nothing.
 */
export function pageEndCut(windowItems: readonly ThreadItem[], page: ThreadHistoryPage): number {
  let cut = 0;
  if (page.items.length > 0) {
    const held = new Set(page.items.map((item) => item.id));
    for (let index = windowItems.length - 1; index >= 0; index -= 1) {
      if (held.has(windowItems[index]!.id)) {
        cut = index + 1;
        break;
      }
    }
  }
  const endItemId = pageEndItemId(page);
  if (typeof endItemId === "string") {
    const end = windowItems.findIndex((item) => item.id === endItemId);
    if (end > cut) {
      cut = end;
    }
  }
  return cut;
}

/**
 * The history once an older page landed: prepended (`mergeHistoryPage`), with
 * the window cut moved on to the page's end when that lies further
 * (`pageEndCut`) — so the window's rows below the page's end render with the
 * history, in their place, and never below the pages, bridge or no bridge.
 * `windowItems` are the fold's items as the page lands.
 */
export function historyWithPage(
  history: AgentChatHistoryState,
  page: ThreadHistoryPage,
  windowItems: readonly ThreadItem[]
): AgentChatHistoryState {
  return {
    ...history,
    pages: mergeHistoryPage(history.pages, page),
    windowCut: Math.max(history.windowCut, pageEndCut(windowItems, page))
  };
}

/**
 * Every loaded page's turns, **once per `turnId`**, oldest first. Pages are
 * blocks of the log by activity count, so a turn a boundary falls inside is
 * listed on both of its pages; the NEWEST page's copy supplies the fields
 * (`ordinal` and `rewindable` stay the index's own words, from that page).
 */
export function historyTurns(pages: readonly ThreadHistoryPage[]): ThreadHistoryTurn[] {
  const newestCopy = new Map<string, ThreadHistoryTurn>();
  const order: string[] = [];
  for (const page of pages) {
    for (const turn of page.turns) {
      if (!newestCopy.has(turn.turnId)) {
        order.push(turn.turnId);
      }
      newestCopy.set(turn.turnId, turn);
    }
  }
  return order.map((turnId) => newestCopy.get(turnId)!);
}

/**
 * Whether anything older can be asked for: until a page has landed, the
 * snapshot's `hasOlder` — or the window having evicted a row since that
 * snapshot (`windowEvicted`), which makes older history exist whatever the
 * snapshot said; then the oldest page's own cursor — the one that reached turn
 * 1 answers `null`. Never without an index.
 */
export function canLoadOlderHistory(history: AgentChatHistoryState): boolean {
  const oldest = history.pages[0];
  if (oldest !== undefined) {
    return oldest.page.beforeCursor !== null;
  }
  return (
    history.bounds !== null &&
    history.bounds.indexed &&
    (history.bounds.hasOlder || history.windowEvicted)
  );
}

/**
 * The `before` of the next `GET …/history`: the oldest page's cursor, or —
 * with nothing loaded — the snapshot's. `undefined` asks for the block just
 * below the retained window as the host holds it NOW.
 *
 * Which is also what a stale snapshot cursor turns into: once the window has
 * evicted a row since that snapshot (`windowEvicted`), the snapshot's cursor
 * names the block below the window as it WAS, and the rows evicted since
 * would sit between that page and the window, shown by neither — or the
 * snapshot had no cursor to give at all (`hasOlder: false`). A reset that
 * dropped the pages (a rewind, the cap) lands here too.
 */
export function nextHistoryCursor(history: AgentChatHistoryState): string | undefined {
  const oldest = history.pages[0];
  if (oldest !== undefined) {
    return oldest.page.beforeCursor ?? undefined;
  }
  if (history.windowEvicted) {
    return undefined;
  }
  return history.bounds?.beforeCursor ?? undefined;
}

/**
 * What a failed `GET …/history` tells the user, in words: an unavailable
 * index and a dropped connection each get their own sentence, and anything
 * else is the host's own message.
 */
export function historyErrorMessage(error: unknown): string {
  if (error instanceof AgentChatCommandError) {
    if (error.code === "INDEX_UNAVAILABLE") {
      return "Older turns are unavailable on this host right now.";
    }
    if (error.code === "THREAD_NOT_FOUND") {
      return "This conversation is no longer available.";
    }
    if (error.status === 0 || error.code === "HOST_UNAVAILABLE") {
      return "Couldn't reach the agent host. Try again in a moment.";
    }
    if (error.message.trim().length > 0) {
      return error.message;
    }
  }
  return "Couldn't load older turns.";
}

// ---------------------------------------------------------------------------
// Revealing a turn (the command palette's search hit)
// ---------------------------------------------------------------------------

export type RevealPlan = "present" | "load-more" | "absent";

/**
 * Where a turn is: on screen (the window, the bridge or a loaded page holds
 * it), one more older page away, or out of reach — nothing older exists, or
 * {@link HISTORY_REVEAL_PAGE_CAP} pages have already been pulled in.
 */
export function planReveal(
  turnId: string,
  input: {
    liveTurnIds: ReadonlySet<string>;
    /** What the bridge shows something of: {@link liveTurnIdsOf} over it. */
    bridgeTurnIds?: ReadonlySet<string>;
    pages: readonly ThreadHistoryPage[];
    hasOlder: boolean;
  }
): RevealPlan {
  if (input.liveTurnIds.has(turnId) || input.bridgeTurnIds?.has(turnId) === true) {
    return "present";
  }
  if (historyTurns(input.pages).some((turn) => turn.turnId === turnId)) {
    return "present";
  }
  return input.hasOlder && input.pages.length < HISTORY_REVEAL_PAGE_CAP ? "load-more" : "absent";
}

/**
 * The turns a list of items shows something of — the window's, or the
 * bridge's: a parent-visible row that carries the turn id, or the turn's
 * prompt (a user message carries no turn id of its own — `Turn.userMessageId`
 * names it). A subagent's rows never render in the parent timeline, so they
 * never make a turn "present".
 */
export function liveTurnIdsOf(items: readonly ThreadItem[], turns: readonly Turn[]): Set<string> {
  const turnIds = new Set<string>();
  const visibleItemIds = new Set<string>();
  for (const item of items) {
    if (item.agentId !== undefined && item.agentId.length > 0) {
      continue;
    }
    visibleItemIds.add(item.id);
    if (item.turnId !== null) {
      turnIds.add(item.turnId);
    }
  }
  for (const turn of turns) {
    if (turn.turnId !== null && turn.userMessageId !== undefined && visibleItemIds.has(turn.userMessageId)) {
      turnIds.add(turn.turnId);
    }
  }
  return turnIds;
}

/** The turn a projected row belongs to, as far as the row itself says. */
function rowTurnId(row: AgentChatTimelineRow): string | null {
  switch (row.kind) {
    case "message":
    case "assistant-meta":
      return row.message.turnId;
    case "activity-group":
    case "turn-fold":
      return row.turnId;
    case "work-toggle":
    case "turn-diff":
    case "goal-marker":
      return row.turnId;
    case "work":
      return row.groupedEntries[0]?.turnId ?? null;
    case "work-live":
      return row.entry.turnId;
    default:
      return null;
  }
}

/**
 * The row a reveal scrolls to: the turn's prompt when it is on screen, else
 * the first row the turn owns (a "Worked for …" fold, a tool group, the
 * answer). `null` when the turn projects no row at all.
 */
export function rowIdForTurn(
  rows: readonly AgentChatTimelineRow[],
  turnId: string,
  userMessageId: string | null | undefined
): string | null {
  if (userMessageId) {
    const prompt = rows.find((row) => row.kind === "message" && row.id === userMessageId);
    if (prompt !== undefined) {
      return prompt.id;
    }
  }
  return rows.find((row) => rowTurnId(row) === turnId)?.id ?? null;
}

// ---------------------------------------------------------------------------
// History rows
// ---------------------------------------------------------------------------

/** Every page's items and the bridge as ONE list — what the history rows are built from. */
export interface HistoryItemsState {
  /** The pages array this was collected from — one half of the memo key. */
  readonly pages: readonly ThreadHistoryPage[];
  /** The bridge it was collected from — the other half. */
  readonly bridge: readonly ThreadItem[];
  /**
   * Oldest source first — pages oldest first, then the bridge — once per
   * id: each at the OLDEST place that holds it, with the NEWEST copy (a
   * message keeps its LONGEST text instead, never a concatenation).
   */
  readonly items: readonly ThreadItem[];
  readonly ids: ReadonlySet<string>;
  /** The ids a PAGE holds: the rows the index's rewind gate speaks for. */
  readonly pageIds: ReadonlySet<string>;
  /** Every call, task and spawn batch the history began ({@link sharingKeysOf}). */
  readonly lifecycleKeys: ReadonlySet<string>;
  /** The history holds a prompt — the user message a running turn's header follows. */
  readonly hasPrompt: boolean;
  /** Every page's turns, once per `turnId` ({@link historyTurns}). */
  readonly turns: readonly ThreadHistoryTurn[];
  readonly checkpoints: readonly Checkpoint[];
}

export const EMPTY_HISTORY_ITEMS: HistoryItemsState = {
  pages: [],
  bridge: NO_ITEMS,
  items: [],
  ids: new Set(),
  pageIds: new Set(),
  lifecycleKeys: new Set(),
  hasPrompt: false,
  turns: [],
  checkpoints: []
};

/** A prompt the parent timeline renders: a user message no agent owns. */
const isPrompt = (item: ThreadItem): boolean =>
  item.kind === "message" &&
  item.role === "user" &&
  (item.agentId === undefined || item.agentId.length === 0);

/** The rows the timeline folds into ONE row per call: its start, its updates, its end, its output. */
const TOOL_LIFECYCLE_KINDS = new Set([
  "tool.started",
  "tool.updated",
  "tool.progress",
  "tool.output",
  "tool.completed"
]);

/** The rows the timeline folds into ONE row per task (its spawn row). */
const TASK_LIFECYCLE_KINDS = new Set(["task.started", "task.progress", "task.completed"]);

const trimmedPayloadString = (payload: unknown, key: string): string | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * The key the timeline folds a row into its call's (or its task's) one row
 * by — the same identity `entries.logic` collapses on: a tool lifecycle row
 * by turn and `toolUseId`, a task row by `taskId`. `null` for anything else.
 */
export function lifecycleKeyOf(item: ThreadItem): string | null {
  if (item.kind !== "activity") {
    return null;
  }
  if (TASK_LIFECYCLE_KINDS.has(item.activityKind)) {
    const taskId = trimmedPayloadString(item.payload, "taskId");
    return taskId === null ? null : `task:${taskId}`;
  }
  if (TOOL_LIFECYCLE_KINDS.has(item.activityKind)) {
    const toolUseId = trimmedPayloadString(item.payload, "toolUseId");
    return toolUseId === null ? null : `tool:${item.turnId ?? "no-turn"}:${toolUseId}`;
  }
  return null;
}

/**
 * The spawn batch an agent's LAUNCH row opens — `entries.logic`'s spawn
 * group, decided (as there) by a task's first row: a workflow's members and
 * its coordinator share one, direct spawns batch per turn. The timeline
 * renders a whole batch as ONE row, so a batch whose launch rows a boundary
 * splits must not render as two. `null` for anything but an agent's
 * `task.started` (a background task's rows are never a spawn row).
 */
export function spawnGroupKeyOf(item: ThreadItem): string | null {
  if (item.kind !== "activity" || item.activityKind !== "task.started") {
    return null;
  }
  const payload = isRecord(item.payload) ? item.payload : null;
  const taskId = trimmedPayloadString(payload, "taskId");
  if (payload === null || taskId === null || payload.agentKind !== "agent") {
    return null;
  }
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `spawn:wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (payload.taskType === "local_workflow" || trimmedPayloadString(payload, "workflowName") !== null) {
    return `spawn:wf:${taskId}`;
  }
  return item.turnId ? `spawn:direct:${item.turnId}` : `spawn:direct:task:${taskId}`;
}

const NO_KEYS: readonly string[] = [];
const sharingKeysCache = new WeakMap<ThreadItem, readonly string[]>();

/**
 * Every key a row joins another source's row by: its call's or task's
 * ({@link lifecycleKeyOf}) and its spawn batch's ({@link spawnGroupKeyOf}).
 * Memoised per item object — items are immutable, and the window's split
 * reads them on every streamed token.
 */
function sharingKeysOf(item: ThreadItem): readonly string[] {
  const cached = sharingKeysCache.get(item);
  if (cached !== undefined) {
    return cached;
  }
  const lifecycle = lifecycleKeyOf(item);
  const group = spawnGroupKeyOf(item);
  const keys =
    lifecycle === null && group === null
      ? NO_KEYS
      : [...(lifecycle === null ? [] : [lifecycle]), ...(group === null ? [] : [group])];
  sharingKeysCache.set(item, keys);
  return keys;
}

/**
 * Which of two copies of one id is kept, `newer` coming from the newer
 * source. A message one source cut short is whole on another: the longer text
 * wins, never a concatenation. Anything else — and a tie — takes the newer
 * copy.
 */
function newerCopy(older: ThreadItem, newer: ThreadItem): ThreadItem {
  if (older.kind === "message" && newer.kind === "message" && older.text.length > newer.text.length) {
    return older;
  }
  return newer;
}

/**
 * Collect every loaded page's items and the bridge, turns and checkpoints,
 * **memoised by the `pages` and `bridge` arrays**. Read oldest source first —
 * the pages oldest first, then the bridge, which only ever holds what left
 * the window after the newest page was asked for — so a shared id keeps the
 * place it first had and takes each newer copy as it comes: the row the first
 * page repeats from the window and the window later hands the bridge renders
 * once, at the page's place, with the bridge's content; a stable-id row the
 * bridge received twice renders at its first place, with its last content.
 */
export function collectHistoryItems(
  previous: HistoryItemsState,
  pages: readonly ThreadHistoryPage[],
  bridge: readonly ThreadItem[] = NO_ITEMS
): HistoryItemsState {
  if (previous.pages === pages && previous.bridge === bridge) {
    return previous;
  }
  if (pages.length === 0 && bridge.length === 0) {
    return EMPTY_HISTORY_ITEMS;
  }
  const chosen = new Map<string, ThreadItem>();
  const order: string[] = [];
  const pageIds = new Set<string>();
  const place = (item: ThreadItem): void => {
    const held = chosen.get(item.id);
    if (held === undefined) {
      chosen.set(item.id, item);
      order.push(item.id);
    } else {
      chosen.set(item.id, newerCopy(held, item));
    }
  };
  for (const page of pages) {
    for (const item of page.items) {
      place(item);
      pageIds.add(item.id);
    }
  }
  for (const item of bridge) {
    place(item);
  }
  const items = order.map((id) => chosen.get(id)!);
  const lifecycleKeys = new Set<string>();
  for (const item of items) {
    for (const key of sharingKeysOf(item)) {
      lifecycleKeys.add(key);
    }
  }
  const byCount = new Map<number, Checkpoint>();
  for (const page of pages) {
    for (const checkpoint of page.checkpoints) {
      byCount.set(checkpoint.checkpointTurnCount, checkpoint);
    }
  }
  return {
    pages,
    bridge,
    items,
    ids: new Set(order),
    pageIds,
    lifecycleKeys,
    hasPrompt: items.some(isPrompt),
    turns: historyTurns(pages),
    checkpoints: [...byCount.values()].sort(
      (left, right) => left.checkpointTurnCount - right.checkpointTurnCount
    )
  };
}

/** What the window's items are split against: what the history holds and began. */
export type LiveSplitHistory = Pick<HistoryItemsState, "ids" | "lifecycleKeys">;

/** The window's items, split against the history. */
export interface LiveSplit {
  readonly source: readonly ThreadItem[];
  readonly history: LiveSplitHistory;
  /** The window cut this split honoured (`AgentChatHistoryState.windowCut`). */
  readonly cut: number;
  /** What the window renders itself: everything the history neither holds nor began. */
  readonly rowItems: readonly ThreadItem[];
  /**
   * The window's items that render with the history, in the window's (newer)
   * content and never in the window: those before the cut, those a page or
   * the bridge also holds, and those that continue a call, a task or a spawn
   * batch the history began.
   */
  readonly shared: readonly ThreadItem[];
  /** `rowItems` hold a prompt: the timeline's last one renders in the window. */
  readonly rowsHavePrompt: boolean;
  /** `shared` holds a prompt. */
  readonly sharedHavePrompt: boolean;
}

export const EMPTY_LIVE_SPLIT: LiveSplit = {
  source: NO_ITEMS,
  history: EMPTY_HISTORY_ITEMS,
  cut: 0,
  rowItems: NO_ITEMS,
  shared: NO_ITEMS,
  rowsHavePrompt: false,
  sharedHavePrompt: false
};

function sameItems(left: readonly ThreadItem[], right: readonly ThreadItem[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Split the window's items against the history. An item goes to the history
 * when it lies before the window cut, when a page or the bridge holds its id,
 * or — guarded to exactly those — when it continues a call, a task or a spawn
 * batch the history began ({@link sharingKeysOf}), so the history's one row
 * for it absorbs the window's later rows instead of the window rendering a
 * second one. A row handed over this way hands its own call and batch over
 * too — its later rows follow it in the list, so one pass sees them.
 *
 * With nothing shared the window's own array is handed back as it is, and
 * `shared` keeps its identity while its items did not move — so a token
 * streaming into a row only the window holds never re-projects the history.
 */
export function splitLiveItems(
  previous: LiveSplit,
  source: readonly ThreadItem[],
  history: LiveSplitHistory,
  windowCut = 0
): LiveSplit {
  const cut = Math.min(Math.max(0, windowCut), source.length);
  if (previous.source === source && previous.history === history && previous.cut === cut) {
    return previous;
  }
  const rowItems: ThreadItem[] = [];
  const shared: ThreadItem[] = [];
  const learned = new Set<string>();
  const known = (key: string): boolean => history.lifecycleKeys.has(key) || learned.has(key);
  let rowsHavePrompt = false;
  let sharedHavePrompt = false;
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index]!;
    let held = index < cut || history.ids.has(item.id);
    if (!held && (history.lifecycleKeys.size > 0 || learned.size > 0)) {
      held = sharingKeysOf(item).some(known);
    }
    if (!held) {
      rowItems.push(item);
      rowsHavePrompt ||= isPrompt(item);
      continue;
    }
    shared.push(item);
    sharedHavePrompt ||= isPrompt(item);
    for (const key of sharingKeysOf(item)) {
      if (!history.lifecycleKeys.has(key)) {
        learned.add(key);
      }
    }
  }
  return {
    source,
    history,
    cut,
    rowItems: shared.length === 0 ? source : rowItems,
    shared:
      shared.length === 0 ? NO_ITEMS : sameItems(previous.shared, shared) ? previous.shared : shared,
    rowsHavePrompt,
    sharedHavePrompt
  };
}

/**
 * Every history row — pages and bridge — projected TOGETHER, ready to sit
 * above the window.
 *
 * Memoised by the collected history, the window's shared copies and the few
 * inputs the rows read, so a streamed token in the window never touches it.
 */
export interface HistoryRowsState {
  readonly history: HistoryItemsState;
  readonly sharedLive: readonly ThreadItem[];
  /** The history's items with the window's copy of every shared one. */
  readonly items: readonly ThreadItem[];
  readonly expandedTurnIds: ReadonlySet<string> | null;
  readonly expandedWorkGroupIds: ReadonlySet<string> | null;
  readonly foldTurns: readonly Turn[] | null;
  readonly rewindOffered: boolean;
  /** The running turn as these rows were projected against ({@link HistoryLiveInput}). */
  readonly live: Required<HistoryLiveInput>;
  readonly timeline: ThreadTimelineProjection;
  readonly rowsProjection: TimelineRowsProjection | null;
  readonly stable: StableRowsState;
  readonly rows: readonly AgentChatTimelineRow[];
  readonly rowIds: ReadonlySet<string>;
  /** A row here is a live activity row: the window's tail needs no placeholder for the turn. */
  readonly hasActivityRow: boolean;
}

const NO_TASK_IDS: ReadonlySet<string> = new Set();

/** A thread with nothing running. */
const SETTLED: Required<HistoryLiveInput> = {
  unsettledTurnId: null,
  isWorking: false,
  isCompacting: false,
  activeTurnStartedAt: null,
  activeTurnHeaderHere: false,
  liveAgentTaskIds: NO_TASK_IDS
};

export const EMPTY_HISTORY_ROWS: HistoryRowsState = {
  history: EMPTY_HISTORY_ITEMS,
  sharedLive: NO_ITEMS,
  items: NO_ITEMS,
  expandedTurnIds: null,
  expandedWorkGroupIds: null,
  foldTurns: null,
  rewindOffered: false,
  live: SETTLED,
  timeline: EMPTY_TIMELINE_PROJECTION,
  rowsProjection: null,
  stable: EMPTY_STABLE_ROWS,
  rows: [],
  rowIds: new Set(),
  hasActivityRow: false
};

/**
 * The running turn, as the window's own rows read it — so a running turn's
 * rows in the history render exactly as the window renders that turn:
 * unfolded, without the settled metadata row, an in-progress call as a live
 * row, its "Working…" header right after its prompt when that prompt is
 * here. The live TAIL (the trailing live run, the "thinking" placeholder, a
 * live group) stays the window's: the timeline goes on below the history.
 * Everything defaults to a settled thread.
 */
export interface HistoryLiveInput {
  /** The turn still running (`deriveUnsettledTurnId`), or null. */
  unsettledTurnId?: string | null;
  isWorking?: boolean;
  isCompacting?: boolean;
  activeTurnStartedAt?: string | null;
  /**
   * The timeline's LAST prompt is in the history, not in the window's own rows:
   * the running turn's header renders here, after it.
   */
  activeTurnHeaderHere?: boolean;
  /**
   * Task ids of the subagents still working — read only to tell whether a
   * running turn's spawn row here is a live activity row.
   */
  liveAgentTaskIds?: ReadonlySet<string>;
}

function sameTaskIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) {
    return true;
  }
  if (left.size !== right.size) {
    return false;
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false;
    }
  }
  return true;
}

/**
 * The live input with every default filled in, keeping `previous` itself
 * when nothing moved — so an unchanged running turn never re-projects the
 * history, and a roster change that leaves the same agents working neither.
 * The task ids matter only while the turn's header is here; otherwise they
 * are dropped, and no roster change touches the history at all.
 */
function liveInputOf(
  input: HistoryLiveInput,
  previous: Required<HistoryLiveInput>
): Required<HistoryLiveInput> {
  const isWorking = input.isWorking === true;
  const activeTurnHeaderHere = isWorking && input.activeTurnHeaderHere === true;
  const tasks = activeTurnHeaderHere ? (input.liveAgentTaskIds ?? NO_TASK_IDS) : NO_TASK_IDS;
  const next: Required<HistoryLiveInput> = {
    unsettledTurnId: input.unsettledTurnId ?? null,
    isWorking,
    isCompacting: isWorking && input.isCompacting === true,
    activeTurnStartedAt: isWorking ? (input.activeTurnStartedAt ?? null) : null,
    activeTurnHeaderHere,
    liveAgentTaskIds: sameTaskIds(previous.liveAgentTaskIds, tasks) ? previous.liveAgentTaskIds : tasks
  };
  return next.unsettledTurnId === previous.unsettledTurnId &&
    next.isWorking === previous.isWorking &&
    next.isCompacting === previous.isCompacting &&
    next.activeTurnStartedAt === previous.activeTurnStartedAt &&
    next.activeTurnHeaderHere === previous.activeTurnHeaderHere &&
    next.liveAgentTaskIds === previous.liveAgentTaskIds
    ? previous
    : next;
}

export interface HistoryRowsInput extends HistoryLiveInput {
  /** Every page's items and the bridge ({@link collectHistoryItems}). */
  history: HistoryItemsState;
  /** The window's items that render with the history ({@link splitLiveItems}). */
  sharedLive: readonly ThreadItem[];
  /** The window's own disclosure sets: a fold or a group in history opens the same way. */
  expandedTurnIds: ReadonlySet<string>;
  expandedWorkGroupIds: ReadonlySet<string>;
  /**
   * The fold's turns. Unbounded — retention evicts rows, never turns — so a
   * page's turns are in it too, and "rewind to here" on a history row is
   * numbered by the same `startedTurns` order as inside the window.
   */
  turns: readonly Turn[];
  /** The adapter capability, exactly as the window reads it. */
  supportsConversationRollback: boolean;
  /**
   * The window's OWN rows hold a settled compaction ({@link hasSettledCompaction}):
   * every history row is before it, so none may offer a rewind (§5.5).
   */
  liveCompacted: boolean;
  /**
   * A Claude thread: drop the re-emitted assistant copies older hosts wrote
   * (`SplitThreadItemsOptions`) — the pages are where they live. Set by the
   * store exactly as it sets it for the window.
   */
  dropRepeatedAssistantMessages?: boolean;
}

/**
 * Withhold "rewind to here" on a PAGE prompt unless the index agrees with the
 * fold: the prompt's turn must be listed by a page, not marked
 * `rewindable: false` (a compaction came after it), and its ordinal − 1 must
 * be exactly the `revertTurnCount` the fold's turn order stamped. Withheld,
 * rather than offered and refused — or, worse, offered on the wrong turn.
 *
 * A prompt no page holds came from the window — through the bridge or the
 * cut — where the fold's own numbering always stood, so it keeps its stamp;
 * the compaction rule still reaches it by its position in the history
 * (a marker there stops the stamping) or through `liveCompacted`.
 */
function gateHistoryRewind(
  rows: readonly AgentChatTimelineRow[],
  turns: readonly ThreadHistoryTurn[],
  pageIds: ReadonlySet<string>
): AgentChatTimelineRow[] {
  const byPrompt = new Map<string, ThreadHistoryTurn>();
  for (const turn of turns) {
    if (turn.userMessageId !== null && !byPrompt.has(turn.userMessageId)) {
      byPrompt.set(turn.userMessageId, turn);
    }
  }
  return rows.map((row) => {
    if (row.kind !== "message" || row.revertTurnCount === undefined || !pageIds.has(row.message.id)) {
      return row;
    }
    const turn = byPrompt.get(row.message.id);
    if (turn !== undefined && turn.rewindable !== false && turn.ordinal - 1 === row.revertTurnCount) {
      return row;
    }
    const { revertTurnCount: _withheld, ...withheld } = row;
    return withheld;
  });
}

/**
 * The history's items with the window's (newer) copy of every shared one, in
 * the history's place; and the window's other shared rows — those before the
 * cut, and the continuations of what the history began — merged in by
 * `createdAt`, each ahead of the first history row newer than it. A
 * continuation is newer than everything a page or the bridge holds, so it
 * lands after them, where the fold's lifecycle and spawn collapses merge it
 * into the history's own row; a row the window outlived the bridge with — an
 * old prompt, an agent's launch row — lands in its place, ahead of the
 * bridge rows that came after it, so it anchors its turn and its spawn batch
 * as it did in the window.
 */
function withWindowContent(
  items: readonly ThreadItem[],
  sharedLive: readonly ThreadItem[]
): readonly ThreadItem[] {
  if (sharedLive.length === 0) {
    return items;
  }
  const windowCopy = new Map<string, ThreadItem>();
  for (const item of sharedLive) {
    windowCopy.set(item.id, item);
  }
  const replaced = new Set<string>();
  const merged = items.map((item) => {
    const copy = windowCopy.get(item.id);
    if (copy === undefined) {
      return item;
    }
    replaced.add(item.id);
    return copy;
  });
  const joining = sharedLive.filter((item) => !replaced.has(item.id));
  if (joining.length === 0) {
    return merged;
  }
  // Stable: rows with the same stamp keep the window's order.
  const byTime = [...joining].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
  );
  const result: ThreadItem[] = [];
  let next = 0;
  for (const item of merged) {
    while (next < byTime.length && byTime[next]!.createdAt < item.createdAt) {
      result.push(byTime[next]!);
      next += 1;
    }
    result.push(item);
  }
  while (next < byTime.length) {
    result.push(byTime[next]!);
    next += 1;
  }
  return result;
}

/**
 * Project the history: every page's items and the bridge (collected once,
 * see {@link collectHistoryItems}), with the window's copy of any item it
 * shares, run through the window's own row derivation as ONE timeline —
 * **never source by source**: a page is a block of the log by activity count,
 * the bridge is whatever retention dropped, any of their boundaries can fall
 * inside a turn, and a per-source projection would open that turn's group
 * and its "Worked for …" fold twice.
 *
 * Memoised on its inputs' identities; a re-derivation keeps every unchanged
 * row object (layer 3's stable rows), so a prepend, a trim or a disclosure
 * toggle re-renders only what moved. The window's projection is never
 * consulted, so its streaming fast path is exactly what it was without
 * history.
 */
export function projectHistoryRows(
  previous: HistoryRowsState,
  input: HistoryRowsInput
): HistoryRowsState {
  if (input.history.items.length === 0 && input.sharedLive.length === 0) {
    return previous.history.items.length === 0 && previous.sharedLive.length === 0
      ? previous
      : EMPTY_HISTORY_ROWS;
  }
  const rewindOffered = input.supportsConversationRollback && !input.liveCompacted;
  const live = liveInputOf(input, previous.live);
  const dropsRepeats = input.dropRepeatedAssistantMessages === true;
  const sameItemsInput =
    previous.history === input.history && previous.sharedLive === input.sharedLive;
  if (
    sameItemsInput &&
    previous.expandedTurnIds === input.expandedTurnIds &&
    previous.expandedWorkGroupIds === input.expandedWorkGroupIds &&
    previous.foldTurns === input.turns &&
    previous.rewindOffered === rewindOffered &&
    previous.live === live &&
    (previous.timeline.dropsRepeatedAssistantMessages === true) === dropsRepeats
  ) {
    return previous;
  }
  const items = sameItemsInput
    ? previous.items
    : withWindowContent(input.history.items, input.sharedLive);
  // The window's own derivation, told what the window knows of the running
  // turn and that the timeline goes on below: a running turn's rows here
  // render live, while the live tail — the trailing run, the placeholder — is
  // left to the window, which ends the timeline.
  const timeline = deriveTimelineEntriesFromItems(
    items,
    previous.timeline,
    dropsRepeats ? { dropRepeatedAssistantMessages: true } : undefined
  );
  const rowsProjection = deriveTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      latestTurn: null,
      runningTurnId: live.unsettledTurnId,
      expandedTurnIds: input.expandedTurnIds,
      expandedWorkGroupIds: input.expandedWorkGroupIds,
      isWorking: live.isWorking,
      isCompacting: live.isCompacting,
      activeTurnStartedAt: live.activeTurnStartedAt,
      checkpoints: input.history.checkpoints,
      turns: input.turns,
      supportsConversationRollback: rewindOffered,
      liveAgentTaskIds: live.liveAgentTaskIds,
      continuesBelow: true,
      activeTurnHeader: live.activeTurnHeaderHere ? "here" : "below"
    },
    previous.rowsProjection
  );
  const stable = computeStableRows(
    gateHistoryRewind(rowsProjection.rows, input.history.turns, input.history.pageIds),
    previous.stable
  );
  return {
    history: input.history,
    sharedLive: input.sharedLive,
    items,
    expandedTurnIds: input.expandedTurnIds,
    expandedWorkGroupIds: input.expandedWorkGroupIds,
    foldTurns: input.turns,
    rewindOffered,
    live,
    timeline,
    rowsProjection,
    stable,
    rows: stable.result,
    rowIds: stable === previous.stable ? previous.rowIds : new Set(stable.result.map((row) => row.id)),
    hasActivityRow: rowsProjection.hasActivityRow
  };
}

/**
 * The timeline's rows: every history row, oldest first, then the window's.
 *
 * A row id both project — a "Worked for …" fold of a turn split across the
 * boundary, say — renders ONCE, at the history's (older) position, as the
 * window's object: the window's copy is the newer, and a turn must read
 * prompt → early work → later work, never its later half first. With nothing
 * loaded the window's array is handed back as it is, so a thread without
 * history pays nothing.
 */
export function mergeTimelineRows(
  history: HistoryRowsState,
  live: AgentChatTimelineRow[]
): AgentChatTimelineRow[] {
  if (history.rows.length === 0) {
    return live;
  }
  let windowCopy: Map<string, AgentChatTimelineRow> | null = null;
  for (const row of live) {
    if (history.rowIds.has(row.id)) {
      (windowCopy ??= new Map()).set(row.id, row);
    }
  }
  if (windowCopy === null) {
    return [...history.rows, ...live];
  }
  const shared = windowCopy;
  return [
    ...history.rows.map((row) => shared.get(row.id) ?? row),
    ...live.filter((row) => !shared.has(row.id))
  ];
}

const settledCompactionCache = new WeakMap<readonly WorkLogEntry[], boolean>();

/**
 * The window holds a SETTLED compaction marker — the same test
 * `buildRevertTurnCountByUserMessageId` stops its walk at. A compaction still
 * running, or one that failed, dropped nothing. Memoised by array identity:
 * the window's work entries keep theirs across streamed tokens.
 */
export function hasSettledCompaction(entries: readonly WorkLogEntry[]): boolean {
  const cached = settledCompactionCache.get(entries);
  if (cached !== undefined) {
    return cached;
  }
  const settled = entries.some(
    (entry) =>
      (entry.sourceActivityKind === "context-compaction" ||
        entry.sourceActivityKind === "thread.state.changed") &&
      entry.compaction?.state === "compacted"
  );
  settledCompactionCache.set(entries, settled);
  return settled;
}

/** The prompt a turn was opened by, from the fold or from a loaded page. */
export function userMessageIdForTurn(
  turnId: string,
  turns: readonly Turn[],
  pages: readonly ThreadHistoryPage[]
): string | null {
  const fromFold = turns.find((turn) => turn.turnId === turnId)?.userMessageId;
  if (fromFold !== undefined) {
    return fromFold;
  }
  return historyTurns(pages).find((turn) => turn.turnId === turnId)?.userMessageId ?? null;
}

/** Whether the fold knows `turnId` as a started turn — a reverted one it does not. */
export function isStartedTurn(turns: readonly Turn[], turnId: string): boolean {
  return startedTurns(turns).some((turn) => turn.turnId === turnId);
}
