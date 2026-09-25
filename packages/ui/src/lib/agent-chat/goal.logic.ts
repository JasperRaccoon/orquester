/**
 * Agent chat — the goal's client-side readings (goals §8, `docs/superpowers/
 * specs/2026-09-24-agent-goals-design.md`).
 *
 * The goal is the PROVIDER's (goals §1): the fold keeps the last `goal.updated`
 * row as the thread's goal, and the slice hands it to the status-line chip
 * (`components/agent-chat/status/goal-chip.ts`, which reads the fold's goal
 * directly). What lives here is every other surface: the timeline's marker
 * rows (§8.4) and the tab marker (§8.3) — and the one reading the chip and
 * the tab marker share, a goal a deploy HELD (§5.7).
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
  type AgentGoal,
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
// A goal held for an Orquester update (§5.7)
// ---------------------------------------------------------------------------

/**
 * How a goal HELD for an Orquester update is named where a sentence names its
 * status — the chip's spoken name, the tab marker's label: a pause the user
 * did not ask for, which ends by itself. The words the eye gets from the
 * in-motion tone, spelled out for a screen reader.
 */
export const GOAL_HELD_FOR_UPDATE_TEXT = "paused for an Orquester update — it resumes by itself";

export interface GoalHoldInput {
  /** The fold's goal — what the chip renders. Only its status is read. */
  goal: Pick<AgentGoal, "status"> | null | undefined;
  /** `SessionSummary.goal` for this thread — wire data, read field-wise. */
  summaryGoal?: unknown;
  /**
   * The head carries `goalHeldForHandover`. Head-only state: a snapshot
   * refreshes it, no live event does.
   */
  goalHeldForHandover?: boolean;
}

/**
 * Goals §5.7: the goal is HELD for an Orquester update. A deploy's drain
 * paused a continuing Codex goal between two of its turns, and the next agent
 * host sets it going again by itself — so the fold reads `paused`, as if the
 * user had paused it, while the host keeps reporting the goal CONTINUING and
 * the tab reads working. The chip, its popover and the tab marker ask this,
 * so none of them calls a hold the user's pause (or the reverse); the
 * timeline keeps the provider's own `paused` row, and the host's
 * `goal.status` row beside it explains it.
 *
 * Only a `paused` fold goal can be held: the fold is what the chip renders,
 * and once it reads anything else the hold is over (the goal was set going
 * again) or beside the point (it ended, blocked or hit a limit).
 *
 * Then, as `isGoalContinuing` (`account-switch.ts`) reads it, the summary's
 * verdict whenever the view has one: `SessionSummary.goal` with a boolean
 * `continuing` — `null` there is a verdict too, the host holding no
 * unfinished goal. A goal the host reports `paused` AND continuing is held:
 * the host's predicate needs `active` unless the goal is held, so no other
 * paused goal ever continues. It must be the summary's OWN status that says
 * `paused`, not just the fold's: the pair is one host reading, while the
 * fold's `paused` arrives live and the summary on the daemon's next poll
 * (1.5 s) — in between, a user's Pause or Stop of a continuing goal reads
 * `{active, continuing: true}` against a paused fold, and must not flash
 * "paused for an Orquester update". A verdict is final: the head's mark,
 * refreshed only by a snapshot, may outlive a hold the user ended — any user
 * action on the goal releases it ("the user wins").
 *
 * Without a verdict — a host that predates the field, a summary not yet
 * received, a malformed one — the head's `goalHeldForHandover` decides.
 */
export function isGoalHeldForUpdate(input: GoalHoldInput): boolean {
  if (input.goal?.status !== "paused") return false;
  const summary = input.summaryGoal;
  if (summary === null) return false;
  if (typeof summary === "object" && summary !== undefined && !Array.isArray(summary)) {
    const { continuing, status } = summary as { continuing?: unknown; status?: unknown };
    if (typeof continuing === "boolean") return continuing && status === "paused";
  }
  return input.goalHeldForHandover === true;
}

// ---------------------------------------------------------------------------
// The tab marker (§8.3)
// ---------------------------------------------------------------------------

const GOAL_STATUSES: ReadonlySet<string> = new Set(AGENT_GOAL_STATUSES);

export interface GoalSummaryMarker {
  /**
   * `info` while the goal is active — or held for an Orquester update (§5.7),
   * which goes on by itself — and `warn` once it has stopped short.
   */
  tone: "info" | "warn";
  /**
   * `Goal: <objective> (<status>)` — the marker's `aria-label` and `title`,
   * the objective capped by {@link clipGoalText}; a held goal's status is
   * {@link GOAL_HELD_FOR_UPDATE_TEXT}.
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
 * read for one thing only, a goal held for an Orquester update (§5.7,
 * {@link isGoalHeldForUpdate}, the summary being the only goal a tab has):
 * `paused` and continuing is the host's own reading of a hold, whose dot says
 * working — a warn target beside it would call the deploy's pause the user's.
 * An older host omits `continuing`, and its paused goal reads as a pause.
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
  const held = isGoalHeldForUpdate({ goal: known, summaryGoal: goal });
  return {
    tone: known.status === "active" || held ? "info" : "warn",
    label: `Goal: ${clipGoalText(objective)} (${held ? GOAL_HELD_FOR_UPDATE_TEXT : status})`
  };
}
