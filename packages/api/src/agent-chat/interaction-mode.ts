/**
 * A thread's CURRENT interaction mode (default / plan), as every daemon-side turn sender needs it:
 * a turn caused in the thread (a merge back) must keep the thread in the mode it is in — the host
 * takes a missing mode as "default", which would flip a planning thread out of plan mode — and a
 * session tool's turn policy must see a caller that plans.
 *
 * The mode is the running turn's (else the latest unsettled one's, else the latest turn's), as the
 * turn recorded it when it started — unless a user message steered that turn since: a steer may
 * switch the live session's mode (Claude's `setPermissionMode` on a running turn), and a message
 * that records its own `interactionMode` (`ThreadMessageItem.interactionMode`, which the host
 * stamps on every steer) is the latest word. A turn that recorded no mode and was never steered
 * (a provider-started continuation, an older log) reads as the latest earlier turn that did.
 */

import type { InteractionMode } from "./adapter-types.ts";
import { SETTLED_TURN_STATES, type ThreadItem, type Turn } from "./thread.ts";

export function currentInteractionMode(snap: {
  head: { session: { activeTurnId: string | null } };
  turns: readonly Turn[];
  items: readonly ThreadItem[];
}): InteractionMode {
  const turn = runningTurnOf(snap);
  if (turn === undefined) return "default";
  for (let index = snap.items.length - 1; index >= 0; index -= 1) {
    const item = snap.items[index]!;
    if (item.kind !== "message" || item.role !== "user" || item.turnId !== turn.turnId) continue;
    if (item.interactionMode === "plan" || item.interactionMode === "default") return item.interactionMode;
  }
  if (turn.interactionMode === "plan" || turn.interactionMode === "default") return turn.interactionMode;
  // A turn that recorded no mode (a provider-started continuation, an older log): the latest
  // earlier turn that did is the thread's mode.
  for (let index = snap.turns.indexOf(turn) - 1; index >= 0; index -= 1) {
    const earlier = snap.turns[index]!.interactionMode;
    if (earlier === "plan" || earlier === "default") return earlier;
  }
  return "default";
}

/**
 * The thread's running turn as every daemon-side reader picks it: the active turn, else the latest
 * unsettled one, else the latest — the turn {@link currentInteractionMode} reads and whose
 * `causedBy` a session tool's call continues (§8.4). Undefined for a thread with no turn.
 */
export function runningTurnOf(snap: {
  head: { session: { activeTurnId: string | null } };
  turns: readonly Turn[];
}): Turn | undefined {
  const active = snap.head.session.activeTurnId;
  return (
    (active !== null ? snap.turns.find((candidate) => candidate.turnId === active) : undefined) ??
    [...snap.turns].reverse().find((candidate) => !SETTLED_TURN_STATES.has(candidate.state)) ??
    snap.turns.at(-1)
  );
}
