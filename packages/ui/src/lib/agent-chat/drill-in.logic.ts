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
 * **A live agent reads live**, by the same context: while the session is live
 * and the roster shows the agent at work (`pending`, `running`, `waiting`),
 * its current run is the running response, as the running turn is the
 * thread's — unfolded, its in-progress calls live rows, a live tail, the
 * working row at its head and the thinking placeholder when nothing at its
 * tail is live. A run is a position, not a turn (`agentRunStartIndex` in
 * `rows.logic.ts`): an agent's rows ride whatever parent turn was live when
 * each started, or none. A loop or a goal is never live here — it drives work
 * and does none, as everywhere else in the client.
 *
 * No React import.
 */

import type { MessageStreamingContext, RuntimeSubagent, ThreadItem } from "@orquester/api/agent-chat";

import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  itemsForAgent,
  type ThreadTimelineProjection,
  type TimelineEntry
} from "./entries.logic";
import { isLoopOrGoalRow } from "./roster.logic";
import {
  computeStableRows,
  deriveTimelineRowsWithState,
  EMPTY_STABLE_ROWS,
  type StableRowsState,
  type TimelineRowsProjection
} from "./rows.logic";

/** What the drill-in reads off the agent's roster row. */
export type DrillInAgentRow = Pick<RuntimeSubagent, "startedAt"> & { kind?: RuntimeSubagent["kind"] };

/** What the drill-in's projection reads of its own disclosure state. */
export interface AgentDrillInDisclosures {
  readonly expandedGroupIds: readonly string[];
  /**
   * The turns whose fold the user closed. Folds start OPEN — the child's rows
   * are the reason the view was opened, and a fold keyed on the parent's
   * turns would hide them behind one more click — so the drill-in keeps what
   * was closed, as it keeps a shell's collapsed rows, and a collapse sticks.
   */
  readonly collapsedTurnIds?: readonly string[];
}

export interface AgentDrillInInput {
  /** The thread's items — the parent's slice, never a second stream. */
  readonly items: readonly ThreadItem[];
  readonly agentId: string;
  /**
   * The thread's `messageStreamingContext`: whether a word can still be
   * written, and — the same notion — whether the agent is at work.
   */
  readonly messageStreaming: MessageStreamingContext;
  /**
   * The agent's roster row: its current run's start (the roster resets
   * `startedAt` on every relaunch), and whether it is a loop or a goal. Absent —
   * a row the roster dropped — the run starts at the agent's latest launch.
   */
  readonly agent?: DrillInAgentRow | null;
  /** The drill-in's own disclosure state ({@link AgentDrillInDisclosures}). */
  readonly disclosures?: AgentDrillInDisclosures | null;
}

/** One drill-in's projection, held across renders. */
export interface AgentDrillInProjection {
  readonly agentId: string | null;
  readonly timeline: ThreadTimelineProjection;
  readonly rows: TimelineRowsProjection | null;
  readonly stable: StableRowsState;
  /**
   * The turns whose fold is open: every turn the agent's rows ride but the
   * collapsed ones. The timeline's toggle patches this list whole, so the
   * drill-in hands it over as its `expandedTurnIds` and reads a patch back
   * with {@link collapsedTurnsAfter}. Held while its members stay the same.
   */
  readonly openTurnIds: readonly string[];
}

export const EMPTY_AGENT_DRILL_IN: AgentDrillInProjection = {
  agentId: null,
  timeline: EMPTY_TIMELINE_PROJECTION,
  rows: null,
  stable: EMPTY_STABLE_ROWS,
  openTurnIds: []
};

/**
 * The turns a drill-in holds closed after the timeline patched its open list
 * (`open`, as the projection handed it over) with `patched`: a turn that was
 * open and is missing from the patch was just closed, and a closed one the
 * patch names was opened again.
 */
export function collapsedTurnsAfter(
  collapsed: readonly string[],
  open: readonly string[],
  patched: readonly string[]
): string[] {
  const patch = new Set(patched);
  const next = collapsed.filter((turnId) => !patch.has(turnId));
  for (const turnId of open) {
    if (!patch.has(turnId) && !next.includes(turnId)) {
      next.push(turnId);
    }
  }
  return next;
}

