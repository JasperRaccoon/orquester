/**
 * Agent host — what a dead process left running, and the rows that close it
 * (spec §3.1 "a running state never outlives its process", §3.3).
 *
 * An adapter settles its own work when its session ends cleanly: Claude's
 * `closeLiveTasks` fails every call a subagent still has open and stops every
 * live task, a background shell's item before its task; Codex's
 * `closeOpenItems` fails every open item. A host that is killed — a crash, an
 * OOM, a deploy's hard stop — runs none of that, and the log keeps the calls,
 * tasks and streaming messages that process owned open for good. The fold
 * keeps their opening rows while they read open (`open-work.ts`, within its
 * caps), and a roster row with no terminal row reads running again the moment
 * a session is live. So the orchestrator appends, on a thread's first load in
 * a host lifetime, the rows its last process never wrote
 * (`closeLeftoverWork` in `orchestrator.ts`); this module derives them from
 * the folded window alone — reading the log past it is the cost the lazy boot
 * exists to avoid. The fold keeps the opening rows of open work within its
 * caps, so what a crash left open is normally in the window; a call whose
 * opening row the window no longer holds is not closed, and an older history
 * page still shows it as it was.
 *
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
 *   anchor retention never drops, like its start) and its start's owner. Calls
 *   come first, so a background shell's item closes before its task, as the
 *   adapters order it.
 * - **Every message still streaming** is settled the way ingestion finalizes
 *   one: `streaming: false` with empty text, which keeps the body, on the
 *   message's own turn, owner and badges.
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
  type ThreadFoldState,
  type ThreadMessageItem,
  type ThreadMessageSentPayload
} from "@orquester/api/agent-chat";

import { taskLinkageActivityFields } from "../ingestion/activities.ts";

/** The detail a call a dead process left open is closed with. */
export const LEFTOVER_CALL_DETAIL = "Stopped when the agent host restarted.";

/** One row that ends one unit of leftover work, ready for `buildEvent`. */
export type LeftoverClosing =
  | {
      /** `call:<toolUseId>`, `task:<taskId>` — one per unit, so a caller can skip what it closed. */
      readonly key: string;
      readonly type: "thread.activity-appended";
      readonly payload: { activity: ThreadActivityItem };
    }
  | {
      /** `message:<messageId>`. */
      readonly key: string;
      readonly type: "thread.message-sent";
      readonly payload: ThreadMessageSentPayload;
    };

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
 * The rows that close what `state` shows running: the open calls, then the
 * active tasks, then the streaming messages. `[]` when nothing is.
 *
 * The roster lists at most `ROSTER_LIMIT` rows, live ones first, so a thread
 * with more running tasks than that shows the rest only once these are
 * closed: fold these rows on and ask again, with {@link LeftoverWorkInput.closed}.
 */
export function leftoverWorkClosings(
  state: Pick<ThreadFoldState, "head" | "items" | "activities">,
  input: LeftoverWorkInput
): LeftoverClosing[] {
  const closed = input.closed ?? NOTHING_CLOSED;
  const closings: LeftoverClosing[] = [];

  for (const call of openWorkOf(state.activities).calls) {
    const key = `call:${call.toolUseId}`;
    if (closed.has(key)) continue;
    closings.push({ key, type: "thread.activity-appended", payload: { activity: callCloser(call, input) } });
  }

  const active = foldSubagentActivities(state.activities).filter((agent) =>
    ACTIVE_SUBAGENT_STATUSES.has(agent.status)
  );
  if (active.length > 0) {
    const rows = taskRowsOf(state.activities);
    // What a teardown stamps its task rows with: the turn running when the
    // process went away, if any.
    const turnId = state.head?.session.activeTurnId ?? null;
    for (const agent of active) {
      const key = `task:${agent.id}`;
      const taskRows = rows.get(agent.id);
      // The roster is folded from these very rows, so an active agent has one.
      if (closed.has(key) || taskRows === undefined) continue;
      closings.push({
        key,
        type: "thread.activity-appended",
        payload: { activity: taskCloser(agent, taskRows, turnId, input) }
      });
    }
  }

  for (const item of state.items) {
    if (item.kind !== "message" || !item.streaming) continue;
    const key = `message:${item.id}`;
    if (closed.has(key)) continue;
    closings.push({ key, type: "thread.message-sent", payload: messageSettle(item) });
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

/** The agent that owns a row — its retention class — or undefined for the parent's. */
function ownerOf(activity: ThreadActivityItem): string | undefined {
  return nonBlank(activity.agentId);
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
  const parentToolUseId = nonBlank(latest.parentToolUseId) ?? nonBlank(payload.parentToolUseId);
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

interface TaskRows {
  /** The task's first `task.started`: whose window it opened in. */
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
function taskCloser(
  agent: RuntimeSubagent,
  rows: TaskRows,
  turnId: string | null,
  input: LeftoverWorkInput
): ThreadActivityItem {
  const source = asRecord(rows.latest.payload) ?? {};
  const linkage = taskLinkageActivityFields(source);
  // The status is this row's own, and an error the last row reported is not
  // what stopped it.
  delete linkage.status;
  delete linkage.error;
  // Sticky on the roster: a row that ever named the task an agent made it one.
  linkage.agentKind = agent.agentKind;
  const owner = ownerOf(rows.start ?? rows.latest);
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
    turnId,
    ...(owner !== undefined ? { agentId: owner } : {}),
    createdAt: input.now,
    updatedAt: input.now
  };
}

/** Ingestion's `finalizeMessage` with nothing left in its buffer. */
function messageSettle(message: ThreadMessageItem): ThreadMessageSentPayload {
  return {
    messageId: message.id,
    role: message.role,
    text: "",
    streaming: false,
    turnId: message.turnId,
    ...(message.agentId !== undefined ? { agentId: message.agentId } : {}),
    ...(message.reasoningKind !== undefined ? { reasoningKind: message.reasoningKind } : {}),
    ...(message.messageKind !== undefined ? { messageKind: message.messageKind } : {})
  };
}
