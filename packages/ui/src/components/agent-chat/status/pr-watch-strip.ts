/**
 * What one pull request watch chip says (spec 2026-10-14 §5 "PR watch"): the
 * pull request, the news its last read held, and a tone from the shared scale.
 * Pure, so the wording is tested without rendering.
 */

import type { PullRequestWatchSummary } from "@orquester/api/agent-chat";

import type { ChatTone } from "../primitives/tone";

export interface PullRequestWatchChip {
  /** "#12". */
  label: string;
  /** "2 failed", "conflict", "checks running", "checks passed", "checking…". */
  detail: string;
  tone: ChatTone;
  /** The tooltip: repository, title, state, when it was last read, a read failure. */
  title: string;
  /** The stop button's accessible name. */
  stopLabel: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function describePullRequestWatch(watch: PullRequestWatchSummary, now: number = Date.now()): PullRequestWatchChip {
  const label = `#${watch.number}`;
  const status = watch.status;
  const facts: string[] = [];
  let detail: string;
  let tone: ChatTone;
  if (status === null) {
    detail = watch.lastError ? "can't read" : "checking…";
    tone = watch.lastError ? "warn" : "muted";
  } else {
    const { checks } = status;
    const conflict = status.mergeability === "conflicting";
    if (checks.failed > 0) facts.push(`${checks.failed} failed`);
    if (conflict) facts.push("conflict");
    if (facts.length === 0) {
      if (checks.pending > 0) facts.push("checks running");
      else if (checks.total > 0) facts.push("checks passed");
      else facts.push("watching");
    }
    detail = facts.join(" · ");
    tone = checks.failed > 0 || conflict ? "danger" : checks.pending > 0 ? "info" : checks.total > 0 ? "ok" : "muted";
    if (watch.lastError) tone = tone === "danger" ? tone : "warn";
  }

  const lines = [`Watching ${watch.repository}#${watch.number}${watch.title ? ` — ${watch.title}` : ""}`];
  if (status) {
    const { checks } = status;
    lines.push(
      checks.total > 0
        ? `Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} running`
        : "No checks reported"
    );
    if (status.mergeability === "conflicting") lines.push(`Conflicts with ${status.baseBranch || "its base branch"}`);
  }
  if (watch.lastCheckedAt) {
    const minutes = Math.max(0, Math.round((now - Date.parse(watch.lastCheckedAt)) / 60_000));
    lines.push(`Checked ${minutes === 0 ? "just now" : `${plural(minutes, "minute", "minutes")} ago`}`);
  }
  if (watch.lastError) lines.push(`Last read failed: ${watch.lastError}`);
  if (watch.wakePending) lines.push("An update waits for this thread to be idle");
  return { label, detail, tone, title: lines.join("\n"), stopLabel: `Stop watching pull request #${watch.number}` };
}
