/**
 * Turn order (spec §5.5).
 *
 * A thread's turns are numbered by their POSITION among the turns that
 * actually started — the fold's `turns[]` in order, skipping the rows that
 * never got a provider turn id. That ordinal, not the checkpoint list, is the
 * `turnCount` every rewind speaks in: `targetTurnCount` is the number of turns
 * kept, and a turn's own checkpoint is keyed by its ordinal (§5.4).
 *
 * Both the host (the `/revert` command, the checkpoint numbering) and the
 * client (the "rewind to here" affordance) derive it from here, so the two can
 * never disagree on which turn a number names. The checkpoint list used to be
 * that numbering, and it is sparse exactly where a rewind matters most: a
 * non-git project captures nothing, a failed capture skips a turn, and a
 * thread resumed from the provider's own transcript has no checkpoint for any
 * of its history.
 */

import type { Turn } from "./thread.ts";

/** A turn the provider minted an id for. */
export interface StartedTurn extends Turn {
  turnId: string;
}

/**
 * The turns that got a provider turn id, in start order, one row per id.
 *
 * A duplicate id — a replayed `turn-start-requested` for a turn the fold
 * already holds — counts once, or the ordinal of every later turn would be
 * off by one on both sides.
 */
export function startedTurns(turns: readonly Turn[]): StartedTurn[] {
  const seen = new Set<string>();
  const started: StartedTurn[] = [];
  for (const turn of turns) {
    if (turn.turnId === null || seen.has(turn.turnId)) {
      continue;
    }
    seen.add(turn.turnId);
    started.push(turn as StartedTurn);
  }
  return started;
}

/** 1-based position of `turnId` among the started turns, or null when it is not one. */
export function turnOrdinal(turns: readonly Turn[], turnId: string): number | null {
  const index = startedTurns(turns).findIndex((turn) => turn.turnId === turnId);
  return index === -1 ? null : index + 1;
}
