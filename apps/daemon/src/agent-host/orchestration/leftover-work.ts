/**
 * Agent host — what a dead process left running, and the rows that close it
 * (spec §3.1 "a running state never outlives its process", §3.3).
 *
 * An adapter settles its own work when its session ends cleanly: it fails
 * every parked request first (Claude's `cancelPendingRequests`, Codex's
 * `failPendingRequests`, Grok's and OpenCode's settle), then Claude's
 * `closeLiveTasks` fails every call a subagent still has open and stops every
 * live task, a background shell's item before its task, and Codex's
 * `closeOpenItems` fails every open item. A host that is killed — a crash, an
 * OOM, a deploy's hard stop — runs none of that, and the log keeps the
 * requests, calls and tasks that process owned open for good. A card nobody can
 * answer blocks the composer ("Answer the request above first") and the MCP's
 * `send_message`; the fold keeps a call's opening row while it reads open
 * (`open-work.ts`, within its caps); a roster row with no terminal row reads
 * running again the moment a session is live. So the orchestrator appends, on
 * a thread's first load in a host lifetime, the rows its last process never
 * wrote (`closeLeftoverWork` in `orchestrator.ts`); this module derives them
 * from the folded window alone — reading the log past it is the cost the lazy
 * boot exists to avoid. The fold keeps the opening rows of open work within
 * its caps, so what a crash left open is normally in the window; a call whose
 * opening row the window no longer holds is not closed, and an older history
 * page still shows it as it was.
 *
 * - **Every request the fold shows pending but a message-mode question** —
 *   every approval, every structured question — is cancelled first, the way
 *   the host cancels one itself on a Stop: `settlePendingRequests`' own row
 *   ("Request cancelled", "Question cancelled", `cancelledRequestActivity` in
 *   `events.ts`) on the turn the head says is running, never the provider's
 *   "resolved"/"submitted" rows the adapters' teardown leads to, which would
 *   say someone answered. The fold then closes it for good
 *   (`closedRequestIds`), and its card with it. A message-mode question
 *   (`responseMode: "message"`) stays pending, where a Stop would cancel it
 *   too: it parked no request, may outlive its turn by design, and a later
 *   user message answers it.
 * - **Every open call** ({@link openWorkOf}) gets a `tool.completed`, `failed`
 *   as both adapters' teardown writes it, with {@link LEFTOVER_CALL_DETAIL}.
 *   Item type, title, turn, owner, parent call and data are its latest
 *   lifecycle row's: the turn and the call id are what the GUI collapses a
 *   call's rows on, and the owner is its retention class — a closer in
 *   another class than the call's opener can leave the window first, and the
 *   call reads open again. The data rides along because a completion carries
 *   a call's final state: the snapshot read drops every `tool.updated` a later
 *   completion supersedes (`dropSupersededToolUpdatedActivities`), so a closer
 *   without it would take a call's input off every cold load.
 * - **Every task the roster shows active** — `pending`, `running`, `waiting`,
 *   the statuses the fold's session-death rule interrupts, any agent kind —
 *   gets a `task.completed {status: "stopped"}`. `idle` is left alone, as that
 *   rule leaves it: a resumable child stays resumable. The row carries the
 *   task's linkage bundle as its latest row has it (so the roster's title does
 *   not move back), the roster's own `agentKind` (an agent's closer is an
 *   anchor retention never drops, like its start), its start's owner, and its
 *   start's turn — a rewind keeps or drops a row by its turn (`reduceReverted`),
 *   so a closer on any other turn could go with a rewind that keeps the start,
 *   and the agent would read running again. Calls come before tasks, so a
 *   background shell's item closes before its task, as the adapters order it.
 *
 * **A message still `streaming: true` is left as the log has it.** Every
 * `thread.message-sent` moves the message's span in the thread index to its
 * line (`updateMessageDoc`), and a history page never splits a streamed
 * message (`outsideMessages` in `orchestrator.ts`), so a settle appended here
 * would stretch an old message's span to the end of the log: the first page
 * would end at its first chunk, and every row between that chunk and the
 * window would be on neither. How a stream no process can continue reads is
 * its readers' to decide.
 *
 * A closer is a new activity id, so nothing it writes spans the log; its turn
 * may be an old one, and the index then grows that turn's range over it — the
 * late-reference rule, bounded at `MAX_LATE_REFERENCE_BYTES` past the next
 * turn's start (`extendReferenced` in `index/indexer.ts`), which pages over
 * without losing a row. As with every late reference, a later rewind that
 * keeps that turn and drops the ones after it brings the dropped turns' rows
 * inside the stretch back onto a history page: the revert-cut filter
 * (`eventsOutsideRevertCuts`) keeps whatever lies in a surviving turn's range.
 *
 * Pure: no clock, no ids, no I/O of its own — the caller hands in both.
 */

