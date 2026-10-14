// Scheduled tasks — the daemon's scheduler (design 2026-10-14 §5 "Scheduling"; the wire contract and
// the user-facing rules are in `@orquester/api` `scheduled-tasks.ts`).
//
// Reuses the workflow schedule trigger's primitives rather than its own: croner via
// `nextScheduleRun`/`validateCron` (@orquester/api), the injectable `Clock`, ONE self-rescheduling
// timer capped at `SCHEDULER_MAX_TIMER_MS` (a wall-clock jump is noticed within a minute) and the
// same missed-run grace (`MISSED_RUN_GRACE_MINUTES`).
//
// Lifecycle of a run:
//
//   1. Due. On a tick (and at boot) every enabled task whose `nextRunAt` has passed is handled ONCE:
//      - more than the grace late (Orquester was not running): recorded `missed`, nothing is sent; a
//        cron task moves on to its next time from now, a one-shot task is paused. Never a burst of
//        catch-up runs;
//      - else a delivery is QUEUED (`pending`, with a `fireKey`) and a cron task's next time is
//        computed from now. A cron run that comes due while the previous delivery still waits is
//        folded into it (no second message).
//      The advanced state is persisted BEFORE anything is sent: a crash between the two retries the
//      same delivery (step 2), never a new one.
//   2. Delivered. A queued delivery goes out through the normal agent-chat `/turn` route once the
//      thread is idle — no running or starting turn, no open approval or question, no goal the
//      provider is continuing — so a scheduled prompt never steers a running turn; it waits like
//      the composer's queue does, but for the turn's END (a scheduled prompt is new work, not a
//      steer). The command id is `scheduled-task:<taskId>:<fireKey>`: a retry after a restart
//      mid-delivery replays the host's receipt instead of sending twice. The thread is re-checked
//      on every `sessions` bus event about it and every `RETRY_MS` while anything waits.
//   3. Settled. Accepted → `delivered` (a one-shot task is removed); the host refused it → `failed`
//      with the reason; the host unreachable → still queued.
//
// A thread that is closed (its tab closed = the thread deleted) takes its tasks with it: on its
// `session.closed` event, and at boot / delivery time when the session list no longer has it.

import { randomUUID } from "node:crypto";
import {
  firstScheduledTaskRun,
  nextScheduleRun,
  SCHEDULED_TASK_CONTEXT_KIND,
  SCHEDULED_TASK_PROMPT_MAX,
  SCHEDULED_TASKS_MAX,
  SCHEDULED_TASKS_PER_THREAD_MAX,
  scheduledTaskScheduleProblem,
  type CreateScheduledTaskRequest,
  type RunScheduledTaskResponse,
  type EventMessage,
  type ScheduledTask,
  type ScheduledTaskDeletedPayload,
  type ScheduledTaskErrorCode,
  type ScheduledTaskEventType,
  type ScheduledTaskRunStatus,
  type ScheduledTaskSchedule,
  type SessionSummary,
  type UpdateScheduledTaskRequest
} from "@orquester/api";
import { agentChatRoutes, type ThreadReadResponse, type ThreadSnapshotPayload, type TurnCommandBody } from "@orquester/api/agent-chat";
import type { ScheduledTaskRecord } from "@orquester/config";
import { resolveChatActivity, type ChatActivityRung } from "../agent-chat/activity-ladder.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { daemonError } from "../mcp/errors.ts";
import type { Clock, WorkflowLogger } from "../workflows/contracts.ts";
import { systemTriggerClock } from "../workflows/triggers/clock.ts";
import { MISSED_RUN_GRACE_MINUTES, SCHEDULER_MAX_TIMER_MS } from "../workflows/triggers/scheduler.ts";
import type { ScheduledTasksStore } from "./store.ts";

/** How often a queued delivery is looked at again when no bus event about its thread arrives. */
export const SCHEDULED_TASK_RETRY_MS = 30_000;

/** The ladder rungs during which a thread is not ready for a new message. */
const BUSY_RUNGS: ReadonlySet<ChatActivityRung> = new Set<ChatActivityRung>(["approval", "question", "starting", "running", "goal-continuing"]);

const RUN_STATUSES: ReadonlySet<string> = new Set<ScheduledTaskRunStatus>(["delivered", "missed", "failed"]);

/** A refusal the routes answer verbatim: `status` with `{ code, message }`. */
export class ScheduledTaskError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: ScheduledTaskErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}

