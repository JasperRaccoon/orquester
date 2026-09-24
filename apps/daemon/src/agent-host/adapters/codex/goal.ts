/**
 * Codex adapter — the provider's goal (goals §3.2, §6, §6.2:
 * `docs/superpowers/specs/2026-09-24-agent-goals-design.md`).
 *
 * Codex owns its goal outright: `thread/goal/*` reads and writes it, the
 * app-server starts the continuation turns itself, and
 * `thread/goal/updated` / `thread/goal/cleared` report every move — after each
 * set, on the model's `create_goal` / `update_goal`, on progress flushes and at
 * turn stop, and once as a snapshot after every `thread/resume`. This module
 * mirrors it:
 *
 * - {@link agentGoalFromCodex} normalises a `ThreadGoal` field-wise;
 * - {@link CodexGoalTracker} keeps, per session, the goal as the provider last
 *   described it and the goal the thread was last told, names every change
 *   (goals §6.2.1), throttles `progress` (goals §6), weighs the resume
 *   snapshot against the fold's goal and decides a carry (goals §6.2.2), and
 *   discards a response a later notification overtook (goals §6.2.5);
 * - {@link codexGoalStatusSummary} is the host `/goal` status text (goals
 *   §6.2.3).
 *
 * Pure over its own state and an injected clock, like the normaliser, so a
 * test drives it without a child. Nothing here is ported: T3 Code has no goal
 * surface.
 */

import {
  GOAL_SUMMARY_TEXT_CHARS,
  isUnfinishedGoal,
  parseAgentGoal,
  sameGoalState,
  type AgentGoal,
  type AgentGoalChange,
  type AgentGoalStatus,
  type GoalUpdatedPayload
} from "@orquester/api/agent-chat";

import type { CodexProtocol } from "./_generated/index.ts";

// ---------------------------------------------------------------------------
// Windows (goals §6, §6.2.3, §6.2.4)
// ---------------------------------------------------------------------------

/** At most one counters-only `progress` row per thread in this window (goals §6). */
export const CODEX_GOAL_PROGRESS_INTERVAL_MS = 30_000;

/**
 * ONE deadline for a whole `/goal` command (goals §6.2.3) — its settle wait
 * and every request it makes share it, so a replace (`get`, `clear`, `set`)
 * against a wedged goal store is refused at 10 s, not 30. The same bound as
 * `AGENT_HOST_DEADLINES.submitMs`, the host's other "one call to the
 * provider" window; kept local because `support/deadline.ts` holds the
 * host-wide ones. A carry is bounded by it too.
 */
export const CODEX_GOAL_COMMAND_MS = 10_000;

/**
 * How long a `/goal` command waits, inside its own deadline, for this home's
 * goal to settle — a resume snapshot still on its way, a carry still landing
 * — before it runs anyway. Both normally take milliseconds.
 */
export const CODEX_GOAL_SETTLE_MS = 2_000;

/**
 * The `/goal` answer when there is no goal (goals §6.2.3): `status`, `clear`,
 * `pause` and `resume` alike — never an error row quoting the provider.
 */
export const NO_GOAL_SUMMARY = "No goal is set.";

/**
 * The `/goal resume` answer for a goal that reached its token budget. Codex
 * would keep it `budgetLimited` without a word — a set to `active` at or over
 * the budget lands `budgetLimited` again (fixtures README observation 19) — so
 * nothing is sent.
 */
export const GOAL_BUDGET_REACHED_SUMMARY =
  "This goal reached its token budget and can't be resumed. Set a new goal or clear it.";

/**
 * The `/goal pause` answer for a goal that already stopped at its budget:
 * Codex keeps a budget-limited goal budget-limited, and the unchanged update
 * is no row, so the command would otherwise say nothing at all.
 */
export const GOAL_AT_BUDGET_SUMMARY = "This goal already stopped at its token budget.";

/**
 * The `/goal edit` answer when there is no goal to edit. A bare `set
 * {objective}` would CREATE an active goal instead (fix round 1, ruling 1).
 */
export const NO_GOAL_TO_EDIT_SUMMARY = "No goal is set. Use /goal <objective> to set one.";

// ---------------------------------------------------------------------------
// Mapping (goals §6.2.1)
// ---------------------------------------------------------------------------

/** A Codex `ThreadGoalStatus` in the normalised spelling, or `null` for one this build does not know. */
export function agentGoalStatusFromCodex(status: unknown): AgentGoalStatus | null {
  if (typeof status !== "string") {
    return null;
  }
  const codex = status as CodexProtocol.v2.ThreadGoalStatus;
  switch (codex) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage-limited";
    case "budgetLimited":
      return "budget-limited";
    case "complete":
      return "complete";
    default:
      // A protocol release that adds a status is a type error here; at runtime
      // an unknown one is unreadable, which the caller surfaces.
      codex satisfies never;
      return null;
  }
}

