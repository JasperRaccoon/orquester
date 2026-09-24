/**
 * Agent chat — provider-native goals (goals spec §4.1, §4.3:
 * `docs/superpowers/specs/2026-09-24-agent-goals-design.md`).
 *
 * A goal is the PROVIDER's: Claude's `/goal` Stop hook, Codex's thread goal,
 * Grok's goal workflow. Orquester only mirrors it — an adapter normalises what
 * its provider says into {@link AgentGoal} and emits `thread.goal.updated`,
 * ingestion writes one `goal.updated` activity per update, and the fold keeps
 * the last one as the thread's {@link ThreadGoal} (goals §4.4). Nothing here is
 * ported: T3 Code has no goal surface.
 *
 * Every goal that reaches typed code from the wire or the disk goes through
 * {@link parseAgentGoal} / {@link parseGoalUpdatedPayload} /
 * {@link parseThreadGoal} first: field-wise, unknown keys dropped, never a
 * throw.
 *
 * Imports nothing, on purpose: `runtime-events.ts` and `thread.ts` read these
 * types, and the fold reads these helpers.
 */

// ---------------------------------------------------------------------------
// The shape (§4.1)
// ---------------------------------------------------------------------------

export type AgentGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget-limited"
  | "usage-limited"
  | "complete"
  | "failed";

/** Every {@link AgentGoalStatus}, in the spec's order — what the parsers accept. */
export const AGENT_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "budget-limited",
  "usage-limited",
  "complete",
  "failed"
] as const satisfies readonly AgentGoalStatus[];

/** One provider-native goal, normalised. Everything but objective/status is optional. */
export interface AgentGoal {
  objective: string;
  status: AgentGoalStatus;
  /** The provider's own id when it has one (Grok `goal_id`). */
  goalId?: string;
  /** Free-text provider phase: Grok's planning/executing/verifying/idle; Claude "waiting-background". */
  phase?: string;
  /** Evaluation rounds so far: Claude's "not met" checks, Grok's worker rounds. */
  rounds?: number;
  /** Why the last check said "not met" / the last event's detail. */
  lastCheck?: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  /** Active wall-clock time in ms. */
  elapsedMs?: number;
  /** When the goal was set (ISO). */
  setAt?: string;
}

export type AgentGoalChange =
  | "set"
  | "replaced"
  | "restored"
  | "progress"
  | "checked"
  | "paused"
  | "resumed"
  | "blocked"
  | "limited"
  | "achieved"
  | "failed"
  | "cleared";

/** Every {@link AgentGoalChange}, in the spec's order — what the parsers accept. */
export const AGENT_GOAL_CHANGES = [
  "set",
  "replaced",
  "restored",
  "progress",
  "checked",
  "paused",
  "resumed",
  "blocked",
  "limited",
  "achieved",
  "failed",
  "cleared"
] as const satisfies readonly AgentGoalChange[];

/** The folded goal: the last `goal.updated` row wins. */
export interface ThreadGoal extends AgentGoal {
  /** When the row that produced this state was written (ISO). */
  updatedAt: string;
}

/** The activity kind every goal row is written under. */
export const GOAL_ACTIVITY_KIND = "goal.updated";
/** A host `/goal` status answer (Codex) — a visible info row. */
export const GOAL_STATUS_ACTIVITY_KIND = "goal.status";
/** A host `/goal` command that failed — a visible error row. */
export const GOAL_COMMAND_FAILED_ACTIVITY_KIND = "goal.command.failed";

/** Payload of a `goal.updated` activity (and of the runtime event). */
export interface GoalUpdatedPayload {
  /** The whole current goal, or null when the thread has none any more. */
  goal: AgentGoal | null;
  change: AgentGoalChange;
  /** The goal as it ended, on achieved/failed/cleared rows whose `goal` is null. */
  previous?: AgentGoal;
}

// ---------------------------------------------------------------------------
// Parsers (§4.1)
// ---------------------------------------------------------------------------