import {
  ACTIVE_SUBAGENT_STATUSES,
  foldSubagentActivities,
  openWorkOf,
  type OpenCall,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadFoldState
} from "@orquester/api/agent-chat";

import { taskLinkageActivityFields } from "../ingestion/activities.ts";
import { cancelledRequestActivity } from "./events.ts";

/** The detail a call a dead process left open is closed with. */
export const LEFTOVER_CALL_DETAIL = "Stopped when the agent host restarted.";

/** One row that ends one unit of leftover work: a `thread.activity-appended` payload's activity. */
export interface LeftoverClosing {
  /**
   * `request:<requestId>`, `call:<toolUseId>` or `task:<taskId>` — one per
   * unit, so a caller can skip what it closed.
   */
  readonly key: string;
  readonly activity: ThreadActivityItem;
  /** The request a resolution closes: its event's `metadata.requestId`, as the host's own settle writes it. */
  readonly requestId?: string;
}

export interface LeftoverWorkInput {
  /** Stamped on every row. */
  readonly now: string;
  /** A fresh activity id, asked once per row. */
  readonly nextId: () => string;
  /** Keys of units already closed: a later pass skips them. */
  readonly closed?: ReadonlySet<string>;
}

const NOTHING_CLOSED: ReadonlySet<string> = new Set();

const TASK_ROW_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed"
]);

/**
 * The rows that close what `state` shows running: the parked requests, then
 * the open calls, then the active tasks. `[]` when nothing is.
 *
 * The roster lists at most `ROSTER_LIMIT` rows, live ones first, so a thread
 * with more running tasks than that shows the rest only once these are
 * closed: fold these rows on and ask again, with {@link LeftoverWorkInput.closed}.
 */