/**
 * A `ThreadGoal` off the wire as an {@link AgentGoal}, or `null` when it has
 * no usable objective or status. `timeUsedSeconds` becomes `elapsedMs` and the
 * unix-seconds `createdAt` becomes the ISO `setAt`; `threadId` and `updatedAt`
 * are the provider's bookkeeping and dropped. Field-wise: a malformed counter
 * is left out rather than failing the goal (`parseAgentGoal`). Never throws.
 */
export function agentGoalFromCodex(value: unknown): AgentGoal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = agentGoalStatusFromCodex(record.status);
  if (status === null) {
    return null;
  }
  const seconds = count(record.timeUsedSeconds);
  const setAt = isoFromUnixSeconds(record.createdAt);
  return parseAgentGoal({
    objective: record.objective,
    status,
    tokensUsed: record.tokensUsed,
    tokenBudget: record.tokenBudget,
    ...(seconds !== undefined ? { elapsedMs: seconds * 1_000 } : {}),
    ...(setAt !== undefined ? { setAt } : {})
  });
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  const seconds = count(value);
  if (seconds === undefined || seconds === 0) {
    return undefined;
  }
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ---------------------------------------------------------------------------
// Naming a change (goals §6.2.1)
// ---------------------------------------------------------------------------

/**
 * The change the goal `next` makes to `previous` (goals §6.2.1), before the
 * throttle and the resume rules; a clear is the tracker's, since it has no
 * goal to name. The same goal in the same status is `progress` — whether that
 * is news is the tracker's call too.
 *
 * `replaced` is an objective edited in place; a NEW goal row after a finished
 * one — `create_goal` rewrites a complete goal with a fresh creation time — is
 * `set`, as it is after a clear, and only one replacing an unfinished goal
 * without a clear is `replaced` (the Claude and Grok rules, goals §6.1, §6.3).
 * Any move to `active` is `resumed`.
 */
function codexGoalChange(previous: AgentGoal | null, next: AgentGoal): AgentGoalChange {
  if (previous === null) {
    return "set";
  }
  if (!sameGoalRow(previous, next)) {
    return isUnfinishedGoal(previous) ? "replaced" : "set";
  }
  if (next.objective !== previous.objective) {
    return "replaced";
  }
  if (next.status === previous.status) {
    return "progress";
  }
  switch (next.status) {
    case "active":
      return "resumed";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "budget-limited":
    case "usage-limited":
      return "limited";
    case "complete":
      return "achieved";
    case "failed":
      // Not a Codex status; kept so the switch stays exhaustive.
      return "failed";
    default:
      next.status satisfies never;
      return "progress";
  }
}

/**
 * The same goal ROW: Codex keeps the creation time through an objective edit
 * and a status change, and stamps a new one on a goal it creates. A goal whose
 * time is unknown is given the benefit of the doubt.
 */
function sameGoalRow(a: AgentGoal, b: AgentGoal): boolean {
  return a.setAt === undefined || b.setAt === undefined || a.setAt === b.setAt;
}

/** Every field equal — counters included. What a `progress` row is compared on. */
function sameGoalSnapshot(a: AgentGoal, b: AgentGoal): boolean {
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.goalId === b.goalId &&
    a.phase === b.phase &&
    a.rounds === b.rounds &&
    a.lastCheck === b.lastCheck &&
    a.tokensUsed === b.tokensUsed &&
    a.tokenBudget === b.tokenBudget &&
    a.elapsedMs === b.elapsedMs &&
    a.setAt === b.setAt
  );
}

// ---------------------------------------------------------------------------
// The tracker (goals §6, §6.2)
// ---------------------------------------------------------------------------

export interface CodexGoalTrackerOptions {
  /**
   * The goal the host's fold holds (goals §4.6 `knownGoal`): what the thread
   * already shows, so only a real change becomes a row. `undefined` reads as
   * no goal.
   */
  known?: AgentGoal | null;
  /**
   * This session replaces one for an account switch (goals §4.6 `carryGoal`):
   * an unfinished goal the new account's home does not know is re-created
   * rather than reported cleared (goals §6.2.2).
   */
  carry?: boolean;
  /** Milliseconds, for the throttle. */
  now?: () => number;
  progressIntervalMs?: number;
}

