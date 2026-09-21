/**
 * Agent host — the background-liveness registry (spec §3.1, §6.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/ThreadBackgroundLiveness.ts`, translated from
 * Effect into a plain object.
 *
 * Subagent fleets, background shells and watch loops keep running inside the
 * provider process after the turn that launched them has settled. This is what
 * stops a thread reading `idle` with a "finished" attention stamp — and firing
 * a push — while an agent is still working in it.
 *
 * In memory only, on purpose: after a host restart the registry is empty,
 * which is correct, because orphaned background work is not live.
 */

import {
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type BackgroundLiveness,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import type { LivenessRegistry } from "../services.ts";

interface ThreadLivenessState {
  readonly agents: Set<string>;
  readonly monitors: Set<string>;
}

/** *T3: `ThreadBackgroundLiveness.ts:35-41`.* */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted"
]);

type TaskTransitionKind = "started" | "progress" | "updated" | "completed";

interface TaskTransition {
  threadId: string;
  taskId: string;
  taskType: string | undefined;
  status: string | undefined;
  kind: TaskTransitionKind;
  agentId: string | undefined;
}

/**
 * Only the four `task.*` arms feed the registry. `session.exited` clears the
 * thread; everything else is ignored.
 */
function transitionFor(event: RuntimeEvent): TaskTransition | null {
  switch (event.type) {
    case "task.started":
    case "task.progress":
    case "task.updated":
    case "task.completed": {
      const payload = event.payload;
      const taskId = payload.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) {
        return null;
      }
      const kind: TaskTransitionKind =
        event.type === "task.started"
          ? "started"
          : event.type === "task.progress"
            ? "progress"
            : event.type === "task.updated"
              ? "updated"
              : "completed";
      return {
        threadId: event.threadId,
        taskId,
        taskType: payload.taskType,
        status: "status" in payload ? payload.status : undefined,
        kind,
        // The task's own `agentId` marks work launched from inside a subagent;
        // it is on the payload linkage, and the envelope carries it too.
        agentId: payload.agentId ?? event.agentId
      };
    }
    default:
      return null;
  }
}

export function createLivenessRegistry(): LivenessRegistry {
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Set(), monitors: new Set() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without a
  // taskType may later reveal itself as a shell, become inert, or turn out to
  // be agent-owned. Every path drops any prior entry for the taskId so a stale
  // bucket assignment cannot pin the thread's status.
  const drop = (threadId: string, taskId: string): void => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return;
    }
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  const record = (input: TaskTransition): void => {
    const taskType = input.taskType;
    if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
      drop(input.threadId, input.taskId);
      return;
    }
    // A subagent's internal non-agent work (its own shells and monitors) is
    // covered by the owning agent's entry. Nested agents fall through: they can
    // outlive their parent and must keep the thread working.
    if (
      input.agentId !== undefined &&
      input.agentId.trim().length > 0 &&
      (taskType === undefined || MONITOR_TASK_TYPES.has(taskType))
    ) {
      drop(input.threadId, input.taskId);
      return;
    }

    // `idle` counts as not-live: a resting (resumable) child is not doing
    // anything, and an all-idle fleet must not pin "working".
    const terminal =
      input.kind === "completed" ||
      input.status === "idle" ||
      (input.status !== undefined && TERMINAL_STATUSES.has(input.status));
    if (terminal) {
      drop(input.threadId, input.taskId);
      return;
    }

    // Status-free progress and metadata updates are not restarts. A delayed row
    // after `idle` must not put the task back in the live set.
    if ((input.kind === "progress" || input.kind === "updated") && input.status === undefined) {
      const existing = stateByThreadId.get(input.threadId);
      const stillLive =
        existing !== undefined &&
        (existing.agents.has(input.taskId) || existing.monitors.has(input.taskId));
      if (!stillLive) {
        return;
      }
    }

    drop(input.threadId, input.taskId);
    const state = stateFor(input.threadId);
    const bucket =
      taskType !== undefined && MONITOR_TASK_TYPES.has(taskType) ? state.monitors : state.agents;
    bucket.add(input.taskId);
  };

  return {
    observe(event: RuntimeEvent): void {
      if (event.type === "session.exited") {
        stateByThreadId.delete(event.threadId);
        return;
      }
      const transition = transitionFor(event);
      if (transition) {
        record(transition);
      }
    },

    liveness(threadId: string): BackgroundLiveness | null {
      const state = stateByThreadId.get(threadId);
      if (!state) {
        return null;
      }
      if (state.agents.size > 0) {
        return "working";
      }
      if (state.monitors.size > 0) {
        return "monitoring";
      }
      return null;
    },

    liveAgentCount(threadId: string): number {
      return stateByThreadId.get(threadId)?.agents.size ?? 0;
    },

    clear(threadId: string): void {
      stateByThreadId.delete(threadId);
    }
  };
}
