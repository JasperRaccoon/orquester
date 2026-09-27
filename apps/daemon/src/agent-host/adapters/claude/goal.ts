/**
 * Claude adapter — the CLI's `/goal`, mirrored (goals §3.1, §6.1:
 * `docs/superpowers/specs/2026-09-24-agent-goals-design.md`).
 *
 * `/goal <condition>` registers a session-scoped PROMPT Stop hook inside the
 * CLI, evaluated by a small model at every turn end. The goal is the CLI's;
 * Orquester only mirrors it, from signals scattered over three channels:
 *
 * - the command's own output, a `<synthetic>` assistant frame carrying
 *   `local_command_run: {command: "goal"}` ({@link parseGoalCommandOutput});
 * - a "not met" check, a synthetic main-thread `user` frame
 *   `Stop hook feedback:\n[<condition>]: <reason>`
 *   ({@link matchGoalStopHookFeedback}), and the deferred evaluation's
 *   `Goal check-in: «…` ({@link parseGoalCheckIn});
 * - `active_goal`, which the CLI writes to stdout only under
 *   `CLAUDE_CODE_REMOTE` — never set here — but which is recognised all the
 *   same ({@link parseActiveGoalValue});
 * - and met, impossible, or cleared by an unrecoverable error: NOTHING on
 *   stdout. Only the CLI's own transcript records those, as `attachment` rows
 *   of type `goal_status` ({@link parseGoalStatusRow}; `goal-transcript.ts`
 *   reads them).
 *
 * {@link ClaudeGoalTracker} holds what this session last emitted, seeded from
 * the host's `knownGoal`, and decides what earns a `thread.goal.updated`
 * (goals §6): a real change of state only, and `progress` at most once per
 * 30 s.
 *
 * Pure: no filesystem, no timers. The normaliser feeds it frame by frame, and
 * the session hands it what the transcript said.
 */

import type {
  AgentGoal,
  AgentGoalChange,
  GoalUpdatedPayload
} from "@orquester/api/agent-chat";
import { parseAgentGoal, sameGoalState } from "@orquester/api/agent-chat";

import type { Clock } from "../../adapter.ts";

/** At most one `progress` update per this window, per thread (goals §6). */
export const GOAL_PROGRESS_THROTTLE_MS = 30_000;

/**
 * The phase of a goal whose evaluation the CLI deferred because background
 * work (a subagent, a background shell) was still running at turn end
 * (goals §3.1): it is re-evaluated only once a later turn ends with nothing in
 * the background.
 */
export const GOAL_WAITING_BACKGROUND_PHASE = "waiting-background";

/** `local_command_run.command` on the `/goal` command's own output frame. */
export const GOAL_COMMAND_NAME = "goal";

/** How a "not met" check starts — the CLI's `Stop` + ` hook feedback:\n`. */
export const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:\n";

/** How a deferred evaluation's check-in starts. */
export const GOAL_CHECK_IN_PREFIX = "Goal check-in: «";

/**
 * Where the CLI cuts the condition quoted in a Stop-hook feedback once the
 * conversation already holds it whole: 500 UTF-16 units (one fewer when that
 * would split a surrogate pair), then `… [+<n> chars]`.
 */
export const STOP_HOOK_CONDITION_CUT = 500;

// ---------------------------------------------------------------------------
// The /goal command's output (goals §6.1.2)
// ---------------------------------------------------------------------------

/** What one `/goal` output says. `other`: a refusal or anything else — no goal change. */
export type ClaudeGoalCommandOutput =
  | { kind: "set"; objective: string }
  | { kind: "cleared"; objective: string }
  | { kind: "none" }
  | { kind: "active"; objective: string; rounds: number; lastCheck?: string }
  | { kind: "other" };

const GOAL_SET_PREFIX = "Goal set: ";
const GOAL_CLEARED_PREFIX = "Goal cleared: ";
const GOAL_ACTIVE_PREFIX = "Goal active: ";
const NO_GOAL_SET = "No goal set";
/** `(not yet evaluated)` or `(<n> turn[s])`, then an optional `\nLast check: <reason>`. */
const GOAL_ACTIVE_SUFFIX_RE = /^\((?:not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]*))?$/;

