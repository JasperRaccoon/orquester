import { agentChatRoutes, decodeHistoryCursor, encodeHistoryCursor, startedTurns, THREAD_HISTORY_MAX_TURNS, type Checkpoint, type StartedTurn, type ThreadActivityItem, type ThreadHistoryBounds, type ThreadHistoryPage, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import type { DaemonApi } from "./daemon-api.ts";
import { itemTurnId } from "./transcript.ts";

/**
 * The most pages of older history one read_transcript call reads. A page is a block of the log of at most 400
 * activities (the host's HISTORY_PAGE_ACTIVITIES), so one call reaches some 2 000 activities below the retained window
 * before it says what it could not read.
 */
export const HISTORY_PAGES_PER_READ = 5;

/** The turns of a read's range that could not be read whole, first and last, and why. */
export interface HistoryUnavailable {
  turns: [number, number];
  /**
   * `unavailable`: the host has no usable thread index, its index has not caught up with this thread yet, or a page
   * read failed. `limit`: HISTORY_PAGES_PER_READ ran out.
   */
  reason: "unavailable" | "limit";
}

export interface OlderHistory {
  /** The snapshot with the pages read merged under its window (`mergeHistoryPages`); the snapshot itself when none was. */
  snapshot: ThreadSnapshotPayload;
  unavailable: HistoryUnavailable | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The snapshot read_transcript builds the turns `[start, end]` from: the retained window, plus the pages of older
 * history the range needs, read from the host's thread index through the daemon's own history route. It pages only
 * when the range reaches the window's oldest turn (which may be partial) and the index holds older rows. The first page
 * ends where turn `end + 1` begins when the range ends before the window's oldest turn — turn records are never
 * evicted, so the snapshot names it — else at the window's boundary; each next page ends where the one before began
 * (its `beforeCursor`), until turn `start` is whole, the thread's start is reached, or HISTORY_PAGES_PER_READ pages were
 * read. Nothing here throws for a page: a read that fails for any reason ends the walk, and the turns left unread are
 * reported beside the rows that were read. Two more cases are reported the same way: the turns an index that has not
 * caught up with this thread cannot page yet (`behindIndex`), and — the safety net — any turn of the range still
 * without a row once the walk is done (`missingTurns`), because a host answers an empty page with a null cursor where it
 * could not plan a block or read one back whole, which the walk alone takes for "the thread's first turn reached". A
 * host that predates `history` is read as it always was: the window alone.
 */
export async function readOlderHistory(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload, range: { start: number; end: number }): Promise<OlderHistory> {
  const { start, end } = range;
  const bounds = snap.history;
  if (!bounds || end < start) return { snapshot: snap, unavailable: null };
  const ordered = startedTurns(snap.turns);
  if (bounds.indexed === false) return { snapshot: snap, unavailable: missingTurns(snap, ordered, range) };
  if (bounds.indexed !== true) return { snapshot: snap, unavailable: null };
  if (bounds.hasOlder !== true) return { snapshot: snap, unavailable: behindIndex(snap, ordered, bounds, range) };
  const oldest = bounds.oldestRetainedOrdinal;
  if (typeof oldest !== "number" || start > oldest) return { snapshot: snap, unavailable: null };
  // Turn end + 1, when the range ends before the window's oldest turn: the first page ends where it begins. Up to the
  // window's oldest turn itself — none of that turn is in the range, so its evicted rows are not waded through first.
  const after = end < oldest ? ordered[end] : undefined;
  let before = after ? encodeHistoryCursor({ threadId: sessionId, beforeAnchorAt: after.requestedAt, beforeTurnId: after.turnId }) : undefined;
  // The first turn read whole, and every later one of the range with it: below turn end + 1, none of the range yet;
  // from the window, the turn after its oldest, which may be partial.
  let wholeFrom = after ? end + 1 : oldest + 1;
  // The soft cap reaches ONE turn below `start`: the host puts `beforeSeq` in every cursor it mints, so a page capped at
  // turn start's own first line names turn start with it, and the stop rule reads one more page to see it whole. Capped
  // at turn start − 1, the page's cursor names that turn instead, and a range the 400-activity block holds is read in
  // one page. From turn 1 it asks for more turns than there are below: no cap, and the walk ends on a null cursor.
  const turns = String(Math.min(wholeFrom - start + 1, THREAD_HISTORY_MAX_TURNS));
  const pages: ThreadHistoryPage[] = [];
  let failed = false;
  while (wholeFrom > start && pages.length < HISTORY_PAGES_PER_READ) {
    const page = await readPage(api, sessionId, before === undefined ? { turns } : { before, turns });
    if (!page) { failed = true; break; }
    pages.push(page);
    const cursor = page.page.beforeCursor;
    if (cursor === null) { wholeFrom = 1; break; } // nothing older: the pages reach the thread's first turn
    const reached = wholeFromCursor(cursor, sessionId, ordered);
    if (reached === null) { failed = true; break; }
    wholeFrom = Math.min(wholeFrom, reached);
    before = cursor;
  }
  const merged = mergeHistoryPages(snap, pages);
  const unavailable: HistoryUnavailable | null = wholeFrom > start ? { turns: [start, Math.min(end, wholeFrom - 1)], reason: failed ? "unavailable" : "limit" } : missingTurns(merged, ordered, range);
  return { snapshot: merged, unavailable };
}

/**
 * The range's turns a host whose index has not caught up with this thread cannot page yet — it knows fewer turns than
 * the thread has, as every thread on the first start after an index rebuild does until its catch-up reaches it. Such
 * an index cannot place the window's rows, so its `hasOlder: false` means "unknown", not "nothing older", and the turns
 * up to the window's oldest one — `oldestRetainedOrdinal`, else the turn of the window's oldest activity row
 * (`windowOldestTurn`), which may be partial — are named. Null when the index knows every turn: then `hasOlder: false`
 * is the host's word that the window holds everything.
 */
function behindIndex(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], bounds: ThreadHistoryBounds, { start, end }: { start: number; end: number }): HistoryUnavailable | null {
  if (typeof bounds.totalTurns !== "number" || bounds.totalTurns >= ordered.length) return null;
  const oldest = typeof bounds.oldestRetainedOrdinal === "number" ? bounds.oldestRetainedOrdinal : windowOldestTurn(snap, ordered);
  return oldest !== null && start <= oldest ? { turns: [start, Math.min(end, oldest)], reason: "unavailable" } : null;
}

/**
 * A row retention keeps whatever its age (`activitiesToDrop`, packages/api fold.ts), so it says nothing about where the
 * window begins: a subagent's own row (each agent keeps a window of its own), an agent's launch or end
 * (`agentKind: "agent"`), a compaction marker, and an async question (`responseMode: "message"`), kept while open.
 */
function keptWhateverItsAge(activity: ThreadActivityItem): boolean {
  const payload = isRecord(activity.payload) ? activity.payload : {};
  if (typeof activity.agentId === "string" && activity.agentId.length > 0) return true;
  if ((activity.activityKind === "task.started" || activity.activityKind === "task.completed") && payload.agentKind === "agent") return true;
  if (activity.activityKind === "context-compaction") return true;
  return activity.activityKind === "user-input.requested" && payload.responseMode === "message";
}

/**
 * The turn of the window's oldest activity row — where the window begins, as far as the snapshot alone can tell. The
 * rows retention keeps whatever their age are passed over (`keptWhateverItsAge`): a thread's first agent launch or an
 * early compaction marker would otherwise name an early turn and hide every partial one after it. Else the oldest
 * activity row of any kind; null when the window holds none. A row with no turn is placed by its time, as the
 * transcript places it: in the last turn requested at or before it, turn 1 when it is older than every turn.
 */
function windowOldestTurn(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[]): number | null {
  const activities = snap.items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  const oldest = activities.find((a) => !keptWhateverItsAge(a)) ?? activities[0];
  if (!oldest) return null;
  const own = oldest.turnId ? ordered.findIndex((t) => t.turnId === oldest.turnId) : -1;
  if (own !== -1) return own + 1;
  let requested = 0;
  while (requested < ordered.length && ordered[requested]!.requestedAt <= oldest.createdAt) requested += 1;
  return Math.max(1, requested);
}

/**
 * The first turn a page holds whole, read off the cursor of the page below it — which ends where this one begins: at
 * the start of the turn `k` the cursor names, so `k` is whole; or, with `beforeSeq`, inside it, so `k + 1` is. The walk
 * stops once that reaches turn `start`, which is the design's rule: `k <= start` without `beforeSeq`, `k < start` with
 * it. Null for a cursor that names no started turn of this thread: nothing below it can be placed.
 */
function wholeFromCursor(cursor: string, sessionId: string, ordered: readonly StartedTurn[]): number | null {
  const decoded = decodeHistoryCursor(cursor, sessionId);
  const k = decoded ? ordered.findIndex((t) => t.turnId === decoded.beforeTurnId) + 1 : 0;
  if (!decoded || k === 0) return null;
  return decoded.beforeSeq === undefined ? k : k + 1;
}

/** One page, or null when its read failed for any reason: an error status, a thrown call, a body that is not a page. */
async function readPage(api: DaemonApi, sessionId: string, query: Record<string, string>): Promise<ThreadHistoryPage | null> {
  try {
    const res = await api.request("GET", agentChatRoutes.history(sessionId), { query });
    return res.status < 400 ? asPage(res.body) : null;
  } catch (error) {
    // A thrown call's text can name a host path: it is logged here and never returned, as sendCommand does.
    console.error("[mcp] daemon call failed", error);
    return null;
  }
}

/**
 * A page's row with what the merge and the transcript read of it: an id and a stamp, and a message's role and text or
 * an activity's kind and summary. The host builds a page's rows as it builds a snapshot's; one without them is dropped,
 * never read into a failed call.
 */
function isRow(item: unknown): item is ThreadItem {
  if (!isRecord(item) || typeof item.id !== "string" || typeof item.createdAt !== "string") return false;
  if (item.kind === "message") return typeof item.role === "string" && typeof item.text === "string";
  return item.kind === "activity" && typeof item.activityKind === "string" && typeof item.summary === "string";
}

/** The body as a page, or null when it is not one: the walk needs `page.beforeCursor`. */
function asPage(body: unknown): ThreadHistoryPage | null {
  if (!isRecord(body) || !Array.isArray(body.items) || !isRecord(body.page)) return null;
  const cursor = body.page.beforeCursor;
  if (cursor !== null && typeof cursor !== "string") return null;
  const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints.filter((cp): cp is Checkpoint => isRecord(cp) && Array.isArray(cp.files) && typeof cp.completedAt === "string") : [];
  return { ...(body as unknown as ThreadHistoryPage), items: body.items.filter(isRow), checkpoints };
}

/**
 * The span of the range's turns without a single row in `snap`, from the first such turn to the last (a turn between
 * them that has rows is inside the span too). For a host with no usable index, `snap` is the window: those turns aged
 * out of it whole, and nothing can read them back. After a walk, it is the window with the pages merged: a turn still
 * without a row was not read, whatever the pages said.
 */
function missingTurns(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], { start, end }: { start: number; end: number }): HistoryUnavailable | null {
  const turnIdOf = itemTurnId(ordered);
  const present = new Set<string>();
  for (const item of snap.items) {
    const id = turnIdOf(item);
    if (id) present.add(id);
  }
  let first = 0;
  let last = 0;
  for (let n = start; n <= end; n += 1) {
    if (present.has(ordered[n - 1]!.turnId)) continue;
    if (!first) first = n;
    last = n;
  }
  return first ? { turns: [first, last], reason: "unavailable" } : null;
}