/**
 * One session's view of its thread's goal (goals §6).
 *
 * Two goals are kept apart on purpose: the provider's latest word, which the
 * next change is named against and a `cleared` row's `previous` quotes, and
 * the goal the thread was last TOLD, which decides whether a counters-only
 * update is news. A `progress` update the throttle holds back still moves the
 * first, so a repeat of it after the window reaches the thread.
 */
export class CodexGoalTracker {
  private goal: AgentGoal | null;
  private told: AgentGoal | null;
  private lastRowAt: number | null = null;
  private notifications = 0;
  private snapshotPending = false;
  private carryRequest: AgentGoal | null = null;
  /** A carry is in flight: the goal it re-creates is `restored`, never `set`. */
  private carrying = false;
  private readonly carry: boolean;
  private readonly now: () => number;
  private readonly progressIntervalMs: number;

  constructor(options: CodexGoalTrackerOptions = {}) {
    // Field-wise, like everything else the tracker holds: the fold's
    // `ThreadGoal` carries its own `updatedAt`, which §5.3 strips — and a
    // row's `previous` must never quote it back if a caller did not.
    const known =
      options.known === undefined || options.known === null ? null : parseAgentGoal(options.known);
    this.goal = known;
    this.told = known;
    this.carry = options.carry === true;
    this.now = options.now ?? Date.now;
    this.progressIntervalMs = options.progressIntervalMs ?? CODEX_GOAL_PROGRESS_INTERVAL_MS;
  }

  /** The goal as the provider last described it — before anything did, the fold's. */
  get current(): AgentGoal | null {
    return this.goal;
  }

  /**
   * How many goal notifications this session has observed. A request captures
   * it when sent; its response is stale once it moved (goals §6.2.5).
   */
  get notificationCount(): number {
    return this.notifications;
  }

  /**
   * A reply to a request sent at `sentAt` is stale when a notification was
   * observed since (goals §6.2.5) — or when the resume snapshot has not been
   * read yet: until it has, a reply describes a home the snapshot has not
   * been weighed against, and on an account switch a `get` answered before it
   * would clear the very goal the carry is about to re-create.
   */
  isStale(sentAt: number): boolean {
    return this.snapshotPending || sentAt !== this.notifications;
  }

  /**
   * Nothing is pending: no resume snapshot is expected and no carry is
   * requested or in flight. A `/goal` command waits for this (bounded), so it
   * never acts on a home whose goal is still being settled.
   */
  get settled(): boolean {
    return !this.snapshotPending && this.carryRequest === null && !this.carrying;
  }

  /**
   * The next goal notification is the snapshot `thread/resume` sends — an
   * `updated` when the thread has a goal, a `cleared` when it has none
   * (fixture 07). Set BEFORE the request: the snapshot can be read off the
   * wire before the resume's own reply is.
   */
  expectResumeSnapshot(): void {
    this.snapshotPending = true;
  }

  /**
   * No snapshot is coming after all: the resume failed, or a turn started —
   * the server sends the snapshot before its idle continuation can begin.
   */
  cancelResumeSnapshot(): void {
    this.snapshotPending = false;
  }

  /** A `thread/goal/updated` (the mapped goal) or `thread/goal/cleared` (`null`). */
  notified(next: AgentGoal | null): GoalUpdatedPayload | null {
    this.notifications += 1;
    if (this.snapshotPending) {
      this.snapshotPending = false;
      return this.snapshot(next);
    }
    return this.observe(next);
  }

  /**
   * A goal notification this build could not read — a status it does not
   * know. The provider still spoke: an earlier reply is stale, and a snapshot
   * it was is over. The goal itself stays as it was; the normaliser surfaces
   * the frame.
   */
  unreadable(): void {
    this.notifications += 1;
    this.snapshotPending = false;
  }

  /**
   * The goal a response to one of our requests carries. Discarded when it is
   * {@link isStale}: a notification observed since is at least as new, and
   * re-emitting the response would put an older state back (#8615's stale
   * re-emit, goals §6.2.5).
   */
  responded(next: AgentGoal | null, sentAt: number): GoalUpdatedPayload | null {
    if (this.isStale(sentAt)) {
      return null;
    }
    return this.observe(next);
  }

  /** `thread/start` opened a new thread, which has no goal of its own. */
  freshThread(): GoalUpdatedPayload | null {
    this.snapshotPending = false;
    return this.snapshot(null);
  }

  /** The goal the session must re-create for an account switch, once. */
  takeCarry(): AgentGoal | null {
    const goal = this.carryRequest;
    this.carryRequest = null;
    return goal;
  }

