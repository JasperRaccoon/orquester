/**
 * The stream's bounded snapshot: which rows of the retained window a cold
 * `snapshot` frame leaves to "load older" (`GET …/history`).
 *
 * The fold keeps up to 2 000 messages and 500 parent activities (plus every
 * agent's own), and a cold stream used to send all of it in one line — 4 MiB on
 * a long thread, which a lossy mobile link restarts from zero every time it
 * drops. The window a client paints first needs only the latest turns; the
 * rest is already reachable as history pages, which are blocks of the LOG
 * ending below a cursor (`planHistoryBlock`). So the frame keeps the newest
 * turns whole and drops, of the settled turns before them, exactly the rows a
 * history page serves and nothing the client derives live state from. The
 * fold, `state.json`, the fold snapshot and the log are untouched: this is a
 * read-time projection, like the §5.6 slimming it runs after.
 *
 * Two halves, both pure:
 * - {@link wireWindowCut} picks the oldest turn the frame keeps whole: the
 *   newest {@link WIRE_WINDOW_MAX_TURNS} started turns, fewer once their rows
 *   pass {@link WIRE_WINDOW_BUDGET_BYTES}, never fewer than
 *   {@link WIRE_WINDOW_MIN_TURNS}, and never past a turn that has not settled;
 * - {@link trimToWireWindow} drops the rows of the turns before it that are
 *   not protected and that the caller places wholly below the cut in the log
 *   (`below` — the host asks the thread index). What stays protected, and
 *   why:
 *   - a turnless row (bar a prompt, which belongs to the turn that names it),
 *     and any row of a kept or unknown turn;
 *   - a subagent's row (`isAgentOwnedActivity`, a message's `agentId`), and an
 *     output chunk of a call a subagent owns: an agent's drill-in reads the
 *     window and never the history, so its rows have no other way in;
 *   - every `task.*` and `tool.progress` row: the client re-derives the roster
 *     from the activities it holds (`createRosterEngine`), and a launch row
 *     anchors its agent on the timeline;
 *   - every row of a request no `*.resolved` row closed: the client
 *     re-derives pending approvals and questions from the rows it holds. A
 *     resolved request's rows go like any row; its tombstone goes with them,
 *     exactly as when retention evicts them;
 *   - compaction markers ("rewind to here" and the divider read them) and
 *     goal rows;
 *   - every row of a call or a background task still open (`openWorkOf`);
 *   - the newest parent row of each activity kind and the newest parent
 *     message of each role: whatever "latest of" reading a surface makes —
 *     the plan checklist, the context meter — answers what it answered;
 *   - a call is dropped whole or kept whole: one kept row keeps all of its.
 *
 * The cut's cursor is one the history route already honours (`blockCursor`,
 * a `beforeSeq` at the kept turn's first line), so a client of any version
 * pages the dropped turns back exactly as it pages rows retention evicted —
 * merging above what it holds and rendering a row it already has once.
 */

import {
  CALL_CLOSER_KINDS,
  CALL_OPENER_KINDS,
  isAgentOwnedActivity,
  isCompactionActivity,
  openWorkOf,
  REQUEST_ACTIVITY_KINDS,
  SETTLED_TURN_STATES,
  startedTurns,
  type StartedTurn,
  type ThreadActivityItem,
  type ThreadItem,
  type Turn
} from "@orquester/api/agent-chat";

/** At most this many started turns are sent whole; older ones are a "load older" away. */
export const WIRE_WINDOW_MAX_TURNS = 10;
/** At least this many, whatever their size: the turn the user is on and the one before it. */
export const WIRE_WINDOW_MIN_TURNS = 2;
/**
 * Past this many bytes of the kept turns' trimmable rows (slimmed, as JSON), no
 * older turn is added. Measured per turn, so the turn that crosses it is still
 * kept whole; a turn is never split.
 */
export const WIRE_WINDOW_BUDGET_BYTES = 512 * 1024;

/** Where the frame's window begins ({@link wireWindowCut}). */
export interface WireWindowCut {
  /** The oldest started turn the frame keeps whole. */
  oldestKept: StartedTurn;
  /** The settled turns before it, whose unprotected rows may go. */
  trimmable: ReadonlySet<string>;
  /**
   * The turn a row belongs to: its own, or — for a prompt, which is written
   * before its turn has an id — the started turn that names it as its
   * `userMessageId`. Null for any other turnless row.
   */
  turnOf(item: ThreadItem): string | null;
}

/**
 * The oldest turn the frame keeps, and the turns before it; null when every
 * started turn is kept. `items` are the slimmed rows, sized as they go out.
 */
