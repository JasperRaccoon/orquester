// Automated workflows — schedules (spec §4, §6.1).
//
// The cron is the authority; the preset only lets the editor reopen as the user built it. `croner`
// (MIT, zero-dependency, no eval) computes fire times in an IANA time zone; nothing here arms a
// timer — `new Cron(pattern, options)` without a callback schedules nothing.

import { Cron } from "croner";

import type { SchedulePreset } from "./types.ts";

const pad2 = (value: number): string => String(value).padStart(2, "0");

function splitTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map((part) => Number(part));
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/** The 5-field cron a preset stands for; null for the `cron` preset (the cron field is typed by hand). */
export function presetToCron(preset: SchedulePreset): string | null {
  switch (preset.kind) {
    case "minutes":
      return preset.every === 1 ? "* * * * *" : `*/${preset.every} * * * *`;
    case "hours":
      return `${preset.atMinute ?? 0} ${preset.every === 1 ? "*" : `*/${preset.every}`} * * *`;
    case "daily": {
      const { hour, minute } = splitTime(preset.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekly": {
      const { hour, minute } = splitTime(preset.time);
      const days = Array.from(new Set(preset.days)).sort((a, b) => a - b);
      return `${minute} ${hour} * * ${days.join(",")}`;
    }
    case "monthly": {
      const { hour, minute } = splitTime(preset.time);
      return `${minute} ${hour} ${preset.day} * *`;
    }
    case "cron":
      return null;
    default: {
      const unhandled: never = preset;
      void unhandled;
      return null;
    }
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function normaliseCron(cron: string): string {
  return cron.trim().split(/\s+/).join(" ");
}

/**
 * Short text for a schedule: "Every 15 min", "Every 2 h at :30", "Daily at 16:00", "Mon, Fri at
 * 16:00", "Monthly on day 1 at 09:00" — or "Cron 0 16 * * 1,5" when the preset is `cron` or no longer
 * matches the cron (the cron is the authority).
 */
export function describeSchedule(preset: SchedulePreset, cron: string): string {
  const derived = presetToCron(preset);
  if (derived === null || normaliseCron(derived) !== normaliseCron(cron)) return `Cron ${normaliseCron(cron)}`;
  switch (preset.kind) {
    case "minutes":
      return preset.every === 1 ? "Every minute" : `Every ${preset.every} min`;
    case "hours": {
      const at = (preset.atMinute ?? 0) === 0 ? "" : ` at :${pad2(preset.atMinute ?? 0)}`;
      return preset.every === 1 ? `Every hour${at}` : `Every ${preset.every} h${at}`;
    }
    case "daily":
      return `Daily at ${preset.time}`;
    case "weekly": {
      const days = Array.from(new Set(preset.days)).sort((a, b) => a - b);
      if (days.length === 7) return `Daily at ${preset.time}`;
      if (days.join(",") === "1,2,3,4,5") return `Weekdays at ${preset.time}`;
      if (days.join(",") === "0,6") return `Weekends at ${preset.time}`;
      // Monday first, Sunday last.
      const ordered = [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)];
      return `${ordered.map((day) => DAY_NAMES[day]).join(", ")} at ${preset.time}`;
    }
    case "monthly":
      return `Monthly on day ${preset.day} at ${preset.time}`;
    default:
      return `Cron ${normaliseCron(cron)}`;
  }
}

/** True when `timeZone` is an IANA zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function makeCron(cron: string, timezone: string): Cron {
  return new Cron(normaliseCron(cron), { timezone, mode: "5-or-6-parts", paused: true });
}

/**
 * Why a cron (in a time zone) cannot schedule a workflow, or null when it can: 5 fields, or 6 with a
 * single fixed second (the minimum interval is one minute), a known time zone, and at least one
 * future fire time.
 */
export function validateCron(cron: string, timezone: string): string | null {
  if (typeof cron !== "string" || cron.trim().length === 0) return "The schedule has no cron expression";
  if (!isValidTimeZone(timezone)) return `Unknown time zone "${String(timezone)}"`;
  const fields = normaliseCron(cron).split(" ");
  if (!cron.trim().startsWith("@")) {
    if (fields.length !== 5 && fields.length !== 6) {
      return `A cron has 5 fields (minute hour day month weekday), or 6 with seconds first — this one has ${fields.length}`;
    }
    if (fields.length === 6 && !/^([0-9]|[1-5][0-9])$/.test(fields[0]!)) {
      return "With 6 fields the seconds must be one fixed value (0–59): a workflow runs at most once a minute";
    }
  }
  let job: Cron;
  try {
    job = makeCron(cron, timezone);
  } catch (error) {
    return `Invalid cron: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    if (job.nextRun() === null) return "This cron never fires";
  } catch (error) {
    return `Invalid cron: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    job.stop();
  }
  return null;
}

/** The next `count` fire times after `from` (default now), as ISO strings in UTC. [] for an invalid cron. */
export function nextRuns(cron: string, timezone: string, count: number, from?: Date | string): string[] {
  if (validateCron(cron, timezone) !== null || count <= 0) return [];
  const job = makeCron(cron, timezone);
  try {
    const start = from === undefined ? undefined : typeof from === "string" ? new Date(from) : from;
    return job.nextRuns(Math.min(count, 100), start).map((date) => date.toISOString());
  } catch {
    return [];
  } finally {
    job.stop();
  }
}

/** The next fire time after `from`, or null. */
export function nextScheduleRun(cron: string, timezone: string, from?: Date | string): string | null {
  return nextRuns(cron, timezone, 1, from)[0] ?? null;
}
