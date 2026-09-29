/**
 * A tool call is visible only if a row names a turn, has an agent owner, or
 * closes the call. Legacy logs can retain unanchored start/update rows after
 * a rewind or session stop; showing or closing those would resurrect work
 * from a removed turn.
 *
 * Shared by the GUI timeline, MCP transcript, and host orphan reconciliation.
 * Reconciliation must not add a closer to an unanchored call: that closer
 * would make the call visible again.
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

/**
 * Whether `row`, a row of a tool call, anchors the call: it names a turn, an
 * agent owns it, or it closes the call.
 */
export function anchorsCall(row: ThreadActivityItem): boolean {
  return Boolean(row.turnId) || isAgentOwnedActivity(row) || CALL_CLOSER_KINDS.has(row.activityKind);
}
