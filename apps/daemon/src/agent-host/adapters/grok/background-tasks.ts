/**
 * Grok adapter — background tasks: the shells and monitors the CLI runs, from
 * the reports that start and end them (`background_tasks` snapshots,
 * `_x.ai/task_backgrounded`, `_x.ai/task_completed`, `_x.ai/monitor_event`)
 * and a tool call's answers about them (T3's reader: a start, a poll, a kill —
 * a poll or a kill may name a subagent too); every end written and by whom, so
 * a finished task never starts again and one the adapter closed counts live
 * again on the CLI's word; and the shells a subagent's end leaves running.
 * Functions over the normaliser's state (`normalizer-state.ts`);
 * `normalize.ts` routes the reports here.
 */

import type { RuntimeEvent, RuntimeEventRaw, RuntimeTaskStatus } from "@orquester/api/agent-chat";

import type { ToolCallStatus } from "./acp/_generated/schema.ts";
import type { XaiBackgroundTask, XaiTaskSnapshot } from "./acp/_generated/xai.ts";
import type { GrokNormalizer } from "./normalize.ts";
import {
  ACP_RAW_SOURCE,
  asRecord,
  event,
  evictOldest,
  textArgument,
  type GrokNormalizerState
} from "./normalizer-state.ts";
import {
  closeSubagent,
  joinHeldSpawn,
  subagentAnswerText,
  subagentFromSnapshot,
  subagentLinkage,
  subagentNamed,
  subagentOfBackgroundTask,
  subagentReport,
  type subagentProgress
} from "./subagents.ts";
import { isTerminalToolStatus, type FINISHED_CALLS_REMEMBERED } from "./tool-calls.ts";

/**
 * Where a background task was started: `session` is the ACP session whose
 * frames report it — `""` for the parent, a child's session id for a
 * subagent's own shell — and `owner` the agent that session is. A
 * `background_tasks` snapshot lists one session's tasks only (fixture 16: the
 * child's own snapshot), so "dropped out of the snapshot" means dropped out of
 * ITS session's.
 */
export interface TaskScope {
  readonly session: string;
  readonly owner?: string;
}

export const PARENT_SCOPE: TaskScope = { session: "" };

export interface BackgroundTrack {
  readonly taskId: string;
  readonly command: string;
  /** A monitor streams events and wakes the agent on each (fixture 20); a shell does neither. */
  readonly taskType: "shell" | "monitor";
  readonly scope: TaskScope;
  description?: string;
  status: RuntimeTaskStatus;
  toolUseId?: string;
  outputFile?: string;
  turnId?: string;
  /**
   * Live again on the CLI's word after an end the adapter wrote itself (see
   * {@link reviveShell}): the roster keeps that end, so no row
   * of this track names a status that would reopen it.
   */
  revived?: boolean;
  /** A monitor's latest line (`_x.ai/monitor_event`), which its progress row shows. */
  lastLine?: string;
  /**
   * The subagent whose child session started it ended while it ran: from
   * then on its rows name itself, so the liveness registry counts it on its
   * own (a watch loop's TTL) rather than as covered by an agent no longer live.
   */
  ownerEnded?: boolean;
}

/**
 * Who wrote a background task's end. `cli`: the CLI reported it — a poll or
 * kill answer, a snapshot's terminal status, the completion tag, a failed
 * spawn call. `adapter`: the adapter wrote it itself — Stop, the session's
 * stop, the exit ({@link GrokNormalizer.stopBackgroundTasks}), or a task that
 * dropped out of a snapshot unannounced.
 */
export type TaskEndSource = "cli" | "adapter";

/** A background task whose end was written, and by whom. */
export interface EndedTask {
  readonly by: TaskEndSource;
  /** A shell the adapter closed itself: its track, to count it live again on the CLI's word. */
  readonly shell?: BackgroundTrack;
}

