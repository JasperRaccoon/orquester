/**
 * The ONE activity ladder of spec §6.4 — "this ladder, and no per-surface
 * variant of it".
 *
 * Ported from T3 Code (MIT): `packages/shared/src/agentAwareness.ts:76-113`
 * (the ladder and both race fallbacks) and
 * `apps/web/src/components/Sidebar.logic.ts:835-864` (error outranks
 * lingering background liveness; working vs monitoring).
 *
 * `session.activity` keeps its three states (`working` | `waiting` | `idle`),
 * so a surface that wants to say "Monitoring" reads `backgroundLiveness` off
 * the summary rather than inventing a fourth state.
 *
 * The `goal-continuing` rung is Orquester's own (goals §4.7) — T3 has no goal
 * surface — and follows the liveness rungs' rule: work that is still going
 * on is never "finished".
 */

import type {
  AgentChatSessionSummaryFields,
  SessionActivityState,
  SessionAttention
} from "@orquester/api";

/**
 * Which rung the ladder stopped on. Carried beside the three-state result so
 * the push gate can pick its copy ("needs your input" vs "finished") and the
 * status line can label a monitoring thread, without re-deriving anything.
 */
export type ChatActivityRung =
  | "approval"
  | "question"
  | "error"
  | "starting"
  | "running"
  /**
   * Between two turns of a goal the provider drives by itself (goals §4.7):
   * the latest turn settled, and the next one is the provider's to start.
   */
  | "goal-continuing"
  /** A settled turn left an unimplemented plan proposal on the table. */
  | "plan-ready"
  | "background-working"
  | "monitoring"
  | "completed"
  /** Nothing in the summary says anything yet — a brand-new tab. */
  | "unknown";

export interface ChatActivityResolution {
  rung: ChatActivityRung;
  state: SessionActivityState;
  attention: SessionAttention | null;
}

/**
 * Resolve the seven §6.4 fields to one activity. Strict priority, top to
 * bottom:
 *
 * 1. pending approval → `waiting`, attention `needs-input`
 * 2. pending question → `waiting`, attention `needs-input`
 * 3. session `error`, or the latest turn `failed` → `idle` + `finished`
 *    (a failure is settled and needs eyes; it is resolved **before** either
 *    liveness value so it is never hidden behind a stale "working") — except
 *    while the host reports the goal continuing (5a)
 * 4. session `starting` → `working`
 * 5. session or turn `running` → `working`
 * 5a. `goal.continuing` → `working` with **no** finished stamp (goals §4.7):
 *    the provider starts the next turn by itself (a Codex goal), so the
 *    settled turn — and every race fallback below — is a pause between two
 *    turns, not the end of the work. It outranks the plan prompt and
 *    liveness because the thread IS working. The host's word is final: it
 *    reports an errored session's goal as continuing only while a restart's
 *    resume is owed (goals §5.5). It never feeds the drain's background-work
 *    view — a Codex goal survives a drain-restart.
 * 6. an actionable proposed plan on a settled turn → `waiting` +
 *    `needs-input`: the agent is done and the user has a decision to make
 * 7. `backgroundLiveness: "working"` → `working`
 * 8. `backgroundLiveness: "monitoring"` → `idle` with **no** finished stamp —
 *    a settled turn whose subagents or watch loops are still running is not
 *    finished (§3.1)
 * 9. turn `completed` → `idle` + `finished`
 *
 * Plus the two race fallbacks §6.4 calls non-optional:
 * - a turn recorded `interrupted` that carries a `completedAt` is
 *   `idle` + `finished`, because session teardown settles still-running turns
 *   by session status and that write races `turn.completed`;
 * - a live session sitting at `ready` with nothing pending and nothing running
 *   is `idle` + `finished`, because a turn that changed no files leaves no turn
 *   row to read.
 */
/**
 * T3's `isLatestTurnSettled` (`session-logic.ts:195-204`): a turn is settled
 * once it has both a start and a completion stamp, and the session is not
 * running. No turn at all is **not** settled — there is nothing to be done
 * with.
 */
function isLatestTurnSettled(fields: AgentChatSessionSummaryFields): boolean {
  const turn = fields.latestTurn ?? null;
  if (!turn || !turn.startedAt || !turn.completedAt) {
    return false;
  }
  return fields.chatSessionStatus !== "running";
}

/**
 * The §6.4 `plan-ready` rung's predicate.
 *
 * *T3: `Sidebar.logic.ts:1049-1066`* — no pending user input, the latest turn
 * settled, and an actionable (unimplemented) proposed plan.
 *
 * **Differs from T3 in one clause, deliberately:** T3 also requires
 * `interactionMode === "plan"`. The ladder is host-side and `interactionMode`
 * is not on `AgentChatSessionSummaryFields`; it would also be the wrong test
 * here, because `hasActionableProposedPlan` is already "the LATEST plan is
 * unimplemented" (R6-3) and a thread switched out of plan mode after
 * proposing still owes the user that decision.
 */
function isPlanReady(fields: AgentChatSessionSummaryFields): boolean {
  return (
    fields.hasActionableProposedPlan === true &&
    fields.hasPendingUserInput !== true &&
    isLatestTurnSettled(fields)
  );
}

