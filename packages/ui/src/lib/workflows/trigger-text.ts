/**
 * The trigger inspector's words (TriggerSettings): a schedule as a headline
 * and a one-line summary, the time zone's offset, what a monthly day 29–31
 * skips, a git trigger's repository / event / polling in plain language, the
 * pull-request actions' labels, and the manual trigger's JSON example checks.
 *
 * `describeSchedule` / `triggerSummaryText` in @orquester/api stay as they are
 * (the rail card and the canvas read them); these build on them for the form.
 *
 * Also the form's edits that switch a kind (schedule preset, repository,
 * event): picking the kind already chosen changes nothing, and an edit within
 * one kind keeps every other field of the stored object — including fields
 * this build does not know (configs pass unknown keys through, AGENTS.md).
 */

import cronstrue from "cronstrue";

import {
  describeSchedule,
  repoDisplayName,
  type GitPullRequestAction,
  type GitRepoRef,
  type GitTriggerEvent,
  type SchedulePreset
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** "0 9 * * 1-5" in words ("At 09:00, Monday through Friday"), or null when cronstrue cannot read it. */
export function cronInWords(cron: string): string | null {
  try {
    const text = cronstrue.toString(cron, { use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
    return text || null;
  } catch {
    return null;
  }
}

/**
 * The schedule as a headline: the preset's words ("Weekdays at 09:00") while
 * the cron still matches the preset, else the cron in words (the cron is what
 * runs) — "Custom schedule" when even that cannot be read.
 */
export function scheduleHeadline(preset: SchedulePreset, cron: string): string {
  const described = describeSchedule(preset, cron);
  if (!described.startsWith("Cron ")) return described;
  return cronInWords(cron) ?? "Custom schedule";
}

/**
 * The collapsed section's one-liner: the headline and, when the schedule runs
 * at clock times (anything but "every N minutes"), the zone they are read in —
 * "Weekdays at 09:00 (Europe/Madrid)".
 */
export function scheduleSummary(preset: SchedulePreset, cron: string, timeZone: string): string {
  const headline = scheduleHeadline(preset, cron);
  const matchesPreset = !describeSchedule(preset, cron).startsWith("Cron ");
  return matchesPreset && preset.kind === "minutes" ? headline : `${headline} (${timeZone})`;
}

/** `timeZone`'s current UTC offset ("GMT+2", "GMT+5:30"), or null for UTC itself or an unknown zone. */
export function zoneOffsetLabel(timeZone: string, at: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at);
    const offset = parts.find((part) => part.type === "timeZoneName")?.value ?? null;
    return offset === null || offset === "GMT" || offset === "GMT+0" || offset === "UTC" ? null : offset;
  } catch {
    return null;
  }
}

/**
 * What a monthly schedule on `day` skips — a cron day of the month fires only in
 * months that have that day (croner, like cron: `0 9 31 * *` runs in Jan, Mar,
 * May, Jul, Aug, Oct, Dec) — or null for days every month has.
 */
export function monthlySkipNote(day: number): string | null {
  if (day === 29) return "February is skipped, except in leap years.";
  if (day === 30) return "February is skipped.";
  if (day === 31) return "February, April, June, September and November are skipped (they have no 31st).";
  return null;
}

/** The cron for "the last day of every month at `time`" (croner's `L`). */
export function lastDayOfMonthCron(time: string): string {
  const [hour = 0, minute = 0] = time.split(":").map((part) => Number(part));
  return `${minute} ${hour} L * *`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The first fire times of an "every N hours at minute M" schedule, counted from midnight: "00:30, 03:30, 06:30, …". */
export function hourlyStartsText(every: number, atMinute: number): string {
  const hours: number[] = [];
  for (let hour = 0; hour < 24 && hours.length < 3; hour += Math.max(1, every)) hours.push(hour);
  const more = hours.length === 3 && hours[2]! + every < 24;
  return `${hours.map((hour) => `${pad2(hour)}:${pad2(atMinute)}`).join(", ")}${more ? ", …" : ""}`;
}

/** The weekday chips, Monday first; values are cron's day numbers (0 = Sunday) as strings. */
export const WEEKDAY_OPTIONS: readonly { value: string; label: string; title: string }[] = [
  { value: "1", label: "Mon", title: "Monday" },
  { value: "2", label: "Tue", title: "Tuesday" },
  { value: "3", label: "Wed", title: "Wednesday" },
  { value: "4", label: "Thu", title: "Thursday" },
  { value: "5", label: "Fri", title: "Friday" },
  { value: "6", label: "Sat", title: "Saturday" },
  { value: "0", label: "Sun", title: "Sunday" }
];

/** One-click day sets for the weekly schedule. */
export const WEEKDAY_QUICK_PICKS: readonly { label: string; days: readonly number[] }[] = [
  { label: "Weekdays", days: [1, 2, 3, 4, 5] },
  { label: "Weekends", days: [6, 0] },
  { label: "Every day", days: [1, 2, 3, 4, 5, 6, 0] }
];

/** Whether `days` is exactly the set `pick` (any order, duplicates ignored). */
export function sameDays(days: readonly number[], pick: readonly number[]): boolean {
  const a = new Set(days);
  const b = new Set(pick);
  return a.size === b.size && [...a].every((day) => b.has(day));
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * The pull-request actions as the poller detects them (apps/daemon
 * triggers/git-events.ts `detectPullRequests`): `opened` = a PR not seen
 * before; `updated` = an open PR's head commit changed; `merged` / `closed` =
 * an open PR was merged / closed without merging. Reopening fires nothing.
 */
export const PR_ACTION_TEXT: Readonly<Record<GitPullRequestAction, { label: string; description: string }>> = {
  opened: { label: "Opened", description: "A new pull request is opened." },
  updated: { label: "New commits", description: "Commits are pushed to an open pull request (a force-push too)." },
  merged: { label: "Merged", description: "An open pull request is merged." },
  closed: { label: "Closed without merging", description: "An open pull request is closed without merging." }
};

/** "a, b and c". */
function listWords(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** A git event in words: "Push to main or release/*", "New tag matching v*", "PR opened or new commits → main". */
export function gitEventText(event: GitTriggerEvent): string {
  switch (event.kind) {
    case "push": {
      const branches = event.branches.map((branch) => branch.trim()).filter((branch) => branch.length > 0);
      return branches.length === 0 ? "Push to the default branch" : `Push to ${listWords(branches, "or")}`;
    }
    case "tag": {
      const pattern = event.pattern?.trim() ?? "";
      return pattern ? `New tag matching ${pattern}` : "Any new tag";
    }
    case "release":
      return event.includePrereleases ? "New release or pre-release" : "New release";
    case "pull_request": {
      const actions = event.actions.map((action) => (PR_ACTION_TEXT[action]?.label ?? action).toLowerCase());
      const bases = (event.baseBranches ?? []).map((base) => base.trim()).filter((base) => base.length > 0);
      return `PR ${actions.length > 0 ? listWords(actions, "or") : "event"}${bases.length > 0 ? ` → ${listWords(bases, "or")}` : ""}`;
    }
    default: {
      const unhandled: never = event;
      void unhandled;
      return "Git event";
    }
  }
}

/** The repository a git trigger watches, in words: "This workflow's project", "owner/repo · public", "owner/repo · as Work". */
export function gitRepoText(
  repo: { kind: "project" } | { kind: "url"; url: string; accountId?: string },
  accountLabel?: string | null
): string {
  if (repo.kind === "project") return "This workflow's project";
  const name = repo.url.trim() ? repoDisplayName(repo.url) : "No repository chosen";
  if (!repo.accountId) return `${name} · public`;
  return `${name} · as ${accountLabel ?? "an unknown account"}`;
}

/**
 * How often the daemon's poller looks (apps/daemon triggers/git-poller.ts):
 * refs (push, tag) every 60 s, pull requests and releases every 120 s
 * (Bitbucket Cloud 180 s), each ±10 %; a failing check backs off up to 15 min.
 */
export function gitPollingText(kind: GitTriggerEvent["kind"]): string {
  switch (kind) {
    case "push":
    case "tag":
      return "Checked about once a minute, not instantly.";
    case "pull_request":
      return "Checked about every 2 minutes (3 on Bitbucket Cloud), not instantly.";
    case "release":
      return "Checked about every 2 minutes, not instantly.";
    default: {
      const unhandled: never = kind;
      void unhandled;
      return "Checked periodically, not instantly.";
    }
  }
}

/** A comma-separated list ("main, release/*") as its trimmed, non-empty parts. */
export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Manual
// ---------------------------------------------------------------------------

/** Line and column (1-based) of `position` in `text`. */
function lineColumn(text: string, position: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(position, text.length)));
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/**
 * Why the example input is not JSON ("Line 2, column 3: Expected ',' or '}'
 * after property value"), or null when it is — or is empty (no input).
 */
export function jsonExampleProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (reason) {
    const raw = reason instanceof Error ? reason.message : String(reason);
    const at = /\bat position (\d+)/.exec(raw);
    const message = raw
      .replace(/\s*\(line \d+ column \d+\)/, "")
      .replace(/\s+in JSON at position \d+/, "")
      .replace(/\s+at position \d+/, "")
      .trim();
    if (!at) return `Not valid JSON: ${message}`;
    const { line, column } = lineColumn(text, Number(at[1]));
    return `Not valid JSON — line ${line}, column ${column}: ${message}`;
  }
}

/** The example re-indented (2 spaces), or null when it is empty or not JSON. */
export function formatJsonExample(text: string): string | null {
  if (!text.trim()) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * The preset after picking `kind`: `previous` itself when it already is that
 * kind (so re-picking wipes nothing), else that kind's starting values —
 * keeping the time of day when both have one.
 */
export function presetForKind(kind: SchedulePreset["kind"], previous: SchedulePreset): SchedulePreset {
  if (previous.kind === kind) return previous;
  const time = "time" in previous ? previous.time : "09:00";
  switch (kind) {
    case "minutes":
      return { kind: "minutes", every: 15 };
    case "hours":
      return { kind: "hours", every: 1, atMinute: 0 };
    case "daily":
      return { kind: "daily", time };
    case "weekly":
      return { kind: "weekly", days: [1, 2, 3, 4, 5], time };
    case "monthly":
      return { kind: "monthly", day: 1, time };
    case "cron":
      return { kind: "cron" };
  }
}

/** The repository after picking `kind`: `current` when it already is that kind, else an empty one of that kind. */
export function repoForKind(kind: GitRepoRef["kind"], current: GitRepoRef): GitRepoRef {
  if (current.kind === kind) return current;
  return kind === "project" ? { kind: "project" } : { kind: "url", url: "" };
}

/** A URL repository with `accountId` set (or removed when empty), every other field kept. */
export function repoWithAccount(current: Extract<GitRepoRef, { kind: "url" }>, accountId: string): Extract<GitRepoRef, { kind: "url" }> {
  const { accountId: _old, ...rest } = current;
  return accountId ? { ...rest, accountId } : rest;
}

/** The event after picking `kind`: `current` when it already is that kind, else that kind's starting values. */
export function eventForKind(kind: GitTriggerEvent["kind"], current: GitTriggerEvent): GitTriggerEvent {
  if (current.kind === kind) return current;
  switch (kind) {
    case "push":
      return { kind: "push", branches: [] };
    case "tag":
      return { kind: "tag", pattern: "v*" };
    case "release":
      return { kind: "release", includePrereleases: false };
    case "pull_request":
      return { kind: "pull_request", actions: ["opened", "updated"] };
  }
}

/** A tag event with `pattern` (removed when empty), every other field kept. */
export function tagWithPattern(current: Extract<GitTriggerEvent, { kind: "tag" }>, pattern: string): Extract<GitTriggerEvent, { kind: "tag" }> {
  const { pattern: _old, ...rest } = current;
  return pattern ? { ...rest, pattern } : rest;
}

/** A pull-request event with `baseBranches` (removed when empty), every other field kept. */
export function pullRequestWithBases(
  current: Extract<GitTriggerEvent, { kind: "pull_request" }>,
  baseBranches: string[]
): Extract<GitTriggerEvent, { kind: "pull_request" }> {
  const { baseBranches: _old, ...rest } = current;
  return baseBranches.length > 0 ? { ...rest, baseBranches } : rest;
}
