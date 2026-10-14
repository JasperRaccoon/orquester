/**
 * Pull request watches — change detection and the wake's wording (spec 2026-10-14 §5 "PR watch").
 *
 * Ported from T3 Code (MIT): `apps/server/src/orchestration-v2/pullRequestWatch.ts`
 * (`evaluatePullRequestWatch`, `pullRequestWatchMessage`), adapted to Orquester's normalised
 * provider reads (`../providers/types.ts`) and persisted watch (`@orquester/config`), with the
 * end-of-watch messages (merged, closed, unreadable) that T3 sent from its reactor.
 *
 * Pure: no clock, no I/O.
 */

import type { PullRequestWatchTold } from "@orquester/config";
import { PR_WATCH_MESSAGE_PREFIX } from "@orquester/api/agent-chat";

import type { PullRequestCheck, PullRequestRemark, PullRequestStatus } from "../providers/types.ts";

/**
 * Wakes in a row that bring only comments. Check, conflict, or push news resets the count, so
 * this only stops a chatty bot looping an agent that is replying to it.
 */
export const PULL_REQUEST_WATCH_WAKE_LIMIT = 10;
/** Reads in a row that failed for a reason other than a rate limit before the watch ends. */
export const PULL_REQUEST_WATCH_READ_FAILURE_LIMIT = 8;
const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 200;

export type PullRequestWatchChange =
  | { readonly kind: "checks-failed"; readonly failed: readonly PullRequestCheck[] }
  | { readonly kind: "checks-passed"; readonly count: number; readonly required: boolean }
  | { readonly kind: "remarks"; readonly remarks: readonly PullRequestRemark[] }
  | { readonly kind: "conflicting" };

export interface PullRequestWatchReport {
  /** What the agent has not been told yet. Empty means no wake. */
  readonly changes: readonly PullRequestWatchChange[];
  /** The told state to record, whether or not anything is reported. */
  readonly next: PullRequestWatchTold;
  /** This report spends the last wake before the limit, so watching stops after it. */
  readonly exhausted: boolean;
}

/** The told state of a watch that has seen nothing yet: remarks count from `startedAt`. */
export function initialTold(startedAt: string): PullRequestWatchTold {
  return {
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: startedAt,
    remarkIds: [],
    conflicting: false,
    wakes: 0
  };
}

// "action-required" is a finished check that needs someone, so the agent hears about it.
export const isFailedCheck = (check: PullRequestCheck): boolean =>
  check.status === "failure" || check.status === "cancelled" || check.status === "action-required";

/** Bitbucket Cloud reads abbreviate the head: two heads are one when either prefixes the other. */
function sameHead(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.toLowerCase().startsWith(short.toLowerCase());
}

/**
 * Compares a watched pull request with what its agent was last told. Each check is reported as
 * soon as it fails, so a check that never finishes (an advisory review bot) cannot hold the
 * news back. "Passed" is reported once the checks the base branch requires all passed, or all
 * checks where the host marks none required. Remarks count when someone other than the viewer's
 * own account (`viewer`; the pull request's author when the read was anonymous) wrote them, so
 * the agent's own replies never wake it. `remarks` is null when the conversation could not be
 * read completely; remarks then wait for a later read.
 */
