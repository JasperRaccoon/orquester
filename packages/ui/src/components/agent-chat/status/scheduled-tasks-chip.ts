/**
 * The scheduled-tasks chip and its popover — the pure half (design 2026-10-14 §5 "Scheduling").
 *
 * The chip sits in the status line only while the thread has a task: `2 scheduled`, in the
 * in-motion tone while a run waits for the thread, the warn tone when a task's last run failed or
 * was missed. The popover lists each task with its schedule, what happens next, and Run now /
 * Cancel. No React import.
 */

import { scheduledTaskTimeOrder as instant, type ScheduledTask } from "@orquester/api";

export type ScheduledChipTone = "neutral" | "info" | "warn";

export interface ScheduledChipModel {
  label: string;
  title: string;
  tone: ScheduledChipTone;
}

export interface ScheduledTaskRowModel {
  id: string;
  prompt: string;
  schedule: string;
  status: string;
  tone: ScheduledChipTone;
}

export interface TimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

/** Soonest first; paused and finished ones (no next run) last, oldest first among them. */
export function sortScheduledTasks(tasks: readonly ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort(
    (a, b) =>
      instant(a.nextRunAt) - instant(b.nextRunAt) || instant(a.createdAt) - instant(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** "14:30" today, else "15 Oct, 14:30" (with the year when it is not this one). */
export function formatTaskTime(iso: string, now: Date, opts: TimeFormatOptions = {}): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const zone = opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {};
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const time = new Intl.DateTimeFormat(opts.locale, { ...zone, hour: "2-digit", minute: "2-digit" }).format(at);
  if (day(at) === day(now)) return time;
  const sameYear = day(at).slice(0, 4) === day(now).slice(0, 4);
  const date = new Intl.DateTimeFormat(opts.locale, { ...zone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
  return `${date}, ${time}`;
}

function hasTrouble(task: ScheduledTask): boolean {
  return task.lastRunStatus === "failed" || task.lastRunStatus === "missed";
}

/** The chip, or null for a thread without tasks. */
export function deriveScheduledChip(tasks: readonly ScheduledTask[], now: Date, opts: TimeFormatOptions = {}): ScheduledChipModel | null {
  if (tasks.length === 0) return null;
  const sorted = sortScheduledTasks(tasks);
  const waiting = tasks.filter((task) => task.queuedAt !== null).length;
  const next = sorted.find((task) => task.enabled && task.nextRunAt !== null)?.nextRunAt ?? null;
  const parts = [`${tasks.length} scheduled ${tasks.length === 1 ? "task" : "tasks"}`];
  if (waiting > 0) parts.push(`${waiting} waiting for the turn to end`);
  if (next !== null) parts.push(`next at ${formatTaskTime(next, now, opts)}`);
  return {
    label: `${tasks.length} scheduled`,
    title: parts.join(" · "),
    tone: waiting > 0 ? "info" : tasks.some(hasTrouble) ? "warn" : "neutral"
  };
}

/** One popover row. */
export function deriveScheduledTaskRow(task: ScheduledTask, now: Date, opts: TimeFormatOptions = {}): ScheduledTaskRowModel {
  const schedule =
    task.schedule.kind === "once"
      ? `Once at ${formatTaskTime(task.schedule.at, now, opts)}`
      : `Cron ${task.schedule.cron} (${task.schedule.timezone})`;
  let status: string;
  let tone: ScheduledChipTone = "neutral";
  if (task.queuedAt !== null) {
    status = "Due — waiting for the running turn to end";
    tone = "info";
  } else if (!task.enabled) {
    status = task.lastRunStatus === "missed" ? "Paused — missed while Orquester was not running" : task.lastRunStatus === "failed" ? "Paused — the last run failed" : "Paused";
    tone = hasTrouble(task) ? "warn" : "neutral";
  } else if (task.lastRunStatus === "failed") {
    status = `Last run failed${task.lastRunError ? `: ${task.lastRunError}` : ""}`;
    tone = "warn";
  } else if (task.lastRunStatus === "missed") {
    status = task.nextRunAt !== null ? `Missed a run · next ${formatTaskTime(task.nextRunAt, now, opts)}` : "Missed a run";
    tone = "warn";
  } else if (task.nextRunAt !== null) {
    status = `Next ${formatTaskTime(task.nextRunAt, now, opts)}${task.runCount > 0 ? ` · ran ${task.runCount}×` : ""}`;
  } else {
    status = "No upcoming run";
  }
  return { id: task.id, prompt: task.prompt, schedule, status, tone };
}