/** A snapshot status that says the task no longer runs. */
export function isEndedTaskStatus(status: RuntimeTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/**
 * How many ended background task ids the normaliser remembers, oldest
 * forgotten first — {@link FINISHED_CALLS_REMEMBERED}'s rule for tasks. A
 * task's track is dropped at its end, so this is what tells a snapshot that
 * still lists a finished task from a new task's first sighting.
 */
export const ENDED_TASKS_REMEMBERED = 1_024;

/**
 * The `rawOutput` tag of a `monitor` call's answer — `{type: "Monitor",
 * taskId, timeoutMs, persistent}`, T3's reader's shape, captured in fixture 20.
 */
const MONITOR_OUTPUT = "Monitor";

/**
 * A poll answer's status, as T3's reader maps it (`XAiBackgroundTasks.ts`
 * `lifecycle`): the words, else the exit code; `undefined` when neither says.
 */
export function pollLifecycle(
  status: unknown,
  exitCode: unknown
): "running" | "completed" | "failed" | "stopped" | undefined {
  switch (typeof status === "string" ? status.trim().toLowerCase() : undefined) {
    case "pending":
    case "running":
      return "running";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
      return "stopped";
    default:
      return typeof exitCode === "number" && Number.isFinite(exitCode)
        ? exitCode === 0
          ? "completed"
          : "failed"
        : undefined;
  }
}

/**
 * How a COMPLETED kill answer's entry ends the task it names, or `undefined`
 * when it ends nothing. Captured (fixture 18, a subagent and a shell): a
 * `KillTask` `Result` is `{task_id, outcome, message}` — `outcome: "killed"`
 * for both, `message` "Subagent cancellation initiated" / "Task was terminated
 * successfully" — which is T3's shape. `explicitly_killed` and
 * `kill_result_delivered`, which the 1.0.34 strings list beside it, are
 * `TaskSnapshot` fields: they ride `_x.ai/task_completed`
 * ({@link taskCompleted}), never a kill answer. The other
 * kill word, `already_exited` — captured too (fixture 27): `{task_id, outcome:
 * "already_exited", message: "Task had already completed"}` for a shell,
 * "Subagent already completed" for a subagent, no status and no exit code —
 * means nobody stopped the task: the kill found it done. The CLI had reported
 * that end first, so the answer ends nothing then (a run already ended gets no
 * second end); for a run whose end the adapter never saw, it is `completed`,
 * or the answer's own terminal status when it carries one.
 */
function killEnd(
  result: Record<string, unknown>
): "completed" | "failed" | "stopped" | undefined {
  if (result["outcome"] === "killed") {
    return "stopped";
  }
  if (result["outcome"] !== "already_exited") {
    return undefined;
  }
  const lifecycle = pollLifecycle(result["status"], result["exit_code"]);
  return lifecycle === undefined || lifecycle === "running" ? "completed" : lifecycle;
}

/**
 * A shell's end was written: its track goes, and who wrote it is
 * remembered — with the track itself when the adapter wrote it, so the
 * CLI's later word can count it live again ({@link reviveShell}).
 */
export function endShell(state: GrokNormalizerState, taskId: string, by: TaskEndSource): void {
  const track = state.tasks.get(taskId);
  state.tasks.delete(taskId);
  rememberEndedTask(state, taskId, by, by === "adapter" ? track : undefined);
}

/**
 * Oldest first out, so the memory stays within
 * {@link ENDED_TASKS_REMEMBERED}. The CLI's word is never replaced by the
 * adapter's.
 */
export function rememberEndedTask(
  state: GrokNormalizerState,
  id: string,
  by: TaskEndSource,
  shell?: BackgroundTrack
): void {
  const key = id.toLowerCase();
  const previous = state.endedTasks.get(key);
  state.endedTasks.delete(key);
  state.endedTasks.set(
    key,
    previous?.by === "cli" || by === "cli"
      ? { by: "cli" }
      : { by, ...(shell === undefined ? {} : { shell }) }
  );
  evictOldest(state.endedTasks, ENDED_TASKS_REMEMBERED);
}

/** Whether any end of the task was written, by the CLI or by the adapter. */
export function hasEnded(state: GrokNormalizerState, taskId: string): boolean {
  return state.endedTasks.has(taskId.toLowerCase());
}

/**
 * A CLI report — a snapshot entry with its status, a start frame (no
 * status), a poll answer — naming a shell with no live track: the rows it
 * produces, or `undefined` when no end of it was written, and so it is a
 * task to start as any other (a poll starts nothing for it).
 *
 * One rule, for shells and subagents alike ({@link subagentReport}):
 * - An end the CLI reported is final: nothing starts again.
 * - An end the adapter wrote itself (Stop, the session's stop, the exit, a
 *   task dropping out of a snapshot unannounced) is not the CLI's word — a
 *   Stop's `session/cancel` leaves a background shell running (fixture 21:
 *   a poll 12 s later answered `running`, and the shell outlived the CLI
 *   itself), and a deploy must never kill running work, which outranks a
 *   duplicate row. So a report that the task still runs counts it live
 *   again ({@link reviveShell}), and a report of its end is the CLI's end,
 *   remembered as such, with no row: the adapter already wrote one.
 */
function shellReport(
  state: GrokNormalizerState,
  taskId: string,
  status: RuntimeTaskStatus | undefined,
  raw: RuntimeEventRaw,
  fill: { toolUseId?: string; outputFile?: string } = {}
): RuntimeEvent[] | undefined {
  const ended = state.endedTasks.get(taskId.toLowerCase());
  if (ended === undefined) {
    return undefined;
  }
  if (ended.by === "cli") {
    return [];
  }
  if (status !== undefined && isEndedTaskStatus(status)) {
    rememberEndedTask(state, taskId, "cli");
    return [];
  }
  if (status === "idle") {
    // Resting: the CLI says neither that it runs nor that it ended.
    return [];
  }
  if (ended.shell === undefined) {
    // An id that named a subagent whose launch is forgotten: no track to
    // count live again, so it starts as any new task would.
    return undefined;
  }
  const track: BackgroundTrack = {
    ...ended.shell,
    toolUseId: ended.shell.toolUseId ?? fill.toolUseId,
    outputFile: ended.shell.outputFile ?? fill.outputFile
  };
  return reviveShell(state, track, status ?? "running", raw);
}

/**
 * A shell the adapter closed itself that the CLI reports still running:
 * live again, under its own start row re-emitted — which the roster reads as
 * a late delivery (it keeps the adapter's end) and the liveness registry as
 * live work, bounded by its watch-loop TTL and re-armed by further reports.
 */
function reviveShell(
  state: GrokNormalizerState,
  track: BackgroundTrack,
  status: RuntimeTaskStatus,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  state.endedTasks.delete(track.taskId.toLowerCase());
  const revived: BackgroundTrack = { ...track, status, revived: true };
  state.tasks.set(track.taskId, revived);
  return [
    event(
      state,
      "task.started",
      {
        ...shellLinkage(track.taskId, revived),
        description: revived.description ?? revived.command,
        ...(revived.outputFile === undefined ? {} : { outputFile: revived.outputFile })
      },
      revived.turnId,
      raw
    )
  ];
}

/**
 * The shells and monitors an ended agent's child session started and left
 * running. Stamped with the agent, the liveness registry counted them as
 * covered by its entry — which the agent's end just removed — so a server
 * the subagent left running stopped holding a deploy's drain. Whether the
 * CLI stops them when their subagent ends is not captured, and not killing
 * running work outranks a stale row: from here each names itself, and one
 * row says so — with its own tracked status, so a resting (`idle`) one is
 * not re-armed, and a running one counts on its own (the watch loop's TTL)
 * until its own end. One the CLI revived after an end the adapter wrote
 * gets its own start row again instead ({@link reviveShell}'s rule): a
 * status would reopen the roster's row, which keeps that end, and a
 * status-less row re-arms nothing the registry no longer counts.
 */
export function orphanAgentTasks(state: GrokNormalizerState, agentTaskId: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const [taskId, task] of state.tasks) {
    if (task.scope.owner !== agentTaskId || task.ownerEnded === true) {
      continue;
    }
    task.ownerEnded = true;
    const linkage = shellLinkage(taskId, task);
    if (task.revived === true) {
      events.push(
        event(
          state,
          "task.started",
          {
            ...linkage,
            description: task.description ?? task.command,
            ...(task.outputFile === undefined ? {} : { outputFile: task.outputFile })
          },
          task.turnId
        )
      );
      continue;
    }
    events.push(
      event(
        state,
        "task.progress",
        {
          ...linkage,
          description: linkage.title,
          ...(task.lastLine === undefined ? {} : { summary: task.lastLine }),
          status: task.status
        },
        task.turnId
      )
    );
  }
  return events;
}

