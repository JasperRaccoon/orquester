import { agentChatRoutes, decodeHistoryCursor, encodeHistoryCursor, isCompactionActivity, startedTurns, THREAD_HISTORY_MAX_TURNS, type Checkpoint, type StartedTurn, type ThreadActivityItem, type ThreadHistoryBounds, type ThreadHistoryPage, type ThreadItem, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
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
 * reported beside the rows that were read. An EMPTY page with a null cursor is such a failed read: it is what a host
 * answers where it could not plan a block or read one back whole, so it never counts as "the thread's first turn
 * reached". Reported the same way: the turns no index can read — a host without a usable one, or one whose index has
 * not caught up with this thread (`behindIndex`) — and, in the parent view, any turn of the range still without a row
 * once the walk is done, unless it stopped at the page limit (`missingTurns`, its net). A host that predates `history`
 * is read as it always was: the window alone. `agentId` names the subagent a drill-in reads: its rows keep windows of
 * their own, so where no index can read them the drill-in names its own span (`windowSpan`), whatever the parent's
 * rows say; and it has no net, because a subagent has no row in the turns it did not run in, so "no row" says nothing
 * there.
 */
export async function readOlderHistory(api: DaemonApi, sessionId: string, snap: ThreadSnapshotPayload, range: { start: number; end: number }, opts: { agentId?: string } = {}): Promise<OlderHistory> {
  const { start, end } = range;
  const bounds = snap.history;
  if (!bounds || end < start) return { snapshot: snap, unavailable: null };
  const ordered = startedTurns(snap.turns);
  // No usable index: nothing older can be read. The parent view names the range's turns with no row left in the
  // window; a drill-in, the subagent's own span — the parent's rows say nothing of the subagent's.
  if (bounds.indexed === false) return { snapshot: snap, unavailable: opts.agentId !== undefined ? windowSpan(snap, ordered, bounds, range, opts.agentId) : missingTurns(snap, ordered, range) };
  if (bounds.indexed !== true) return { snapshot: snap, unavailable: null };
  if (bounds.hasOlder !== true) return { snapshot: snap, unavailable: behindIndex(snap, ordered, bounds, range, opts.agentId) };
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
    // An empty page with no cursor is the host's answer where it could not plan a block or read one back whole: turn
    // `start` is not whole yet, and nothing was read.
    if (!page || (page.page.beforeCursor === null && page.items.length === 0)) { failed = true; break; }
    pages.push(page);
    const cursor = page.page.beforeCursor;
    if (cursor === null) { wholeFrom = 1; break; } // nothing older: the pages reach the thread's first turn
    const reached = wholeFromCursor(cursor, sessionId, ordered);
    if (reached === null) { failed = true; break; }
    wholeFrom = Math.min(wholeFrom, reached);
    before = cursor;
  }
  const merged = mergeHistoryPages(snap, pages);
  const unread: HistoryUnavailable | null = wholeFrom > start ? { turns: [start, Math.min(end, wholeFrom - 1)], reason: failed ? "unavailable" : "limit" } : null;
  // Past the page limit the walk's sentence stands alone: it names the call that reads on. A drill-in has no net: a
  // subagent has no row in the turns it did not run in, so there "no row" says nothing.
  if (unread?.reason === "limit" || opts.agentId !== undefined) return { snapshot: merged, unavailable: unread };
  // The parent view's net, whether the walk read the range whole or failed: a turn of it still without a row was not
  // read either, and joins a failed read's span.
  const missing = missingTurns(merged, ordered, range);
  return { snapshot: merged, unavailable: unread && missing ? { turns: [start, Math.max(unread.turns[1], missing.turns[1])], reason: "unavailable" } : unread ?? missing };
}

/**
 * The range's turns a host whose index has not caught up with this thread cannot page yet — it knows fewer turns than
 * the thread has, as every thread on the first start after an index rebuild does until its catch-up reaches it. Such
 * an index cannot place the window's rows, so its `hasOlder: false` means "unknown", not "nothing older", and the turns
 * up to where the window's rows begin to be whole are named (`windowSpan`). Null when the index knows every turn: then
 * `hasOlder: false` is the host's word that the window holds everything.
 */
