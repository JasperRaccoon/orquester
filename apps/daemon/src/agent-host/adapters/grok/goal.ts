/**
 * Grok adapter — the provider's goal, mirrored (goals §3.3, §6.3:
 * `docs/superpowers/specs/2026-09-24-agent-goals-design.md`).
 *
 * `/goal <objective>` is forwarded to the CLI, which runs the WHOLE goal inside
 * one `session/prompt` turn — a planner, worker rounds, one to three "goal
 * achievement skeptic" verifiers — and reports it on the private channel as
 * `goal_updated`: the goal's entire state, on every change and again whenever
 * its counters move, sometimes twice byte for byte (fixtures README
 * observation 36). This module turns that stream into `thread.goal.updated`
 * payloads: one per real change, `progress` throttled, replayed history held
 * back and compared once, after the load.
 *
 * Every read of a frame is field-wise with a fallback: a malformed field is
 * dropped, a malformed frame is a debug line — never a throw and never a
 * `runtime.warning` (goals §7 item 3).
 *
 * Nothing here is ported: T3 Code has no goal surface.
 */

import {
  isUnfinishedGoal,
  parseAgentGoal,
  sameGoalState,
  type AgentGoal,
  type AgentGoalChange,
  type AgentGoalStatus,
  type GoalUpdatedPayload
} from "@orquester/api/agent-chat";

/** At most one `progress` update per thread in this window (goals §6). */
export const GROK_GOAL_PROGRESS_THROTTLE_MS = 30_000;

/**
 * `lastCheck` for a `not_achieved` verdict (goals §6.3 item 2). On the `checked`
 * row a NEW verdict produces it is the whole last check — plus ` (attempt <n>
 * of <max>)` when the frame names both counts — and never `last_event_detail`,
 * which on a verdict frame is still the worker's own summary of its round.
 */
export const GROK_GOAL_NOT_ACHIEVED_CHECK = "Verification: not achieved";

/**
 * Grok's goal status → the goal status set (goals §6.3 item 2). Observed:
 * `active` and `complete`; the binary also names `user_paused`,
 * `back_off_paused`, `no_progress_paused`, `infra_paused`, `blocked` and
 * `budget_limited`. `undefined` for anything else: the caller keeps the status
 * it already tracks rather than guess one.
 */
export function grokGoalStatus(status: unknown): AgentGoalStatus | undefined {
  if (typeof status !== "string") {
    return undefined;
  }
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "complete";
    case "paused":
    case "interrupted":
      return "paused";
    case "blocked":
      return "blocked";
    case "budget_limited":
      return "budget-limited";
    case "failed":
      return "failed";
    default:
      // The four `*_paused` statuses the binary names, and any later one.
      return status.endsWith("_paused") ? "paused" : undefined;
  }
}

/**
 * The change a `last_event` names when it is NEW (goals §6.3 item 3).
 * `goal_cleared` is not here: it is a level, handled on its own. Every other
 * event — `planning_*`, `worker_*`, `context_rotated`, anything later — is
 * `progress` unless the status moved.
 */
const EVENT_CHANGES: ReadonlyMap<string, AgentGoalChange> = new Map<string, AgentGoalChange>([
  ["goal_created", "set"],
  ["goal_paused", "paused"],
  ["goal_resumed", "resumed"],
  ["goal_completed", "achieved"],
  ["budget_exceeded", "limited"],
  ["premature_stop_detected", "checked"]
]);

/**
 * The change a status move names when no new event does. The spec's event
 * list has none for `blocked` or `failed`, and a status change is never a
 * hidden `progress` row.
 */
function statusChange(to: AgentGoalStatus): AgentGoalChange {
  switch (to) {
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
      return "failed";
    default: {
      const exhaustive: never = to;
      void exhaustive;
      return "progress";
    }
  }
}

// ---------------------------------------------------------------------------
// Reading a frame
// ---------------------------------------------------------------------------

