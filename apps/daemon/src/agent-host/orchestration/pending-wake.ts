/**
 * Pending wakes — what keeps a background task's result from being lost to an
 * agent-host restart (2026-10-23, thread bbd7145a).
 *
 * A background task the parent launched (a subagent, a background shell)
 * that ends while no turn runs is handed to the agent by the PROVIDER, which
 * starts a turn by itself for it — Claude about a second after the end, Grok
 * and OpenCode likewise (`AdapterCapabilities.wakesOnBackgroundCompletion`).
 * Between the end and that turn the thread reads idle with no background
 * work, and a deploy's drain-restart that landed there killed the CLI before
 * it woke: the result was never delivered and the chat sat waiting until the
 * user typed "continue". So the host holds such an end as a pending wake
 * (`ThreadHead.pendingWake`, on `meta.json`): the drain waits on it, bounded
 * (`/health` `pendingWakes`), and a host that stops anyway — the bound
 * reached, a crash, a reboot — leaves it for the next host, which hands the
 * agent the results itself under the §3.3 continuation rules.
 *
 * Pure functions only; the orchestrator owns the state and its writes.
 */

import {
  INERT_TASK_TYPES,
  type PendingWake,
  type PendingWakeTask,
  type RuntimeEvent,
  type RuntimeSubagent,
  type Turn
} from "@orquester/api/agent-chat";

/**
 * How long a pending wake is held at all. A provider wakes within seconds of
 * the end (Claude: 1-5 s across 88 ends of the owner's log); one that has not
 * after this long is not going to, and a mark left that long would make a
 * much later restart hand the agent a result it chose not to act on. Well past
 * the daemon's drain cap (`PENDING_WAKE_DRAIN_CAP_MS`, 2 min), so a restart
 * that went ahead at the cap still finds the mark.
 */
export const PENDING_WAKE_EXPIRY_MS = 15 * 60_000;

/** At most this many tasks are listed on one mark; more are counted. */
export const PENDING_WAKE_MAX_TASKS = 8;

/** A task's result text is cut to this many characters on the mark. */
export const PENDING_WAKE_RESULT_MAX_CHARS = 4_000;

/**
 * Deliveries of one pending wake a restart may attempt in a row: a host that
 * dies between preparing the delivery and sending it counts on, never loops.
 */
export const MAX_WAKE_DELIVERY_ATTEMPTS = 2;

/**
 * The summary of the visible row a host writes for a pending wake the previous
 * host left: handed to the agent or not, its detail says which
 * ({@link wakeNoteDetail}).
 */
export const WAKE_NOTE_SUMMARY = "Background work finished while the agent host restarted";

const TERMINAL_WAKE_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * The task end `event` reports that the provider wakes the PARENT for, or
 * null. Only a task's own end — `completed` or `failed`, on `task.updated` or
 * `task.completed` (Claude sends both, in that order) — never a stop (the
 * user's, or a teardown's: nothing wakes for it), never an inert task (a plan,
 * a scheduled prompt), never a subagent's own work (its shell's end wakes the
 * subagent, not the parent; an `agentId` naming the task itself is Grok's
 * self-stamp and names no owner — `liveness.ts`), never a row that bypasses
 * the parent timeline.
 */
