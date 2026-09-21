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
 * Resolve the six §6.4 fields to one activity. Strict priority, top to bottom:
 *
 * 1. pending approval → `waiting`, attention `needs-input`
 * 2. pending question → `waiting`, attention `needs-input`
 * 3. session `error`, or the latest turn `failed` → `idle` + `finished`
 *    (a failure is settled and needs eyes; it is resolved **before** either
 *    liveness value so it is never hidden behind a stale "working")
 * 4. session `starting` → `working`
 * 5. session or turn `running` → `working`
 * 6. `backgroundLiveness: "working"` → `working`
 * 7. `backgroundLiveness: "monitoring"` → `idle` with **no** finished stamp —
 *    a settled turn whose subagents or watch loops are still running is not
 *    finished (§3.1)
 * 8. turn `completed` → `idle` + `finished`
 *
 * Plus the two race fallbacks §6.4 calls non-optional:
 * - a turn recorded `interrupted` that carries a `completedAt` is
 *   `idle` + `finished`, because session teardown settles still-running turns
 *   by session status and that write races `turn.completed`;
 * - a live session sitting at `ready` with nothing pending and nothing running
 *   is `idle` + `finished`, because a turn that changed no files leaves no turn
 *   row to read.
 */
export function resolveChatActivity(fields: AgentChatSessionSummaryFields): ChatActivityResolution {
  const turn = fields.latestTurn ?? null;
  const session = fields.chatSessionStatus;

  if (fields.hasPendingApprovals) {
    return { rung: "approval", state: "waiting", attention: "needs-input" };
  }
  if (fields.hasPendingUserInput) {
    return { rung: "question", state: "waiting", attention: "needs-input" };
  }
  if (session === "error" || turn?.state === "failed") {
    return { rung: "error", state: "idle", attention: "finished" };
  }
  if (session === "starting") {
    return { rung: "starting", state: "working", attention: null };
  }
  if (session === "running" || turn?.state === "running" || turn?.state === "pending") {
    return { rung: "running", state: "working", attention: null };
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
 * that is what rungs 6 and 7 exist for, and both answer null here, so the rule
 * is enforced by the ladder rather than by a second check that could drift.
 */
export function pushTypeForRung(rung: ChatActivityRung): "needs-input" | "finished" | null {
  return pushTypeForRungInternal(rung);
}

/**
 * The push a set of fields produces, with §6.4's hard suppression applied:
 * **never a "finished" push while `backgroundLiveness` is non-null.** The
 * ladder already answers `working`/`idle` on those rungs, but the `error` rung
 * outranks liveness, so without this an errored thread whose watch loop is
 * still running would push "finished" while work is live.
 */
export function pushTypeForFields(
  fields: AgentChatSessionSummaryFields
): "needs-input" | "finished" | null {
  const type = pushTypeForRungInternal(resolveChatActivity(fields).rung);
  if (type === "finished" && fields.backgroundLiveness != null) {
    return null;
  }
  return type;
}

function pushTypeForRungInternal(rung: ChatActivityRung): "needs-input" | "finished" | null {
  switch (rung) {
    case "approval":
    case "question":
      return "needs-input";
    case "completed":
    case "error":
      return "finished";
    default:
      return null;
  }
}
