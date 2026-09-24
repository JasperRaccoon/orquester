/**
 * Agent chat — the goal's client-side readings (goals §8, `docs/superpowers/
 * specs/2026-09-24-agent-goals-design.md`).
 *
 * The goal is the PROVIDER's (goals §1): the fold keeps the last `goal.updated`
 * row as the thread's goal, and the slice hands it to the status-line chip
 * (`components/agent-chat/status/goal-chip.ts`, which reads the fold's goal
 * directly). What lives here is every other surface: the timeline's marker
 * rows (§8.4) and the tab marker (§8.3).
 *
 * Nothing reaches typed code raw. A row's payload goes through the shared
 * `parseGoalUpdatedPayload`, and a summary's `goal` is validated field-wise,
 * because both come off the wire from a host that may be older or newer than
 * this client (goals §9) — a goal row that does not parse is a generic row,
 * and a summary goal that does not validate draws nothing.
 *
 * No React import.
 */

import {
  AGENT_GOAL_STATUSES,
  GOAL_ACTIVITY_KIND,
  GOAL_SUMMARY_TEXT_CHARS,
  isHiddenGoalChange,
  isUnfinishedGoal,
  parseGoalUpdatedPayload,
  type AgentGoalStatus,
  type GoalUpdatedPayload,
  type ThreadActivityItem
} from "@orquester/api/agent-chat";

import type { WorkLogEntry } from "./contracts";

// ---------------------------------------------------------------------------
// Timeline rows (§8.4)
// ---------------------------------------------------------------------------

const parsedUpdates = new WeakMap<ThreadActivityItem, GoalUpdatedPayload | null>();

/**
 * A `goal.updated` row's payload, or `null` for any other row and for a goal
 * row that does not parse — a `change` this client does not know, a goal
 * without an objective. Parsed once per activity: the fold hands the same
 * activity object back on every projection.
 */
export function goalUpdateOf(activity: ThreadActivityItem): GoalUpdatedPayload | null {
  if (activity.activityKind !== GOAL_ACTIVITY_KIND) {
    return null;
  }
  const cached = parsedUpdates.get(activity);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseGoalUpdatedPayload(activity.payload);
  parsedUpdates.set(activity, parsed);
  return parsed;
}

/**
 * `progress` never becomes a row (goals §8.4): it is the goal's heartbeat,
 * which keeps the chip current and says nothing a reader of the conversation
 * needs. A row this client cannot read is never hidden — it renders as the
 * generic row, with its summary, exactly as an older client renders every
 * goal row (goals §9).
 */
export function isHiddenGoalActivity(activity: ThreadActivityItem): boolean {
  const update = goalUpdateOf(activity);
  return update !== null && isHiddenGoalChange(update.change);
}

/**
 * What a marker row needs beyond its summary: the change, and the goal it is
 * about — the current one, or, on the achieved/failed/cleared rows whose goal
 * is null, the one that ended. The objective rides whole (the summary cuts it
 * to 200 characters); the counters ride for the stats line an ended goal's
 * marker draws.
 */
export function goalMarkerOf(update: GoalUpdatedPayload): NonNullable<WorkLogEntry["goal"]> {
  const subject = update.goal ?? update.previous ?? null;
  return {
    change: update.change,
    ...(subject !== null ? { objective: subject.objective } : {}),
    ...(subject?.rounds !== undefined ? { rounds: subject.rounds } : {}),
    ...(subject?.elapsedMs !== undefined ? { elapsedMs: subject.elapsedMs } : {}),
    ...(subject?.tokensUsed !== undefined ? { tokensUsed: subject.tokensUsed } : {})
  };
}

// ---------------------------------------------------------------------------
// Accessible names
// ---------------------------------------------------------------------------

/**
 * An objective as an accessible name or a tooltip quotes it: at most
 * {@link GOAL_SUMMARY_TEXT_CHARS} (200) characters, the last an ellipsis,
 * never splitting a surrogate pair — the rule the host's goal-row summary
 * cuts by (`goal.ts`). Objectives run to 4000 characters, and a name that
 * long is read out whole; the popover is where the uncut text lives.
 */
export function clipGoalText(text: string): string {
  if (text.length <= GOAL_SUMMARY_TEXT_CHARS) {
    return text;
  }
  let end = GOAL_SUMMARY_TEXT_CHARS - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The tab marker (§8.3)
// ---------------------------------------------------------------------------

const GOAL_STATUSES: ReadonlySet<string> = new Set(AGENT_GOAL_STATUSES);

export interface GoalSummaryMarker {
  /** `info` while the goal is active, `warn` once it has stopped short. */
  tone: "info" | "warn";
  /**
   * `Goal: <objective> (<status>)` — the marker's `aria-label` and `title`,
   * the objective capped by {@link clipGoalText}.
   */
  label: string;
}

/**
 * The tab marker for a `SessionSummary.goal`, or `null` for none.
 *
 * The summary is wire data, so it is read field-wise rather than trusted: an
 * objective that is not a non-empty string or a status outside the enum draws
 * nothing. Only an unfinished goal draws — the host sends only those, and a
 * finished one reaching a tab would claim work that is over. `continuing` is
 * not read: an older host omits it, and the marker never needed it.
 */
export function goalSummaryMarker(goal: unknown): GoalSummaryMarker | null {
  if (goal === null || typeof goal !== "object" || Array.isArray(goal)) {
    return null;
  }
  const { objective, status } = goal as { objective?: unknown; status?: unknown };
  if (typeof objective !== "string" || objective.length === 0) {
    return null;
  }
  if (typeof status !== "string" || !GOAL_STATUSES.has(status)) {
    return null;
  }
  const known = { objective, status: status as AgentGoalStatus };
  if (!isUnfinishedGoal(known)) {
    return null;
  }
  return {
    tone: known.status === "active" ? "info" : "warn",
    label: `Goal: ${clipGoalText(objective)} (${status})`
  };
}
