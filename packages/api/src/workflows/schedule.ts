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

/**
 * The intervals the "every N minutes / hours" presets offer: the divisors of 60 and 24. A cron step
 * restarts at every hour (day), so `*\/45` fires at :00 and :45 — not every 45 minutes; only a
 * divisor keeps the promise the preset's words make.
 */
export const SCHEDULE_MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const;
export const SCHEDULE_HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

/**
 * Why a preset's interval cannot be kept evenly, or null. Stored definitions with such a value
 * still load (the schema accepts 1–59 / 1–23); validation reports it.
 */
export function scheduleIntervalProblem(preset: SchedulePreset): string | null {
  if (preset.kind === "minutes" && !(SCHEDULE_MINUTE_STEPS as readonly number[]).includes(preset.every)) {
    return `"Every ${preset.every} minutes" cannot run evenly (the cron restarts every hour); pick one of ${SCHEDULE_MINUTE_STEPS.join(", ")}, or write a cron`;
  }
  if (preset.kind === "hours" && !(SCHEDULE_HOUR_STEPS as readonly number[]).includes(preset.every)) {
    return `"Every ${preset.every} hours" cannot run evenly (the cron restarts every day); pick one of ${SCHEDULE_HOUR_STEPS.join(", ")}, or write a cron`;
  }
  return null;
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

/** How far back twins of the repeated fall-back hour are looked for (DST shifts are ≤ 2 h). */
const DST_LOOKBACK_MS = 2 * 60 * 60_000 + 60_000;
/** Bound on croner steps per call (a sparse cron needs `count`, an every-minute one `count + 121`). */
const MAX_CRON_STEPS = 1_000;

/**
 * True for a cron that fires more than once a day by its hour field (`*`, a step like `*\/2`, or
 * `@hourly`): such a schedule means "every so often" in REAL time, so the hour a DST fall-back
 * repeats must fire again. A daily-style cron (`30 1 * * *`) keeps firing once — croner's choice.
 */
function isSubDailyCron(cron: string): boolean {
  const normalised = normaliseCron(cron);
  if (normalised.startsWith("@")) return /^@hourly$/i.test(normalised);
  const fields = normalised.split(" ");
  const hour = fields.length === 6 ? fields[2] : fields[1];
  return hour !== undefined && (hour === "*" || hour.includes("/"));
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/** `timeZone`'s wall-clock minute at `ms`, as a UTC epoch (so two instants compare by local time). */
function localWallMs(ms: number, timeZone: string): number {
  let format = localFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric"
    });
    localFormatters.set(timeZone, format);
  }
  const part = (parts: Intl.DateTimeFormatPart[], type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const parts = format.formatToParts(new Date(ms));
  return Date.UTC(part(parts, "year"), part(parts, "month") - 1, part(parts, "day"), part(parts, "hour"), part(parts, "minute"));
}

/**
 * The second occurrence of `ms`'s wall-clock time when a DST fall-back repeats it, or null: the
 * zone's offset shrinks by `shift` within the next few hours and `ms + shift` reads the same local
 * minute.
 */
function fallBackTwin(ms: number, timeZone: string): number | null {
  const offsetAt = (at: number) => localWallMs(at, timeZone) - Math.floor(at / 60_000) * 60_000;
  const shift = offsetAt(ms) - offsetAt(ms + DST_LOOKBACK_MS);
  if (shift <= 0) return null;
  const twin = ms + shift;
  return localWallMs(twin, timeZone) === localWallMs(ms, timeZone) ? twin : null;
}

/**
 * The next `count` fire times after `from` (default now), as ISO strings in UTC, strictly
 * increasing. [] for an invalid cron. Steps croner one run at a time (its `nextRuns` chains in local
 * time and repeats instants across a spring-forward gap), and for a sub-daily cron adds the second
 * occurrence of every run in an hour a fall-back repeats (croner skips it).
 */
export function nextRuns(cron: string, timezone: string, count: number, from?: Date | string): string[] {
  if (validateCron(cron, timezone) !== null || count <= 0) return [];
  const wanted = Math.min(count, 100);
  const job = makeCron(cron, timezone);
  try {
    const start = from === undefined ? new Date() : typeof from === "string" ? new Date(from) : from;
    const fromMs = start.getTime();
    if (Number.isNaN(fromMs)) return [];
    const subDaily = isSubDailyCron(cron);
    // A twin can fall after `from` while its first occurrence lies before it: look back for those.
    let cursor = new Date(subDaily ? fromMs - DST_LOOKBACK_MS : fromMs);
    const candidates = new Set<number>();
    let after = 0;
    for (let step = 0; step < MAX_CRON_STEPS && after < wanted; step += 1) {
      const next = job.nextRun(cursor);
      if (next === null) break;
      let ms = next.getTime();
      if (ms <= cursor.getTime()) ms = cursor.getTime() + 60_000; // never step backwards
      cursor = new Date(ms);
      if (next.getTime() !== ms) continue;
      candidates.add(ms);
      if (ms > fromMs) after += 1;
      if (subDaily) {
        const twin = fallBackTwin(ms, timezone);
        if (twin !== null) candidates.add(twin);
      }
    }
    // Every twin is later than its own run, so the `wanted` earliest are all among these.
    return [...candidates]
      .filter((ms) => ms > fromMs)
      .sort((a, b) => a - b)
      .slice(0, wanted)
      .map((ms) => new Date(ms).toISOString());
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