  /** The re-create failed: the provider has no goal, so the fold's is cleared. */
  carryFailed(): GoalUpdatedPayload | null {
    this.carrying = false;
    return this.observe(null);
  }

  /**
   * Goals §6.2.2, against the fold's goal: the same state is no news (moved
   * counters are `progress`), a different one is `restored`, none at all
   * clears an unfinished goal — or, on an account switch, re-creates it.
   */
  private snapshot(next: AgentGoal | null): GoalUpdatedPayload | null {
    const known = this.goal;
    if (next === null) {
      if (known === null || !isUnfinishedGoal(known)) {
        // A finished goal the provider no longer keeps changes nothing anyone
        // sees: the chip only ever shows an unfinished goal.
        this.goal = null;
        return null;
      }
      if (this.carry) {
        this.carryRequest = known;
        this.carrying = true;
        return null;
      }
      return this.observe(null);
    }
    this.goal = next;
    if (sameGoalState(known, next)) {
      return this.progress(next);
    }
    return this.row({ goal: next, change: "restored" });
  }

  private observe(next: AgentGoal | null): GoalUpdatedPayload | null {
    const previous = this.goal;
    this.goal = next;
    if (this.carrying) {
      this.carrying = false;
      if (next !== null) {
        return this.row({ goal: next, change: "restored" });
      }
    }
    if (next === null) {
      // `cleared` only when there was something to clear (goals §6.2.1).
      return previous === null ? null : this.row({ goal: null, change: "cleared", previous });
    }
    const change = codexGoalChange(previous, next);
    return change === "progress" ? this.progress(next) : this.row({ goal: next, change });
  }

  /** Goals §6: a counters-only update is a row only when it is news and the window has passed. */
  private progress(next: AgentGoal): GoalUpdatedPayload | null {
    if (this.told !== null && sameGoalSnapshot(this.told, next)) {
      return null;
    }
    if (this.lastRowAt !== null && this.now() - this.lastRowAt < this.progressIntervalMs) {
      return null;
    }
    return this.row({ goal: next, change: "progress" });
  }

  private row(payload: GoalUpdatedPayload): GoalUpdatedPayload {
    this.told = payload.goal;
    this.lastRowAt = this.now();
    return payload;
  }
}

// ---------------------------------------------------------------------------
// The carry (goals §6.2.2)
// ---------------------------------------------------------------------------

/**
 * The `thread/goal/set` that re-creates the fold's goal on a new account's
 * home: active only when it was active, paused otherwise — a blocked or
 * limited goal must not start running on its own — with the budget it had.
 * An unknown budget is left to the provider's default.
 */
export function codexGoalCarry(goal: AgentGoal): {
  objective: string;
  status: "active" | "paused";
  tokenBudget?: number | null;
} {
  return {
    objective: goal.objective,
    status: goal.status === "active" ? "active" : "paused",
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {})
  };
}

// ---------------------------------------------------------------------------
// The `/goal` status text (goals §6.2.3)
// ---------------------------------------------------------------------------

/**
 * `No goal is set.`, or `Goal <status>: <objective> — <tokens> tokens,
 * <time>` with the budget beside the tokens when there is one; a part the
 * provider did not report is left out. The objective is cut like a goal row's.
 */
export function codexGoalStatusSummary(goal: AgentGoal | null): string {
  if (goal === null) {
    return NO_GOAL_SUMMARY;
  }
  const parts: string[] = [];
  if (goal.tokensUsed !== undefined) {
    const used = groupDigits(goal.tokensUsed);
    parts.push(
      typeof goal.tokenBudget === "number"
        ? `${used}/${groupDigits(goal.tokenBudget)} tokens`
        : `${used} tokens`
    );
  }
  if (goal.elapsedMs !== undefined) {
    parts.push(formatGoalElapsed(goal.elapsedMs));
  }
  const head = `Goal ${goal.status}: ${clip(goal.objective)}`;
  return parts.length > 0 ? `${head} — ${parts.join(", ")}` : head;
}

/**
 * Codex's own compact duration (`format_goal_elapsed_seconds` in the TUI's
 * `goal_display.rs`): `59s`, `30m`, `1h 30m`, `2h`, `2d 23h 42m`.
 */
export function formatGoalElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d ${hours % 24}h ${remainingMinutes}m`;
  }
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/** `12345` → `12,345`, without depending on the host's ICU data. */
function groupDigits(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * At most {@link GOAL_SUMMARY_TEXT_CHARS}, the last an ellipsis, never
 * splitting a surrogate pair — the same cut a goal row's summary makes.
 */
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