function behindIndex(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], bounds: ThreadHistoryBounds, range: { start: number; end: number }, agentId: string | undefined): HistoryUnavailable | null {
  if (typeof bounds.totalTurns !== "number" || bounds.totalTurns >= ordered.length) return null;
  return windowSpan(snap, ordered, bounds, range, agentId);
}

/**
 * The range's turns up to where the window's rows begin to be whole, where no index can read what it dropped: the
 * window's oldest turn — `oldestRetainedOrdinal`, else, from the snapshot alone, the turn of the window's oldest
 * activity row (`windowOldestTurn`) or, for a drill-in, where the subagent's own rows begin to be whole
 * (`agentWindowOldestTurn`), either of which may be partial — and every turn of the range before it; a drill-in's from
 * the turn the subagent was launched in (`agentLaunchTurn`), since it has no row before it. Null when the range lies
 * after that turn, or nothing in the window says where it begins.
 */
function windowSpan(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], bounds: ThreadHistoryBounds, { start, end }: { start: number; end: number }, agentId: string | undefined): HistoryUnavailable | null {
  const oldest = typeof bounds.oldestRetainedOrdinal === "number" ? bounds.oldestRetainedOrdinal
    : agentId !== undefined ? agentWindowOldestTurn(snap, ordered, agentId) : windowOldestTurn(snap, ordered);
  // A subagent has no rows before the turn it was launched in: those turns are not partial, only empty.
  const from = agentId !== undefined ? Math.max(start, agentLaunchTurn(snap, ordered, agentId) ?? 1) : start;
  return oldest !== null && from <= Math.min(end, oldest) ? { turns: [from, Math.min(end, oldest)], reason: "unavailable" } : null;
}

/**
 * A row retention keeps whatever its age (`activitiesToDrop`, packages/api fold.ts), so it says nothing about where the
 * window begins: a subagent's own row (each agent keeps a window of its own), an agent's launch or end
 * (`agentKind: "agent"`), a compaction marker in either spelling (`isCompactionActivity`: a `context-compaction` row,
 * or the legacy `thread.state.changed {state: "compacted"}` an older log recorded), and an async question
 * (`responseMode: "message"`), kept while open.
 */
function keptWhateverItsAge(activity: ThreadActivityItem): boolean {
  const payload = isRecord(activity.payload) ? activity.payload : {};
  if (typeof activity.agentId === "string" && activity.agentId.length > 0) return true;
  if (isAgentAnchor(activity)) return true;
  if (isCompactionActivity(activity)) return true;
  return activity.activityKind === "user-input.requested" && payload.responseMode === "message";
}

/**
 * The turn of the window's oldest activity row — where the window begins, as far as the snapshot alone can tell. The
 * rows retention keeps whatever their age are passed over (`keptWhateverItsAge`): a thread's first agent launch or an
 * early compaction marker would otherwise name an early turn and hide every partial one after it. Else the oldest
 * activity row of any kind; null when the window holds none. A row with no turn is placed by its time (`turnOfRow`).
 */
function windowOldestTurn(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[]): number | null {
  const activities = snap.items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  const oldest = activities.find((a) => !keptWhateverItsAge(a)) ?? activities[0];
  return oldest ? turnOfRow(oldest, ordered) : null;
}

/**
 * Where a subagent's own rows begin to be whole, for a drill-in — as far as the snapshot alone can tell, by the rule
 * the parent's view uses (`windowOldestTurn`): its oldest row left. Retention keeps an agent's rows in windows of their
 * own (packages/api fold.ts `activitiesToDrop`) — its last AGENT_ACTIVITY_RETENTION_LIMIT rows, then the newest
 * AGENT_ACTIVITY_TOTAL_LIMIT across every agent by `createdAt` — and both drop the OLDEST rows first, so the rows an
 * agent keeps are its newest ones, and they can begin turns after the parent's window does. The rows cannot be counted
 * to tell whether a window is full, as the host's `windowBoundary` counts the fold's: the snapshot the host serves has
 * already dropped every `tool.updated` that a later `tool.completed` of the same call replaces
 * (`projectSnapshotActivities`), about a third of an agent's rows, so a full window never reads as full. An anchor —
 * the agent's launch or end (`agentKind: "agent"`), which Codex and OpenCode stamp with the agent's own id — is kept
 * whatever its age and says nothing. An agent with no row left lost every row it had. When its last task row
 * (`isTaskRowOf`) is its end, they all lay between its launch and that end, whose turn bounds them. Otherwise — it has
 * not ended, or was relaunched since (a resumed agent keeps its id) and may have worked on — they are bounded by the
 * oldest row any agent kept: the cross-agent window dropped everything older. Null when neither is there.
 */