/** `rows` sorted by the stamp `at` reads, stably (Array.prototype.sort is), compared as the transcript compares stamps. */
function byTime<T>(rows: T[], at: (row: T) => string): T[] {
  return rows.sort((x, y) => (at(x) < at(y) ? -1 : at(x) > at(y) ? 1 : 0));
}

/**
 * The snapshot with the rows of `pages` — newest block first, as they were read — merged under its window: items by id,
 * the pages' first, oldest page first so a row two pages repeat keeps the newer page's copy, and the window's copy
 * winning, as it is the newer state of the same row; then a stable sort by `createdAt`, which puts the rows in log
 * order, so the transcript folds a tool call from its start. Checkpoints the same way, keyed by turn id (a page's
 * checkpoint without one is never read, so it is not kept). Pure; the snapshot itself when there are no pages.
 */
export function mergeHistoryPages(snap: ThreadSnapshotPayload, pages: readonly Pick<ThreadHistoryPage, "items" | "checkpoints">[]): ThreadSnapshotPayload {
  if (pages.length === 0) return snap;
  const items = new Map<string, ThreadItem>();
  const checkpoints = new Map<string, Checkpoint>();
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    for (const item of pages[i]!.items) items.set(item.id, item);
    for (const cp of pages[i]!.checkpoints) if (cp.turnId) checkpoints.set(cp.turnId, cp);
  }
  for (const item of snap.items) items.set(item.id, item);
  const turnless: Checkpoint[] = [];
  for (const cp of snap.checkpoints) {
    if (cp.turnId) checkpoints.set(cp.turnId, cp);
    else turnless.push(cp);
  }
  return {
    ...snap,
    items: byTime([...items.values()], (item) => item.createdAt),
    checkpoints: byTime([...checkpoints.values(), ...turnless], (cp) => cp.completedAt)
  };
}

