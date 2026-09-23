import { agentChatRoutes, decodeHistoryCursor, encodeHistoryCursor, startedTurns, THREAD_HISTORY_MAX_TURNS, type Checkpoint, type StartedTurn, type ThreadHistoryPage, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
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
  /** `unavailable`: the host has no usable thread index, or a page read failed. `limit`: HISTORY_PAGES_PER_READ ran out. */
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
 * ends where turn `end + 1` begins when that turn is older than the window — turn records are never evicted, so the
 * snapshot names it — else at the window's boundary; each next page ends where the one before began (its
 * `beforeCursor`), until turn `start` is whole, the thread's start is reached, or HISTORY_PAGES_PER_READ pages were read.
 * Nothing here throws for a page: a read that fails for any reason ends the walk, and the turns left unread are
 * reported beside the rows that were read. A host that predates `history` is read as it always was: the window alone.
 */
export async function readOlderHistory(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload, range: { start: number; end: number }): Promise<OlderHistory> {
  const { start, end } = range;
  const bounds = snap.history;
  if (!bounds || end < start) return { snapshot: snap, unavailable: null };
  const ordered = startedTurns(snap.turns);
  if (bounds.indexed === false) return { snapshot: snap, unavailable: missingFromWindow(snap, ordered, range) };
  const oldest = bounds.oldestRetainedOrdinal;
  if (bounds.indexed !== true || bounds.hasOlder !== true || typeof oldest !== "number" || start > oldest) return { snapshot: snap, unavailable: null };
  const after = end + 1 < oldest ? ordered[end] : undefined; // turn end + 1
  let before = after ? encodeHistoryCursor({ threadId: sessionId, beforeAnchorAt: after.requestedAt, beforeTurnId: after.turnId }) : undefined;
  // The first turn read whole, and every later one of the range with it: below turn end + 1, none of the range yet;
  // from the window, the turn after its oldest, which may be partial.
  let wholeFrom = after ? end + 1 : oldest + 1;
  const turns = String(Math.min(end - start + 1, THREAD_HISTORY_MAX_TURNS));
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
  const unavailable: HistoryUnavailable | null = wholeFrom > start ? { turns: [start, Math.min(end, wholeFrom - 1)], reason: failed ? "unavailable" : "limit" } : null;
  return { snapshot: mergeHistoryPages(snap, pages), unavailable };
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
 * The turns of the range without a single row in the window, first and last, for a host with no usable index: those
 * aged out of the window whole, and nothing can read them back.
 */
function missingFromWindow(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], { start, end }: { start: number; end: number }): HistoryUnavailable | null {
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

/** The sentence read_transcript's hint opens with when turns of its range could not be read whole (tools/messages.ts). */
export function unavailableHint({ turns: [from, to], reason }: HistoryUnavailable): string {
  const which = from === to ? `Turn ${from}` : `Turns ${from}–${to}`;
  if (reason === "unavailable") return `${which} could not be read whole: older turns are unavailable on this host right now. Try again later.`;
  return `${which} could not be read whole: one call reads at most ${HISTORY_PAGES_PER_READ} pages of older history. Read ${from === to ? "it" : "them"} with beforeTurn: ${to + 1}, turns: ${to - from + 1}.`;
}