/**
 * `background_tasks` is a **complete snapshot** of ONE session's background
 * tasks with per-task `status`, so the roster folds it directly instead of
 * inferring a lifecycle from `rawOutput` discriminants the way T3 must.
 * Captured (fixtures 16, 18, 20): the CLI sends one whenever a task of that
 * session starts or ends, restating every task it lists; a subagent's child
 * session sends its own, listing its own tasks only ({@link TaskScope}) —
 * so a task drops out of ITS session's snapshot, never another's.
 *
 * An end shows here (`completed`, a killed shell's `failed`), in
 * `_x.ai/task_completed` — the CLI's own end report, which usually comes
 * first ({@link taskCompleted}) — or in a poll or kill answer
 * ({@link taskAnswers}). A task nobody hears from again is bounded by
 * §3.1's liveness TTL; the adapter's duty is to stop claiming it is live
 * once the session ends, which {@link GrokNormalizer.stopBackgroundTasks} does.
 *
 * An entry whose id a `spawn_subagent` launch reported is that subagent: its
 * end, or its dropping out once listed, is the agent's end. Not seen in any
 * capture — the CLI lists shells and monitors here, never a subagent — but
 * kept, since a subagent's id and a task's share one namespace.
 */
export function foldBackgroundTasks(
  state: GrokNormalizerState,
  tasks: ReadonlyArray<XaiBackgroundTask>,
  raw: RuntimeEventRaw,
  scope: TaskScope
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const seen = new Set<string>();
  const listedSubagents = new Set<string>();
  for (const task of tasks) {
    if (typeof task.task_id !== "string" || task.task_id.length === 0) {
      continue;
    }
    seen.add(task.task_id);
    const status = normalizeTaskStatus(task.status);
    const existing = state.tasks.get(task.task_id);
    if (existing === undefined) {
      events.push(...joinHeldSpawn(state, task.task_id));
    }
    const subagentTask =
      existing === undefined ? state.subagentIds.get(task.task_id.toLowerCase()) : undefined;
    if (subagentTask !== undefined) {
      listedSubagents.add(subagentTask);
      events.push(...subagentFromSnapshot(state, subagentTask, status, raw));
      continue;
    }
    if (existing !== undefined) {
      events.push(...snapshotChange(state, existing, task, status, raw));
      continue;
    }
    const reported = shellReport(state, task.task_id, status, raw);
    if (reported !== undefined) {
      events.push(...reported);
      continue;
    }
    events.push(
      ...startBackgroundTask(
        state,
        {
          taskId: task.task_id,
          command: task.command,
          taskType: task.kind === "monitor" ? "monitor" : "shell",
          scope,
          status,
          ...(task.description === undefined ? {} : { description: task.description }),
          ...(task.output_file === undefined ? {} : { outputFile: task.output_file })
        },
        raw
      )
    );
  }
  // A task that dropped out of its session's snapshot ended without telling us.
  for (const [taskId, track] of [...state.tasks.entries()]) {
    if (track.scope.session !== scope.session || seen.has(taskId) || track.status === "pending") {
      continue;
    }
    endShell(state, taskId, "adapter");
    events.push(
      event(state, "task.completed", { ...shellLinkage(taskId, track), status: "completed" }, track.turnId, raw)
    );
  }
  if (scope.session === PARENT_SCOPE.session) {
    for (const track of state.subagents.values()) {
      if (track.live && track.listed && !listedSubagents.has(track.taskId)) {
        events.push(...closeSubagent(state, track, "completed", "adapter", undefined, raw));
      }
    }
  }
  return events;
}