/**
 * Whether the drilled agent is at work: the session is live and the roster
 * shows it `pending`, `running` or `waiting` — the context's own notion
 * (`MessageStreamingContext`, which `isMessageStreaming` and the roster's
 * session-death pass share), never a second one. A loop or a goal only drives
 * work (§7.6): it never reads as working.
 */
export function isDrillInAgentLive(
  agentId: string,
  agent: DrillInAgentRow | null | undefined,
  context: MessageStreamingContext
): boolean {
  return (
    context.sessionLive &&
    context.activeAgentIds.has(agentId) &&
    !(agent !== null && agent !== undefined && isLoopOrGoalRow(agent))
  );
}

/**
 * When the agent's latest launch started: the newest `task.started` naming it
 * (`payload.taskId`), whoever owns the row — Claude's launch is the PARENT's
 * row, the other adapters stamp it with the agent. Null when none is held.
 */
export function latestLaunchAt(items: readonly ThreadItem[], agentId: string): string | null {
  let latest: string | null = null;
  for (const item of items) {
    if (item.kind !== "activity" || item.activityKind !== "task.started") {
      continue;
    }
    const payload = item.payload as { taskId?: unknown } | null;
    if (payload?.taskId === agentId && (latest === null || item.createdAt > latest)) {
      latest = item.createdAt;
    }
  }
  return latest;
}

/**
 * Where a live agent's current run begins in its entries: the first row at or
 * after the run's start. Nothing known of the start — every row is the run.
 */
export function agentRunStart(entries: readonly TimelineEntry[], runStartedAt: string | null): number {
  if (runStartedAt === null) {
    return 0;
  }
  const at = entries.findIndex((entry) => entry.createdAt >= runStartedAt);
  return at < 0 ? entries.length : at;
}

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
  // Every fold starts open; the ones the user closed stay closed.
  const collapsedTurnIds = new Set(input.disclosures?.collapsedTurnIds ?? []);
  const expandedTurnIds = new Set<string>();
  for (const entry of timeline.entries) {
    const turnId =
      entry.kind === "message"
        ? entry.message.turnId
        : entry.kind === "work"
          ? entry.entry.turnId
          : null;
    if (typeof turnId === "string" && turnId.length > 0 && !collapsedTurnIds.has(turnId)) {
      expandedTurnIds.add(turnId);
    }
  }
  const live = isDrillInAgentLive(agentId, input.agent, input.messageStreaming);
  const runStartedAt = live ? (input.agent?.startedAt ?? latestLaunchAt(input.items, agentId)) : null;
  // The rows derivation compares these sets by identity, so the pair is held
  // while its members stay the same: a fresh pair per projection sent every
  // streamed token down a full rebuild instead of the streamed-text fast path.
  const heldInput = held?.rows?.input;
  const openTurns = keepHeldSet(heldInput?.expandedTurnIds, expandedTurnIds);
  const rows = deriveTimelineRowsWithState(
    {
      timelineEntries: timeline.entries,
      isWorking: live,
      activeTurnStartedAt: runStartedAt,
      ...(live ? { agentRunStartIndex: agentRunStart(timeline.entries, runStartedAt) } : {}),
      expandedTurnIds: openTurns,
      expandedWorkGroupIds: keepHeldSet(
        heldInput?.expandedWorkGroupIds,
        new Set(input.disclosures?.expandedGroupIds ?? [])
      ),
      // A spawn batch inside the child is live while a member is at work: the
      // same set, memoised with the context by the roster.
      liveAgentTaskIds: input.messageStreaming.activeAgentIds,
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
  // The same list while the set is held: the drill-in hands it to the
  // timeline's context, which every row reads.
  const openTurnIds =
    held !== null && openTurns === heldInput?.expandedTurnIds ? held.openTurnIds : [...openTurns];
  return { agentId, timeline, rows, stable, openTurnIds };
}

/** `held` when it has exactly `next`'s members, else `next`. */
function keepHeldSet(held: ReadonlySet<string> | undefined, next: ReadonlySet<string>): ReadonlySet<string> {
  if (held === undefined || held.size !== next.size) {
    return next;
  }
  for (const id of next) {
    if (!held.has(id)) {
      return next;
    }
  }
  return held;
}