export function evaluatePullRequestWatch(
  told: PullRequestWatchTold,
  status: Pick<PullRequestStatus, "headSha" | "checks" | "mergeability" | "author">,
  remarks: readonly PullRequestRemark[] | null,
  viewer: readonly string[]
): PullRequestWatchReport {
  const changes: PullRequestWatchChange[] = [];
  const headSha = status.headSha ?? null;
  const headMoved = !sameHead(headSha, told.headSha);

  // An empty list keeps the last state: a host can answer with one when its check read fails.
  let failedChecks = headMoved ? [] : told.failedChecks;
  let passed = headMoved ? false : told.passed;
  let passedChecks = headMoved ? [] : told.passedChecks;
  if (status.checks.length > 0) {
    const failed = status.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) changes.push({ kind: "checks-failed", failed: newlyFailed });
    // A check that runs again leaves the list, so a rerun that fails again is reported.
    failedChecks = failed.map((check) => check.name);

    const required = status.checks.filter((check) => check.required === true);
    const gate = required.length > 0 ? required : status.checks;
    const passedNow = gate.every((check) => check.status !== "pending" && !isFailedCheck(check));
    const gateNames = gate.map((check) => check.name);
    const tellFrom = passed && passedChecks.length === 0 ? gateNames : passedChecks;
    // A required job created and finished between two reads is never seen pending. Without
    // required checks, any check counts, and advisory bots keep adding passed ones: no wake.
    const gateGrew = required.length > 0 && gateNames.some((name) => !tellFrom.includes(name));
    if (passedNow && (!passed || gateGrew)) {
      changes.push({ kind: "checks-passed", count: gate.length, required: required.length > 0 });
    }
    passed = passedNow;
    passedChecks = passedNow ? gateNames : [];
  }

  const own = new Set(
    (viewer.length > 0 ? viewer : status.author ? [status.author] : []).map((login) => login.toLowerCase())
  );
  const isOwn = (remark: PullRequestRemark) =>
    (remark.author !== null && own.has(remark.author.toLowerCase())) ||
    (remark.authorRef != null && own.has(remark.authorRef.toLowerCase()));
  const through = Date.parse(told.remarksThrough);
  // An edit counts as new activity, so bots that rewrite one summary comment still wake the agent.
  const activeAt = (remark: PullRequestRemark) => remark.editedAt ?? remark.createdAt;
  // Hosts stamp per second (GitHub), so remarks at the boundary time are told apart by ID.
  const fresh = (remarks ?? []).filter((remark) => {
    const at = Date.parse(activeAt(remark));
    return !Number.isNaN(at) && (at > through || (at === through && !told.remarkIds.includes(remark.id))) && !isOwn(remark);
  });
  if (fresh.length > 0) changes.push({ kind: "remarks", remarks: fresh });
  const latest = Math.max(through, ...fresh.map((remark) => Date.parse(activeAt(remark))));
  const atLatest = fresh.filter((remark) => Date.parse(activeAt(remark)) === latest);
  const remarksThrough = latest === through ? told.remarksThrough : activeAt(atLatest[0]!);
  const remarkIds = [...(latest === through ? told.remarkIds : []), ...atLatest.map((remark) => remark.id)];

  if (status.mergeability === "conflicting" && !told.conflicting) {
    changes.push({ kind: "conflicting" });
  }
  // "unknown" is the host still computing after a push; only a clean answer clears a conflict.
  const conflicting = status.mergeability === "unknown" ? told.conflicting : status.mergeability === "conflicting";

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const wakes = (progress ? 0 : told.wakes) + (commentsOnly ? 1 : 0);
  return {
    changes,
    next: { ...told, headSha, failedChecks, passed, passedChecks, remarksThrough, remarkIds, conflicting, wakes },
    exhausted: commentsOnly && wakes >= PULL_REQUEST_WATCH_WAKE_LIMIT
  };
}

// ---------------------------------------------------------------------------
// The wake's wording
// ---------------------------------------------------------------------------

function snippet(body: string): string {
  const text = body
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 3)}...`;
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function changeLines(change: PullRequestWatchChange, context: { baseBranch: string; commit: string }): string[] {
  switch (change.kind) {
    case "checks-failed":
      return [
        `- Checks failed${context.commit}:`,
        ...listed(
          change.failed,
          (check) => `  - ${check.name}${check.status === "failure" ? "" : ` (${check.status})`}${check.url ? ` ${check.url}` : ""}`
        )
      ];
    case "checks-passed":
      return [
        `- All ${change.count} ${change.required ? "required " : ""}${change.count === 1 ? "check" : "checks"} passed${context.commit}.`
      ];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) => {
          const where = remark.path === null ? "" : ` on ${remark.path}`;
          const body = snippet(remark.body);
          const said = body.length === 0 ? (remark.reviewState ?? "reviewed") : `"${body}"`;
          const verdict = body.length > 0 && remark.reviewState && remark.reviewState !== "commented" ? ` (${remark.reviewState})` : "";
          return `  - ${remark.author ?? "someone"}${where}${verdict}: ${said}${remark.url ? ` ${remark.url}` : ""}`;
        })
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${context.baseBranch || "its base branch"}.`];
  }
}

