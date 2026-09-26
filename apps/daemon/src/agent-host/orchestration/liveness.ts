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
 *
 * **Differs from T3: background rows expire.** T3 drops a task only on a
 * terminal status, which assumes every provider reports one — and every
 * provider can fail to: a Grok shell's end arrives by `_x.ai/task_completed`,
 * a snapshot or a poll (fixtures README observation 39), none of which comes
 * once the CLI stops reporting on it, and a thread could read `"monitoring"`
 * for the rest of the host's life while the §6.4 ladder kept the tab out of
 * "finished" forever. Two bounds fix it, both on the **background** bucket
 * only:
 *
 * - a watch loop with no transition for {@link BACKGROUND_LIVENESS_TTL_MS} is
 *   dropped (evaluated lazily on read, so there is no timer to leak and a test
 *   drives it with a set clock);
 * - a turn ending drops every background row that reported nothing **during
 *   that turn** — it was already not live while the agent worked. Only a turn
 *   the host sent: a turn the provider started itself (a Grok wake, an
 *   OpenCode woken reply, Claude's synthetic woken turn —
 *   `LivenessObservation.providerInitiatedTurn`) is not the agent working on
 *   anyone's behalf, and a watch loop's silence through it proves nothing.
 *   Wakes come at every background end and monitor line, so sweeping at their
 *   ends dropped a silent dev server long before its TTL — and let a deploy
 *   kill it.
 *
 * Agent rows are never expired — a subagent that runs for hours is real work —
 * unless the row says otherwise: an adapter whose agents' ends can go
 * unreported stamps `livenessTtlMs` on every row of the agent (Grok's: its
 * runs report their end and a heartbeat about every ten seconds, but a chat
 * session lives until Stop or the tab closes, so `session.exited` may never
 * come for a run whose reports stop). Such an agent counts for at most that
 * long after the latest row naming it; the roster keeps its row, and a later
 * end is recorded as any end is.
 */

import {
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type BackgroundLiveness,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import type { LivenessObservation, LivenessRegistry } from "../services.ts";
import { systemClock, type Clock } from "./runtime-seams.ts";

/**
 * How long a watch loop may stay silent before it stops counting as live. Ten
 * minutes, the same horizon as the turn watchdog's idle window (§3.1): if
 * nothing has happened for that long, nothing is happening.
 */
export const BACKGROUND_LIVENESS_TTL_MS = 10 * 60_000;

interface ThreadLivenessState {
  /**
   * taskId → when the agent stops counting (epoch ms: its latest row plus the
   * row's `livenessTtlMs`), or `null` for an agent that counts until its end.
   */
  readonly agents: Map<string, number | null>;
  /** taskId → the epoch ms of its last transition, for the TTL. */
  readonly monitors: Map<string, number>;
  /**
   * When the thread's current turn started, for the turn-boundary sweep;
   * `null` outside a turn and through a turn the provider started, whose end
   * sweeps nothing.
   */
  turnStartedAt: number | null;
}

export interface LivenessRegistryOptions {
  clock?: Clock;
  /** Overridable so a test drives the TTL with a set clock (§9). */
  backgroundTtlMs?: number;
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
  /** The row's `livenessTtlMs`, when it is a positive finite number. */
  livenessTtlMs: number | undefined;
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
        agentId: payload.agentId ?? event.agentId,
        livenessTtlMs:
          typeof payload.livenessTtlMs === "number" &&
          Number.isFinite(payload.livenessTtlMs) &&
          payload.livenessTtlMs > 0
            ? payload.livenessTtlMs
            : undefined
      };
    }
    default:
      return null;
  }
}

