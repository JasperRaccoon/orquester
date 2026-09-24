/**
 * Agent chat — the drill-in's rows: one subagent's own timeline (§7.6).
 *
 * Its items filtered by `agentId` (`itemsForAgent`), through the very same
 * three layers as the parent's timeline — entries, rows, stable rows — held
 * between renders so a streamed token in the child's timeline changes one row
 * object, exactly as in the parent. `useAgentChatDrillIn` (hooks.ts) holds the
 * projection; this is the derivation, so it is testable without a renderer.
 *
 * A child's words stream only while the rule says so (`isMessageStreaming`,
 * `@orquester/api/agent-chat`) against the THREAD's context — its live
 * session, its running turn, the agents its roster shows at work — never by
 * their bare flag: an agent's words that rode no turn were left
 * `streaming: true` for good (one thread held 5 479), and every one of them
 * read "Thinking" in its drill-in forever.
 *
 * No React import.
 */

import type { MessageStreamingContext, ThreadItem } from "@orquester/api/agent-chat";

import type { DisclosureState } from "./contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  itemsForAgent,
  type ThreadTimelineProjection
} from "./entries.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";

export interface AgentDrillInInput {
  /** The thread's items — the parent's slice, never a second stream. */
  readonly items: readonly ThreadItem[];
  readonly agentId: string;
  /** The thread's `messageStreamingContext`: whether a word can still be written. */
  readonly messageStreaming: MessageStreamingContext;
  /**
   * The drill-in's own disclosure state. Group toggles honour it; turn folds
   * start OPEN — the child's rows are the reason the view was opened, and a
   * fold keyed on the parent's turns would hide them behind one more click.
   */
  readonly disclosures?: Pick<DisclosureState, "expandedGroupIds" | "expandedTurnIds"> | null;
}

/** One drill-in's projection, held across renders. */
export interface AgentDrillInProjection {
  readonly agentId: string | null;
  readonly timeline: ThreadTimelineProjection;
  readonly rows: TimelineRowsProjection | null;
  readonly stable: StableRowsState;
}

export const EMPTY_AGENT_DRILL_IN: AgentDrillInProjection = {
  agentId: null,
  timeline: EMPTY_TIMELINE_PROJECTION,
  rows: null,
  stable: EMPTY_STABLE_ROWS
};

/** Project one agent's rows off the thread's items; `stable.result` is what renders. */
export function projectAgentDrillIn(
  previous: AgentDrillInProjection,
  input: AgentDrillInInput
): AgentDrillInProjection {
  const { agentId } = input;
  // A different child is a different timeline: never reuse the previous
  // agent's projection as the fast path's baseline.
  const held = previous.agentId === agentId ? previous : null;
  const timeline = deriveTimelineEntriesFromItems(
    itemsForAgent(input.items, agentId),
    held?.timeline ?? null,
    // The agent's own rows are agent-internal to the parent, not to itself.
    { ownerAgentId: agentId }
  );
  const expandedTurnIds = new Set<string>(input.disclosures?.expandedTurnIds ?? []);
  for (const entry of timeline.entries) {
    const turnId =
      entry.kind === "message"
        ? entry.message.turnId
        : entry.kind === "work"
          ? entry.entry.turnId
          : null;
    if (typeof turnId === "string" && turnId.length > 0) {
      expandedTurnIds.add(turnId);
    }
  }
  const rows = deriveTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      isWorking: false,
      activeTurnStartedAt: null,
      expandedTurnIds,
      expandedWorkGroupIds: new Set(input.disclosures?.expandedGroupIds ?? []),
      // A child timeline offers no rewind: §5.5 rolls back the thread, and
      // a subagent has no turn of the thread's own to roll back to. Nor the
      // thread's `turns`: a fold here is timed by the agent's own rows — a
      // background agent works long past the parent turn its rows ride, and
      // that turn's seconds say nothing of it (`deriveTurnFolds`).
      supportsConversationRollback: false,
      messageStreaming: input.messageStreaming
    },
    held?.rows ?? null
  );
  const stable = computeStableRows(rows.rows, held?.stable ?? EMPTY_STABLE_ROWS);
  return { agentId, timeline, rows, stable };
}
