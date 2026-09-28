/**
 * Automated workflows — the rail's words: filters, trigger lines, run status,
 * durations and relative times. Pure (every clock is a parameter), so the
 * panel and the tests read the same sentences.
 */

import {
  isRunActive,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowTriggerKind,
  type WorkflowTriggerSummary
} from "@orquester/api";

/** A project path without trailing slashes ("" for none). */
export function normalizeWorkflowProjectPath(path: string | null | undefined): string {
  return (path ?? "").trim().replace(/\/+$/, "");
}

/** The workflow runs in this existing project (a temporary project belongs to none). */
export function workflowInProject(summary: WorkflowSummary, projectPath: string): boolean {
  const target = normalizeWorkflowProjectPath(projectPath);
  return (
    target.length > 0 &&
    summary.project.kind === "existing" &&
    normalizeWorkflowProjectPath(summary.project.projectPath) === target
  );
}

export type WorkflowListFilter = "all" | "project" | "running";

/** The list the panel shows: the filter, then the search over name, description and trigger texts. */
export function filterWorkflows(
  workflows: readonly WorkflowSummary[],
  filter: WorkflowListFilter,
  projectPath: string,
  query: string
): WorkflowSummary[] {
  const needle = query.trim().toLowerCase();
  return workflows.filter((workflow) => {
    if (filter === "project" && !workflowInProject(workflow, projectPath)) return false;
    if (filter === "running" && workflow.activeRuns.length === 0) return false;
    if (needle.length === 0) return true;
    const haystack = [workflow.name, workflow.description ?? "", ...workflow.triggers.map((t) => t.text)]
      .join("\n")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/** "8s", "12m", "1h 4m", "2d 3h" — a duration at a glance. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** "just now", "3m ago", "2h ago", "5d ago"; "" for no parseable time. A future time reads "just now". */
export function formatAgo(iso: string | null | undefined, now: number): string {
  const time = parse(iso);
  if (time === null) return "";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

const pad = (value: number): string => String(value).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * When a trigger fires next, in the viewer's local time: "in 12m" within the
 * hour, "14:45" today, "tomorrow 09:00", "Tue 14:45" this week, else "Oct 3".
 * "due" for a time already passed (the engine fires it within its grace).
 */
export function formatNextRun(iso: string | null | undefined, now: number): string {
  const time = parse(iso);
  if (time === null) return "";
  const delta = time - now;
  if (delta <= 0) return "due";
  if (delta < 60_000) return "in <1m";
  if (delta < 60 * 60_000) return `in ${Math.floor(delta / 60_000)}m`;
  const date = new Date(time);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days < 7) return `${DAYS[date.getDay()]} ${clock}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** A trigger in words, with its next firing: "Every 15 min · next 14:45". */
export function triggerLine(trigger: WorkflowTriggerSummary, now: number): string {
  const text = trigger.text.trim() || TRIGGER_TYPE_TEXT[trigger.type] || "Trigger";
  const next = formatNextRun(trigger.nextRunAt, now);
  return next ? `${text} · next ${next}` : text;
}

const TRIGGER_TYPE_TEXT: Record<string, string> = {
  "trigger.manual": "Manual",
  "trigger.schedule": "On a schedule",
  "trigger.git": "On a git event"
};

const TRIGGER_KIND_TEXT: Record<WorkflowTriggerKind, string> = {
  manual: "Run now",
  schedule: "Schedule",
  git: "Git event",
  retry: "Retry",
  test: "Test run",
  subworkflow: "Sub-workflow"
};

/** What started a run, for a history row. */
export function runTriggerText(run: WorkflowRunSummary): string {
  const text = run.trigger.text?.trim();
  return text && text.length > 0 ? text : TRIGGER_KIND_TEXT[run.trigger.kind];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunTone = "ok" | "danger" | "warn" | "info" | "neutral";

/** The status dot's colour. */
export function runStatusTone(status: WorkflowRunStatus): RunTone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
    case "interrupted":
      return "danger";
    case "cancelled":
    case "stopped":
      return "warn";
    case "queued":
    case "running":
      return "info";
    case "skipped":
      return "neutral";
  }
}

const STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  stopped: "Stopped",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  interrupted: "Interrupted"
};

export function runStatusLabel(run: Pick<WorkflowRunSummary, "status" | "skipReason">): string {
  if (run.status === "skipped" && run.skipReason === "overlap") return "Skipped · overlap";
  if (run.status === "skipped" && run.skipReason === "missed") return "Skipped · missed";
  return STATUS_LABEL[run.status];
}

/** How long a run took — or, still running, has taken so far. `null` when unknown. */
export function runElapsedMs(run: WorkflowRunSummary, now: number): number | null {
  if (!isRunActive(run.status) && typeof run.durationMs === "number") return run.durationMs;
  const start = parse(run.startedAt);
  if (start === null) return null;
  const end = isRunActive(run.status) ? now : (parse(run.endedAt) ?? null);
  return end === null ? null : Math.max(0, end - start);
}

export interface RunProgressView {
  /** "Step 3/7 · Codex review · 12m" (or "Queued · 2m"). */
  line: string;
  /** 0..1 for the thin bar; `null` while nothing is known (an indeterminate bar). */
  fraction: number | null;
}

/** The live line a running card shows. */
export function runProgress(run: WorkflowRunSummary, now: number): RunProgressView {
  const elapsed = runElapsedMs(run, now);
  const time = elapsed === null ? "" : formatDuration(elapsed);
  if (run.status === "queued") {
    return { line: ["Queued", time].filter(Boolean).join(" · "), fraction: null };
  }
  const current = run.current;
  if (current === undefined || current.total <= 0) {
    return { line: ["Starting", time].filter(Boolean).join(" · "), fraction: null };
  }
  const index = Math.min(Math.max(current.index, 1), current.total);
  const parts = [`Step ${index}/${current.total}`, current.name, time].filter((part) => part.length > 0);
  // The step in progress counts half: a bar that sits at 0 through a long first step reads as stuck.
  return { line: parts.join(" · "), fraction: Math.min(1, (index - 0.5) / current.total) };
}

/** The newest active run a card shows live, if any. */
export function liveRunOf(summary: WorkflowSummary): WorkflowRunSummary | null {
  return summary.activeRuns.find((run) => run.status === "running") ?? summary.activeRuns[0] ?? null;
}