/**
 * A snapshot entry of a task already tracked. A row only when something the
 * roster or the GUI reads changed — its status, its title (`description`,
 * else `command`), its output file — and then exactly one row, carrying
 * all of it; an unchanged entry emits nothing. The CLI restates every task
 * of a session whenever one of them changes, and a `task.updated` is an
 * APPENDED row (its id is its event's), so one per unchanged listing would
 * be pure churn in the parent's and the agent's retention windows.
 *
 * Nothing here re-arms liveness, and nothing needs to: a shell is a watch
 * loop the registry's TTL bounds (a snapshot is no heartbeat — the CLI
 * sends one on a start or an end, not while a task runs), a monitor re-arms
 * on its own events ({@link monitorEvent}), an agent on its heartbeat
 * ({@link subagentProgress}). A task the adapter closed and the CLI revived
 * keeps the rule of {@link reviveShell}: its status changes ride a
 * status-less, replaced-in-place `task.progress`, never a status that would
 * reopen the roster's row.
 */
function snapshotChange(
  state: GrokNormalizerState,
  track: BackgroundTrack,
  task: XaiBackgroundTask,
  status: RuntimeTaskStatus,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const statusChanged = track.status !== status;
  const description = task.description ?? track.description;
  const titleChanged = description !== track.description;
  const outputFile = task.output_file ?? track.outputFile;
  const fileChanged = outputFile !== track.outputFile;
  if (!statusChanged && !titleChanged && !fileChanged) {
    return [];
  }
  track.status = status;
  if (description !== undefined) {
    track.description = description;
  }
  if (outputFile !== undefined) {
    track.outputFile = outputFile;
  }
  const linkage = {
    ...shellLinkage(track.taskId, track),
    ...(outputFile === undefined ? {} : { outputFile })
  };
  if (statusChanged && isEndedTaskStatus(status)) {
    endShell(state, track.taskId, "cli");
    return [
      event(
        state,
        "task.completed",
        { ...linkage, status: status === "completed" || status === "failed" ? status : "stopped" },
        track.turnId,
        raw
      )
    ];
  }
  if (track.revived === true) {
    // The roster keeps the adapter's end, which a status would reopen: a
    // report that it runs only re-arms the shell's liveness, and a resting
    // one says nothing (its watch-loop TTL bounds it).
    if (statusChanged && status !== "idle") {
      return [event(state, "task.progress", { ...linkage, description: linkage.title }, track.turnId, raw)];
    }
    if (!titleChanged && !fileChanged) {
      return [];
    }
    return [event(state, "task.updated", { ...linkage, description: linkage.title }, track.turnId, raw)];
  }
  return [
    event(
      state,
      "task.updated",
      {
        ...linkage,
        ...(statusChanged ? { status } : {}),
        ...(titleChanged ? { description: linkage.title } : {})
      },
      track.turnId,
      raw
    )
  ];
}

