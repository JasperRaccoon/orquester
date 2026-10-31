/**
 * Scheduled prompts in the composer: reading the user's "send in" / "send at" input, and saying
 * when a prompt goes out. Pure; no React import.
 */

import type { ScheduledPromptView } from "@orquester/api/agent-chat";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: Record<string, number> = {
  d: DAY,
  day: DAY,
  days: DAY,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE
};

/**
 * A delay the user typed, in ms, or null when it does not read: "5m", "1h 24m", "1h24m",
 * "2 hours", "1.5h", "1:24" (hours:minutes), or a bare number of minutes ("90").
 */
export function parseDelay(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (value.length === 0) return null;
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (clock) return positive(Number(clock[1]) * HOUR + Number(clock[2]) * MINUTE);
  if (/^\d+(\.\d+)?$/.test(value)) return positive(Number(value) * MINUTE);
  const parts = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = "";
  for (const match of value.matchAll(parts)) {
    const unit = UNITS[match[2]!];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  // Every character but separators must have been read: "1h banana" is no delay.
  if (consumed.replace(/\s+/g, "") !== value.replace(/[\s,]+|and/g, "")) return null;
  return positive(total);
}

function positive(ms: number): number | null {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/**
 * The next time the wall clock reads `hhmm` ("04:30", as an `<input type="time">` gives it):
 * later today, else tomorrow. Null when it does not read.
 */
export function nextClockTime(hhmm: string, now: Date): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** A span as the user reads it: "4h 12m", "2d 3h", "12m", "under a minute". */
export function formatSpan(ms: number): string {
  if (ms < MINUTE) return "under a minute";
  const totalMinutes = Math.round(ms / MINUTE);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** A send time: "4:24 AM" today, with the weekday when it is not today ("Sun 4:24 AM"). */
export function formatSendTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** "Sends at 4:24 AM (in 4h 12m)". */
export function sendsAtText(at: Date, now: Date): string {
  return `Sends at ${formatSendTime(at, now)} (in ${formatSpan(at.getTime() - now.getTime())})`;
}

/** What a scheduled prompt's row says about where it stands. */
export function scheduledPromptStatus(prompt: Pick<ScheduledPromptView, "state" | "sendAt" | "error">, now: Date): string {
  switch (prompt.state) {
    case "waiting":
      return "Due: sends once the chat is idle";
    case "sending":
      return "Sending…";
    case "failed":
      return `Not sent: ${prompt.error ?? "the chat refused it."}`;
    case "scheduled": {
      const at = new Date(prompt.sendAt);
      return at.getTime() <= now.getTime() ? "Sending…" : sendsAtText(at, now);
    }
  }
}

/** The chat's scheduled prompts off its summary, tolerating an older daemon (absent) or a malformed value. */
export function scheduledPromptsOf(summary: { scheduledPrompts?: unknown }): ScheduledPromptView[] {
  const value = summary.scheduledPrompts;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is ScheduledPromptView =>
      typeof p === "object" && p !== null && typeof p.id === "string" && typeof p.sendAt === "string" && typeof p.state === "string"
  );
}