/**
 * The sentence read_transcript's hint opens with when turns of its range could not be read whole (tools/messages.ts);
 * `end` is the range's last turn. Past the page limit, the call that reads the turns left always ends before this
 * one's end, so following the hints never asks for the same range twice. When the walk never got out of turn `end`,
 * that turn alone is more than one call reads — asking for it again would read the same pages — so the hint says its
 * latest rows are what there is, and names the call for the turns before it.
 */
export function unavailableHint({ turns: [from, to], reason }: HistoryUnavailable, end: number): string {
  const which = from === to ? `Turn ${from}` : `Turns ${from}–${to}`;
  if (reason === "unavailable") return `${which} could not be read whole: older turns are unavailable on this host right now. Try again later.`;
  if (to < end) return `${which} could not be read whole: one call reads at most ${HISTORY_PAGES_PER_READ} pages of older history. Read ${from === to ? "it" : "them"} with beforeTurn: ${to + 1}, turns: ${to - from + 1}.`;
  const large = `Turn ${to} is larger than one call reads (${HISTORY_PAGES_PER_READ} pages of older history): its latest rows are returned.`;
  if (from === to) return large;
  return `${large} Read ${to - from === 1 ? `turn ${from}` : `turns ${from}–${to - 1}`} with beforeTurn: ${to}, turns: ${to - from}.`;
}
