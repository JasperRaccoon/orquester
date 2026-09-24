/**
 * Agent chat — the work a thread still has running, read off its activity
 * list: the tool calls no row has closed yet, and the background tasks (a
 * shell, a watch loop) with no `task.completed`.
 *
 * Each open unit has an OPENING row, the one row that says what the work is:
 * a call's title and command, a shell's description. The fold's retention
 * trim keeps it while the work runs, for the most recently active units
 * (`fold.ts`, `OPEN_WORK_RETENTION_LIMIT`) — a long command's own output
 * chunks used to push it out of the window — and the MCP's snapshot-only
 * history reads pass it over as a row kept whatever its age
 * (`apps/daemon/src/mcp/history.ts`).
 *
 * - A **call** is keyed by its non-blank `payload.toolUseId`. It is open while
 *   the list holds one of its {@link CALL_OPENER_KINDS} rows and none of its
 *   {@link CALL_CLOSER_KINDS} rows: a closer ends it for good, whatever
 *   follows. Its opening row is its first opener in list order, its latest
 *   lifecycle row its newest opener, and its last activity the position of
 *   its newest `tool.*` row — a streamed `tool.output` chunk included, so a
 *   call still printing reads as active and one a crash left open does not.
 * - A **background task** is keyed by its non-blank `payload.taskId`. It is
 *   open while the list holds a `task.started` of it that is not an agent's
 *   (`agentKind: "agent"` — an agent's launch is an anchor retention keeps
 *   anyway; an unstamped row is background, as the roster reads it) and no
 *   `task.completed` of it. Its opening row is that `task.started`, the first
 *   should there be several; its last activity the position of its newest
 *   `task.*` row or of the newest row it owns (`agentId` equal to the task id:
 *   a Claude shell's own `bgshell:<taskId>` output rows).
 *
 * Positions are indexes into the list given. Pure, one pass, no Node APIs:
 * `@orquester/api` is shared with the browser.
 */

import type { ThreadActivityItem } from "./thread.ts";

/** The lifecycle kinds that open a call: the first one in list order is its opening row. */
export const CALL_OPENER_KINDS: ReadonlySet<string> = new Set(["tool.started", "tool.updated"]);

/** The lifecycle kinds that close a call: a denied call never ran, a completed one is over. */
export const CALL_CLOSER_KINDS: ReadonlySet<string> = new Set(["tool.completed", "tool.denied"]);

/** A tool call no row has closed yet. */
export interface OpenCall {
  readonly toolUseId: string;
  /** The call's first opener row in list order: the row that names it. */
  readonly opening: ThreadActivityItem;
  readonly openingIndex: number;
  /** The call's newest opener row: its latest title, command and status. */
  readonly latestLifecycle: ThreadActivityItem;
  /** The position of the call's newest `tool.*` row, a streamed chunk included. */
  readonly lastActiveIndex: number;
}

/** A background task (a shell, a watch loop) with no `task.completed`. */
export interface OpenBackgroundTask {
  readonly taskId: string;
  /** Its first `task.started` that is not an agent's: the row that names it. */
  readonly start: ThreadActivityItem;
  readonly startIndex: number;
  /** The position of its newest `task.*` row or of the newest row it owns (`agentId`). */
  readonly lastActiveIndex: number;
}

/** {@link openWorkOf}'s answer: each list in the order of the units' opening rows. */
export interface OpenWork {
  calls: OpenCall[];
  tasks: OpenBackgroundTask[];
}

interface CallFacts {
  readonly toolUseId: string;
  opening: ThreadActivityItem | null;
  openingIndex: number;
  latest: ThreadActivityItem | null;
  lastActive: number;
  closed: boolean;
}

interface TaskFacts {
  readonly taskId: string;
  start: ThreadActivityItem | null;
  startIndex: number;
  lastActive: number;
  closed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `payload[key]` when it is a string with something in it, else null. */
function idIn(payload: Record<string, unknown> | null, key: "toolUseId" | "taskId"): string | null {
  const id = payload?.[key];
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

/** The calls and background tasks `activities` shows running, with their opening rows. */
export function openWorkOf(activities: readonly ThreadActivityItem[]): OpenWork {
  const calls = new Map<string, CallFacts>();
  const tasks = new Map<string, TaskFacts>();
  // Pushed the moment a unit's opening row is found, so already in list order.
  const openedCalls: CallFacts[] = [];
  const startedTasks: TaskFacts[] = [];
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    const kind = activity.activityKind;
    if (kind.startsWith("tool.")) {
      const payload = asRecord(activity.payload);
      const toolUseId = idIn(payload, "toolUseId");
      if (toolUseId !== null) {
        let call = calls.get(toolUseId);
        if (call === undefined) {
          call = { toolUseId, opening: null, openingIndex: -1, latest: null, lastActive: index, closed: false };
          calls.set(toolUseId, call);
        }
        call.lastActive = index;
        if (CALL_OPENER_KINDS.has(kind)) {
          if (call.opening === null) {
            call.opening = activity;
            call.openingIndex = index;
            openedCalls.push(call);
          }
          call.latest = activity;
        } else if (CALL_CLOSER_KINDS.has(kind)) {
          call.closed = true;
        }
      }
    } else if (kind.startsWith("task.")) {
      const payload = asRecord(activity.payload);
      const taskId = idIn(payload, "taskId");
      if (taskId !== null) {
        let task = tasks.get(taskId);
        if (task === undefined) {
          task = { taskId, start: null, startIndex: -1, lastActive: index, closed: false };
          tasks.set(taskId, task);
        }
        task.lastActive = index;
        if (kind === "task.started") {
          if (task.start === null && payload?.agentKind !== "agent") {
            task.start = activity;
            task.startIndex = index;
            startedTasks.push(task);
          }
        } else if (kind === "task.completed") {
          task.closed = true;
        }
      }
    }
    // A row a task owns is its activity too. One written before the task's
    // first `task.*` row cannot be its newest, so only a known task is moved.
    const owner = activity.agentId;
    if (typeof owner === "string" && owner.length > 0) {
      const task = tasks.get(owner);
      if (task !== undefined) task.lastActive = index;
    }
  }

  const openCalls: OpenCall[] = [];
  for (const call of openedCalls) {
    if (call.closed) continue;
    openCalls.push({
      toolUseId: call.toolUseId,
      opening: call.opening!,
      openingIndex: call.openingIndex,
      latestLifecycle: call.latest!,
      lastActiveIndex: call.lastActive
    });
  }
  const openTasks: OpenBackgroundTask[] = [];
  for (const task of startedTasks) {
    if (task.closed) continue;
    openTasks.push({
      taskId: task.taskId,
      start: task.start!,
      startIndex: task.startIndex,
      lastActiveIndex: task.lastActive
    });
  }
  return { calls: openCalls, tasks: openTasks };
}