export function wireWindowCut(turns: readonly Turn[], items: readonly ThreadItem[]): WireWindowCut | null {
  const started = startedTurns(turns);
  if (started.length <= WIRE_WINDOW_MIN_TURNS) {
    return null;
  }
  // Nothing at or after an unsettled turn goes: its rows are live.
  let floor = started.length;
  for (let index = 0; index < started.length; index += 1) {
    if (!SETTLED_TURN_STATES.has(started[index]!.state)) {
      floor = index;
      break;
    }
  }
  const startedIds = new Set(started.map((turn) => turn.turnId));
  const promptTurn = new Map<string, string>();
  for (const turn of started) {
    if (turn.userMessageId !== undefined) promptTurn.set(turn.userMessageId, turn.turnId);
  }
  const turnOf = (item: ThreadItem): string | null =>
    item.turnId ?? (item.kind === "message" && item.role === "user" ? (promptTurn.get(item.id) ?? null) : null);
  const bytesByTurn = new Map<string, number>();
  for (const item of items) {
    const turnId = turnOf(item);
    if (turnId === null || !startedIds.has(turnId) || ownedByAgent(item)) continue;
    bytesByTurn.set(turnId, (bytesByTurn.get(turnId) ?? 0) + JSON.stringify(item).length);
  }
  let oldest = started.length;
  let kept = 0;
  let bytes = 0;
  while (oldest > 0) {
    if (kept >= WIRE_WINDOW_MIN_TURNS && (kept >= WIRE_WINDOW_MAX_TURNS || bytes >= WIRE_WINDOW_BUDGET_BYTES)) {
      break;
    }
    oldest -= 1;
    kept += 1;
    bytes += bytesByTurn.get(started[oldest]!.turnId) ?? 0;
  }
  oldest = Math.min(oldest, floor);
  if (oldest === 0) {
    return null;
  }
  return {
    oldestKept: started[oldest]!,
    trimmable: new Set(started.slice(0, oldest).map((turn) => turn.turnId)),
    turnOf
  };
}

/**
 * `items` without the trimmable rows `below` places wholly under the cut —
 * see the module doc for what is never trimmed. Null when nothing goes.
 */
export function trimToWireWindow(
  items: readonly ThreadItem[],
  cut: Pick<WireWindowCut, "trimmable" | "turnOf">,
  below: (item: ThreadItem) => boolean
): ThreadItem[] | null {
  const activities = items.filter((item): item is ThreadActivityItem => item.kind === "activity");
  const open = openWorkOf(activities);
  const openCalls = new Set(open.calls.map((call) => call.toolUseId));
  const openTasks = new Set(open.tasks.map((task) => task.taskId));
  // A subagent's calls: an unstamped output chunk of one is the agent's (`agentItemFilter`).
  const agentCalls = new Set<string>();
  for (const activity of activities) {
    const callId = idIn(activity, "toolUseId");
    if (callId !== null && isCallLifecycle(activity) && isAgentOwnedActivity(activity)) {
      agentCalls.add(callId);
    }
  }
  // Requests no `*.resolved` row closed: the client re-derives pending cards from these rows.
  const resolved = new Set<string>();
  for (const activity of activities) {
    const requestId = requestIdOf(activity);
    if (requestId !== null && activity.activityKind.endsWith(".resolved")) resolved.add(requestId);
  }
  // The newest parent row of each kind and the newest parent message of each role.
  const newest = new Set<ThreadItem>();
  const seen = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (ownedByAgent(item)) continue;
    const key = item.kind === "activity" ? `activity:${item.activityKind}` : `message:${item.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      newest.add(item);
    }
  }
  const isProtected = (item: ThreadItem): boolean => {
    if (ownedByAgent(item) || newest.has(item)) return true;
    if (item.kind === "message") return false;
    const kind = item.activityKind;
    if (kind.startsWith("task.") || kind === "tool.progress" || kind.startsWith("goal.") || isCompactionActivity(item)) {
      return true;
    }
    if (REQUEST_ACTIVITY_KINDS.has(kind)) {
      const requestId = requestIdOf(item);
      return requestId === null || !resolved.has(requestId);
    }
    const callId = idIn(item, "toolUseId");
    if (callId !== null && (openCalls.has(callId) || agentCalls.has(callId))) return true;
    const taskId = idIn(item, "taskId");
    return taskId !== null && openTasks.has(taskId);
  };

  const dropped = new Set<ThreadItem>();
  for (const item of items) {
    const turnId = cut.turnOf(item);
    if (turnId === null || !cut.trimmable.has(turnId) || isProtected(item)) continue;
    if (below(item)) dropped.add(item);
  }
  if (dropped.size === 0) {
    return null;
  }
  // A call goes whole or not at all: one row it keeps keeps every row of it.
  const keptCalls = new Set<string>();
  for (const activity of activities) {
    if (dropped.has(activity)) continue;
    const callId = idIn(activity, "toolUseId");
    if (callId !== null) keptCalls.add(callId);
  }
  for (const item of dropped) {
    if (item.kind !== "activity") continue;
    const callId = idIn(item, "toolUseId");
    if (callId !== null && keptCalls.has(callId)) dropped.delete(item);
  }
  return dropped.size === 0 ? null : items.filter((item) => !dropped.has(item));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idIn(activity: ThreadActivityItem, key: "toolUseId" | "taskId"): string | null {
  const id = asRecord(activity.payload)?.[key];
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

function requestIdOf(activity: ThreadActivityItem): string | null {
  const id = asRecord(activity.payload)?.requestId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isCallLifecycle(activity: ThreadActivityItem): boolean {
  return CALL_OPENER_KINDS.has(activity.activityKind) || CALL_CLOSER_KINDS.has(activity.activityKind);
}

/** A subagent's row: it renders only in that agent's drill-in, which reads the window alone. */
function ownedByAgent(item: ThreadItem): boolean {
  return item.kind === "activity"
    ? isAgentOwnedActivity(item)
    : typeof item.agentId === "string" && item.agentId.trim().length > 0;
}
