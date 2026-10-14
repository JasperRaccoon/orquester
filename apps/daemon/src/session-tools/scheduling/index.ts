/**
 * Session tools — scheduling (design 2026-10-14 §5 "Scheduling"): an agent schedules prompts for a
 * chat thread of its own project, once or on a cron. The daemon's scheduler
 * (`apps/daemon/src/scheduled-tasks/`) persists and delivers them; these handlers only call its
 * routes (`/api/scheduled-tasks`) through `ctx.api` and keep every call inside the caller's project.
 *
 * Imported by the agent host too (it advertises the definitions): nothing here may import a daemon
 * service — only the pure contracts.
 */

import { z } from "zod";
import type { SessionSummary } from "@orquester/api";
// The module, not the package root: the agent host loads this file, and the root pulls in every
// workflow module (the graph layout included).
import {
  SCHEDULED_TASK_MISSED_GRACE_MINUTES,
  SCHEDULED_TASK_PROMPT_MAX,
  scheduledTaskRoutes,
  type RunScheduledTaskResponse,
  type ScheduledTask,
  type ScheduledTaskListResponse,
  type ScheduledTaskSchedule
} from "@orquester/api/scheduled-tasks";

import { expectOk } from "../../mcp/errors.ts";
import {
  defineSessionTool,
  defineSessionToolkit,
  SESSION_TOOL_DESTRUCTIVE,
  SESSION_TOOL_MUTATING,
  SESSION_TOOL_READ_ONLY,
  type SessionToolContext
} from "../contract.ts";
import { jsonResult, ToolError } from "../results.ts";

/** A listed prompt is cut to this many characters; `update_scheduled_task` replaces it whole. */
const LISTED_PROMPT_CHARS = 500;
/** The most tasks one list answers with, soonest first. */
const LIST_LIMIT = 100;
const MAX_IN_MINUTES = 366 * 24 * 60;

const DELIVERY_RULES =
  "The prompt arrives in the thread as a user message, through the normal send path: if the thread is busy (a turn running, an approval or question open) it waits until that turn has ended — it never interrupts or steers a running turn. " +
  `Missed runs (Orquester was not running at the time): a run more than ${SCHEDULED_TASK_MISSED_GRACE_MINUTES} minutes late is not delivered; it is recorded as missed, a cron task moves on to its next time, a one-shot task is paused. ` +
  "A one-shot task is removed once delivered. A thread's tasks are removed when the thread is closed. " +
  "The scheduled turn always runs in default mode, never plan mode — even in a thread that was planning.";

const taskIdField = z.string().min(1).max(200).describe("The task id from schedule_task or list_scheduled_tasks.");
const whenFields = {
  at: z.string().max(64).optional().describe("Run once at this instant: ISO 8601 with an offset, e.g. 2026-10-15T09:00:00+02:00."),
  inMinutes: z.number().int().min(1).max(MAX_IN_MINUTES).optional().describe("Run once this many minutes from now."),
  cron: z.string().max(120).optional().describe("Run repeatedly on this 5-field cron (minute hour day month weekday), at most once a minute, e.g. \"0 9 * * 1-5\"."),
  timezone: z.string().max(64).optional().describe("IANA time zone for `cron` (e.g. Europe/Berlin). Default: the task's current zone when updating a cron task, else the Orquester host's zone (returned in the result).")
};

/** What an agent sees of a task. */
function view(task: ScheduledTask, opts: { clip?: boolean } = {}) {
  const clipped = opts.clip === true && task.prompt.length > LISTED_PROMPT_CHARS;
  return {
    taskId: task.id,
    threadId: task.threadId,
    prompt: clipped ? `${task.prompt.slice(0, LISTED_PROMPT_CHARS - 1)}…` : task.prompt,
    ...(clipped ? { promptTruncated: true } : {}),
    schedule: task.schedule,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    ...(task.queuedAt !== null ? { waitingForThreadSince: task.queuedAt } : {}),
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.lastRunError !== null ? { lastRunError: task.lastRunError } : {}),
    runCount: task.runCount
  };
}

