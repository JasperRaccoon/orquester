/**
 * A thread's CURRENT interaction mode (default / plan), as every daemon-side turn sender needs it:
 * a turn caused in the thread (a merge back, a scheduled task, a pull request wake) must keep the
 * thread in the mode it is in — the host takes a missing mode as "default", which would flip a
 * planning thread out of plan mode — and a session tool's turn policy must see a caller that plans.
 *
 * The mode is the running turn's (else the latest unsettled one's, else the latest turn's), as the
 * turn recorded it when it started — unless a user message steered that turn since: a steer may
 * switch the live session's mode (Claude's `setPermissionMode` on a running turn), and a message
 * that records its own `interactionMode` (`ThreadMessageItem.interactionMode`) is the latest word.
 */

import type { InteractionMode } from "./adapter-types.ts";
import { SETTLED_TURN_STATES, type ThreadItem, type Turn } from "./thread.ts";

export function currentInteractionMode(snap: {
  head: { session: { activeTurnId: string | null } };
  turns: readonly Turn[];
  items: readonly ThreadItem[];
}): InteractionMode {
  const active = snap.head.session.activeTurnId;
  const turn =
    (active !== null ? snap.turns.find((candidate) => candidate.turnId === active) : undefined) ??
    [...snap.turns].reverse().find((candidate) => !SETTLED_TURN_STATES.has(candidate.state)) ??
    snap.turns.at(-1);
  if (turn === undefined) return "default";
  for (let index = snap.items.length - 1; index >= 0; index -= 1) {
    const item = snap.items[index]!;
    if (item.kind !== "message" || item.role !== "user" || item.turnId !== turn.turnId) continue;
    if (item.interactionMode === "plan" || item.interactionMode === "default") return item.interactionMode;
  }
  return turn.interactionMode === "plan" ? "plan" : "default";
}
