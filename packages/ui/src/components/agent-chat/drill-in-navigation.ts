/**
 * When the chat view leaves a drill-in on its own (§7.6). Two rules, pure so
 * they are tested apart from the view that owns the drill-in state.
 *
 * **The auto-return.** An agent that SETTLES while its drill-in is open hands
 * the view back to the thread — the parent is where its result lands. It is
 * judged per agent: only an agent seen at work (`pending`, `running`,
 * `waiting`) in THIS opening of its drill-in, and then settling, returns; an
 * agent opened already finished stays open. It was one "was live" flag for the
 * whole view, so opening a finished agent from a running agent's view read as
 * that agent settling, and the view flashed back to the thread. And it fires
 * only while the reader follows the child's end: a reader who scrolled up is
 * reading, and stays — the header's status chip already says it finished
 * (§7.3: nothing else scrolls a reader away).
 *
 * **A palette search hit.** Only the thread's timeline takes a reveal, and
 * while a child is open it is not mounted: the request waited, and fired
 * minutes later on Back. A reveal that arrives while a drill-in is open closes
 * the drill-in, and the thread's timeline takes it at once.
 */

import type { RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import { ACTIVE_SUBAGENT_STATUSES, TERMINAL_SUBAGENT_STATUSES } from "@orquester/api/agent-chat";

/** What the auto-return watches of the open drill-in. */
export interface DrillInWatch {
  /** The agent this watch describes; null with no drill-in open. */
  readonly agentId: string | null;
  /** That agent was seen at work since its drill-in opened. */
  readonly sawLive: boolean;
}

export const NO_DRILL_IN_WATCH: DrillInWatch = { agentId: null, sawLive: false };

/**
 * The watch after one observation of the open drill-in, and whether the view
 * returns to the thread now. `status` is the agent's roster status (null when
 * the roster no longer has it); `following` is its drill-in's follow flag.
 */
export function nextDrillInReturn(
  watch: DrillInWatch,
  observed: { agentId: string | null; status: RuntimeSubagentStatus | null; following: boolean }
): { watch: DrillInWatch; returnToMain: boolean } {
  const { agentId, status, following } = observed;
  if (agentId === null) {
    return { watch: NO_DRILL_IN_WATCH, returnToMain: false };
  }
  const live = status !== null && ACTIVE_SUBAGENT_STATUSES.has(status);
  if (agentId !== watch.agentId || status === null) {
    // A new opening: an agent opened already finished stays open.
    return { watch: { agentId, sawLive: live }, returnToMain: false };
  }
  if (live) {
    return { watch: watch.sawLive ? watch : { agentId, sawLive: true }, returnToMain: false };
  }
  if (watch.sawLive && TERMINAL_SUBAGENT_STATUSES.has(status)) {
    // Its settle is seen once: a reader who scrolled up keeps the view, and
    // is not handed back later on reaching the end.
    return { watch: { agentId, sawLive: false }, returnToMain: following };
  }
  return { watch, returnToMain: false };
}

/**
 * Whether a reveal closes an open drill-in: a NEW request, never one that was
 * pending when the drill-in opened (`previous` is the nonce last seen), nor
 * the thread acknowledging one.
 */
export function revealClosesDrillIn(previous: number | null, next: number | null): boolean {
  return next !== null && next !== previous;
}
