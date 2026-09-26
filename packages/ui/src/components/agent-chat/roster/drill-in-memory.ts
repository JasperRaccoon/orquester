/**
 * The drill-in's per-agent memory (§7.6).
 *
 * The thread's own timeline remembers its disclosures, reading position and
 * follow in the store and the §7.2 LRU; a drill-in must never write that LRU —
 * it reuses the parent's slice, and a child's position is not the thread's
 * (`ChatTimeline` refuses the write). It forgot everything instead: Back, an
 * auto-return and A → B all reopened an agent at its end with every group
 * closed, and A's disclosures leaked into B. So `AgentChatView` keeps this
 * memory beside its drill-in state — in memory only, per thread (a switch
 * drops it), bounded to the {@link DRILL_IN_MEMORY_LIMIT} agents most
 * recently remembered — and each agent's drill-in opens from its entry.
 *
 * Pure: the view holds the value, this says what it becomes.
 */

import type { DisclosureState } from "../../../lib/agent-chat/contracts";
import type { TimelineScrollPosition } from "../contracts";

/** What a drill-in remembers of one agent. */
export interface DrillInMemoryEntry {
  /** Its groups, reasoning blocks, spawn rows and tool-output offsets. */
  readonly disclosures: DisclosureState;
  /** The turn folds the reader closed (folds start open). */
  readonly collapsedTurnIds: readonly string[];
  /** A shell's default-open rows the reader closed. */
  readonly collapsedShellRowIds: readonly string[];
  /** Where the reader was, as the timeline last published it. */
  readonly position: TimelineScrollPosition | null;
  /** The drill-in's live-follow flag as it was left. */
  readonly follow: boolean;
}

/** One thread's memory: agent id → entry, least recently remembered first. */
export type DrillInMemory = ReadonlyMap<string, DrillInMemoryEntry>;

export const EMPTY_DRILL_IN_MEMORY: DrillInMemory = new Map();

/** How many agents one thread's memory keeps. */
export const DRILL_IN_MEMORY_LIMIT = 50;

const NO_DISCLOSURES: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

const NO_IDS: readonly string[] = [];

/** The memory with `agentId`'s entry, as the most recently remembered. */
export function rememberDrillIn(
  memory: DrillInMemory,
  agentId: string,
  entry: DrillInMemoryEntry,
  limit = DRILL_IN_MEMORY_LIMIT
): DrillInMemory {
  const next = new Map(memory);
  next.delete(agentId);
  next.set(agentId, entry);
  for (const oldest of next.keys()) {
    if (next.size <= limit) {
      break;
    }
    next.delete(oldest);
  }
  return next;
}

/** `agentId`'s entry, or null when this thread never opened it (or forgot it). */
export function recallDrillIn(memory: DrillInMemory, agentId: string): DrillInMemoryEntry | null {
  return memory.get(agentId) ?? null;
}

/** What an agent's drill-in opens with. */
export interface DrillInOpening {
  readonly disclosures: DisclosureState;
  readonly collapsedTurnIds: readonly string[];
  readonly collapsedShellRowIds: readonly string[];
  /** A position to restore — only one the reader left mid-list; null opens at the end. */
  readonly position: TimelineScrollPosition | null;
  readonly follow: boolean;
}

/**
 * How `agentId`'s drill-in opens: its remembered disclosures, and the reader's
 * position when they left it mid-list — with follow OFF, or the first re-pin
 * would carry the list to its end over the restore. An agent never opened, or
 * left at its end, opens at its end, following: the content grew since.
 */
export function openDrillIn(memory: DrillInMemory, agentId: string): DrillInOpening {
  return drillInOpening(recallDrillIn(memory, agentId));
}

/** {@link openDrillIn} for an entry already recalled (or none). */
export function drillInOpening(entry: DrillInMemoryEntry | null): DrillInOpening {
  const midList = entry?.position !== null && entry?.position !== undefined && !entry.position.atEnd;
  return {
    disclosures: entry?.disclosures ?? NO_DISCLOSURES,
    collapsedTurnIds: entry?.collapsedTurnIds ?? NO_IDS,
    collapsedShellRowIds: entry?.collapsedShellRowIds ?? NO_IDS,
    position: midList ? entry.position : null,
    follow: !midList
  };
}
