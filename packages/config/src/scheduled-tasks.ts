// Scheduled tasks — `<appdir>/daemon/scheduled-tasks.json` (design
// docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §5 "Scheduling").
//
// A scheduled task delivers a prompt to one agent-chat thread later: once, or on a cron. The daemon
// owns the list (`apps/daemon/src/scheduled-tasks/`); the wire shape is `ScheduledTask` in
// @orquester/api. This module imports only zod: the path helper lives in index.ts, which re-exports
// this file.
//
// Tolerant like saved-prompts.json: every record keeps the keys it does not know (`passthrough`), a
// record that fails the schema (a newer schedule kind, a hand edit) is kept VERBATIM in `rejected`
// and written back by every rewrite, and unknown top-level keys survive in `extra`. Shape only —
// limits (prompt length, caps, a valid cron) are enforced on write by the daemon, never on read.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`**: a record an
// older build can parse under the old meaning would be served and rewritten wrongly.

import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

/** When a task fires: once at an instant, or on a 5-field cron in an IANA time zone. */
export const scheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: isoDateTime }).passthrough(),
  z.object({ kind: z.literal("cron"), cron: z.string().min(1), timezone: z.string().min(1) }).passthrough()
]);
export type ScheduledTaskScheduleRecord = z.infer<typeof scheduledTaskScheduleSchema>;

/**
 * A delivery that came due (or was asked for with "Run now") and has not reached the thread yet: the
 * thread was busy, or the agent host was down. Persisted BEFORE the delivery is attempted, so a
 * restart retries it with the same `fireKey` — the agent-chat command id is derived from it, and the
 * host's receipt for that id makes the retry a no-op when the first attempt had landed.
 */
export const scheduledTaskPendingSchema = z
  .object({
    fireKey: z.string().min(1),
    scheduledFor: isoDateTime,
    queuedAt: isoDateTime,
    manual: z.boolean().default(false)
  })
  .passthrough();
export type ScheduledTaskPendingRecord = z.infer<typeof scheduledTaskPendingSchema>;

export const scheduledTaskRecordSchema = z
  .object({
    id: z.string().min(1),
    /** The agent-chat thread (= session id) the prompt is delivered to. */
    threadId: z.string().min(1),
    /** That thread's project when the task was created ("" for a thread bound to none). */
    projectPath: z.string().default(""),
    prompt: z.string(),
    schedule: scheduledTaskScheduleSchema,
    enabled: z.boolean().default(true),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    /** The thread whose agent scheduled it, when an agent did. */
    createdByThreadId: z.string().min(1).nullable().default(null),
    /** The next due time; null when disabled, finished, or the cron never fires again. */
    nextRunAt: isoDateTime.nullable().default(null),
    lastRunAt: isoDateTime.nullable().default(null),
    /** `delivered` | `missed` | `failed` today; a string so a newer build's status still loads. */
    lastRunStatus: z.string().nullable().default(null),
    lastRunError: z.string().nullable().default(null),
    runCount: z.number().int().nonnegative().default(0),
    pending: scheduledTaskPendingSchema.nullable().default(null)
  })
  .passthrough();
export type ScheduledTaskRecord = z.infer<typeof scheduledTaskRecordSchema>;

/**
 * A read `scheduled-tasks.json`: the tasks this build can use, plus everything else in the file kept
 * verbatim so a rewrite puts it back unchanged.
 */
export interface ScheduledTasksFile {
  version: 1;
  tasks: ScheduledTaskRecord[];
  /** `tasks` entries not in `tasks`, exactly as found: schema failures and repeated ids. */
  rejected: unknown[];
  /** Every top-level key but `version` and `tasks`, exactly as found. */
  extra: Record<string, unknown>;
}

export function createDefaultScheduledTasksFile(): ScheduledTasksFile {
  return { version: 1, tasks: [], rejected: [], extra: {} };
}

/**
 * Entry-wise tolerant. The OUTER shape still throws (a `version` other than 1 included): the daemon
 * reads a throw as "this file is not mine to rewrite" and moves it aside instead of writing an empty
 * list over it.
 */
export function parseScheduledTasksFile(raw: unknown): ScheduledTasksFile {
  const outer = z
    .object({ version: z.literal(1).default(1), tasks: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 scheduled tasks file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const tasks: ScheduledTaskRecord[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of outer.data.tasks) {
    const parsed = scheduledTaskRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      tasks.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  // `fromEntries`, not assignment: a key such as `__proto__` stays an own key.
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "version" && key !== "tasks")
  );
  return { version: 1, tasks, rejected, extra };
}

/** The file as written: unknown top-level keys first, then the version and every task, the rejected ones last. */
export function serializeScheduledTasksFile(file: Omit<ScheduledTasksFile, "version">): string {
  return `${JSON.stringify({ ...file.extra, version: 1, tasks: [...file.tasks, ...file.rejected] }, null, 2)}\n`;
}