/**
 * The goal rung's predicate (goals §4.7, §5.5): the HOST's `continuing`,
 * taken as it is. The host decides it — an `active` goal on a provider that
 * starts turns by itself, on a live session or one a restart's resume is still
 * owed — and it is what keeps "a goal never masks an error" true: an errored
 * session reads as continuing only while that resume is pending (a goal turn
 * a restart killed, settled as an error), and never otherwise. A refusal
 * re-derived here would raise the very "finished" stamp and push the host
 * withheld.
 */
function isGoalContinuing(fields: AgentChatSessionSummaryFields): boolean {
  return fields.goal?.continuing === true;
}

export function resolveChatActivity(fields: AgentChatSessionSummaryFields): ChatActivityResolution {
  const turn = fields.latestTurn ?? null;
  const session = fields.chatSessionStatus;
  const goalContinues = isGoalContinuing(fields);

  if (fields.hasPendingApprovals) {
    return { rung: "approval", state: "waiting", attention: "needs-input" };
  }
  if (fields.hasPendingUserInput) {
    return { rung: "question", state: "waiting", attention: "needs-input" };
  }
  // A failed turn does not by itself end a continuing goal: continuation is
  // the provider's, at every turn's end — interrupted ones included (Codex
  // fixtures README, observation 20) — so what ends it is the goal's own
  // status. A provider that stops its goal says so in a goal update, which
  // ends `continuing`, and this rung then shows the failure. An errored
  // session likewise, while the host still reports the goal continuing: that
  // is the restart gap of goals §5.5, and the host ends it either way.
  if ((session === "error" || turn?.state === "failed") && !goalContinues) {
    return { rung: "error", state: "idle", attention: "finished" };
  }
  if (session === "starting") {
    return { rung: "starting", state: "working", attention: null };
  }
  if (session === "running" || turn?.state === "running" || turn?.state === "pending") {
    return { rung: "running", state: "working", attention: null };
  }
  if (goalContinues) {
    return { rung: "goal-continuing", state: "working", attention: null };
  }
  // An actionable plan prompt **outranks lingering background work**: it needs
  // the user's decision, while liveness merely reports (T3's own review
  // finding, `Sidebar.logic.ts:1049-1066`). It sits BELOW approval and
  // question — those are the agent blocked on you — and below `starting` /
  // `running`, which `isLatestTurnSettled` excludes anyway.
  if (isPlanReady(fields)) {
    return { rung: "plan-ready", state: "waiting", attention: "needs-input" };
  }
  if (fields.backgroundLiveness === "working") {
    return { rung: "background-working", state: "working", attention: null };
  }
  if (fields.backgroundLiveness === "monitoring") {
    // Deliberately no "finished" stamp: work is still live in the thread.
    return { rung: "monitoring", state: "idle", attention: null };
  }
  if (turn?.state === "completed") {
    return { rung: "completed", state: "idle", attention: "finished" };
  }
  // Race fallback 1 — `interrupted` + a completion timestamp means it finished,
  // whatever the state column says.
  if (turn?.state === "interrupted" && turn.completedAt !== null) {
    return { rung: "completed", state: "idle", attention: "finished" };
  }
  // Race fallback 2 — a live session at `ready`/`idle` with nothing pending and
  // nothing running: the agent finished and is waiting for the next prompt.
  if (session === "ready" || session === "idle") {
    return { rung: "completed", state: "idle", attention: "finished" };
  }
  return { rung: "unknown", state: "idle", attention: null };
}

/**
 * The push type this rung produces, or null when it must not push (§6.4).
 *
 * **A "finished" push is never sent while background liveness is non-null** —
 * that is what rungs 7 and 8 exist for, and both answer null here, so the rule
 * is enforced by the ladder rather than by a second check that could drift.
 * The same holds for a continuing goal (goals §4.7): its rung answers null,
 * and while the host reports it continuing the `error` rung does not fire.
 */
export function pushTypeForRung(rung: ChatActivityRung): ChatPushType | null {
  return pushTypeForRungInternal(rung);
}

/**
 * The push kinds a chat thread produces. `plan-ready` is its own kind rather
 * than a `needs-input` with different copy: "needs your input" reads as a
 * blocked provider waiting on an answer, and a finished turn that left a plan
 * on the table is neither blocked nor finished.
 */
export type ChatPushType = "needs-input" | "finished" | "plan-ready";

/**
 * The push a set of fields produces, with §6.4's hard suppression applied:
 * **never a "finished" push while `backgroundLiveness` is non-null.** The
 * ladder already answers `working`/`idle` on those rungs, but the `error` rung
 * outranks liveness, so without this an errored thread whose watch loop is
 * still running would push "finished" while work is live.
 */
export function pushTypeForFields(fields: AgentChatSessionSummaryFields): ChatPushType | null {
  const type = pushTypeForRungInternal(resolveChatActivity(fields).rung);
  if (type === "finished" && fields.backgroundLiveness != null) {
    return null;
  }
  return type;
}

function pushTypeForRungInternal(rung: ChatActivityRung): ChatPushType | null {
  switch (rung) {
    case "approval":
    case "question":
      return "needs-input";
    case "plan-ready":
      return "plan-ready";
    case "completed":
    case "error":
      return "finished";
    default:
      return null;
  }
}
