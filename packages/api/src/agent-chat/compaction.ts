/**
 * The conversation's compaction marker (spec §7.3, §5.5) — one rule for every
 * reader.
 *
 * The provider holds nothing from before the LAST settled compaction of the
 * conversation, so "rewind to here" stops there: a rewind across it is one
 * the adapter can only refuse. Three readers ask where that marker is — the
 * UI's window gate (`rows.logic.ts` `buildRevertTurnCountByUserMessageId`),
 * the MCP's `revert_session` and the host's thread index, whose `markers`
 * rows a history page's `rewindable` reads — and they used to disagree: the
 * MCP missed a subagent named on the payload, and the index missed the legacy
 * spelling and counted a subagent's own compaction. This is the one answer. A
 * row is the conversation's settled compaction marker when
 *
 * - it is a compaction marker at all ({@link isCompactionActivity}): a
 *   `context-compaction` activity, or the legacy `thread.state.changed
 *   {state: "compacted"}` an older log recorded instead;
 * - it is settled ({@link compactionMarkerState} is `compacted`): a
 *   compaction still running, or one that failed, dropped nothing;
 * - it is the conversation's own ({@link isAgentOwnedActivity} is false): a
 *   subagent compacting its context leaves the parent's untouched, and its
 *   row never reaches the parent timeline (§7.2).
 *
 * The host's index stores rows derived by this rule, so changing it means
 * bumping `INDEX_SCHEMA_VERSION` (`apps/daemon/src/agent-host/index/schema.ts`)
 * with it: an index file written by the old rule is otherwise trusted.
 */

import type { ThreadActivityItem, ThreadItem } from "./thread.ts";

/**
 * The three states a compaction marker comes in (mirrors
 * `RuntimeThreadState`'s compaction arm).
 *
 * `compacting` is a **phase, not an event**: it says the provider is rewriting
 * the conversation right now, so it renders as the live placeholder's label
 * rather than as a divider claiming a compaction that has not happened yet.
 */
export type CompactionMarkerState = "compacting" | "compacted" | "compaction-failed";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** A compaction marker, in any phase and of any owner: both spellings. */
export function isCompactionActivity(activity: ThreadActivityItem): boolean {
  if (activity.activityKind === "context-compaction") {
    return true;
  }
  return (
    activity.activityKind === "thread.state.changed" &&
    asRecord(activity.payload)?.state === "compacted"
  );
}

/**
 * Which of the three markers this activity is (§7.3).
 *
 * **Anything unreadable is `compacted`.** An old log only ever recorded the
 * settled marker — a `context-compaction` activity with no `state`, or the
 * legacy `thread.state.changed` one — and reading an unknown spelling as an
 * in-flight phase would leave a resumed thread shimmering "Compacting
 * context…" against a provider that finished months ago.
 */
export function compactionMarkerState(activity: ThreadActivityItem): CompactionMarkerState {
  const state = asRecord(activity.payload)?.state;
  return state === "compacting" || state === "compaction-failed" ? state : "compacted";
}

/**
 * A row a subagent owns: a non-blank `agentId` on the row or on its payload.
 * The ownership half of the UI's quiet-timeline rule (`isAgentInternalActivity`,
 * §7.2) — such a row renders only in its agent's drill-in, never in the parent
 * timeline.
 */
export function isAgentOwnedActivity(activity: ThreadActivityItem): boolean {
  return (
    isNonBlankString(activity.agentId) || isNonBlankString(asRecord(activity.payload)?.agentId)
  );
}

/**
 * A compaction marker of the conversation itself, in any phase — the markers
 * the parent timeline shows. The thread index keeps one `markers` row for each,
 * its kind {@link compactionMarkerState}.
 */
export function isConversationCompactionActivity(activity: ThreadActivityItem): boolean {
  return isCompactionActivity(activity) && !isAgentOwnedActivity(activity);
}

/**
 * The conversation's settled compaction marker: the provider no longer holds
 * anything from before it, so no rewind may cut across it (§5.5).
 */
export function isSettledConversationCompaction(item: ThreadItem): boolean {
  return (
    item.kind === "activity" &&
    isConversationCompactionActivity(item) &&
    compactionMarkerState(item) === "compacted"
  );
}
