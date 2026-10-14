/**
 * Scheduled tasks — prompts delivered to an agent-chat thread later, once or on a cron (design
 * `docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md` §5 "Scheduling").
 *
 * Owned by the daemon (`<appdir>/daemon/scheduled-tasks.json`, schema in `@orquester/config`),
 * served by `/api/scheduled-tasks`, and every change is broadcast on the `/events` channel
 * {@link SCHEDULED_TASKS_CHANNEL}. Agents create them through the `schedule_task` session tool; the
 * chat's status line lists a thread's tasks with Run now and Cancel.
 *
 * Delivery: when a task comes due the daemon queues ONE delivery and sends the prompt as a user
 * message through the normal agent-chat `/turn` path once the thread is idle — never as a steer into
 * a running turn, never while an approval or a question is open. A cron run that comes due while the
 * previous delivery still waits is folded into it. Missed runs (Orquester not running at the time):
 * a run more than {@link SCHEDULED_TASK_MISSED_GRACE_MINUTES} late is not delivered; it is recorded
 * as `missed`, a cron task moves on to its next time from now, a one-shot task is paused.
 */

import { nextScheduleRun, validateCron, isValidTimeZone } from "./workflows/schedule.ts";

// ---------------------------------------------------------------------------
// Limits (enforced by the daemon)
// ---------------------------------------------------------------------------

/** UTF-16 units. */
export const SCHEDULED_TASK_PROMPT_MAX = 32_000;
/** Tasks one thread may have. A create past it is a 409 `SCHEDULED_TASKS_FULL`. */
export const SCHEDULED_TASKS_PER_THREAD_MAX = 25;
/** Tasks across every thread. */
export const SCHEDULED_TASKS_MAX = 1_000;
/** How far ahead a one-shot task may be scheduled. */
export const SCHEDULED_TASK_MAX_AHEAD_DAYS = 366;
/**
 * A due run later than this after its time (Orquester was not running) is recorded as missed rather
 * than delivered — the workflow schedule trigger's grace (`MISSED_RUN_GRACE_MINUTES`).
 */
export const SCHEDULED_TASK_MISSED_GRACE_MINUTES = 15;

// ---------------------------------------------------------------------------
// The record and the routes
// ---------------------------------------------------------------------------

export type ScheduledTaskSchedule =
  | { kind: "once"; /** ISO instant. */ at: string }
  | { kind: "cron"; /** 5 fields (or 6 with a fixed second), at most once a minute. */ cron: string; /** IANA zone. */ timezone: string };

export type ScheduledTaskRunStatus = "delivered" | "missed" | "failed";

export interface ScheduledTask {
  id: string;
  /** The agent-chat thread (= session id) the prompt goes to. */
  threadId: string;
  /** That thread's project ("" for a thread bound to none). */
  projectPath: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  /** False: paused — never comes due (Run now still works). */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The thread whose agent scheduled it, when an agent did. */
  createdByThreadId: string | null;
  /** The next due time; null when paused, finished, or the cron never fires again. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduledTaskRunStatus | null;
  lastRunError: string | null;
  runCount: number;
  /**
   * When a delivery came due and started waiting for the thread (busy, or the agent host down);
   * null when nothing waits.
   */
  queuedAt: string | null;
}

/** `GET /api/scheduled-tasks?threadId=&projectPath=` — both optional filters. Unordered. */
export interface ScheduledTaskListQuery {
  threadId?: string;
  projectPath?: string;
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTask[];
}

/** `POST /api/scheduled-tasks` → 201 the created {@link ScheduledTask}. */
export interface CreateScheduledTaskRequest {
  threadId: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  createdByThreadId?: string | null;
}

/** `PUT /api/scheduled-tasks/:id` → the updated {@link ScheduledTask}. Omitted fields stay. */
export interface UpdateScheduledTaskRequest {
  prompt?: string;
  schedule?: ScheduledTaskSchedule;
  enabled?: boolean;
}

// `GET /api/scheduled-tasks/:id` → the {@link ScheduledTask}.
// `DELETE /api/scheduled-tasks/:id` → 204.

/**
 * `POST /api/scheduled-tasks/:id/run` — queue a delivery now, whatever the schedule (a paused task
 * included), and try it at once. 409 `ALREADY_QUEUED` when one already waits. A one-shot task is
 * removed once its prompt is delivered.
 */
export interface RunScheduledTaskResponse {
  /** The task after the attempt; null when a one-shot task was delivered and so removed. */
  task: ScheduledTask | null;
  /** The prompt reached the thread now; false while it waits for the thread to be idle. */
  delivered: boolean;
}

export const scheduledTaskRoutes = {
  list: "/api/scheduled-tasks",
  item: (id: string): string => `/api/scheduled-tasks/${encodeURIComponent(id)}`,
  run: (id: string): string => `/api/scheduled-tasks/${encodeURIComponent(id)}/run`
} as const;

/** The refusal codes the routes answer with, flat `{ code, message }`. */
export type ScheduledTaskErrorCode =
  | "INVALID_REQUEST"
  | "THREAD_NOT_FOUND"
  | "NOT_A_CHAT_SESSION"
  | "SCHEDULED_TASK_NOT_FOUND"
  | "SCHEDULED_TASKS_FULL"
  | "ALREADY_QUEUED"
  | "SCHEDULER_UNAVAILABLE";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const SCHEDULED_TASKS_CHANNEL = "scheduled-tasks";

export type ScheduledTaskEventType = "scheduledTask.upserted" | "scheduledTask.deleted";

/** `scheduledTask.upserted` carries the whole {@link ScheduledTask}; `scheduledTask.deleted` this. */
export interface ScheduledTaskDeletedPayload {
  id: string;
  threadId: string;
}

// ---------------------------------------------------------------------------
// Schedules (pure; the daemon and the tools share them)
// ---------------------------------------------------------------------------

/** Why `schedule` cannot be used as of `now`, or null. A one-shot time must lie ahead. */
export function scheduledTaskScheduleProblem(schedule: ScheduledTaskSchedule, now: Date): string | null {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) return `"${schedule.at}" is not an ISO date-time`;
    if (at <= now.getTime()) return "The time must be in the future";
    if (at - now.getTime() > SCHEDULED_TASK_MAX_AHEAD_DAYS * 86_400_000) {
      return `The time must be within ${SCHEDULED_TASK_MAX_AHEAD_DAYS} days`;
    }
    return null;
  }
  if (!isValidTimeZone(schedule.timezone)) return `Unknown time zone "${schedule.timezone}"`;
  const problem = validateCron(schedule.cron, schedule.timezone);
  return problem === null ? null : problem.replace("a workflow runs", "a task runs");
}

/** The first due time of `schedule` after `from` (a one-shot's own time), or null. */
export function firstScheduledTaskRun(schedule: ScheduledTaskSchedule, from: Date): string | null {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    return Number.isNaN(at) ? null : new Date(at).toISOString();
  }
  return nextScheduleRun(schedule.cron, schedule.timezone, from);
}

/** "Once" / "Cron 0 9 * * 1-5 (Europe/Berlin)". */
export function describeScheduledTaskSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.kind === "once") return "Once";
  return `Cron ${schedule.cron.trim().split(/\s+/).join(" ")} (${schedule.timezone})`;
}