/** Track a new shell or monitor and emit its start. */
function startBackgroundTask(
  state: GrokNormalizerState,
  fields: {
    taskId: string;
    command: string;
    taskType: BackgroundTrack["taskType"];
    scope: TaskScope;
    status: RuntimeTaskStatus;
    description?: string;
    toolUseId?: string;
    outputFile?: string;
  },
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const track: BackgroundTrack = { ...fields, turnId: state.deps.activeTurnId() };
  state.tasks.set(fields.taskId, track);
  return [
    event(
      state,
      "task.started",
      {
        ...shellLinkage(fields.taskId, track),
        description: track.description ?? track.command,
        ...(track.outputFile === undefined ? {} : { outputFile: track.outputFile })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * `_x.ai/task_backgrounded` is the only frame carrying `tool_call_id` AND
 * `task_id` together, so it is the cleanest join between a tool call and the
 * task it started. A monitor's carries `monitor_description` too, and
 * arrives before its call's `Monitor` answer (fixture 20): it starts the
 * monitor. A foreground command the CLI moved to the background is
 * reported here too, its task id being its call's (fixture 16).
 */
export function taskBackgrounded(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw,
  scope: TaskScope
): RuntimeEvent[] {
  const taskId = update["task_id"];
  const command = update["command"];
  if (typeof taskId !== "string" || taskId.length === 0) {
    return [];
  }
  const toolUseId = typeof update["tool_call_id"] === "string" ? update["tool_call_id"] : undefined;
  // A task a `spawn_subagent` call backgrounded is that subagent, already on
  // the roster — never a shell row of its own. Captured: the CLI sends this
  // frame for shells and monitors only (fixtures 16–23); the join stays for
  // a subagent's id, which shares the task namespace.
  if (scope.session === PARENT_SCOPE.session) {
    const subagentTask = subagentOfBackgroundTask(state, taskId, toolUseId);
    if (subagentTask !== undefined) {
      const track = state.subagents.get(subagentTask);
      return track === undefined || track.live ? [] : subagentReport(state, track, true, raw);
    }
  }
  if (typeof command !== "string") {
    return [];
  }
  const monitorDescription = textArgument(update, "monitor_description");
  const description = textArgument(update, "description") ?? monitorDescription;
  const outputFile = typeof update["output_file"] === "string" ? update["output_file"] : undefined;
  const existing = state.tasks.get(taskId);
  if (existing !== undefined) {
    existing.toolUseId ??= toolUseId;
    return [];
  }
  const reported = shellReport(state, taskId, undefined, raw, { toolUseId, outputFile });
  if (reported !== undefined) {
    return reported;
  }
  return startBackgroundTask(
    state,
    {
      taskId,
      command,
      taskType: monitorDescription === undefined ? "shell" : "monitor",
      scope,
      status: "running",
      ...(description === undefined ? {} : { description }),
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(outputFile === undefined ? {} : { outputFile })
    },
    raw
  );
}

/**
 * `_x.ai/task_completed`: a background shell's or monitor's end, in the
 * session that owns it (fixtures 16, 18, 20) — the CLI's own end report,
 * with the task's final state in `task_snapshot`, before its session's
 * snapshot lists it ended. Never sent for a subagent. An end the CLI
 * reported, once ({@link endBackgroundTask}): `explicitly_killed` is a kill
 * (`stopped`; fixture 18's `sleep 301`, `signal: "killed"`), else the exit
 * code decides (`0` completed), else a signal is a failure, else completed.
 * `will_wake: true` announces the parent's wake (a monitor's end), which is
 * the session's.
 */
export function taskCompleted(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const snapshot = asRecord(update["task_snapshot"]) as Partial<XaiTaskSnapshot> | undefined;
  const taskId = textArgument(snapshot as Record<string, unknown> | undefined, "task_id");
  if (snapshot === undefined || taskId === undefined) {
    return [
      event(state, "runtime.warning", { message: "grok: task_completed without a task_snapshot.task_id" }, undefined, raw)
    ];
  }
  const exitCode =
    typeof snapshot.exit_code === "number" && Number.isInteger(snapshot.exit_code) ? snapshot.exit_code : undefined;
  const status: "completed" | "failed" | "stopped" =
    snapshot.explicitly_killed === true
      ? "stopped"
      : exitCode !== undefined
        ? exitCode === 0
          ? "completed"
          : "failed"
        : typeof snapshot.signal === "string" && snapshot.signal.length > 0
          ? "failed"
          : "completed";
  const output = typeof snapshot.output === "string" ? snapshot.output : undefined;
  return endBackgroundTask(state, taskId, status, output, raw, exitCode);
}

/**
 * `_x.ai/monitor_event`: one line a monitor's command printed (fixture 20).
 * The monitor's latest line, as a `task.progress` — replaced in place, so a
 * chatty monitor costs one row — re-arming its liveness: a monitor is a
 * watch loop that reports. The CLI then wakes the agent with the line as a
 * prompt of its own, which is the session's. A monitor the adapter closed
 * that still reports is live again ({@link shellReport}).
 */
export function monitorEvent(
  state: GrokNormalizerState,
  update: Record<string, unknown>,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const taskId = textArgument(update, "task_id");
  if (taskId === undefined) {
    return [];
  }
  const track = state.tasks.get(taskId);
  if (track === undefined) {
    return shellReport(state, taskId, "running", raw) ?? [];
  }
  const line = textArgument(update, "event_text");
  if (line !== undefined) {
    track.lastLine = line;
  }
  const linkage = shellLinkage(taskId, track);
  return [
    event(
      state,
      "task.progress",
      {
        ...linkage,
        description: linkage.title,
        ...(track.lastLine === undefined ? {} : { summary: track.lastLine }),
        ...(track.revived === true ? {} : { status: "running" })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * The background-task discriminants on a tool call's answer (T3's reader,
 * `XAiBackgroundTasks.ts`, and fixtures 16, 18, 20): `BackgroundTaskStarted`
 * starts a shell; `Monitor` — `{type, taskId, timeoutMs, persistent}` on a
 * completed `monitor` call — starts a monitor, described by the call's own
 * `description` argument (T3's rule; normally `_x.ai/task_backgrounded`
 * started it a millisecond before); `TaskOutput` (a
 * `get_command_or_subagent_output` answer) and `KillTask` (a
 * `kill_command_or_subagent` answer) report on tasks already started.
 */
export function backgroundFromToolCall(
  state: GrokNormalizerState,
  toolCallId: string,
  rawInput: unknown,
  rawOutput: unknown,
  status: ToolCallStatus | undefined,
  raw: RuntimeEventRaw,
  scope: TaskScope
): RuntimeEvent[] {
  const record = asRecord(rawOutput);
  if (record === undefined) {
    return [];
  }
  if (record["type"] === "TaskOutput" || record["type"] === "KillTask") {
    return isTerminalToolStatus(status)
      ? taskAnswers(state, record, status === "completed", raw)
      : [];
  }
  const answerRaw: RuntimeEventRaw = {
    source: ACP_RAW_SOURCE,
    method: "session/update:tool_call_update",
    payload: { toolCallId, rawOutput }
  };
  if (record["type"] === MONITOR_OUTPUT) {
    const taskId = textArgument(record, "taskId") ?? textArgument(record, "task_id");
    if (status !== "completed" || taskId === undefined) {
      return [];
    }
    const input = asRecord(rawInput);
    const description = textArgument(input, "description") ?? "Monitor";
    return taskBackgrounded(
      state,
      {
        task_id: taskId,
        command: textArgument(input, "command") ?? description,
        tool_call_id: toolCallId,
        monitor_description: description
      },
      answerRaw,
      scope
    );
  }
  if (record["type"] !== "BackgroundTaskStarted" || status === undefined) {
    return [];
  }
  const taskId = record["task_id"] ?? record["taskId"];
  const command = record["command"];
  if (typeof taskId !== "string" || taskId.length === 0 || typeof command !== "string") {
    return [];
  }
  if (state.tasks.has(taskId)) {
    return [];
  }
  return taskBackgrounded(
    state,
    {
      task_id: taskId,
      command,
      tool_call_id: toolCallId,
      description: typeof record["summary"] === "string" ? record["summary"] : undefined,
      output_file: typeof record["output_file"] === "string" ? record["output_file"] : undefined
    },
    answerRaw,
    scope
  );
}

/**
 * A poll or kill answer about tasks this session started, T3's reader
 * (`XAiBackgroundTasks.ts` `buildGrokBackgroundTaskEvents`) with one
 * departure: a subagent's entry (`command: "[subagent:<type>] …"`) is read
 * too, by the id its launch reported — T3 skips it. Shapes, captured
 * (fixtures 16, 18, 21): `{type: "TaskOutput", Result}` or `{…, MultiResult:
 * {mode, results, summary}}`, each `{task_id, command, status, exit_code,
 * started, ended, duration_secs, output, …}`; `{type: "KillTask", Result:
 * {task_id, outcome: "killed", message}}` ({@link killEnd}). Answers arrive
 * between turns too: the CLI wakes the parent when a background task
 * finishes.
 *
 * - `running` re-arms the task's liveness with a progress row, and ends
 *   nothing (its `output` then is the CLI's advice to the model, not
 *   output); a finished status ends a live run once, with `output` as a
 *   subagent's result (a shell's summary is its first line, as T3's); a
 *   completed kill call ends it as {@link killEnd} says.
 * - An id this session never named — an older process's task, a subagent
 *   whose id no launch reported — starts nothing: T3 starts a row for it,
 *   but after a host restart that would name work the first load already
 *   closed.
 */
function taskAnswers(
  state: GrokNormalizerState,
  output: Record<string, unknown>,
  callCompleted: boolean,
  raw: RuntimeEventRaw
): RuntimeEvent[] {
  const multi = asRecord(output["MultiResult"])?.["results"];
  const results = Array.isArray(multi) ? multi : [output["Result"]];
  const events: RuntimeEvent[] = [];
  for (const value of results) {
    const result = asRecord(value);
    const id = textArgument(result, "task_id");
    if (result === undefined || id === undefined) {
      continue;
    }
    if (output["type"] === "KillTask") {
      const end = callCompleted ? killEnd(result) : undefined;
      if (end !== undefined) {
        events.push(...endBackgroundTask(state, id, end, undefined, raw));
      }
      continue;
    }
    const lifecycle = pollLifecycle(result["status"], result["exit_code"]);
    if (lifecycle === undefined) {
      continue;
    }
    const text = typeof result["output"] === "string" ? result["output"].trim() : "";
    const exitCode =
      typeof result["exit_code"] === "number" && Number.isInteger(result["exit_code"])
        ? result["exit_code"]
        : undefined;
    events.push(
      ...(lifecycle === "running"
        ? backgroundTaskRunning(state, id, raw)
        : endBackgroundTask(state, id, lifecycle, text.length > 0 ? text : undefined, raw, exitCode))
    );
  }
  return events;
}

/**
 * A task an answer names as still running. A live one: one progress row
 * re-arms it — with no status on a revived one, whose roster row keeps the
 * adapter's end. One the adapter closed itself counts live again
 * ({@link shellReport}, {@link subagentReport}).
 */
function backgroundTaskRunning(state: GrokNormalizerState, id: string, raw: RuntimeEventRaw): RuntimeEvent[] {
  const shell = state.tasks.get(id);
  if (shell !== undefined) {
    const linkage = shellLinkage(id, shell);
    return [
      event(
        state,
        "task.progress",
        {
          ...linkage,
          description: linkage.title,
          ...(shell.revived === true ? {} : { status: "running" })
        },
        shell.turnId,
        raw
      )
    ];
  }
  // A child whose join still waits is decided before its agent is read.
  const decided = joinHeldSpawn(state, id);
  if (decided.length > 0) {
    return [...decided, ...backgroundTaskRunning(state, id, raw)];
  }
  const track = subagentNamed(state, id);
  if (track === undefined) {
    return shellReport(state, id, "running", raw) ?? [];
  }
  if (!track.live) {
    return subagentReport(state, track, true, raw);
  }
  return [
    event(
      state,
      "task.progress",
      {
        ...subagentLinkage(track),
        description: track.title,
        ...(track.revived ? {} : { status: "running" })
      },
      track.turnId,
      raw
    )
  ];
}

/**
 * A task the CLI reports finished: a live one's end, once — a shell's or
 * monitor's with its output's first line and its exit code, a subagent's
 * with its answer. For one the adapter closed itself, the CLI's end —
 * remembered, with no second row; for one whose end the CLI already
 * reported, nothing.
 */
function endBackgroundTask(
  state: GrokNormalizerState,
  id: string,
  status: "completed" | "failed" | "stopped",
  output: string | undefined,
  raw: RuntimeEventRaw,
  exitCode?: number
): RuntimeEvent[] {
  const shell = state.tasks.get(id);
  if (shell !== undefined) {
    endShell(state, id, "cli");
    // A shell's summary is its output's first line (T3's rule); a monitor's
    // its LAST — its latest event, as its progress row showed while it ran.
    const lines = (output ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const summary = shell.taskType === "monitor" ? lines.at(-1) : lines[0];
    return [
      event(
        state,
        "task.completed",
        {
          ...shellLinkage(id, shell),
          status,
          ...(summary === undefined ? {} : { summary }),
          ...(exitCode === undefined ? {} : { exitCode })
        },
        shell.turnId,
        raw
      )
    ];
  }
  const decided = joinHeldSpawn(state, id);
  if (decided.length > 0) {
    return [...decided, ...endBackgroundTask(state, id, status, output, raw, exitCode)];
  }
  const track = subagentNamed(state, id);
  if (track === undefined) {
    return shellReport(state, id, status === "stopped" ? "cancelled" : status, raw) ?? [];
  }
  if (!track.live) {
    return subagentReport(state, track, false, raw);
  }
  const owner = state.subagentLaunches.get(track.owner);
  if (owner !== undefined) {
    owner.settled = true;
  }
  return closeSubagent(state, track, status, "cli", subagentAnswerText(output), raw);
}

/**
 * A shell's or monitor's rows, as the snapshot and Stop closers write them.
 * Its `agentId` is its owner's — the subagent whose child session started
 * it — else itself (every Grok task row names an agent; the liveness
 * registry reads an id equal to the task's own as "no owner").
 */
export function shellLinkage(
  taskId: string,
  track: BackgroundTrack
): {
  taskId: string;
  taskType: string;
  agentKind: "background";
  agentId: string;
  title: string;
  toolUseId?: string;
} {
  return {
    taskId,
    taskType: track.taskType,
    agentKind: "background",
    agentId: track.scope.owner !== undefined && track.ownerEnded !== true ? track.scope.owner : taskId,
    title: track.description ?? track.command,
    ...(track.toolUseId === undefined ? {} : { toolUseId: track.toolUseId })
  };
}

/** `killed`→`cancelled`, `paused`→`idle`, normalised at the adapter (§4.2). */
export function normalizeTaskStatus(status: string | undefined): RuntimeTaskStatus {
  switch (status?.trim().toLowerCase()) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "paused":
    case "idle":
      return "idle";
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "stopped":
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}