export function leftoverWorkClosings(
  state: Pick<ThreadFoldState, "head" | "activities" | "pending">,
  input: LeftoverWorkInput
): LeftoverClosing[] {
  const closed = input.closed ?? NOTHING_CLOSED;
  const closings: LeftoverClosing[] = [];

  // First, as a teardown settles them before anything else; approvals, then
  // questions, as `settlePendingRequests` lists them.
  const parked: ParkedRequest[] = [
    ...(state.pending?.approvals ?? []).map((approval) => ({
      requestId: approval.requestId,
      kind: "approval" as const
    })),
    ...(state.pending?.userInputs ?? [])
      .filter((question) => question.responseMode !== "message")
      .map((question) => ({ requestId: question.requestId, kind: "question" as const }))
  ];
  // The turn a Stop cancels its requests in: the one the head says is running.
  const turnId = state.head?.session.activeTurnId ?? null;
  for (const request of parked) {
    const key = `request:${request.requestId}`;
    if (closed.has(key)) continue;
    closings.push({
      key,
      requestId: request.requestId,
      activity: cancelledRequestActivity({ ...request, turnId, createdAt: input.now })
    });
  }

  for (const call of openWorkOf(state.activities).calls) {
    const key = `call:${call.toolUseId}`;
    if (closed.has(key)) continue;
    closings.push({ key, activity: callCloser(call, input) });
  }

  const active = foldSubagentActivities(state.activities).filter((agent) =>
    ACTIVE_SUBAGENT_STATUSES.has(agent.status)
  );
  if (active.length > 0) {
    const rows = taskRowsOf(state.activities);
    for (const agent of active) {
      const key = `task:${agent.id}`;
      const taskRows = rows.get(agent.id);
      // The roster is folded from these very rows, so an active agent has one.
      if (closed.has(key) || taskRows === undefined) continue;
      closings.push({ key, activity: taskCloser(agent, taskRows, input) });
    }
  }
  return closings;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** An id as the fold reads one: any non-empty string, blank or not. */
function presentId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The agent that owns a row — its retention class — or undefined for the
 * parent's: the fold's own rule (`fold.ts` `ownerOf`), so a closer lands in
 * exactly the class the fold gives the row it closes.
 */
function ownerOf(activity: ThreadActivityItem): string | undefined {
  return presentId(activity.agentId);
}

/** `item.completed`'s row, as ingestion writes one, for a call nothing will complete. */
function callCloser(call: OpenCall, input: LeftoverWorkInput): ThreadActivityItem {
  const latest = call.latestLifecycle;
  const payload = asRecord(latest.payload) ?? {};
  const opening = asRecord(call.opening.payload) ?? {};
  const itemType = nonBlank(payload.itemType) ?? nonBlank(opening.itemType);
  const title = nonBlank(payload.title) ?? nonBlank(opening.title);
  const data = payload.data ?? opening.data;
  const owner = ownerOf(latest);
  const parentToolUseId = presentId(latest.parentToolUseId) ?? presentId(payload.parentToolUseId);
  return {
    kind: "activity",
    id: input.nextId(),
    tone: "tool",
    activityKind: "tool.completed",
    summary: title ?? "Tool",
    payload: {
      ...(itemType !== undefined ? { itemType } : {}),
      toolUseId: call.toolUseId,
      status: "failed",
      ...(title !== undefined ? { title } : {}),
      detail: LEFTOVER_CALL_DETAIL,
      ...(data !== undefined ? { data } : {}),
      ...(owner !== undefined ? { agentId: owner } : {}),
      ...(parentToolUseId !== undefined ? { parentToolUseId } : {})
    },
    turnId: latest.turnId,
    ...(owner !== undefined ? { agentId: owner } : {}),
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
    status: "failed",
    createdAt: input.now,
    updatedAt: input.now
  };
}

/** A request the fold shows pending that no process of this host can answer. */
interface ParkedRequest {
  readonly requestId: string;
  readonly kind: "approval" | "question";
}

interface TaskRows {
  /** The task's first `task.started`: whose window and turn it opened in. */
  start: ThreadActivityItem | undefined;
  /** Its newest `task.*` row: the linkage bundle as it now stands. */
  latest: ThreadActivityItem;
}

/** Each task's rows, by the trimmed id the roster keys it on. One pass. */
function taskRowsOf(activities: readonly ThreadActivityItem[]): Map<string, TaskRows> {
  const rows = new Map<string, TaskRows>();
  for (const activity of activities) {
    if (!TASK_ROW_KINDS.has(activity.activityKind)) continue;
    const taskId = nonBlank(asRecord(activity.payload)?.taskId)?.trim();
    if (taskId === undefined) continue;
    const known = rows.get(taskId);
    if (known === undefined) {
      rows.set(taskId, {
        start: activity.activityKind === "task.started" ? activity : undefined,
        latest: activity
      });
      continue;
    }
    if (known.start === undefined && activity.activityKind === "task.started") {
      known.start = activity;
    }
    known.latest = activity;
  }
  return rows;
}

/** `task.completed {status: "stopped"}`, as a teardown's `closeLiveTasks` writes it. */
function taskCloser(agent: RuntimeSubagent, rows: TaskRows, input: LeftoverWorkInput): ThreadActivityItem {
  const source = asRecord(rows.latest.payload) ?? {};
  const linkage = taskLinkageActivityFields(source);
  // The status is this row's own, and an error the last row reported is not
  // what stopped it.
  delete linkage.status;
  delete linkage.error;
  // Sticky on the roster: a row that ever named the task an agent made it one.
  linkage.agentKind = agent.agentKind;
  // The row that opened the task decides both the window and the turn the
  // stop rides; without one in the window, its latest row does.
  const opener = rows.start ?? rows.latest;
  const owner = ownerOf(opener);
  return {
    kind: "activity",
    id: input.nextId(),
    tone: "info",
    activityKind: "task.completed",
    summary: "Task stopped",
    payload: {
      // The rows' own spelling: `openWorkOf` keys a task on it untrimmed.
      taskId: nonBlank(asRecord(rows.start?.payload)?.taskId) ?? nonBlank(source.taskId) ?? agent.id,
      status: "stopped",
      ...linkage
    },
    turnId: opener.turnId,
    ...(owner !== undefined ? { agentId: owner } : {}),
    createdAt: input.now,
    updatedAt: input.now
  };
}