export function wakingTaskEnd(event: RuntimeEvent, completedAt: string): PendingWakeTask | null {
  if (event.type !== "task.updated" && event.type !== "task.completed") return null;
  const payload = event.payload;
  const status = payload.status;
  if (status === undefined || !TERMINAL_WAKE_STATUSES.has(status)) return null;
  const completed = event.type === "task.completed" ? event.payload : null;
  if (completed?.leftRunning === true) return null;
  if (payload.timelineBypass === true) return null;
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  const taskType = payload.taskType;
  if (taskType !== undefined && INERT_TASK_TYPES.has(taskType)) return null;
  const owner = payload.agentId ?? event.agentId;
  if (owner !== undefined && owner.trim().length > 0 && owner !== taskId) return null;
  const summary = completed !== null ? completed.summary : event.type === "task.updated" ? event.payload.error : undefined;
  const result = capText(summary, PENDING_WAKE_RESULT_MAX_CHARS);
  return {
    taskId,
    status,
    completedAt,
    ...(nonBlank(payload.title) !== undefined ? { title: payload.title } : {}),
    ...(taskType !== undefined ? { taskType } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(nonBlank(payload.outputFile) !== undefined ? { outputFile: payload.outputFile } : {}),
    ...(typeof completed?.exitCode === "number" ? { exitCode: completed.exitCode } : {})
  };
}

/**
 * `task` merged into `wake` (a new mark when there is none): one entry per
 * task — a later row of the same end fills what an earlier one lacked (Claude's
 * `task.completed` carries the summary its `task.updated` did not) — and at
 * most {@link PENDING_WAKE_MAX_TASKS} listed, the rest counted.
 */
export function withWakeTask(wake: PendingWake | undefined, task: PendingWakeTask): PendingWake {
  if (wake === undefined) return { since: task.completedAt, tasks: [task] };
  const at = wake.tasks.findIndex((entry) => entry.taskId === task.taskId);
  if (at >= 0) {
    const existing = wake.tasks[at]!;
    // The later row's status stands; the first end's time stays.
    const merged: PendingWakeTask = { ...existing, status: task.status };
    for (const key of ["title", "taskType", "outputFile", "exitCode"] as const) {
      if (merged[key] === undefined && task[key] !== undefined) {
        Object.assign(merged, { [key]: task[key] });
      }
    }
    if (task.result !== undefined && (existing.result === undefined || task.result.length > existing.result.length)) {
      merged.result = task.result;
    }
    const tasks = [...wake.tasks];
    tasks[at] = merged;
    return { ...wake, tasks };
  }
  if (wake.tasks.length >= PENDING_WAKE_MAX_TASKS) {
    return { ...wake, moreTasks: (wake.moreTasks ?? 0) + 1 };
  }
  return { ...wake, tasks: [...wake.tasks, task] };
}

/**
 * Whether the agent already took the wake: a turn started — or the user asked
 * for one — at or after its first end. Either way the provider had it, or the
 * user's message wins; it is never handed over again.
 */
export function wakeConsumed(wake: PendingWake, turns: readonly Turn[] | undefined): boolean {
  const since = Date.parse(wake.since);
  if (!Number.isFinite(since)) return true;
  return (turns ?? []).some((turn) =>
    [turn.startedAt, turn.requestedAt].some((stamp) => {
      const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
      return Number.isFinite(at) && at >= since;
    })
  );
}

/** Whether a pending wake has outlived {@link PENDING_WAKE_EXPIRY_MS} at `nowMs`. */
export function wakeExpired(wake: PendingWake, nowMs: number): boolean {
  const since = Date.parse(wake.since);
  return !Number.isFinite(since) || nowMs - since >= PENDING_WAKE_EXPIRY_MS;
}

/**
 * Background work the restart stopped: every roster task that ended
 * `stopped` (the roster reads it `interrupted`) at or after the wake's first
 * end — the old host's teardown closed it, or this host's first load did for a
 * process that died without one — other than the wake's own tasks.
 */
export function stoppedBackgroundWork(
  roster: readonly RuntimeSubagent[] | undefined,
  wake: PendingWake
): RuntimeSubagent[] {
  const since = Date.parse(wake.since);
  const own = new Set(wake.tasks.map((task) => task.taskId));
  return (roster ?? []).filter((row) => {
    if (row.status !== "interrupted" || own.has(row.id)) return false;
    const ended = row.completedAt !== null ? Date.parse(row.completedAt) : Number.NaN;
    return Number.isFinite(ended) && Number.isFinite(since) && ended >= since;
  });
}

/** One task's display name. */
function taskName(task: { title?: string | undefined; taskId: string }): string {
  return nonBlank(task.title) !== undefined ? `"${task.title}"` : `task ${task.taskId}`;
}

function stoppedName(row: RuntimeSubagent): string {
  const name = nonBlank(row.title) !== undefined ? `"${row.title}"` : `task ${row.id}`;
  return row.agentKind === "background" ? `${name} (background task)` : `${name} (agent)`;
}

/**
 * What the next host sends the agent in place of the wake it missed: which
 * background tasks finished while the agent host restarted, their results
 * (each capped on the mark), where their whole output is, and what the restart
 * stopped — ending with the ordinary continuation sentence.
 */
export function wakePrompt(wake: PendingWake, stopped: readonly RuntimeSubagent[]): string {
  const lines: string[] = [
    wake.tasks.length + (wake.moreTasks ?? 0) === 1
      ? "While the agent host restarted, a background task you started finished, and its completion notification may not have reached you. Its result:"
      : "While the agent host restarted, background tasks you started finished, and their completion notifications may not have reached you. Their results:"
  ];
  wake.tasks.forEach((task, index) => {
    lines.push("");
    lines.push(`${index + 1}. ${taskName(task)} (task id ${task.taskId}) ${task.status === "failed" ? "failed" : "completed"}${task.exitCode !== undefined ? ` (exit code ${task.exitCode})` : ""}.`);
    if (task.outputFile !== undefined) lines.push(`   Full output: ${task.outputFile}`);
    lines.push(task.result !== undefined ? `   Result:\n${indent(task.result)}` : "   (No result text was reported.)");
  });
  if ((wake.moreTasks ?? 0) > 0) {
    lines.push("", `${wake.moreTasks} more background task(s) finished as well; check their output.`);
  }
  if (stopped.length > 0) {
    lines.push(
      "",
      `This background work was still running when the agent host stopped, and it was stopped with it: ${stopped.map(stoppedName).join(", ")}. Start it again if it is still needed.`
    );
  }
  lines.push("", "Continue where you left off.");
  return lines.join("\n");
}

/** The visible note's detail: what finished, what was stopped, and what happens now. */
export function wakeNoteDetail(
  wake: PendingWake,
  stopped: readonly RuntimeSubagent[],
  outcome: "delivered" | "opted-out" | "no-cursor" | "attempts"
): string {
  const names = wake.tasks.map(taskName);
  const more = (wake.moreTasks ?? 0) > 0 ? `, and ${wake.moreTasks} more` : "";
  const finished = `${names.join(", ")}${more} finished while the agent host restarted.`;
  const stoppedText =
    stopped.length > 0
      ? ` Stopped with the restart: ${stopped.map(stoppedName).join(", ")}.`
      : "";
  const next =
    outcome === "delivered"
      ? " The agent was given the result and continues."
      : outcome === "opted-out"
        ? " The agent was not continued, because continuing after a restart is off for this project. Send a message to continue."
        : outcome === "no-cursor"
          ? " The agent could not be continued. Send a message to continue."
          : " The agent host stopped again while handing the agent the result, so it was not tried again. Send a message to continue.";
  return `${finished}${stoppedText}${next}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

function capText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  return text.length <= max ? text : `${text.slice(0, max)}… (cut; see the full output)`;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