/** An ISO time as a number for sorting; none (or unreadable) sorts last. */
function instant(iso: string | null): number {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The schedule the arguments name, or null when they name none. At most one of `at`, `inMinutes`
 * and `cron`; `timezone` belongs to a cron. `current`: the task being updated — an omitted cron or
 * time zone keeps its own (a time-zone-only update re-zones its cron; a cron-only one keeps its zone).
 */
function scheduleOf(
  args: { at?: string; inMinutes?: number; cron?: string; timezone?: string },
  ctx: SessionToolContext,
  current?: ScheduledTaskSchedule
): ScheduledTaskSchedule | null {
  const currentCron = current?.kind === "cron" ? current : undefined;
  const given = [args.at, args.inMinutes, args.cron].filter((value) => value !== undefined).length;
  if (given > 1) throw new ToolError("INVALID_ARGUMENT", "Give only one of at, inMinutes or cron.");
  if (args.at !== undefined) {
    if (args.timezone !== undefined) throw new ToolError("INVALID_ARGUMENT", "timezone applies to cron only; put the offset in `at`.");
    return { kind: "once", at: args.at };
  }
  if (args.inMinutes !== undefined) {
    if (args.timezone !== undefined) throw new ToolError("INVALID_ARGUMENT", "timezone applies to cron only.");
    return { kind: "once", at: new Date(ctx.now() + args.inMinutes * 60_000).toISOString() };
  }
  const cron = args.cron ?? (args.timezone !== undefined ? currentCron?.cron : undefined);
  if (cron === undefined) {
    if (args.timezone !== undefined) throw new ToolError("INVALID_ARGUMENT", "timezone applies to a cron task only.");
    return null;
  }
  return { kind: "cron", cron, timezone: args.timezone ?? currentCron?.timezone ?? hostTimeZone() };
}

/** Whether a task (or thread) of `projectPath` / `threadId` is the caller's to see. */
function inScope(ctx: SessionToolContext, target: { projectPath: string; threadId: string }): boolean {
  // A thread bound to no project sees only its own tasks: "" is not a project.
  if (ctx.projectPath === "") return target.threadId === ctx.threadId;
  return target.projectPath === ctx.projectPath;
}

/** The target thread: the caller, or another chat thread of its project. */
async function targetThread(ctx: SessionToolContext, threadId: string | undefined): Promise<string> {
  if (threadId === undefined || threadId === ctx.threadId) return ctx.threadId;
  const sessions = expectOk<SessionSummary[]>(await ctx.api.request("GET", "/api/sessions"));
  const session = sessions.find((candidate) => candidate.id === threadId);
  if (!session || session.kind !== "agent-chat" || !inScope(ctx, { projectPath: session.projectPath, threadId: session.id })) {
    throw new ToolError("THREAD_NOT_FOUND", `No chat thread "${threadId}" in this project.`);
  }
  return session.id;
}

/** A task of the caller's project, or SCHEDULED_TASK_NOT_FOUND — another project's task is never confirmed to exist. */
async function scopedTask(ctx: SessionToolContext, taskId: string): Promise<ScheduledTask> {
  const res = await ctx.api.request("GET", scheduledTaskRoutes.item(taskId));
  const notFound = new ToolError("SCHEDULED_TASK_NOT_FOUND", `No scheduled task "${taskId}" in this project.`);
  if (res.status === 404) throw notFound;
  const task = expectOk<ScheduledTask>(res);
  if (!inScope(ctx, task)) throw notFound;
  return task;
}

export const schedulingToolkit = defineSessionToolkit({
  id: "scheduling",
  instructions:
    "Scheduling: `schedule_task` sends a prompt to a chat thread of this project later — once (`at`/`inMinutes`) or on a `cron` — as a user message after any running turn. Manage with `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`.",
  tools: [
    defineSessionTool({
      name: "schedule_task",
      title: "Schedule a task",
      description:
        "Schedule a prompt to be sent to a chat thread later: once (`at` or `inMinutes`) or repeatedly (`cron`, with `timezone`). Give exactly one of at, inMinutes or cron. " +
        "The thread is this one unless `threadId` names another chat thread of this project. Use it for follow-ups, reminders and periodic checks the user asked for; write the prompt as the instruction the agent should act on then. " +
        `${DELIVERY_RULES} The result has the task (taskId, nextRunAt) and the host's current time.`,
      input: {
        prompt: z.string().min(1).max(SCHEDULED_TASK_PROMPT_MAX).describe("What to send when the task runs."),
        ...whenFields,
        threadId: z.string().min(1).max(200).optional().describe("Another chat thread of this project to send it to. Default: this thread.")
      },
      annotations: SESSION_TOOL_MUTATING,
      resultKind: "json",
      run: async (args, ctx) => {
        const schedule = scheduleOf(args, ctx);
        if (schedule === null) throw new ToolError("INVALID_ARGUMENT", "Give one of at, inMinutes or cron.");
        const threadId = await targetThread(ctx, args.threadId);
        const task = expectOk<ScheduledTask>(
          await ctx.api.request("POST", scheduledTaskRoutes.list, {
            body: { threadId, prompt: args.prompt, schedule, createdByThreadId: ctx.threadId }
          })
        );
        return jsonResult({ task: view(task), now: new Date(ctx.now()).toISOString() });
      }
    }),
    defineSessionTool({
      name: "list_scheduled_tasks",
      title: "List scheduled tasks",
      description:
        "List the scheduled tasks of this project's chat threads (or of one thread with `threadId`), soonest first: id, thread, prompt (long ones cut — the full text is kept), schedule, whether it is paused, the next run, and how the last run went (delivered, missed or failed, with the reason). " +
        "`waitingForThreadSince` marks a run that came due and waits for its thread to be idle.",
      input: {
        threadId: z.string().min(1).max(200).optional().describe("Only this thread's tasks.")
      },
      annotations: SESSION_TOOL_READ_ONLY,
      resultKind: "json",
      run: async (args, ctx) => {
        const query: Record<string, string> = ctx.projectPath === "" ? { threadId: ctx.threadId } : { projectPath: ctx.projectPath };
        const { tasks } = expectOk<ScheduledTaskListResponse>(await ctx.api.request("GET", scheduledTaskRoutes.list, { query }));
        const listed = tasks
          .filter((task) => inScope(ctx, task) && (args.threadId === undefined || task.threadId === args.threadId))
          .sort((a, b) => instant(a.nextRunAt) - instant(b.nextRunAt) || instant(a.createdAt) - instant(b.createdAt));
        return jsonResult({
          tasks: listed.slice(0, LIST_LIMIT).map((task) => view(task, { clip: true })),
          ...(listed.length > LIST_LIMIT ? { more: listed.length - LIST_LIMIT } : {}),
          now: new Date(ctx.now()).toISOString()
        });
      }
    }),
    defineSessionTool({
      name: "update_scheduled_task",
      title: "Update a scheduled task",
      description:
        "Change a scheduled task of this project: its prompt, its schedule (one of at, inMinutes or cron; `timezone` alone re-zones a cron task, `cron` alone keeps its zone; a new schedule drops a run still waiting for the thread — a Run now stays), or `enabled` (false pauses it without deleting it; true resumes it from now — a one-shot task whose time has passed needs a new time). Omitted fields stay as they are. Pausing also drops a run that waits for its thread.",
      input: {
        taskId: taskIdField,
        prompt: z.string().min(1).max(SCHEDULED_TASK_PROMPT_MAX).optional().describe("The new prompt, replacing the old one whole."),
        ...whenFields,
        enabled: z.boolean().optional().describe("False pauses the task; true resumes it.")
      },
      annotations: SESSION_TOOL_MUTATING,
      resultKind: "json",
      run: async (args, ctx) => {
        const current = await scopedTask(ctx, args.taskId);
        const schedule = scheduleOf(args, ctx, current.schedule);
        const body = {
          ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
          ...(schedule !== null ? { schedule } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled } : {})
        };
        if (Object.keys(body).length === 0) throw new ToolError("INVALID_ARGUMENT", "Nothing to change: give prompt, a schedule, or enabled.");
        const task = expectOk<ScheduledTask>(await ctx.api.request("PUT", scheduledTaskRoutes.item(current.id), { body }));
        return jsonResult({ task: view(task), now: new Date(ctx.now()).toISOString() });
      }
    }),
    defineSessionTool({
      name: "delete_scheduled_task",
      title: "Delete a scheduled task",
      description:
        "Delete a scheduled task of this project for good; a run waiting for its thread is dropped too. To stop it for a while instead, update_scheduled_task with enabled=false.",
      input: { taskId: taskIdField },
      annotations: SESSION_TOOL_DESTRUCTIVE,
      resultKind: "json",
      run: async (args, ctx) => {
        const current = await scopedTask(ctx, args.taskId);
        expectOk(await ctx.api.request("DELETE", scheduledTaskRoutes.item(current.id)));
        return jsonResult({ deleted: true, taskId: current.id });
      }
    }),
    defineSessionTool({
      name: "run_scheduled_task_now",
      title: "Run a scheduled task now",
      description:
        "Send a scheduled task's prompt to its thread now, whatever its schedule (a paused task too); its schedule is unchanged. If the thread is busy it waits for the running turn to end, like a scheduled run (`delivered: false`). Sending into THIS thread queues it behind your own turn. Refused (ALREADY_QUEUED) while a run of it already waits.",
      input: { taskId: taskIdField },
      annotations: SESSION_TOOL_MUTATING,
      resultKind: "json",
      run: async (args, ctx) => {
        const current = await scopedTask(ctx, args.taskId);
        const result = expectOk<RunScheduledTaskResponse>(await ctx.api.request("POST", scheduledTaskRoutes.run(current.id)));
        return jsonResult({
          delivered: result.delivered,
          task: result.task === null ? null : view(result.task),
          ...(result.task === null ? { note: "A one-shot task is removed once delivered." } : {})
        });
      }
    })
  ]
});