export function createLivenessRegistry(
  options: LivenessRegistryOptions = {}
): LivenessRegistry {
  const clock = options.clock ?? systemClock;
  const backgroundTtlMs = options.backgroundTtlMs ?? BACKGROUND_LIVENESS_TTL_MS;
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = {
      agents: new Map(),
      monitors: new Map(),
      turnStartedAt: null
    };
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
    dropIfEmpty(threadId, state);
  };

  const dropIfEmpty = (threadId: string, state: ThreadLivenessState): void => {
    if (state.agents.size === 0 && state.monitors.size === 0 && state.turnStartedAt === null) {
      stateByThreadId.delete(threadId);
    }
  };

  /**
   * Lazy TTLs: evaluated on every read and write, so no timer can leak. A
   * watch loop expires after the registry's own window; an agent only when its
   * latest row set an expiry (`livenessTtlMs`).
   */
  const expire = (state: ThreadLivenessState): void => {
    const now = clock.now().getTime();
    const cutoff = now - backgroundTtlMs;
    for (const [taskId, lastSeenAt] of [...state.monitors]) {
      if (lastSeenAt <= cutoff) {
        state.monitors.delete(taskId);
      }
    }
    for (const [taskId, expiresAt] of [...state.agents]) {
      if (expiresAt !== null && expiresAt <= now) {
        state.agents.delete(taskId);
      }
    }
  };

  const readState = (threadId: string): ThreadLivenessState | undefined => {
    const state = stateByThreadId.get(threadId);
    if (!state) return undefined;
    expire(state);
    return state;
  };

  const record = (input: TaskTransition): void => {
    // An expired entry must read as gone to the status-free check below.
    readState(input.threadId);
    const taskType = input.taskType;
    if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
      drop(input.threadId, input.taskId);
      return;
    }
    // A subagent's internal non-agent work (its own shells and monitors) is
    // covered by the owning agent's entry. Nested agents fall through: they can
    // outlive their parent and must keep the thread working.
    //
    // An `agentId` equal to the task's OWN id names no owner: Grok stamps every
    // row of a background shell with the shell itself (`adapters/grok/
    // background-tasks.ts`), and reading that as "some agent's shell" dropped every
    // Grok shell — a dev server left running neither read "monitoring" nor
    // held a deploy's drain. Such a row is the task's own, classified below
    // like any other: a shell is a watch loop, bounded by the TTL. Claude
    // stamps only a real owner, and Codex and OpenCode type every live row
    // `subagent` (Codex's Stop/exit closer carries no type, but it is terminal
    // either way), so none of them reads differently.
    if (
      input.agentId !== undefined &&
      input.agentId.trim().length > 0 &&
      input.agentId !== input.taskId &&
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
    if (taskType !== undefined && MONITOR_TASK_TYPES.has(taskType)) {
      state.monitors.set(input.taskId, clock.now().getTime());
      return;
    }
    state.agents.set(
      input.taskId,
      input.livenessTtlMs === undefined ? null : clock.now().getTime() + input.livenessTtlMs
    );
  };

  return {
    observe(event: RuntimeEvent, observation: LivenessObservation = {}): void {
      if (event.type === "session.exited") {
        stateByThreadId.delete(event.threadId);
        return;
      }
      if (event.type === "turn.started") {
        if (observation.providerInitiatedTurn === true) {
          // A turn the provider started arms no sweep: its end drops nothing.
          const state = stateByThreadId.get(event.threadId);
          if (state) {
            state.turnStartedAt = null;
            dropIfEmpty(event.threadId, state);
          }
          return;
        }
        const state = stateFor(event.threadId);
        state.turnStartedAt = clock.now().getTime();
        return;
      }
      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const state = stateByThreadId.get(event.threadId);
        if (!state) return;
        const turnStartedAt = state.turnStartedAt;
        state.turnStartedAt = null;
        if (turnStartedAt !== null) {
          // A watch loop that reported nothing for the whole turn was already
          // not live while the agent worked.
          for (const [taskId, lastSeenAt] of [...state.monitors]) {
            if (lastSeenAt < turnStartedAt) {
              state.monitors.delete(taskId);
            }
          }
        }
        expire(state);
        dropIfEmpty(event.threadId, state);
        return;
      }
      const transition = transitionFor(event);
      if (transition) {
        record(transition);
      }
    },

    liveness(threadId: string): BackgroundLiveness | null {
      const state = readState(threadId);
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
      return readState(threadId)?.agents.size ?? 0;
    },

    clear(threadId: string): void {
      stateByThreadId.delete(threadId);
    }
  };
}
