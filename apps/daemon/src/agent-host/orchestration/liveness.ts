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
 * a push — while an agent is still working in it, and what a deploy's
 * drain-restart waits on: a restart kills every one of them.
 *
 * In memory only, on purpose: after a host restart the registry is empty,
 * which is correct, because orphaned background work is not live.
 *
 * **A row is live until its work ends, never until it falls silent.** A task
 * leaves on its own terminal row, when its provider process goes
 * (`session.exited`), or when the adapter that owns it says its work is gone
 * ({@link TaskLivenessProbe}: Claude's own live-task set, which the CLI's
 * level signal keeps; a Grok shell's own process, by its pid). Silence proves
 * nothing: a test suite with its output sent to a file runs for twenty minutes
 * without a line, and the expiry this registry used to apply to quiet shells —
 * ten minutes, or the end of any turn the user sent while it said nothing —
 * read such a shell as finished, let the thread show "finished", and let a
 * deploy's drain kill it (2026-10-23). Only a task whose adapter can answer
 * nothing about it — no probe, or an answer of `undefined` — is bounded by
 * time, and generously ({@link UNCHECKED_BACKGROUND_TTL_MS}), as the guard
 * against a provider that never reports an end. An agent row that carries its
 * own `livenessTtlMs` (Grok's subagents, which run inside the CLI and report a
 * heartbeat about every ten seconds) keeps that bound while its adapter cannot
 * answer for it.
 */

import {
  INERT_TASK_TYPES,
  MONITOR_TASK_TYPES,
  type BackgroundLiveness,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import type { LiveBackgroundTask, LivenessRegistry, TaskLivenessProbe } from "../services.ts";
import { systemClock, type Clock } from "./runtime-seams.ts";

/**
 * How long a watch loop or shell whose adapter cannot say whether it still
 * runs ({@link TaskLivenessProbe} answers `undefined`) counts as live after its
 * last transition. Long on purpose: it only guards against a provider that
 * never reports an end, and a shorter bound killed real work.
 */
const UNCHECKED_BACKGROUND_TTL_MS = 6 * 60 * 60_000;

interface TaskEntry {
  /** When the task was first seen live (epoch ms). */
  readonly since: number;
  /** Its last transition (epoch ms), for {@link UNCHECKED_BACKGROUND_TTL_MS}. */
  lastSeenAt: number;
  /** An agent's own bound: when it stops counting unless re-armed (`livenessTtlMs`), or null. */
  expiresAt: number | null;
  taskType: string | undefined;
  title: string | undefined;
}

interface ThreadLivenessState {
  readonly agents: Map<string, TaskEntry>;
  /** Watch loops and background shells (`MONITOR_TASK_TYPES`). */
  readonly monitors: Map<string, TaskEntry>;
}

interface LivenessRegistryOptions {
  clock?: Clock;
  /** The adapters' answer to "is this task's work still running?"; settable later. */
  probe?: TaskLivenessProbe;
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
  title: string | undefined;
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
      const description = "description" in payload ? payload.description : undefined;
      return {
        threadId: event.threadId,
        taskId,
        taskType: payload.taskType,
        status: "status" in payload ? payload.status : undefined,
        kind,
        // The task's own `agentId` marks work launched from inside a subagent;
        // it is on the payload linkage, and the envelope carries it too.
        agentId: payload.agentId ?? event.agentId,
        title: nonBlank(payload.title) ?? nonBlank(description),
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
  let probe: TaskLivenessProbe | null = options.probe ?? null;
  const stateByThreadId = new Map<string, ThreadLivenessState>();

  const stateFor = (threadId: string): ThreadLivenessState => {
    const existing = stateByThreadId.get(threadId);
    if (existing) {
      return existing;
    }
    const created: ThreadLivenessState = { agents: new Map(), monitors: new Map() };
    stateByThreadId.set(threadId, created);
    return created;
  };

  // Classification is per-transition, not sticky: a task first seen without a
  // taskType may later reveal itself as a shell, become inert, or turn out to
  // be agent-owned. Every path drops any prior entry for the taskId so a stale
  // bucket assignment cannot pin the thread's status.
  const drop = (threadId: string, taskId: string): TaskEntry | undefined => {
    const state = stateByThreadId.get(threadId);
    if (!state) {
      return undefined;
    }
    const previous = state.agents.get(taskId) ?? state.monitors.get(taskId);
    state.agents.delete(taskId);
    state.monitors.delete(taskId);
    dropIfEmpty(threadId, state);
    return previous;
  };

  const dropIfEmpty = (threadId: string, state: ThreadLivenessState): void => {
    if (state.agents.size === 0 && state.monitors.size === 0) {
      stateByThreadId.delete(threadId);
    }
  };

  /** The adapter's answer for one task; a probe that throws knows nothing. */
  const ask = (threadId: string, taskId: string): boolean | undefined => {
    if (probe === null) return undefined;
    try {
      return probe(threadId, taskId);
    } catch {
      return undefined;
    }
  };

  /**
   * Evaluated on every read and write, so no timer can leak. A task its
   * adapter says is gone leaves; one it says runs stays, however quiet; one it
   * cannot answer for is bounded — an agent by its own `livenessTtlMs`, a watch
   * loop or shell by {@link UNCHECKED_BACKGROUND_TTL_MS}.
   */
  const settle = (threadId: string, state: ThreadLivenessState): void => {
    const now = clock.now().getTime();
    for (const [bucket, entries] of [
      ["agent", state.agents],
      ["monitor", state.monitors]
    ] as const) {
      for (const [taskId, entry] of entries) {
        const answer = ask(threadId, taskId);
        if (answer === true) continue;
        const gone =
          answer === false ||
          (entry.expiresAt !== null && entry.expiresAt <= now) ||
          (bucket === "monitor" && entry.lastSeenAt <= now - UNCHECKED_BACKGROUND_TTL_MS);
        if (gone) entries.delete(taskId);
      }
    }
  };

  const readState = (threadId: string): ThreadLivenessState | undefined => {
    const state = stateByThreadId.get(threadId);
    if (!state) return undefined;
    settle(threadId, state);
    dropIfEmpty(threadId, state);
    return stateByThreadId.get(threadId);
  };

  const record = (input: TaskTransition): void => {
    // A gone entry must read as gone to the status-free check below.
    readState(input.threadId);
    const taskType = input.taskType;
    if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) {
      drop(input.threadId, input.taskId);
      return;
    }
    // A subagent's own non-agent work (its shells and monitors) is background
    // work like the parent's: while its agent runs the agent's entry already
    // reads "working", and once the agent finishes the shell may run on —
    // Claude keeps it in its live set, the finished agent its
    // `parent_task_id` — so it must keep the thread "monitoring" until its own
    // end, never vanish with its owner (2026-10-25). Nested agents keep their
    // own type: they can outlive their parent and must keep the thread working.
    //
    // An `agentId` equal to the task's OWN id names no owner: Grok stamps every
    // row of a background shell with the shell itself
    // (`adapters/grok/background-tasks.ts`). Such a row is the task's own,
    // classified by its type like any other. Codex and OpenCode type every
    // live row `subagent` (Codex's Stop/exit closer carries no type, but it is
    // terminal either way), so none of them reads differently.
    const ownedWork =
      input.agentId !== undefined &&
      input.agentId.trim().length > 0 &&
      input.agentId !== input.taskId &&
      (taskType === undefined || MONITOR_TASK_TYPES.has(taskType));

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

    const previous = drop(input.threadId, input.taskId);
    const state = stateFor(input.threadId);
    const now = clock.now().getTime();
    const entry: TaskEntry = {
      since: previous?.since ?? now,
      lastSeenAt: now,
      expiresAt: input.livenessTtlMs === undefined ? null : now + input.livenessTtlMs,
      taskType: taskType ?? previous?.taskType,
      title: input.title ?? previous?.title
    };
    if (ownedWork || (taskType !== undefined && MONITOR_TASK_TYPES.has(taskType))) {
      state.monitors.set(input.taskId, { ...entry, expiresAt: null });
      return;
    }
    state.agents.set(input.taskId, entry);
  };

  return {
    observe(event: RuntimeEvent): void {
      if (event.type === "session.exited") {
        // The provider process that ran every task of the thread is gone.
        stateByThreadId.delete(event.threadId);
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

    liveTasks(threadId: string): LiveBackgroundTask[] {
      const state = readState(threadId);
      if (!state) return [];
      const rows: LiveBackgroundTask[] = [];
      for (const [bucket, entries] of [
        ["agent", state.agents],
        ["background", state.monitors]
      ] as const) {
        for (const [taskId, entry] of entries) {
          rows.push({
            taskId,
            kind: bucket,
            since: new Date(entry.since).toISOString(),
            ...(entry.taskType !== undefined ? { taskType: entry.taskType } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {})
          });
        }
      }
      return rows;
    },

    setProbe(next: TaskLivenessProbe | null): void {
      probe = next;
    },

    clear(threadId: string): void {
      stateByThreadId.delete(threadId);
    }
  };
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