const SUMMARY: Record<PullRequestWatchChange["kind"], string> = {
  "checks-failed": "checks failed",
  "checks-passed": "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict"
};

/** Why a watch ended with a message to its thread. */
export type PullRequestWatchEnd =
  | { readonly kind: "merged" }
  | { readonly kind: "closed" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** One pull request's part of a wake. */
export type PullRequestWakeSection = {
  readonly number: number;
  readonly url: string;
} & (
  | {
      readonly kind: "update";
      readonly report: PullRequestWatchReport;
      readonly baseBranch: string;
      readonly headSha: string | null;
    }
  | { readonly kind: "ended"; readonly end: PullRequestWatchEnd }
);

function sectionSummary(section: PullRequestWakeSection): string {
  if (section.kind === "ended") {
    const what = section.end.kind === "unreadable" ? "stopped watching, could not read it" : `${section.end.kind}, stopped watching`;
    return `#${section.number}: ${what}`;
  }
  const parts = section.report.changes.map((change) => SUMMARY[change.kind]);
  if (section.report.exhausted) parts.push("stopped watching");
  return `#${section.number}: ${parts.join(", ")}`;
}

function sectionLines(section: PullRequestWakeSection): string[] {
  const ref = `pull request #${section.number}${section.url ? ` (${section.url})` : ""}`;
  if (section.kind === "ended") {
    switch (section.end.kind) {
      case "merged":
        return [`Pull request #${section.number}${section.url ? ` (${section.url})` : ""} was merged, so Orquester stopped watching it.`];
      case "closed":
        return [
          `Pull request #${section.number}${section.url ? ` (${section.url})` : ""} was closed without being merged, so Orquester stopped watching it. Call watch_pull_request if it reopens.`
        ];
      case "unreadable":
        return [
          `Orquester stopped watching ${ref} because it failed to read it ${PULL_REQUEST_WATCH_READ_FAILURE_LIMIT} times in a row (${section.end.reason}). Check it yourself, and call watch_pull_request to watch it again.`
        ];
    }
  }
  const context = {
    baseBranch: section.baseBranch,
    commit: section.headSha === null ? "" : ` on ${section.headSha.slice(0, 7)}`
  };
  const lines = [
    `Update on ${ref}, which Orquester is watching for you:`,
    ...section.report.changes.flatMap((change) => changeLines(change, context))
  ];
  if (section.report.exhausted) {
    lines.push(
      `Orquester stopped watching it after ${PULL_REQUEST_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`
    );
  }
  return lines;
}

/**
 * The wake the agent reads: `[Pull request watch] <summary>`, then one part per pull request,
 * then what to do. One message per wake, however many of the thread's pull requests moved.
 */
export function pullRequestWakeMessage(sections: readonly PullRequestWakeSection[]): string {
  const stillWatching = sections.some((section) => section.kind === "update" && !section.report.exhausted);
  const closing = stillWatching
    ? "Look into each item and act on it as your task requires. Orquester keeps watching and wakes you on the next change, so end your turn when you are done. Call unwatch_pull_request when you no longer need updates."
    : null;
  return [
    `${PR_WATCH_MESSAGE_PREFIX}${sections.map(sectionSummary).join("; ")}`,
    ...sections.flatMap((section, index) => [...(index > 0 ? [""] : []), ...sectionLines(section)]),
    ...(closing ? ["", closing] : [])
  ].join("\n");
}