/**
 * Read the text the CLI prints for `/goal` (Claude Code 2.1.280):
 *
 * - `Goal set: <cond>` — a set, and a replace prints exactly the same;
 * - `Goal cleared: <cond>` / `No goal set` — `/goal clear` (or `stop`, `off`,
 *   `reset`, `none`, `cancel`, any case);
 * - `No goal set. Usage: …` / `Goal active: <cond> (not yet evaluated|<n>
 *   turn[s])[\nLast check: <reason>]` — a bare `/goal`;
 * - the two refusals (`Goal condition is limited to 4000 characters (got
 *   <n>)`, `/goal can't run while hooks are restricted …`) and anything else —
 *   `other`.
 *
 * `trackedObjective` anchors the `Goal active:` parse, because a condition may
 * itself contain `(…)`.
 */
export function parseGoalCommandOutput(
  text: string,
  trackedObjective?: string
): ClaudeGoalCommandOutput {
  const body = text.trim();
  if (body.startsWith(GOAL_SET_PREFIX)) {
    const objective = body.slice(GOAL_SET_PREFIX.length).trim();
    return objective.length > 0 ? { kind: "set", objective } : { kind: "other" };
  }
  if (body.startsWith(GOAL_CLEARED_PREFIX)) {
    const objective = body.slice(GOAL_CLEARED_PREFIX.length).trim();
    return objective.length > 0 ? { kind: "cleared", objective } : { kind: "none" };
  }
  if (body === NO_GOAL_SET || body.startsWith(`${NO_GOAL_SET}.`)) {
    return { kind: "none" };
  }
  if (body.startsWith(GOAL_ACTIVE_PREFIX)) {
    return parseGoalActive(body.slice(GOAL_ACTIVE_PREFIX.length), trackedObjective) ?? {
      kind: "other"
    };
  }
  return { kind: "other" };
}

function parseGoalActive(
  rest: string,
  trackedObjective: string | undefined
): ClaudeGoalCommandOutput | undefined {
  if (trackedObjective !== undefined && rest.startsWith(`${trackedObjective} `)) {
    const suffix = parseGoalActiveSuffix(rest.slice(trackedObjective.length + 1));
    if (suffix !== undefined) {
      return { kind: "active", objective: trackedObjective, ...suffix };
    }
  }
  // Otherwise the FIRST ` (` whose remainder is a whole status suffix: a
  // condition's own parentheses are followed by more condition, never by the
  // end of the text or a `Last check:` line.
  for (let at = rest.indexOf(" ("); at > 0; at = rest.indexOf(" (", at + 1)) {
    const suffix = parseGoalActiveSuffix(rest.slice(at + 1));
    if (suffix !== undefined) {
      return { kind: "active", objective: rest.slice(0, at), ...suffix };
    }
  }
  return undefined;
}

function parseGoalActiveSuffix(
  suffix: string
): { rounds: number; lastCheck?: string } | undefined {
  const match = GOAL_ACTIVE_SUFFIX_RE.exec(suffix);
  if (match === null) {
    return undefined;
  }
  const rounds = match[1] !== undefined ? Number.parseInt(match[1], 10) : 0;
  const lastCheck = match[2]?.trim();
  return {
    rounds: Number.isFinite(rounds) ? rounds : 0,
    ...(lastCheck !== undefined && lastCheck.length > 0 ? { lastCheck } : {})
  };
}

const LOCAL_COMMAND_OUTPUT_RE = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;

/**
 * A local command's printed text: the text blocks of the frame's content, or
 * — when those are empty — `local_command_source` without its
 * `<local-command-stdout>` tags (goals §6.1.2).
 */
export function localCommandOutputText(content: unknown, source: unknown): string | undefined {
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""
      )
      .join("")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  if (typeof source !== "string") {
    return undefined;
  }
  const text = source.replace(LOCAL_COMMAND_OUTPUT_RE, (_whole, _stream, inner: string) => inner).trim();
  return text.length > 0 ? text : undefined;
}

// ---------------------------------------------------------------------------
// Stop-hook feedback and the check-in (goals §6.1.3)
// ---------------------------------------------------------------------------

/** `…`, optionally `… [+<n> chars]` — how the CLI marks a cut condition. */
const CUT_MARKER_RE = /(?:…|\.\.\.)(?:\s*\[\+\d+ chars?\])?$/;

/**
 * The evaluator's reason, when `text` is a `Stop hook feedback:\n[<cond>]:
 * <reason>` frame whose condition is `objective`: equal, or cut by the CLI
 * ({@link STOP_HOOK_CONDITION_CUT}) to a prefix of it. `undefined` for any
 * other hook's feedback and for any other text.
 *
 * The condition is user text and may contain `]: ` itself, so every
 * candidate end is tried against the objective rather than the first one
 * taken on trust.
 */
