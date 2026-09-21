/**
 * Agent chat — the turn state machine (spec §5.1, §6.4).
 *
 * **Signatures only (except the two total predicates). Package W2 implements
 * the rest.**
 * Ported from T3 Code (MIT): `apps/server/src/orchestration/projector.ts:101-115`
 * (`settledTurnStateForSessionStatus`) and `:808-868` (the `thread.session-set`
 * fold that drives `latestTurn`).
 */

import type {
  LatestTurnSummary,
  ThreadSessionStatus,
  Turn,
  TurnState
} from "./thread.ts";

/** A turn in one of the four terminal states of `RuntimeTurnState`. */
export function isSettledTurnState(state: TurnState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "interrupted" ||
    state === "cancelled"
  );
}

/**
 * A turn is settled **by session status**, not by `turn.completed` (§5.1):
 * leaving `running` for `idle`/`ready` settles it `completed`, for `stopped`
 * `interrupted`, for `error` `failed`. `starting` and `running` leave it
 * unsettled — that is what keeps a late checkpoint or diff from extending the
 * recorded duration.
 */
export function settledTurnStateForSessionStatus(status: ThreadSessionStatus): TurnState | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "stopped":
      return "interrupted";
    case "error":
      return "failed";
    case "starting":
    case "running":
      return null;
  }
}

/**
 * Advance a turn row on a session transition, applying
 * {@link settledTurnStateForSessionStatus} and stamping `completedAt` exactly
 * once. Returns `turn` unchanged (same reference) when nothing moved.
 */
export function applySessionStatusToTurn(
  turn: Turn,
  status: ThreadSessionStatus,
  at: string
): Turn {
  void turn;
  void status;
  void at;
  throw new Error("agent-chat: applySessionStatusToTurn not implemented (package W2)");
}

/**
 * The compact row every ambient surface reads off `SessionSummary` (§6.4).
 * Returns `null` for a thread with no turns.
 */
export function deriveLatestTurn(turns: readonly Turn[]): LatestTurnSummary | null {
  void turns;
  throw new Error("agent-chat: deriveLatestTurn not implemented (package W2)");
}