function agentWindowOldestTurn(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], agentId: string): number | null {
  let own: ThreadActivityItem | undefined;
  let floor: ThreadActivityItem | undefined;
  let lastTask: ThreadActivityItem | undefined;
  for (const item of snap.items) {
    if (item.kind !== "activity") continue;
    if (isTaskRowOf(item, agentId)) lastTask = item;
    if (typeof item.agentId !== "string" || item.agentId.length === 0 || isAgentAnchor(item)) continue;
    if (own === undefined && item.agentId === agentId) own = item;
    if (floor === undefined || item.createdAt < floor.createdAt) floor = item;
  }
  const row = own ?? (lastTask?.activityKind === "task.completed" ? lastTask : floor);
  return row ? turnOfRow(row, ordered) : null;
}

/**
 * The turn a subagent or a background task was launched in: its first `task.started` row's (`isTaskRowOf`). An
 * agent's is an anchor, which retention never drops; a background task's may have aged out, and then the span starts
 * at the range's first turn. A resumed agent launches again under the same id, so the first row is the earliest
 * launch. Null when the window holds none.
 */
function agentLaunchTurn(snap: ThreadSnapshotPayload, ordered: readonly StartedTurn[], agentId: string): number | null {
  const launch = snap.items.find((item): item is ThreadActivityItem => item.kind === "activity" && item.activityKind === "task.started" && isTaskRowOf(item, agentId));
  return launch ? turnOfRow(launch, ordered) : null;
}

/**
 * Whether `item` is a launch or an end (`task.started`, `task.completed`) of the subagent or background task `agentId`.
 * Its `taskId` names the task — a parent row's (Claude) as a row stamped with the task's own id (Codex, OpenCode,
 * Grok) — while a row's stamp names its OWNER: a task Claude launched inside a subagent is stamped with that
 * subagent's id, so the stamp decides only for a row that names no task.
 */
function isTaskRowOf(item: ThreadActivityItem, agentId: string): boolean {
  if (item.activityKind !== "task.started" && item.activityKind !== "task.completed") return false;
  const taskId = isRecord(item.payload) ? item.payload.taskId : undefined;
  return typeof taskId === "string" ? taskId === agentId : item.agentId === agentId;
}

/** An agent's launch or end row (`agentKind: "agent"`): the fold keeps it whatever its age (`isAgentAnchorRow`). */
function isAgentAnchor(activity: ThreadActivityItem): boolean {
  return (activity.activityKind === "task.started" || activity.activityKind === "task.completed") && isRecord(activity.payload) && activity.payload.agentKind === "agent";
}

/**
 * The turn a row belongs to: its own, or — for a row with no turn — the last turn requested at or before it, as the
 * transcript places it; turn 1 when it is older than every turn.
 */
function turnOfRow(row: ThreadActivityItem, ordered: readonly StartedTurn[]): number {
  const own = row.turnId ? ordered.findIndex((t) => t.turnId === row.turnId) : -1;
  if (own !== -1) return own + 1;
  let requested = 0;
  while (requested < ordered.length && ordered[requested]!.requestedAt <= row.createdAt) requested += 1;
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
 * them that has rows is inside the span too). The parent view's rule, which reads any row: every turn has rows of its
 * own there, the prompt first. For a host with no usable index, `snap` is the window: those turns aged out of it whole,
 * and nothing can read them back. After a walk, it is the window with the pages merged: a turn still without a row was
 * not read, whatever the pages said.
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