export function matchGoalStopHookFeedback(
  text: string,
  objective: string
): { reason: string } | undefined {
  const opening = `${STOP_HOOK_FEEDBACK_PREFIX}[`;
  if (!text.startsWith(opening) || objective.length === 0) {
    return undefined;
  }
  const rest = text.slice(opening.length);
  for (let at = rest.indexOf("]: "); at >= 0; at = rest.indexOf("]: ", at + 1)) {
    if (quotesCondition(rest.slice(0, at), objective)) {
      return { reason: rest.slice(at + 3).trim() };
    }
  }
  return undefined;
}

function quotesCondition(quoted: string, objective: string): boolean {
  if (quoted === objective) {
    return true;
  }
  const cut = quoted.replace(CUT_MARKER_RE, "");
  if (cut !== quoted) {
    return cut.length > 0 && cut.length < objective.length && objective.startsWith(cut);
  }
  // A cut without its marker (an older spelling) is only ever the cut length.
  return (
    quoted.length >= STOP_HOOK_CONDITION_CUT - 1 &&
    quoted.length < objective.length &&
    objective.startsWith(quoted)
  );
}

/** The turn-end deferral's own words — the only check-in that means background work. */
const CHECK_IN_BACKGROUND_RUNNING = "because background work is still running";

/**
 * A `Goal check-in: «<cond>» is still active…` frame, the CLI nudging its
 * model about a goal it has not evaluated. Only the deferral check-in —
 * "… because background work is still running:" — means background work;
 * the idle one ("that work is no longer running") and the re-prompt after a
 * turn an API error cut short ("The last turn ended before the goal could be
 * evaluated: …") mean the opposite, so anything else reads as not waiting.
 */
export function parseGoalCheckIn(text: string): { backgroundRunning: boolean } | undefined {
  if (!text.startsWith(GOAL_CHECK_IN_PREFIX)) {
    return undefined;
  }
  return { backgroundRunning: text.includes(CHECK_IN_BACKGROUND_RUNNING) };
}

// ---------------------------------------------------------------------------
// active_goal (goals §6.1.6)
// ---------------------------------------------------------------------------

/** The last instant a `Date` can hold (ECMA-262 §21.4.1.22, TimeClip). */
const MAX_DATE_MS = 8.64e15;

/** An `active_goal` frame's `value`, read field-wise. */
export interface ClaudeActiveGoal {
  condition: string;
  iterations: number;
  /** `set_at` (epoch ms) as ISO. */
  setAt?: string;
  lastReason?: string;
}

/**
 * `null` when the frame says the goal is gone (its `value` is `null`, or
 * absent — the CLI's internal `undefined`); `undefined` for a value that is
 * not a goal at all, which is ignored rather than guessed at.
 */
export function parseActiveGoalValue(value: unknown): ClaudeActiveGoal | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const condition = record.condition;
  const iterations = record.iterations;
  if (
    typeof condition !== "string" ||
    condition.length === 0 ||
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < 0
  ) {
    return undefined;
  }
  const setAtMs = record.set_at;
  // Past ±8.64e15 ms a Date is invalid and `toISOString()` THROWS: a
  // malformed stamp is dropped, never allowed to take the frame down with it.
  const setAt =
    typeof setAtMs === "number" &&
    Number.isFinite(setAtMs) &&
    setAtMs > 0 &&
    setAtMs <= MAX_DATE_MS
      ? new Date(setAtMs).toISOString()
      : undefined;
  const lastReason =
    typeof record.last_reason === "string" && record.last_reason.trim().length > 0
      ? record.last_reason.trim()
      : undefined;
  return {
    condition,
    iterations,
    ...(setAt !== undefined ? { setAt } : {}),
    ...(lastReason !== undefined ? { lastReason } : {})
  };
}

// ---------------------------------------------------------------------------
// The transcript's goal_status rows (goals §3.1, §6.1.4-5)
// ---------------------------------------------------------------------------

/**
 * One `{type: "attachment", attachment: {type: "goal_status", …}}` row. The
 * CLI writes one for every goal event, stdout or not:
 *
 * | row | written by |
 * |---|---|
 * | `{met: false, sentinel: true, condition}` | a set, and a compaction that keeps the goal |
 * | `{met: false, condition, reason}` | a "not met" check (also on stdout, as Stop-hook feedback) |
 * | `{met: true, condition, reason, iterations, durationMs, tokens}` | met — transcript only |
 * | `{met: false, failed: true, condition, reason, iterations, durationMs, tokens}` | judged impossible — transcript only |
 * | `{met: true, sentinel: true, condition}` | `/goal clear`, and a clear by an unrecoverable error — the latter transcript only |
 */