/** One `goal_updated` body, read field by field. Absent = missing or malformed. */
interface GoalFrame {
  readonly goalId?: string;
  readonly objective?: string;
  /** Verbatim, for the debug line an unknown status earns. */
  readonly status: unknown;
  readonly phase?: string;
  readonly rounds?: number;
  readonly event?: string;
  readonly eventAt?: string;
  readonly detail?: string;
  readonly verdict?: string;
  /** The verifier run's own report file: the identity of the run that gave the verdict. */
  readonly verdictPath?: string;
  readonly verdictRuns?: number;
  readonly verdictMaxRuns?: number;
  /** A verification is running: the verdict on the frame is the PREVIOUS one. */
  readonly verifying: boolean;
  readonly tokensUsed?: number;
  readonly tokenBudget?: number | null;
  readonly elapsedMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A string with something in it, kept verbatim. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readGoalFrame(update: unknown): GoalFrame | null {
  if (!isRecord(update) || update["sessionUpdate"] !== "goal_updated") {
    return null;
  }
  return {
    goalId: text(update["goal_id"]),
    objective: text(update["objective"]),
    status: update["status"],
    phase: text(update["phase"]),
    rounds: count(update["total_worker_rounds"]),
    event: text(update["last_event"]),
    eventAt: text(update["last_event_timestamp"]),
    detail: text(update["last_event_detail"]),
    verdict: text(update["last_classifier_verdict"]),
    verdictPath: text(update["last_classifier_details_path"]),
    verdictRuns: count(update["classifier_runs_attempted"]),
    verdictMaxRuns: count(update["classifier_max_runs"]),
    verifying: update["verifying_completion"] === true,
    tokensUsed: count(update["tokens_used"]),
    tokenBudget: update["token_budget"] === null ? null : count(update["token_budget"]),
    elapsedMs: count(update["elapsed_ms"])
  };
}

/** `last_event_timestamp` carries nanoseconds; an ISO string holds milliseconds. */
function isoOf(value: string | undefined): string | undefined {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** One goal, or the goal a frame describes: Grok's `goal_id`, else the objective. */
function sameGoal(
  a: { goalId?: string; objective?: string },
  b: { goalId?: string; objective?: string }
): boolean {
  return a.goalId !== undefined && b.goalId !== undefined
    ? a.goalId === b.goalId
    : a.objective !== undefined && a.objective === b.objective;
}

/** What a verifier's `not_achieved` says, with its attempt when both counts are known. */
function verificationCheck(frame: GoalFrame): string {
  return frame.verdictRuns !== undefined && frame.verdictMaxRuns !== undefined
    ? `${GROK_GOAL_NOT_ACHIEVED_CHECK} (attempt ${frame.verdictRuns} of ${frame.verdictMaxRuns})`
    : GROK_GOAL_NOT_ACHIEVED_CHECK;
}

/**
 * The goal a frame describes (goals §6.3 item 2), or `null` without a usable
 * objective and status. `same` is the goal already tracked when it IS this
 * one: its status stands in for a status this adapter does not know, and it
 * carries what the frames do not repeat — the set time, a budget. `lastCheck`
 * is decided by the caller, which knows whether a verification's verdict
 * still stands.
 */
function goalOf(frame: GoalFrame, same: AgentGoal | null, lastCheck: string | undefined): AgentGoal | null {
  return parseAgentGoal({
    objective: frame.objective ?? same?.objective,
    status: grokGoalStatus(frame.status) ?? same?.status,
    goalId: frame.goalId,
    phase: frame.phase,
    rounds: frame.rounds,
    lastCheck,
    tokensUsed: frame.tokensUsed,
    tokenBudget: frame.tokenBudget !== undefined ? frame.tokenBudget : same?.tokenBudget,
    elapsedMs: frame.elapsedMs,
    // The frames carry no `created_at`; the creating event's time is it.
    setAt: (frame.event === "goal_created" ? isoOf(frame.eventAt) : undefined) ?? same?.setAt
  });
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

export interface GrokGoalTrackerOptions {
  /** The goal the thread shows (`StartSessionInput.knownGoal`); absent/`null`: none. */
  readonly knownGoal?: AgentGoal | null;
  now(): number;
  debug?(message: string, detail?: unknown): void;
}

/** What one frame means, before deciding whether it is news. */
interface Step {
  /** The provider's goal after the frame; `null` once it is cleared. */
  readonly goal: AgentGoal | null;
  readonly change: AgentGoalChange;
  /** On `cleared`: the goal as it ended. */
  readonly previous?: AgentGoal;
}

/**
 * One session's view of its goal (goals §6): the goal the thread SHOWS —
 * seeded from `knownGoal`, then every update emitted — and the provider's own
 * latest state, which a throttled `progress` or a replay can put ahead of it.
 *
 * Every USABLE frame, live or replayed, moves the frame memory — the last
 * event, the last verdict, the check that verdict made — because that memory
 * describes the provider's stream, not what was shown: after a load, the
 * first live frame repeating the replayed state is not news. A frame this
 * tracker cannot use moves none of it, so the valid frame after it is read as
 * if the dropped one had never arrived. Only the byte-for-byte memory sees
 * every frame: it exists to drop the repeat.
 *
 * No timers, deliberately. A throttled `progress` is not recorded as shown,
 * so it goes out with the next frame that still differs from what is shown —
 * the CLI re-sends the goal whenever its counters move — or, when the session
 * ends first, as the next session's {@link reconcile}.
 */
export class GrokGoalTracker {
  private readonly options: GrokGoalTrackerOptions;
  private shown: AgentGoal | null;
  /**
   * The provider's goal as its rows say: `null` once a row cleared it,
   * `undefined` while no goal row has been seen in this session at all —
   * which means "none" for a fresh session and nothing for a load
   * ({@link reconcile}).
   */
  private provider: AgentGoal | null | undefined;
  private lastFrame: string | undefined;
  private lastEvent: string | undefined;
  private lastVerdict: string | undefined;
  /**
   * The check a new `not_achieved` verdict made, while that verdict is still
   * the latest word — the same event, the same verdict. Its text stays the
   * `lastCheck` of the frames that repeat the verdict: they still carry the
   * worker's summary in `last_event_detail`, and reading that would turn every
   * repeat into a `progress` row undoing the check.
   */
  private check: StandingCheck | undefined;
  private lastProgressAt: number | undefined;
  private reconciled = false;

  constructor(options: GrokGoalTrackerOptions) {
    this.options = options;
    // Parsed rather than trusted: this goal can be re-emitted as a `cleared`
    // row's `previous`, which must carry exactly the goal fields (goals §4.1)
    // and never, say, a `ThreadGoal`'s `updatedAt`.
    this.shown = parseAgentGoal(options.knownGoal);
  }

  /** A LIVE `goal_updated` body: the update to emit, or `null` when it is no news. */
  live(update: unknown): GoalUpdatedPayload | null {
    const frame = this.read(update);
    if (frame === null) {
      return null;
    }
    const step = this.step(frame, this.shown);
    if (step === null) {
      return null;
    }
    this.provider = step.goal;
    return this.decide(step);
  }

  /**
   * A REPLAYED body (`session/load`, goals §6.3 item 4): the past. It moves the
   * provider's state and the frame memory and is never emitted — as it
   * arrives, the thread would take history for news.
   */
  replayed(update: unknown): void {
    const frame = this.read(update);
    if (frame === null) {
      return;
    }
    const step = this.step(frame, this.provider ?? null);
    if (step !== null) {
      this.provider = step.goal;
    }
  }

  /**
   * Once, when the session is up (goals §6.3 item 4): the provider's goal as
   * its rows left it, against the goal the thread shows. `opened` says how
   * the session began, and it decides what NO goal row means:
   * - a FRESH session (`"new"`) has no goal by definition, so the provider's
   *   goal is none — as the Claude adapter treats a cursor-less new session;
   * - a LOAD (`"load"`) speaks only on evidence: a replay without goal rows
   *   proves nothing (ruling: 1.0.34 persisting `goal_updated` is unverified
   *   live, and a false `cleared` would hide a paused or blocked goal after
   *   every restart), so that is no update; the provider's next goal frame
   *   corrects the thread.
   * Then, at most one update:
   * - the provider has none — fresh, or its last row cleared the goal — and
   *   the thread shows one unfinished ⇒ `cleared`;
   * - the thread shows a goal running and the provider's last goal ENDED:
   *   the same goal ⇒ `achieved`/`failed` (the rule goals §6.1 item 5 gives
   *   Claude); another goal ⇒ the one shown is gone, `cleared`, and nothing is
   *   said of the other, which the thread never showed running;
   * - a finished goal while the thread shows nothing running ⇒ nothing;
   * - the same goal, objective and status, only its progress moved ⇒
   *   `progress`;
   * - anything else unfinished ⇒ `restored`;
   * - nothing either side, or the same state ⇒ nothing.
   */
  reconcile(opened: "new" | "load"): GoalUpdatedPayload | null {
    if (this.reconciled) {
      return null;
    }
    this.reconciled = true;
    if (this.provider === undefined && opened === "load") {
      return null;
    }
    const provider = this.provider ?? null;
    const shown = this.shown;
    const showsRunning = shown !== null && isUnfinishedGoal(shown);
    if (provider === null) {
      return shown !== null && showsRunning
        ? this.emit({ goal: null, change: "cleared", previous: shown })
        : null;
    }
    if (!isUnfinishedGoal(provider)) {
      if (shown === null || !showsRunning) {
        return null;
      }
      return sameGoal(shown, provider)
        ? this.emit({ goal: provider, change: provider.status === "failed" ? "failed" : "achieved" })
        : this.emit({ goal: null, change: "cleared", previous: shown });
    }
    if (
      shown !== null &&
      sameGoal(shown, provider) &&
      shown.objective === provider.objective &&
      shown.status === provider.status
    ) {
      if (sameGoalState(shown, provider)) {
        return null;
      }
      this.lastProgressAt = this.options.now();
      return this.emit({ goal: provider, change: "progress" });
    }
    return this.emit({ goal: provider, change: "restored" });
  }

  // ------------------------------------------------------------- internals

  /** Read a body, dropping a byte-identical repeat (goals §6.3 item 1). */
  private read(update: unknown): GoalFrame | null {
    const frame = readGoalFrame(update);
    if (frame === null) {
      this.options.debug?.("grok: goal_updated without an update object; dropped");
      return null;
    }
    const key = JSON.stringify(update);
    if (key === this.lastFrame) {
      return null;
    }
    this.lastFrame = key;
    return frame;
  }

  /**
   * What a frame means against `reference` — the goal the thread shows (live)
   * or the provider's replayed state (replay). A frame that yields no usable
   * goal changes no memory (see the class comment).
   */
  private step(frame: GoalFrame, reference: AgentGoal | null): Step | null {
    const eventKey = eventKeyOf(frame);
    const verdictKey = verdictKeyOf(frame);
    const newEvent = eventKey !== undefined && eventKey !== this.lastEvent;
    // While `verifying_completion` is set the frame still carries the PREVIOUS
    // verdict — the next verification is running — so it is not read then
    // (observation 36): reading it would make every new round a second check.
    const freshVerdict =
      !frame.verifying && frame.verdict === "not_achieved" && verdictKey !== this.lastVerdict;
    const same = reference !== null && sameGoal(reference, frame) ? reference : null;

    if (frame.event === "goal_cleared") {
      // A level, not an edge: the provider has no goal until the next one is
      // created, however often it repeats the frame.
      const ended = goalOf(frame, same, frame.detail) ?? reference;
      this.remember(frame, eventKey, verdictKey, undefined);
      return { goal: null, change: "cleared", ...(ended === null ? {} : { previous: ended }) };
    }

    const check: StandingCheck | undefined =
      freshVerdict && verdictKey !== undefined
        ? { event: eventKey, verdict: verdictKey, text: verificationCheck(frame) }
        : this.check !== undefined && this.check.event === eventKey && this.check.verdict === verdictKey
          ? this.check
          : undefined;
    // The ruling on check rows: the verdict's own text while it stands, the
    // worker's `last_event_detail` otherwise (progress, blocked, …).
    const lastCheck =
      check?.text ??
      frame.detail ??
      (frame.verdict === "not_achieved" ? GROK_GOAL_NOT_ACHIEVED_CHECK : undefined);
    const goal = goalOf(frame, same, lastCheck);
    if (grokGoalStatus(frame.status) === undefined) {
      this.options.debug?.("grok: unknown goal status; keeping the tracked one", {
        status: frame.status,
        kept: same?.status ?? null
      });
    }
    if (goal === null) {
      this.options.debug?.("grok: goal_updated without a usable objective and status; dropped", {
        goalId: frame.goalId ?? null,
        event: frame.event ?? null
      });
      return null;
    }
    this.remember(frame, eventKey, verdictKey, check);

    const named = newEvent && frame.event !== undefined ? EVENT_CHANGES.get(frame.event) : undefined;
    let change: AgentGoalChange;
    if (same !== null && goal.objective !== same.objective) {
      // A new objective under the same `goal_id` is a new goal to the user,
      // whatever event it rides — resumed, paused, completed — and never a
      // hidden, throttled `progress` row. Checked before the event is named.
      change = "replaced";
    } else if (named === "set") {
      change = reference !== null && same === null && isUnfinishedGoal(reference) ? "replaced" : "set";
    } else if (named !== undefined) {
      change = named;
    } else if (same === null) {
      // A goal the thread does not show, met mid-flight: its creation was
      // before this session's first frame.
      change = "restored";
    } else if (freshVerdict) {
      change = "checked";
    } else if (goal.status !== same.status) {
      change = statusChange(goal.status);
    } else {
      change = "progress";
    }
    return { goal, change };
  }

  /** Whether a live step is news, and the payload when it is. */
  private decide(step: Step): GoalUpdatedPayload | null {
    if (step.change === "cleared") {
      // Nothing shown, nothing to clear.
      return this.shown === null
        ? null
        : this.emit({
            goal: null,
            change: "cleared",
            ...(step.previous === undefined ? {} : { previous: step.previous })
          });
    }
    if (step.change === "restored" && !isUnfinishedGoal(step.goal)) {
      // A finished goal the thread never showed running is not news — the
      // rule `reconcile` applies to a load. The CLI re-sends a completed
      // goal's frame, counters moved, during later turns of the session.
      return null;
    }
    if (step.change === "progress") {
      if (sameGoalState(this.shown, step.goal)) {
        return null;
      }
      // Throttled, not coalesced, and no timer: the dropped update is not
      // shown, so the next frame that still differs delivers it once the
      // window has passed — or the next session's `reconcile` does. A status
      // or objective change is never `progress`.
      const now = this.options.now();
      if (this.lastProgressAt !== undefined && now - this.lastProgressAt < GROK_GOAL_PROGRESS_THROTTLE_MS) {
        return null;
      }
      this.lastProgressAt = now;
    }
    // Every other change is an edge — a new event, a new verdict, a status,
    // objective or goal that moved — so it cannot repeat, and it is emitted
    // even when the state it carries equals the one shown.
    return this.emit({ goal: step.goal, change: step.change });
  }

  private emit(payload: GoalUpdatedPayload): GoalUpdatedPayload {
    this.shown = payload.goal;
    return payload;
  }

  /** Record a usable frame in the frame memory. */
  private remember(
    frame: GoalFrame,
    eventKey: string | undefined,
    verdictKey: string | undefined,
    check: StandingCheck | undefined
  ): void {
    if (eventKey !== undefined) {
      this.lastEvent = eventKey;
    }
    if (!frame.verifying && verdictKey !== undefined) {
      this.lastVerdict = verdictKey;
    }
    this.check = check;
  }
}

/** A verification's `not_achieved`, standing until its event or verdict moves on. */
interface StandingCheck {
  readonly event: string | undefined;
  readonly verdict: string;
  readonly text: string;
}

/** Which goal a frame's memory belongs to: Grok's `goal_id`, else the objective. */
function goalKeyOf(frame: GoalFrame): string {
  return frame.goalId ?? frame.objective ?? "";
}

/**
 * The frame's `last_event`, as an event: the name AND its timestamp, because
 * the name is sticky — repeated on every frame until the next event.
 */
function eventKeyOf(frame: GoalFrame): string | undefined {
  return frame.event === undefined
    ? undefined
    : [goalKeyOf(frame), frame.event, frame.eventAt ?? ""].join("\u0000");
}

/**
 * The frame's verdict, as one verifier run's verdict. The run is named by its
 * report file (`last_classifier_details_path`, `…/goal-classifier-<id>-<n>.md`),
 * never by `classifier_runs_attempted`, which moves when the NEXT run starts.
 */
function verdictKeyOf(frame: GoalFrame): string | undefined {
  return frame.verdict === undefined
    ? undefined
    : [goalKeyOf(frame), frame.verdict, frame.verdictPath ?? ""].join("\u0000");
}

// ---------------------------------------------------------------------------
// The replayed goal user message (goals §6.3 item 5)
// ---------------------------------------------------------------------------

const REMINDER_CLOSE = "</system-reminder>";
/** The message LEADS with the block, and the block's first line sets the goal. */
const GOAL_BLOCK_START = /^<system-reminder>\s*A goal has been set:/;
/** The sentence Grok's goal block continues with: what ends the objective. */
const GOAL_BLOCK_NEXT = "\n\nYou are working directly on this goal";

/**
 * The `/goal <objective>` a replayed goal-set block stands for, or
 * `undefined` for any other text.
 *
 * Grok replays the goal's user message as a ~6 KB `<system-reminder>` block —
 * `A goal has been set: <objective>`, then the goal workflow's standing
 * instructions — never the `/goal …` the user typed. Only a message that
 * LEADS with such a block, whose first line sets the goal, is one: another
 * reminder that quotes the phrase is left alone.
 *
 * The objective runs to the block's own next sentence, so one with blank
 * lines in it survives; without that sentence, to whichever comes first — a
 * blank line or the end of the block. Text after the block is the user's, and
 * stays beneath the `/goal` line.
 */
export function goalCommandFromReminder(message: string): string | undefined {
  const text = message.trimStart();
  const start = GOAL_BLOCK_START.exec(text);
  if (start === null) {
    return undefined;
  }
  const bodyStart = start[0].length;
  const close = text.indexOf(REMINDER_CLOSE, bodyStart);
  const body = text.slice(bodyStart, close >= 0 ? close : text.length);
  const next = body.indexOf(GOAL_BLOCK_NEXT);
  const blank = body.indexOf("\n\n");
  const objective = body.slice(0, next >= 0 ? next : blank >= 0 ? blank : body.length).trim();
  const command = objective.length > 0 ? `/goal ${objective}` : "/goal";
  const after = close >= 0 ? text.slice(close + REMINDER_CLOSE.length).trim() : "";
  return after.length > 0 ? `${command}\n\n${after}` : command;
}
