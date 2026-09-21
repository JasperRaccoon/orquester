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
 *
 * Only an UNSETTLED turn moves. A settled turn is final: a late checkpoint,
 * diff or session bounce must never extend its recorded duration (§5.1).
 */
export function applySessionStatusToTurn(
  turn: Turn,
  status: ThreadSessionStatus,
  at: string
): Turn {
  if (isSettledTurnState(turn.state)) {
    return turn;
  }
  const settled = settledTurnStateForSessionStatus(status);
  if (settled === null) {
    return turn;
  }
  return {
    ...turn,
    state: settled,
    // The session leaving "running" is the authoritative turn end; a running
    // turn's `completedAt` can only hold a mid-turn placeholder-checkpoint
    // timestamp, so it is overwritten rather than preserved.
    completedAt: at
  };
}

/**
 * The compact row every ambient surface reads off `SessionSummary` (§6.4).
 * Returns `null` for a thread with no turns.
 *
 * "Latest" is positional, not chronological: the fold appends turns in the
 * order they were requested, and the last row is the one the composer, the
 * tab strip and the Attention Center all talk about.
 */
export function deriveLatestTurn(turns: readonly Turn[]): LatestTurnSummary | null {
  const turn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  if (!turn) {
    return null;
  }
  return {
    turnId: turn.turnId,
    state: turn.state,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt
  };
}