export interface ClaudeGoalStatusRow {
  met: boolean;
  sentinel: boolean;
  failed: boolean;
  /** `""` when the row names none; the restore rule reads that as no goal. */
  condition: string;
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A transcript row as a {@link ClaudeGoalStatusRow}, or `undefined` for every other row. */
export function parseGoalStatusRow(value: unknown): ClaudeGoalStatusRow | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as { type?: unknown; attachment?: unknown };
  if (row.type !== "attachment" || row.attachment === null || typeof row.attachment !== "object") {
    return undefined;
  }
  const attachment = row.attachment as Record<string, unknown>;
  if (attachment.type !== "goal_status") {
    return undefined;
  }
  const reason =
    typeof attachment.reason === "string" && attachment.reason.trim().length > 0
      ? attachment.reason.trim()
      : undefined;
  const iterations = count(attachment.iterations);
  const durationMs = count(attachment.durationMs);
  const tokens = count(attachment.tokens);
  return {
    met: attachment.met === true,
    sentinel: attachment.sentinel === true,
    failed: attachment.failed === true,
    condition: typeof attachment.condition === "string" ? attachment.condition : "",
    ...(reason !== undefined ? { reason } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokens !== undefined ? { tokens } : {})
  };
}

/** What a resumed CLI makes of its transcript's goal (goals §6.1.5). */
export type ClaudeTranscriptGoal =
  /** No `goal_status` row that names a goal: nothing is re-armed. */
  | { kind: "none" }
  /** The last row ended the goal — met, impossible, or cleared (`met` sentinel). */
  | { kind: "ended"; row: ClaudeGoalStatusRow }
  /** The last row left it running: the CLI re-arms it, `iterations: 0`. */
  | { kind: "active"; objective: string };

/**
 * `restoreGoalFromTranscript`'s rule, which `--resume` runs: the LAST
 * `goal_status` row decides — met or failed means no goal, anything else
 * re-arms its condition (Claude Code 2.1.280, `cAt`).
 */
export function transcriptGoalFromLastRow(
  row: ClaudeGoalStatusRow | undefined
): ClaudeTranscriptGoal {
  if (row === undefined) {
    return { kind: "none" };
  }
  if (row.met || row.failed) {
    return { kind: "ended", row };
  }
  return row.condition.length > 0 ? { kind: "active", objective: row.condition } : { kind: "none" };
}

/**
 * What a `goal_status` row that ends a goal means: met, judged impossible, or
 * a `met` sentinel — a clear (by `/goal clear`, or by an unrecoverable error,
 * the transcript-only path). `undefined` for a row that ends nothing.
 */