const GOAL_STATUSES: ReadonlySet<string> = new Set(AGENT_GOAL_STATUSES);
const GOAL_CHANGES: ReadonlySet<string> = new Set(AGENT_GOAL_CHANGES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isGoalStatus(value: unknown): value is AgentGoalStatus {
  return typeof value === "string" && GOAL_STATUSES.has(value);
}

function isGoalChange(value: unknown): value is AgentGoalChange {
  return typeof value === "string" && GOAL_CHANGES.has(value);
}

/**
 * A goal read from anything — a provider-shaped payload, a persisted row, a
 * snapshot — or `null` when it has no usable objective (a non-empty string) or
 * status (one of {@link AGENT_GOAL_STATUSES}). Every optional field is kept
 * only when it is well-formed (strings non-empty, numbers finite and ≥ 0,
 * `tokenBudget` also `null`) and dropped otherwise; unknown keys are dropped.
 * Always a fresh object, fields in declaration order, so parsing a parsed goal
 * gives the same goal. Never throws.
 */
export function parseAgentGoal(value: unknown): AgentGoal | null {
  if (!isRecord(value)) {
    return null;
  }
  const objective = nonEmptyString(value.objective);
  const status = value.status;
  if (objective === undefined || !isGoalStatus(status)) {
    return null;
  }
  const goalId = nonEmptyString(value.goalId);
  const phase = nonEmptyString(value.phase);
  const rounds = count(value.rounds);
  const lastCheck = nonEmptyString(value.lastCheck);
  const tokensUsed = count(value.tokensUsed);
  const tokenBudget = value.tokenBudget === null ? null : count(value.tokenBudget);
  const elapsedMs = count(value.elapsedMs);
  const setAt = nonEmptyString(value.setAt);
  return {
    objective,
    status,
    ...(goalId !== undefined ? { goalId } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
    ...(lastCheck !== undefined ? { lastCheck } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(setAt !== undefined ? { setAt } : {})
  };
}

/**
 * A `goal.updated` payload, or `null` when it is not one: `goal` must be
 * `null` or parse, and `change` must be one of {@link AGENT_GOAL_CHANGES}.
 * `previous` is optional — kept when it parses, dropped when it does not, as
 * any other optional field is. Never throws.
 */
export function parseGoalUpdatedPayload(value: unknown): GoalUpdatedPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const change = value.change;
  if (!isGoalChange(change)) {
    return null;
  }
  const goal = value.goal === null ? null : parseAgentGoal(value.goal);
  if (goal === null && value.goal !== null) {
    return null;
  }
  const previous = parseAgentGoal(value.previous);
  return {
    goal,
    change,
    ...(previous !== null ? { previous } : {})
  };
}

/**
 * The folded goal as a snapshot or `state.json` carries it: a goal that
 * parses plus the string `updatedAt` of the row that produced it — or `null`.
 * Never throws.
 */
export function parseThreadGoal(value: unknown): ThreadGoal | null {
  if (!isRecord(value) || typeof value.updatedAt !== "string") {
    return null;
  }
  const goal = parseAgentGoal(value);
  return goal === null ? null : { ...goal, updatedAt: value.updatedAt };
}

// ---------------------------------------------------------------------------
// The row text (§4.3)
// ---------------------------------------------------------------------------

/**
 * Free text a goal row's summary quotes — the objective, the last check — is
 * cut to this many characters, the last one an ellipsis (§4.3). The payload
 * keeps the whole text; the summary is a row label and must stay one.
 */
export const GOAL_SUMMARY_TEXT_CHARS = 200;

/** Cut to {@link GOAL_SUMMARY_TEXT_CHARS}, never splitting a surrogate pair. */
function clip(text: string): string {
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

/**
 * The summary of a `goal.updated` row (§4.3). It reads the current goal, or —
 * on the achieved/failed/cleared rows whose goal is null — the one that ended;
 * a row naming neither still gets its bare label. The text it quotes is cut to
 * {@link GOAL_SUMMARY_TEXT_CHARS}.
 */
export function goalActivitySummary(payload: GoalUpdatedPayload): string {
  const subject = payload.goal ?? payload.previous ?? null;
  const naming = (label: string, source: AgentGoal | null | undefined): string =>
    source === null || source === undefined ? label : `${label}: ${clip(source.objective)}`;
  const lastCheck = subject?.lastCheck !== undefined ? clip(subject.lastCheck) : undefined;
  switch (payload.change) {
    case "set":
      return naming("Goal set", subject);
    case "replaced":
      return naming("Goal replaced", subject);
    case "restored":
      return naming("Goal restored", subject);
    case "progress":
      return "Goal progress";
    case "checked": {
      const check =
        subject?.rounds !== undefined
          ? `Goal check ${subject.rounds}: not met`
          : "Goal check: not met";
      return lastCheck !== undefined ? `${check} — ${lastCheck}` : check;
    }
    case "paused":
      return "Goal paused";
    case "resumed":
      return "Goal resumed";
    case "blocked":
      return lastCheck !== undefined ? `Goal blocked: ${lastCheck}` : "Goal blocked";
    case "limited":
      // Only a usage limit names itself; a budget is the provider's other
      // limit, and Grok's `budget_exceeded` can arrive before its status does.
      return subject?.status === "usage-limited"
        ? "Goal stopped: usage limit reached"
        : "Goal stopped: token budget reached";
    case "achieved":
      return naming("Goal achieved", subject);
    case "failed":
      return lastCheck !== undefined ? `Goal can't be met: ${lastCheck}` : "Goal can't be met";
    case "cleared":
      return naming("Goal cleared", payload.previous);
    default: {
      const exhaustive: never = payload.change;
      void exhaustive;
      return "Goal updated";
    }
  }
}

// ---------------------------------------------------------------------------
// Predicates (§4.1)
// ---------------------------------------------------------------------------

/** A change the timeline does not show as a row of its own: `progress` only. */
export function isHiddenGoalChange(change: AgentGoalChange): boolean {
  return change === "progress";
}

/**
 * A goal that is still being worked towards. The chip and the tab marker show
 * exactly these. No goal — `null`, or `undefined` from a state that predates
 * the field — is not one.
 */
export function isUnfinishedGoal(goal: AgentGoal | null | undefined): boolean {
  return (
    goal !== null && goal !== undefined && goal.status !== "complete" && goal.status !== "failed"
  );
}

/**
 * Whether two goals are the same STATE — objective, status, rounds, phase and
 * last check — which is what an adapter compares before it emits, so a
 * provider repeating itself produces no row. Counters, ids and times are not
 * state. No goal equals no goal, `null` and `undefined` alike.
 */
export function sameGoalState(
  a: AgentGoal | null | undefined,
  b: AgentGoal | null | undefined
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.rounds === b.rounds &&
    a.phase === b.phase &&
    a.lastCheck === b.lastCheck
  );
}
