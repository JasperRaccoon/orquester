// Automated workflows — a trigger in words, for the rail card and the canvas block summary:
// "Every 15 min · next 14:45", "Push to main · this project", "New tag v* · AppsStats/Apps-Stats",
// "PR opened, merged · owner/repo", "Release · owner/repo".

import { describeSchedule } from "./schedule.ts";
import type { WorkflowNode } from "./types.ts";

export interface TriggerSummaryOptions {
  /** A project-repo trigger says "· <projectName>"; "· this project" when absent. */
  projectName?: string;
  /** A schedule's next fire time (ISO): adds "· next 14:45". */
  nextRunAt?: string | null;
  /** The zone `nextRunAt` is shown in (the workflow's); the runtime's own when absent. */
  timeZone?: string;
  /** "Today" for the next-run text; now by default. */
  now?: Date;
}

/** "owner/repo" from a clone URL (https, ssh, scp-style; Bitbucket Server's `/scm/PROJ/repo`). */
export function repoDisplayName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  // scp-style: git@host:owner/repo
  const scp = /^[^/@\s]+@[^:/\s]+:(.+)$/.exec(trimmed);
  const path = scp ? scp[1]! : trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return segments[0] ?? trimmed;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? "";
}

/** "14:45" today, "Tue 14:45" within the week, "Oct 3 14:45" later — in `timeZone`. */
export function formatNextRun(nextRunAt: string, timeZone?: string, now: Date = new Date()): string | null {
  const when = new Date(nextRunAt);
  if (Number.isNaN(when.getTime())) return null;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    return formatNextRun(nextRunAt, undefined, now);
  }
  const at = format.formatToParts(when);
  const today = format.formatToParts(now);
  const time = `${part(at, "hour")}:${part(at, "minute")}`;
  const sameDay = ["year", "month", "day"].every((type) => part(at, type as Intl.DateTimeFormatPartTypes) === part(today, type as Intl.DateTimeFormatPartTypes));
  if (sameDay) return time;
  const days = (when.getTime() - now.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return `${part(at, "weekday")} ${time}`;
  return `${part(at, "month")} ${part(at, "day")} ${time}`;
}

/** A trigger block in words; "" for a block that is not a trigger. */
export function triggerSummaryText(node: WorkflowNode, opts: TriggerSummaryOptions = {}): string {
  switch (node.type) {
    case "trigger.manual":
      return "Run manually";
    case "trigger.schedule": {
      const text = describeSchedule(node.config.preset, node.config.cron);
      const next = opts.nextRunAt ? formatNextRun(opts.nextRunAt, opts.timeZone, opts.now) : null;
      return next === null ? text : `${text} · next ${next}`;
    }
    case "trigger.git": {
      const { event, repo } = node.config;
      let what: string;
      switch (event.kind) {
        case "push":
          what = event.branches.length === 0 ? "Push to the default branch" : `Push to ${event.branches.join(", ")}`;
          break;
        case "tag":
          what = event.pattern && event.pattern.trim().length > 0 ? `New tag ${event.pattern.trim()}` : "New tag";
          break;
        case "release":
          what = event.includePrereleases ? "Release (incl. pre-releases)" : "Release";
          break;
        case "pull_request":
          what = `PR ${event.actions.join(", ")}${event.baseBranches && event.baseBranches.length > 0 ? ` → ${event.baseBranches.join(", ")}` : ""}`;
          break;
        default: {
          const unhandled: never = event;
          void unhandled;
          what = "Git event";
        }
      }
      const where = repo.kind === "project" ? (opts.projectName?.trim() || "this project") : repoDisplayName(repo.url);
      return `${what} · ${where}`;
    }
    default:
      return "";
  }
}