export function goalEndingOf(
  row: ClaudeGoalStatusRow
): Extract<AgentGoalChange, "achieved" | "failed" | "cleared"> | undefined {
  if (row.failed) {
    return "failed";
  }
  if (row.met) {
    return row.sentinel ? "cleared" : "achieved";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Revising a goal
// ---------------------------------------------------------------------------

/**
 * `goal` with some fields replaced: `undefined` keeps a field, `null` (or an
 * empty string) drops it. Always a fresh object.
 */
export function reviseGoal(
  goal: AgentGoal,
  patch: {
    status?: AgentGoal["status"];
    rounds?: number;
    lastCheck?: string | null;
    phase?: string | null;
  }
): AgentGoal {
  const { lastCheck, phase, ...rest } = goal;
  const nextLastCheck = patch.lastCheck === undefined ? lastCheck : patch.lastCheck || undefined;
  const nextPhase = patch.phase === undefined ? phase : patch.phase || undefined;
  return {
    ...rest,
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.rounds !== undefined ? { rounds: patch.rounds } : {}),
    ...(nextLastCheck !== undefined ? { lastCheck: nextLastCheck } : {}),
    ...(nextPhase !== undefined ? { phase: nextPhase } : {})
  };
}

/**
 * The goal as it ended — the `previous` of an `achieved`, `failed` or
 * `cleared` update (goals §4.1, §6.1.4). A phase means nothing once the goal
 * is over. Met and impossible take the CLI's own totals from the row
 * (`iterations` → rounds, `durationMs` → elapsed, `tokens`), and the
 * evaluator's verdict becomes the last check.
 */
export function endedGoal(
  goal: AgentGoal,
  ending: Extract<AgentGoalChange, "achieved" | "failed" | "cleared">,
  row?: ClaudeGoalStatusRow
): AgentGoal {
  if (ending === "cleared" || row === undefined) {
    return reviseGoal(goal, { phase: null });
  }
  const ended = reviseGoal(goal, {
    status: ending === "achieved" ? "complete" : "failed",
    phase: null,
    // A met goal's last word is the evaluator's "met", never an older "not met".
    lastCheck: row.reason ?? (ending === "achieved" ? null : undefined),
    ...(row.iterations !== undefined ? { rounds: row.iterations } : {})
  });
  return {
    ...ended,
    ...(row.tokens !== undefined ? { tokensUsed: row.tokens } : {}),
    ...(row.durationMs !== undefined ? { elapsedMs: row.durationMs } : {})
  };
}

// ---------------------------------------------------------------------------
// The tracker (goals §6)
// ---------------------------------------------------------------------------

/** What {@link ClaudeGoalTracker.apply} decided. */
export type ClaudeGoalDecision =
  | { kind: "emit"; payload: GoalUpdatedPayload }
  /** A throttled `progress`, due for {@link ClaudeGoalTracker.flushProgress} at `dueAtMs`. */
  | { kind: "deferred"; dueAtMs: number }
  | { kind: "unchanged" };

export interface ClaudeGoalTrackerOptions {
  clock: Clock;
  /** The fold's goal when the session starts (goals §5.3). */
  knownGoal?: AgentGoal | null;
  throttleMs?: number;
}

/**
 * The goal of one Claude session, twice over: {@link goal} is the latest the
 * provider has said — what every next change is computed from — and
 * {@link lastEmitted} is the last one sent to the host, i.e. what the fold
 * holds. They differ only while a throttled `progress` is pending.
 */
export class ClaudeGoalTracker {
  private readonly clock: Clock;
  private readonly throttleMs: number;
  private current: AgentGoal | null;
  private emitted: AgentGoal | null;
  private lastProgressAtMs: number | undefined;
  private progressDueAtMs: number | undefined;

  constructor(options: ClaudeGoalTrackerOptions) {
    this.clock = options.clock;
    this.throttleMs = options.throttleMs ?? GOAL_PROGRESS_THROTTLE_MS;
    // Through the parser: the fold's goal carries an `updatedAt` that is not
    // provider state, and nothing from another process reaches typed code raw.
    const known = parseAgentGoal(options.knownGoal ?? null);
    this.current = known;
    this.emitted = known;
  }

  get goal(): AgentGoal | null {
    return this.current;
  }

  get lastEmitted(): AgentGoal | null {
    return this.emitted;
  }

  /** When the deferred `progress` is due, if one is. */
  get pendingProgressDueAtMs(): number | undefined {
    return this.progressDueAtMs;
  }

  /**
   * Record what the provider just said and decide whether it is news:
   * `achieved`, `failed` and `cleared` always are; anything else only when
   * {@link sameGoalState} says the state moved; and a `progress` at most once
   * per throttle window — a later one is kept and flushed when due, never
   * dropped. A status or objective change is never throttled, and neither is
   * an `immediate` one: a session that is going away has no timer left to
   * flush it with.
   */
  apply(
    change: AgentGoalChange,
    next: AgentGoal | null,
    previous?: AgentGoal,
    options?: { immediate?: boolean }
  ): ClaudeGoalDecision {
    this.current = next;
    const terminal = change === "achieved" || change === "failed" || change === "cleared";
    if (!terminal && sameGoalState(this.emitted, next)) {
      this.progressDueAtMs = undefined;
      return { kind: "unchanged" };
    }
    if (change === "progress" && options?.immediate !== true && this.lastProgressAtMs !== undefined) {
      const dueAtMs = this.lastProgressAtMs + this.throttleMs;
      if (this.clock.now().getTime() < dueAtMs) {
        this.progressDueAtMs = dueAtMs;
        return { kind: "deferred", dueAtMs };
      }
    }
    return this.commit(change, next, previous);
  }

  /** Emit the deferred `progress`, if the state still differs from what was sent. */
  flushProgress(): ClaudeGoalDecision {
    if (this.progressDueAtMs === undefined) {
      return { kind: "unchanged" };
    }
    this.progressDueAtMs = undefined;
    if (sameGoalState(this.emitted, this.current)) {
      return { kind: "unchanged" };
    }
    return this.commit("progress", this.current);
  }

  private commit(
    change: AgentGoalChange,
    next: AgentGoal | null,
    previous?: AgentGoal
  ): ClaudeGoalDecision {
    this.emitted = next;
    this.progressDueAtMs = undefined;
    if (change === "progress") {
      this.lastProgressAtMs = this.clock.now().getTime();
    }
    return {
      kind: "emit",
      payload: { goal: next, change, ...(previous !== undefined ? { previous } : {}) }
    };
  }
}