export interface ScheduledTasksServiceOptions {
  store: ScheduledTasksStore;
  /** Every change, after it is written: the daemon's broadcaster on `SCHEDULED_TASKS_CHANNEL`. */
  publish(type: ScheduledTaskEventType, payload: ScheduledTask | ScheduledTaskDeletedPayload): void;
  clock?: Clock;
  logger?: WorkflowLogger;
  mintId?: () => string;
}

const consoleLogger: WorkflowLogger = {
  debug() {},
  info: (msg, meta) => console.log(`[scheduled-tasks] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
  warn: (msg, meta) => console.warn(`[scheduled-tasks] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
  error: (msg, meta) => console.error(`[scheduled-tasks] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`)
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The record as the wire shows it. */
export function toScheduledTask(record: ScheduledTaskRecord): ScheduledTask {
  return {
    id: record.id,
    threadId: record.threadId,
    projectPath: record.projectPath,
    prompt: record.prompt,
    schedule:
      record.schedule.kind === "once"
        ? { kind: "once", at: record.schedule.at }
        : { kind: "cron", cron: record.schedule.cron, timezone: record.schedule.timezone },
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdByThreadId: record.createdByThreadId,
    nextRunAt: record.nextRunAt,
    lastRunAt: record.lastRunAt,
    lastRunStatus: record.lastRunStatus !== null && RUN_STATUSES.has(record.lastRunStatus) ? (record.lastRunStatus as ScheduledTaskRunStatus) : null,
    lastRunError: record.lastRunError,
    runCount: record.runCount,
    queuedAt: record.pending?.queuedAt ?? null
  };
}

function invalid(message: string): ScheduledTaskError {
  return new ScheduledTaskError(400, "INVALID_REQUEST", message);
}

function readPrompt(value: unknown): string {
  if (typeof value !== "string") throw invalid("prompt must be a string.");
  const prompt = value.trim();
  if (prompt.length === 0) throw invalid("prompt must not be empty.");
  if (prompt.length > SCHEDULED_TASK_PROMPT_MAX) throw invalid(`prompt must be at most ${SCHEDULED_TASK_PROMPT_MAX} characters.`);
  return prompt;
}

/** A schedule from the wire, normalised: a one-shot's `at` as UTC ISO, a cron's whitespace collapsed. */
function readSchedule(value: unknown, now: Date): ScheduledTaskSchedule {
  if (!isRecord(value)) throw invalid("schedule must be an object.");
  let schedule: ScheduledTaskSchedule;
  if (value.kind === "once") {
    if (typeof value.at !== "string") throw invalid("schedule.at must be an ISO date-time.");
    schedule = { kind: "once", at: value.at };
  } else if (value.kind === "cron") {
    if (typeof value.cron !== "string") throw invalid("schedule.cron must be a string.");
    if (typeof value.timezone !== "string" || value.timezone.length === 0) throw invalid("schedule.timezone must be an IANA time zone.");
    schedule = { kind: "cron", cron: value.cron.trim().split(/\s+/).join(" "), timezone: value.timezone };
  } else {
    throw invalid('schedule.kind must be "once" or "cron".');
  }
  const problem = scheduledTaskScheduleProblem(schedule, now);
  if (problem !== null) throw invalid(`${problem}.`);
  return schedule.kind === "once" ? { kind: "once", at: new Date(Date.parse(schedule.at)).toISOString() } : schedule;
}

/** Whether a fresh snapshot says the thread cannot take a new message yet. */
function snapshotBusy(snap: ThreadSnapshotPayload): boolean {
  if (snap.pending.approvals.length > 0 || snap.pending.userInputs.length > 0) return true;
  const session = snap.head.session;
  if (session.activeTurnId !== null || session.status === "starting") return true;
  const last = snap.turns[snap.turns.length - 1];
  return last !== undefined && (last.state === "pending" || last.state === "running");
}

export class ScheduledTasksService {
  private readonly store: ScheduledTasksStore;
  private readonly clock: Clock;
  private readonly logger: WorkflowLogger;
  private readonly mintId: () => string;
  private api: DaemonApi | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: { cancel(): void } | null = null;
  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  /** Threads with a delivery pass already queued on the chain (bus events can come in bursts). */
  private readonly wakeQueued = new Set<string>();

  constructor(private readonly options: ScheduledTasksServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemTriggerClock;
    this.logger = options.logger ?? consoleLogger;
    this.mintId = options.mintId ?? randomUUID;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /**
   * With the daemon's own client (after `agentChat.init()`, like the workflow engine): drops the
   * tasks of threads that no longer exist, handles anything that came due while Orquester was down
   * (the missed-run policy), retries the deliveries a restart interrupted, and arms the timer.
   */
  start(api: DaemonApi): Promise<void> {
    if (this.started || this.stopped) return this.chain;
    this.started = true;
    this.api = api;
    this.unsubscribe = api.subscribe((event) => this.onEvent(event));
    return this.enqueue(async () => {
      await this.reconcileThreads();
      await this.tick();
      await this.deliverQueued(null);
    });
  }

  /** Cancels the timer and the bus subscription; work in flight finishes, nothing new starts. */
  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once every queued unit of work has finished (tests). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  // ---- reads -----------------------------------------------------------------------------------

  list(filter: { threadId?: string; projectPath?: string } = {}): ScheduledTask[] {
    return this.store
      .all()
      .filter((record) => (filter.threadId === undefined || record.threadId === filter.threadId) && (filter.projectPath === undefined || record.projectPath === filter.projectPath))
      .map(toScheduledTask);
  }

  get(id: string): ScheduledTask | undefined {
    const record = this.store.get(id);
    return record ? toScheduledTask(record) : undefined;
  }

  // ---- mutations (serialized with the scheduler's own work) --------------------------------------

  create(request: CreateScheduledTaskRequest): Promise<ScheduledTask> {
    return this.serialized(async () => {
      this.requireWritable();
      const body: unknown = request;
      if (!isRecord(body)) throw invalid("The body must be an object.");
      if (typeof body.threadId !== "string" || body.threadId.length === 0 || body.threadId.length > 200) throw invalid("threadId must be a session id.");
      const createdBy = body.createdByThreadId;
      if (createdBy !== undefined && createdBy !== null && (typeof createdBy !== "string" || createdBy.length === 0 || createdBy.length > 200)) {
        throw invalid("createdByThreadId must be a session id or null.");
      }
      const prompt = readPrompt(body.prompt);
      const now = this.clock.now();
      const schedule = readSchedule(body.schedule, now);
      const session = (await this.sessions()).find((candidate) => candidate.id === body.threadId);
      if (!session) throw new ScheduledTaskError(404, "THREAD_NOT_FOUND", `No chat thread with id "${body.threadId}".`);
      if (session.kind !== "agent-chat") throw new ScheduledTaskError(400, "NOT_A_CHAT_SESSION", "Tasks can only be scheduled for a chat thread.");
      const all = this.store.all();
      if (all.filter((record) => record.threadId === session.id).length >= SCHEDULED_TASKS_PER_THREAD_MAX) {
        throw new ScheduledTaskError(409, "SCHEDULED_TASKS_FULL", `This thread already has ${SCHEDULED_TASKS_PER_THREAD_MAX} scheduled tasks. Delete one first.`);
      }
      if (all.length >= SCHEDULED_TASKS_MAX) {
        throw new ScheduledTaskError(409, "SCHEDULED_TASKS_FULL", `Orquester already holds ${SCHEDULED_TASKS_MAX} scheduled tasks. Delete one first.`);
      }
      const stamp = now.toISOString();
      const record: ScheduledTaskRecord = {
        id: this.mintId(),
        threadId: session.id,
        projectPath: session.projectPath,
        prompt,
        schedule,
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
        createdByThreadId: typeof createdBy === "string" ? createdBy : null,
        nextRunAt: firstScheduledTaskRun(schedule, now),
        lastRunAt: null,
        lastRunStatus: null,
        lastRunError: null,
        runCount: 0,
        pending: null
      };
      await this.commit([record], []);
      return toScheduledTask(record);
    });
  }

  update(id: string, patch: UpdateScheduledTaskRequest): Promise<ScheduledTask> {
    return this.serialized(async () => {
      this.requireWritable();
      const current = this.require(id);
      const body: unknown = patch;
      if (!isRecord(body)) throw invalid("The body must be an object.");
      const now = this.clock.now();
      const next: ScheduledTaskRecord = { ...current, updatedAt: now.toISOString() };
      if (body.prompt !== undefined) next.prompt = readPrompt(body.prompt);
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean.");
      const scheduleChanged = body.schedule !== undefined;
      if (scheduleChanged) next.schedule = readSchedule(body.schedule, now);
      const enabled = body.enabled === undefined ? current.enabled : body.enabled;
      next.enabled = enabled;
      if (!enabled) {
        // Paused: nothing comes due, and a delivery still waiting is dropped with it.
        next.nextRunAt = null;
        next.pending = null;
      } else if (scheduleChanged || !current.enabled) {
        if (!scheduleChanged) {
          const problem = scheduledTaskScheduleProblem(next.schedule as ScheduledTaskSchedule, now);
          if (problem !== null) throw invalid(next.schedule.kind === "once" ? "This task's time has passed: give it a new schedule to resume it." : `${problem}.`);
        }
        next.nextRunAt = firstScheduledTaskRun(next.schedule as ScheduledTaskSchedule, now);
      }
      await this.commit([next], []);
      return toScheduledTask(next);
    });
  }

  delete(id: string): Promise<void> {
    return this.serialized(async () => {
      this.requireWritable();
      this.require(id);
      await this.commit([], [id]);
    });
  }

  /** Queues a delivery now (whatever the schedule, paused included) and tries it at once. */
  runNow(id: string): Promise<RunScheduledTaskResponse> {
    return this.serialized(async () => {
      this.requireWritable();
      if (this.api === null) throw new ScheduledTaskError(503, "SCHEDULER_UNAVAILABLE", "The scheduler is starting; try again in a few seconds.");
      const current = this.require(id);
      if (current.pending !== null) {
        throw new ScheduledTaskError(409, "ALREADY_QUEUED", "A delivery of this task is already waiting for the thread to be idle.");
      }
      const now = this.clock.now();
      const stamp = now.toISOString();
      const queued: ScheduledTaskRecord = {
        ...current,
        updatedAt: stamp,
        pending: { fireKey: `manual-${now.getTime()}-${this.mintId().slice(0, 8)}`, scheduledFor: stamp, queuedAt: stamp, manual: true }
      };
      await this.commit([queued], []);
      await this.deliverQueued(current.threadId);
      const after = this.store.get(id);
      return { task: after ? toScheduledTask(after) : null, delivered: after === undefined || after.pending === null };
    });
  }

  // ---- internals -------------------------------------------------------------------------------

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain
      .then(work)
      .catch((error: unknown) => {
        this.logger.error("scheduler step failed", { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => this.arm());
    this.chain = next;
    return next;
  }

  /** A route's mutation, on the same chain as the timer's work; its result (or refusal) goes back to the caller. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
    const result = new Promise<T>((resolve, reject) => {
      settle = { resolve, reject };
    });
    void this.enqueue(async () => {
      try {
        settle.resolve(await work());
      } catch (error) {
        settle.reject(error);
      }
    });
    return result;
  }

  private requireWritable(): void {
    if (this.store.blockedReason !== null) {
      throw new ScheduledTaskError(503, "SCHEDULER_UNAVAILABLE", "Scheduled tasks are unavailable: their file could not be read. Restart Orquester after fixing it.");
    }
  }

  private require(id: string): ScheduledTaskRecord {
    const record = this.store.get(id);
    if (!record) throw new ScheduledTaskError(404, "SCHEDULED_TASK_NOT_FOUND", `No scheduled task with id "${id}".`);
    return record;
  }

  /**
   * Applies upserts and deletes, writes them, then publishes. A write that fails restores memory to
   * what it was and refuses: no client is told about a change that is not on disk.
   */
  private async commit(upserts: ScheduledTaskRecord[], deletes: string[]): Promise<void> {
    const before = new Map<string, ScheduledTaskRecord | undefined>();
    for (const record of upserts) before.set(record.id, this.store.get(record.id));
    for (const id of deletes) before.set(id, this.store.get(id));
    for (const record of upserts) this.store.put(record);
    for (const id of deletes) this.store.delete(id);
    try {
      await this.store.persist();
    } catch {
      for (const [id, record] of before) {
        if (record) this.store.put(record);
        else this.store.delete(id);
      }
      throw new ScheduledTaskError(503, "SCHEDULER_UNAVAILABLE", "The scheduled tasks could not be saved.");
    }
    for (const record of upserts) this.options.publish("scheduledTask.upserted", toScheduledTask(record));
    for (const id of deletes) {
      const gone = before.get(id);
      if (gone) this.options.publish("scheduledTask.deleted", { id, threadId: gone.threadId });
    }
  }

  /** `commit` for the scheduler's own steps: a failed write is logged, never thrown. */
  private async commitQuietly(upserts: ScheduledTaskRecord[], deletes: string[]): Promise<boolean> {
    try {
      await this.commit(upserts, deletes);
      return true;
    } catch {
      this.logger.error("could not save scheduled tasks; the change is not applied");
      return false;
    }
  }

  private async sessions(): Promise<SessionSummary[]> {
    if (this.api === null) throw new ScheduledTaskError(503, "SCHEDULER_UNAVAILABLE", "The scheduler is starting; try again in a few seconds.");
    const res = await this.api.request("GET", "/api/sessions");
    if (res.status >= 400 || !Array.isArray(res.body)) {
      throw new ScheduledTaskError(503, "SCHEDULER_UNAVAILABLE", "The session list could not be read.");
    }
    return res.body as SessionSummary[];
  }

  private onEvent(event: EventMessage): void {
    if (this.stopped || event.channel !== "sessions") return;
    const id = (event.payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return;
    if (event.type === "session.closed") {
      if (this.store.all().some((record) => record.threadId === id)) {
        void this.enqueue(() => this.removeThreadTasks(id));
      }
      return;
    }
    if (event.type !== "session.updated" && event.type !== "session.activity" && event.type !== "session.created") return;
    if (this.wakeQueued.has(id)) return;
    if (!this.store.all().some((record) => record.threadId === id && record.pending !== null)) return;
    this.wakeQueued.add(id);
    void this.enqueue(async () => {
      this.wakeQueued.delete(id);
      await this.deliverQueued(id);
    });
  }

  private async removeThreadTasks(threadId: string): Promise<void> {
    const ids = this.store.all().filter((record) => record.threadId === threadId).map((record) => record.id);
    if (ids.length === 0) return;
    this.logger.info("thread closed: its scheduled tasks are removed", { threadId, tasks: ids.length });
    await this.commitQuietly([], ids);
  }

  /** At boot: the tasks of a thread the session list no longer has (closed while the daemon was down) go. */
  private async reconcileThreads(): Promise<void> {
    if (this.store.size === 0) return;
    let sessions: SessionSummary[];
    try {
      sessions = await this.sessions();
    } catch {
      return;
    }
    const chats = new Set(sessions.filter((session) => session.kind === "agent-chat").map((session) => session.id));
    const gone = new Set(this.store.all().filter((record) => !chats.has(record.threadId)).map((record) => record.threadId));
    for (const threadId of gone) await this.removeThreadTasks(threadId);
  }

  /** Handles every due task once (the missed-run policy), persisting before anything is sent. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.clock.now();
    const graceMs = MISSED_RUN_GRACE_MINUTES * 60_000;
    const stamp = now.toISOString();
    const changed: ScheduledTaskRecord[] = [];
    for (const task of this.store.all()) {
      if (!task.enabled || task.nextRunAt === null) continue;
      const due = Date.parse(task.nextRunAt);
      if (Number.isNaN(due) || due > now.getTime()) continue;
      const nextRunAt = task.schedule.kind === "cron" ? nextScheduleRun(task.schedule.cron, task.schedule.timezone, now) : null;
      if (task.pending !== null) {
        // Still waiting for the thread from an earlier run: this one folds into it.
        this.logger.info("a run came due while the previous delivery still waits; folded into it", { taskId: task.id });
        changed.push({ ...task, nextRunAt });
        continue;
      }
      if (now.getTime() - due > graceMs) {
        this.logger.info("missed run (Orquester was not running at its time)", { taskId: task.id, scheduledFor: task.nextRunAt });
        changed.push({
          ...task,
          nextRunAt,
          enabled: task.schedule.kind === "once" ? false : task.enabled,
          updatedAt: stamp,
          lastRunStatus: "missed",
          lastRunError: `Missed the run due at ${task.nextRunAt}: Orquester was not running.`
        });
        continue;
      }
      changed.push({
        ...task,
        nextRunAt,
        updatedAt: stamp,
        pending: { fireKey: String(due), scheduledFor: new Date(due).toISOString(), queuedAt: stamp, manual: false }
      });
    }
    if (changed.length > 0) await this.commitQuietly(changed, []);
  }

  /**
   * Tries the queued deliveries — of one thread, or of all — at most one per thread per pass: once
   * one is accepted the thread is busy, and the next waits for its turn to end.
   */
  private async deliverQueued(onlyThread: string | null): Promise<void> {
    if (this.stopped || this.api === null) return;
    const queued = this.store
      .all()
      .filter((record) => record.pending !== null && (onlyThread === null || record.threadId === onlyThread))
      .sort((a, b) => a.pending!.queuedAt.localeCompare(b.pending!.queuedAt));
    if (queued.length === 0) return;
    let sessions: SessionSummary[];
    try {
      sessions = await this.sessions();
    } catch {
      return; // retried on the next event or timer
    }
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const threads = [...new Set(queued.map((record) => record.threadId))];
    for (const threadId of threads) {
      if (this.stopped) return;
      const session = byId.get(threadId);
      if (!session || session.kind !== "agent-chat") {
        await this.removeThreadTasks(threadId);
        continue;
      }
      if (BUSY_RUNGS.has(resolveChatActivity(session).rung)) continue;
      const first = queued.find((record) => record.threadId === threadId);
      if (first) await this.deliverOne(first.id);
    }
  }

  private async deliverOne(taskId: string): Promise<void> {
    const api = this.api;
    if (api === null) return;
    const before = this.store.get(taskId);
    if (!before?.pending) return;
    const threadId = before.threadId;
    // The summary trails the host by a poll: the snapshot is what the host holds right now — a turn
    // this scheduler sent a moment ago included.
    let snapshotRes;
    try {
      snapshotRes = await api.request("GET", agentChatRoutes.thread(threadId));
    } catch {
      return;
    }
    const snap = (snapshotRes.body as ThreadReadResponse | null) ?? null;
    if (snapshotRes.status >= 400 || snap?.kind !== "snapshot") return;
    if (snapshotBusy(snap.thread)) return;
    const task = this.store.get(taskId);
    if (!task?.pending) return;
    const fireKey = task.pending.fireKey;
    const body: TurnCommandBody = {
      commandId: `scheduled-task:${task.id}:${fireKey}`,
      input: task.prompt,
      interactionMode: "default",
      context: [{ kind: SCHEDULED_TASK_CONTEXT_KIND, label: "Scheduled task", ref: task.id }]
    };
    let res;
    try {
      res = await api.request("POST", agentChatRoutes.turn(threadId), { body });
    } catch (error) {
      this.logger.warn("delivery failed; it stays queued", { taskId, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (res.status === 502 || res.status === 503) return; // the host is restarting: still queued
    const current = this.store.get(taskId);
    if (!current || current.pending?.fireKey !== fireKey) return; // deleted or replaced meanwhile
    const stamp = this.clock.now().toISOString();
    if (res.status < 400) {
      this.logger.info("delivered", { taskId, threadId });
      if (current.schedule.kind === "once") {
        await this.commitQuietly([], [taskId]);
        return;
      }
      await this.commitQuietly(
        [{ ...current, pending: null, updatedAt: stamp, lastRunAt: stamp, lastRunStatus: "delivered", lastRunError: null, runCount: current.runCount + 1 }],
        []
      );
      return;
    }
    const reason = daemonError(res).message;
    this.logger.warn("the thread refused the delivery", { taskId, status: res.status, reason });
    await this.commitQuietly(
      [
        {
          ...current,
          pending: null,
          updatedAt: stamp,
          lastRunAt: stamp,
          lastRunStatus: "failed",
          lastRunError: reason,
          runCount: current.runCount + 1,
          ...(current.schedule.kind === "once" ? { enabled: false, nextRunAt: null } : {})
        }
      ],
      []
    );
  }

  /** One timer: the earliest due time, sooner while a delivery waits, never more than a minute away. */
  private arm(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.stopped || !this.started) return;
    const now = this.clock.now().getTime();
    let earliest: number | null = null;
    for (const record of this.store.all()) {
      const candidates: number[] = [];
      if (record.enabled && record.nextRunAt !== null) candidates.push(Date.parse(record.nextRunAt));
      if (record.pending !== null) candidates.push(now + SCHEDULED_TASK_RETRY_MS);
      for (const at of candidates) {
        if (Number.isNaN(at)) continue;
        earliest = earliest === null ? at : Math.min(earliest, at);
      }
    }
    if (earliest === null) return;
    const delay = Math.min(SCHEDULER_MAX_TIMER_MS, Math.max(0, earliest - now));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.enqueue(async () => {
        await this.tick();
        await this.deliverQueued(null);
      });
    }, delay);
  }
}
