/**
 * Agent chat — whether a tool call is anyone's to show: one rule for every
 * reader of a call's rows.
 *
 * A Claude parent call can start before the synthetic turn its own message
 * opens: what it emits before that turn opens — its start and any early input
 * update — carries no turn and no owner. The turn adopts the call as it opens,
 * with one update on it (the Claude normaliser's `adoptedToolEvent`), so a
 * running call always has a row that names its turn. A rewind of that turn
 * removes that row with the rest, and its completion too (`reduceReverted`
 * keeps turnless rows, and only those): the turnless rows are then all there
 * is of the call, open, and it ran in a turn that no longer exists. So is a
 * woken call no turn ever adopted, its session stopped first.
 *
 * A row of a call ({@link CALL_ROW_KINDS}) ANCHORS it ({@link anchorsCall})
 * when it names a turn, when an agent owns it (a non-blank `agentId` on the
 * row or on its payload, {@link isAgentOwnedActivity}), or when it closes the
 * call. A call no row anchors is shown by no one, and nothing writes one row
 * that would anchor it:
 *
 * - the GUI's timeline shows it no row — its start is not the call's row
 *   (`startIsCallRow`, packages/ui `entries.logic.ts`), and an update still in
 *   progress is a neutral row a group hides;
 * - the MCP's transcript builds it no entry (`anchoredCalls` in
 *   `apps/daemon/src/mcp/transcript.ts`);
 * - a host's first load writes it no closer
 *   (`apps/daemon/src/agent-host/orchestration/leftover-work.ts`): a closer
 *   would anchor it, and the call would come back as a failed row in both
 *   views — after any host start, a deploy's included.
 *
 * Pure, no Node APIs: `@orquester/api` is shared with the browser.
 */

import { isAgentOwnedActivity } from "./compaction.ts";
import { CALL_CLOSER_KINDS, CALL_OPENER_KINDS } from "./open-work.ts";
import type { ThreadActivityItem } from "./thread.ts";

/** The rows of a tool call the rule reads: its lifecycle rows and its streamed output chunks. */
export const CALL_ROW_KINDS: ReadonlySet<string> = new Set([
  ...CALL_OPENER_KINDS,
  ...CALL_CLOSER_KINDS,
  "tool.output"
]);

/** Whether `row`, a row of a tool call, anchors the call: it names a turn, an agent owns it, or it closes the call. */
export function anchorsCall(row: ThreadActivityItem): boolean {
  return Boolean(row.turnId) || isAgentOwnedActivity(row) || CALL_CLOSER_KINDS.has(row.activityKind);
}
