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

export function resolveChatActivity(fields: AgentChatSessionSummaryFields): ChatActivityResolution {
  const turn = fields.latestTurn ?? null;
  const session = fields.chatSessionStatus;
  // Trust the host's continuation flag, including a goal awaiting resume after a restart.
  const goalContinues = fields.goal?.continuing === true;

  if (fields.hasPendingApprovals) {
    return { rung: "approval", state: "waiting", attention: "needs-input" };
  }
  if (fields.hasPendingUserInput) {
    return { rung: "question", state: "waiting", attention: "needs-input" };
  }
  // A failed turn does not by itself end a continuing goal: continuation is
  // the provider's, at every turn's end — interrupted ones included (Codex
  // fixtures README, observation 23) — so what ends it is the goal's own
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
  // A settled plan needs a decision even after switching out of plan mode,
  // and outranks lingering background work. Pending input and running turns
  // have already returned above (T3: Sidebar.logic.ts:1049-1066).
  if (fields.hasActionableProposedPlan === true && turn?.startedAt && turn.completedAt) {
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
  switch (resolveChatActivity(fields).rung) {
    case "approval":
    case "question":
      return "needs-input";
    case "plan-ready":
      return "plan-ready";
    case "completed":
    case "error":
      return fields.backgroundLiveness != null ? null : "finished";
    default:
      return null;
  }
}
