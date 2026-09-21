/**
 * Agent chat — layers 2 and 3: timeline entries → rows → stable rows (§7.2, §7.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/web/src/components/chat/MessagesTimeline.logic.ts`
 * (`deriveMessagesTimelineRows`, `deriveTurnFolds`,
 * `attachTrailingToolGroupsToAssistant`, `replaceStreamingMessageRows`,
 * `computeStableMessagesTimelineRows` and its per-variant `isRowUnchanged`).
 *
 * **Activity-group boundaries are mechanical** (§7.3): a group starts at the
 * first reasoning row or plain tool row of a turn and runs until a non-grouping
 * entry, a turn-id change, or a row the user collapsed out. Errors, answered
 * questions, subagent-spawn rows and compaction markers are hoisted out as
 * their own rows — an error must never hide inside a collapsed summary line —
 * and a run with no reasoning row is a plain tool group, not an activity group.
 *
 * `isRowUnchanged` is hand-written per variant on purpose: React 18 with no
 * compiler means identity preservation is the whole performance story, and a
 * deep equality here would cost more than the render it saves.
 *
 * No React import.
 */

import type { Checkpoint, LatestTurnSummary, ThreadMessageItem } from "@orquester/api/agent-chat";

import type {
  AgentChatTimelineRow,
  QueuedComposerMessage,
  WorkLogEntry
} from "./contracts";
import { isStreamingMessageTextUpdate, type TimelineEntry } from "./entries.logic";
import {
  omitSupersededLifecycleMarkers,
  singleToolCallLabel,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
  workEntryIsVisibleInGroup,
  workLogEntryIsToolLike
} from "./presentation.logic";

const LIVE_ACTIVITY_ROW_ID = "live-activity-row";
const WORKING_ROW_ID = "working-indicator-row";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** *T3: `packages/shared/src/orchestrationTiming.ts:14-31`.* */
export function formatWorkDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0ms";
  }
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ") || "0s";
}

function elapsedMs(from: string | null, to: string | null): number | null {
  if (!from || !to) {
    return null;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return end - start;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.localeCompare(right) >= 0 ? left : right;
}

function workGroupIdentity(timelineEntryId: string, entry: WorkLogEntry): string {
  return entry.toolCallId
    ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`
    : timelineEntryId;
}

function workGroupId(timelineEntryId: string, entry: WorkLogEntry): string {
  return `work-group:${workGroupIdentity(timelineEntryId, entry)}`;
}

function expandedWorkGroupRow(
  groupId: string,
  createdAt: string,
  groupedEntries: WorkLogEntry[]
): Extract<AgentChatTimelineRow, { kind: "work" }> {
  return { kind: "work", id: `${groupId}:details`, createdAt, groupedEntries, isExpandedToolGroup: true };
}

export function timelineEntryTurnId(entry: TimelineEntry): string | null {
  if (entry.kind === "message") {
    return entry.message.role === "assistant" || entry.message.role === "reasoning"
      ? entry.message.turnId
      : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId;
  }
  return entry.entry.turnId;
}

function lastUserMessageIndex(entries: readonly TimelineEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "message" && entry.message.role === "user") {
      return index;
    }
  }
  return -1;
}

/**
 * A group qualifies only when a message in it is reasoning; a work row is
 * excluded when it carries `agentSpawn` or `questionAnswer`, is a compaction,
 * or has `tone === "error"` (§7.3).
 *
 * *T3: `MessagesTimeline.logic.ts:317-327`.*
 */
export function isGroupingEntry(entry: TimelineEntry): boolean {
  if (entry.kind === "message") {
    return entry.message.role === "reasoning";
  }
  if (entry.kind !== "work") {
    return false;
  }
  return (
    entry.entry.agentSpawn === undefined &&
    entry.entry.questionAnswer === undefined &&
    entry.entry.sourceActivityKind !== "context-compaction" &&
    entry.entry.sourceActivityKind !== "thread.state.changed" &&
    entry.entry.tone !== "error"
  );
}

function isCompactionEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === "work" &&
    (entry.entry.sourceActivityKind === "context-compaction" ||
      entry.entry.sourceActivityKind === "thread.state.changed")
  );
}

/** *T3: `MessagesTimeline.logic.ts:449-466`.* */
export function computeMessageDurationStart(
  messages: readonly ThreadMessageItem[]
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && !message.streaming) {
      lastBoundary = message.updatedAt;
    }
  }
  return result;
}

/** *T3: `MessagesTimeline.logic.ts:509-533`.* */
function deriveTerminalAssistantMessageIds(entries: readonly TimelineEntry[]): Set<string> {
  const lastByResponseKey = new Map<string, string>();
  let nullTurnIndex = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      nullTurnIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    lastByResponseKey.set(
      message.turnId ? `turn:${message.turnId}` : `unkeyed:${nullTurnIndex}`,
      message.id
    );
  }
  return new Set(lastByResponseKey.values());
}

/**
 * The session's running turn is authoritative when the latest turn briefly
 * lags behind it; folding must not flicker through that window.
 *
 * *T3: `MessagesTimeline.logic.ts:551-563`.*
 */
export function deriveUnsettledTurnId(
  latestTurn: LatestTurnSummary | null,
  runningTurnId: string | null
): string | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return settled ? null : latestTurn.turnId;
}

/** *T3: `MessagesTimeline.logic.ts:589-612`.* */
function deriveActiveVisualResponseTurnIds(input: {
  entries: readonly TimelineEntry[];
  unsettledTurnId: string | null;
  isWorking: boolean;
}): ReadonlySet<string> {
  const turnIds = new Set<string>();
  if (input.unsettledTurnId === null) {
    return turnIds;
  }
  turnIds.add(input.unsettledTurnId);
  if (!input.isWorking) {
    return turnIds;
  }
  for (let index = lastUserMessageIndex(input.entries) + 1; index < input.entries.length; index += 1) {
    const turnId = timelineEntryTurnId(input.entries[index]!);
    if (turnId !== null) {
      turnIds.add(turnId);
    }
  }
  return turnIds;
}

/** *T3: `MessagesTimeline.logic.ts:614-620`.* */
export function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

// ---------------------------------------------------------------------------
// Turn folds
// ---------------------------------------------------------------------------

interface TurnFold {
  turnId: string;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

/**
 * Settled turns fold activity before their terminal assistant message behind a
 * "Worked for …" row. A single ordinary activity after that message joins the
 * fold; larger groups and failures stay visible as a trailing summary.
 *
 * *T3: `MessagesTimeline.logic.ts:627-803`.*
 */
function deriveTurnFolds(input: {
  entries: readonly TimelineEntry[];
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: LatestTurnSummary | null;
  unfoldedTurnIds: ReadonlySet<string>;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: TimelineEntry[];
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    startBoundary: string | null;
  }
  const groups = new Map<string, TurnGroup>();
  let pendingUserBoundary: string | null = null;

  for (const entry of input.entries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId = timelineEntryTurnId(entry);
    if (!turnId || entry.kind === "proposed-plan") {
      continue;
    }
    let group = groups.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingUserBoundary
      };
      pendingUserBoundary = null;
      groups.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      // A thinking block stranded by a crashed provider keeps its streaming
      // flag forever and must not hold a fold open.
      if (entry.message.streaming && entry.message.role !== "reasoning") {
        group.hasStreamingMessage = true;
      }
    }
  }

  const folds = new Map<string, TurnFold>();
  for (const [turnId, group] of groups) {
    if (input.unfoldedTurnIds.has(turnId) || group.hasStreamingMessage) {
      continue;
    }
    const hiddenEntryIds = new Set<string>();
    const terminalIndex = group.terminalEntry
      ? group.entries.findIndex((entry) => entry.id === group.terminalEntry?.id)
      : group.entries.length;
    // Thinking blocks do not count towards "one trailing activity".
    const trailingEntryCount = group.entries.filter(
      (candidate, candidateIndex) =>
        candidateIndex > terminalIndex &&
        !(candidate.kind === "message" && candidate.message.role === "reasoning")
    ).length;

    for (const [index, entry] of group.entries.entries()) {
      if (entry.id === group.terminalEntry?.id) {
        continue;
      }
      const isCompaction = isCompactionEntry(entry);
      const isSingleTrailingActivity =
        trailingEntryCount === 1 &&
        entry.kind === "work" &&
        !workEntryDisplayIndicatesToolFailure(entry.entry);
      const isReasoning = entry.kind === "message" && entry.message.role === "reasoning";
      if (!isCompaction && !isReasoning && index > terminalIndex && !isSingleTrailingActivity) {
        continue;
      }
      // User input and subagent batches stay visible after their turn settles.
      if (
        entry.kind === "work" &&
        (entry.entry.questionAnswer !== undefined || entry.entry.agentSpawn !== undefined)
      ) {
        continue;
      }
      hiddenEntryIds.add(entry.id);
    }
    if (hiddenEntryIds.size === 0) {
      continue;
    }
    // A lone compaction (or a lone thinking block) stays visible on its own.
    const hidesFoldableWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !isCompactionEntry(entry) &&
        !(entry.kind === "message" && entry.message.role === "reasoning")
    );
    if (!hidesFoldableWork) {
      continue;
    }

    const firstEntry = group.entries[0];
    const firstHidden = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !firstHidden || !lastEntry) {
      continue;
    }
    const isLatestInterruptedTurn =
      input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
    const lastEntryEnd = lastEntry.kind === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;
    const durationMs =
      input.latestTurn?.turnId === turnId && input.latestTurn.startedAt && input.latestTurn.completedAt
        ? elapsedMs(input.latestTurn.startedAt, input.latestTurn.completedAt)
        : elapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIso(group.terminalEntry?.message.updatedAt ?? null, lastEntryEnd) ?? lastEntryEnd
          );
    const duration = durationMs !== null ? formatWorkDuration(durationMs) : null;
    const label = isLatestInterruptedTurn
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    folds.set(firstHidden.id, {
      turnId,
      anchorEntryId: firstHidden.id,
      createdAt: firstHidden.createdAt,
      hiddenEntryIds,
      label
    });
  }
  return folds;
}

// ---------------------------------------------------------------------------
// Checkpoints → the changed-files card and "rewind to here"
// ---------------------------------------------------------------------------

function buildRevertTurnCountByUserMessageId(input: {
  supportsConversationRollback: boolean;
  entries: readonly TimelineEntry[];
  checkpointByAssistantMessageId: ReadonlyMap<string, Checkpoint>;
}): Map<string, number> {
  const byUserMessageId = new Map<string, number>();
  if (!input.supportsConversationRollback) {
    return byUserMessageId;
  }
  for (let index = 0; index < input.entries.length; index += 1) {
    const entry = input.entries[index]!;
    if (entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }
    for (let next = index + 1; next < input.entries.length; next += 1) {
      const nextEntry = input.entries[next]!;
      if (nextEntry.kind !== "message") {
        continue;
      }
      if (nextEntry.message.role === "user") {
        break;
      }
      const checkpoint = input.checkpointByAssistantMessageId.get(nextEntry.message.id);
      if (!checkpoint) {
        continue;
      }
      byUserMessageId.set(entry.message.id, Math.max(0, checkpoint.checkpointTurnCount - 1));
      break;
    }
  }
  return byUserMessageId;
}

// ---------------------------------------------------------------------------
// Layer 2
// ---------------------------------------------------------------------------

export interface TimelineRowsInput {
  timelineEntries: readonly TimelineEntry[];
  latestTurn?: LatestTurnSummary | null;
  runningTurnId?: string | null;
  expandedTurnIds?: ReadonlySet<string>;
  expandedWorkGroupIds?: ReadonlySet<string>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  checkpoints?: readonly Checkpoint[];
  supportsConversationRollback: boolean;
  /** Task ids of subagents still working; the live activity row reads them. */
  liveAgentTaskIds?: ReadonlySet<string>;
  /** The client's own undispatched queue, rendered as ghost bubbles (§7.4). */
  queuedMessages?: readonly QueuedComposerMessage[];
}

export function deriveTimelineRows(input: TimelineRowsInput): AgentChatTimelineRow[] {
  const entries = input.timelineEntries;
  const checkpoints = input.checkpoints ?? [];
  const checkpointByAssistantMessageId = new Map<string, Checkpoint>();
  const checkpointByTurnId = new Map<string, Checkpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.assistantMessageId) {
      checkpointByAssistantMessageId.set(checkpoint.assistantMessageId, checkpoint);
    }
    if (checkpoint.turnId) {
      checkpointByTurnId.set(checkpoint.turnId, checkpoint);
    }
  }
  const revertTurnCountByUserMessageId = buildRevertTurnCountByUserMessageId({
    supportsConversationRollback: input.supportsConversationRollback,
    entries,
    checkpointByAssistantMessageId
  });

  const rows: AgentChatTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []))
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(entries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null
  );
  const activeVisualResponseTurnIds = deriveActiveVisualResponseTurnIds({
    entries,
    unsettledTurnId,
    isWorking: input.isWorking
  });
  const foldsByAnchorEntryId = deriveTurnFolds({
    entries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unfoldedTurnIds: activeVisualResponseTurnIds
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!input.expandedTurnIds?.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  let activeTurnHeaderIndex = entries.length;
  if (input.isWorking) {
    activeTurnHeaderIndex = lastUserMessageIndex(entries) + 1;
  }
  const entryBelongsToActiveTurn = (entry: TimelineEntry, index: number): boolean =>
    input.isWorking &&
    index >= activeTurnHeaderIndex &&
    (unsettledTurnId === null || timelineEntryTurnId(entry) === unsettledTurnId);
  const workEntryIsInActiveRun = (entry: WorkLogEntry): boolean =>
    input.isWorking &&
    unsettledTurnId !== null &&
    entry.toolLifecycleStatus === "inProgress" &&
    entry.turnId === unsettledTurnId;

  // The live tool run: the trailing streak of work entries in the active turn.
  const activeToolEntries: Array<Extract<TimelineEntry, { kind: "work" }>> = [];
  for (let index = entries.length - 1; index >= activeTurnHeaderIndex; index -= 1) {
    const entry = entries[index]!;
    if (
      !entryBelongsToActiveTurn(entry, index) ||
      entry.kind !== "work" ||
      entry.entry.questionAnswer !== undefined ||
      isCompactionEntry(entry) ||
      entry.entry.tone === "error"
    ) {
      break;
    }
    activeToolEntries.unshift(entry);
    if (workEntryDisplayIndicatesToolFailure(entry.entry)) {
      break;
    }
  }
  const visibleActiveToolEntries = omitSupersededLifecycleMarkers(
    activeToolEntries.filter((entry) => workEntryIsVisibleInGroup(entry.entry, true)),
    (entry) => entry.entry
  );
  const activeWorkAnchor = activeToolEntries[0];
  const latestVisibleToolEntry = visibleActiveToolEntries.at(-1);
  const latestRunningToolEntry = [...visibleActiveToolEntries]
    .reverse()
    .find((entry) => {
      const spawn = entry.entry.agentSpawn;
      return spawn
        ? entry === latestVisibleToolEntry &&
            ((spawn.workflowId !== null && input.liveAgentTaskIds?.has(spawn.workflowId)) ||
              spawn.agentTaskIds.some((taskId) => input.liveAgentTaskIds?.has(taskId)))
        : workEntryIsActiveTurnActivity(entry.entry);
    });
  const latestToolFailed =
    latestRunningToolEntry === undefined &&
    latestVisibleToolEntry !== undefined &&
    latestVisibleToolEntry.entry.toolLifecycleStatus !== "declined" &&
    workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry);
  const latestToolKeepsActivityLive =
    latestRunningToolEntry !== undefined ||
    (latestVisibleToolEntry !== undefined &&
      latestVisibleToolEntry.entry.agentSpawn === undefined &&
      (workEntryIndicatesToolSuccess(latestVisibleToolEntry.entry) ||
        (latestVisibleToolEntry.entry.toolLifecycleStatus === "completed" &&
          !workEntryDisplayIndicatesToolFailure(latestVisibleToolEntry.entry))));
  const activeWorkPlacementEntryId = latestVisibleToolEntry?.id;
  const activeWorkRow: Extract<AgentChatTimelineRow, { kind: "work-live" }> | null =
    activeWorkAnchor && latestVisibleToolEntry && !latestToolFailed
      ? (() => {
          const groupId = workGroupId(activeWorkAnchor.id, activeWorkAnchor.entry);
          return {
            kind: "work-live" as const,
            id: latestToolKeepsActivityLive
              ? LIVE_ACTIVITY_ROW_ID
              : `work-live:${workGroupIdentity(activeWorkAnchor.id, activeWorkAnchor.entry)}`,
            createdAt: activeWorkAnchor.createdAt,
            entry: (latestRunningToolEntry ?? latestVisibleToolEntry).entry,
            groupedEntries: visibleActiveToolEntries.map((entry) => entry.entry),
            groupId,
            expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
            active: latestToolKeepsActivityLive
          };
        })()
      : null;
  const activeWorkEntryIds = new Set(
    activeWorkRow !== null || latestToolFailed ? activeToolEntries.map((entry) => entry.id) : []
  );

  let hasActivityRow = false;
  const appendWorkingRow = (): void => {
    const latestUserMessage = entries[lastUserMessageIndex(entries)];
    const startedAt =
      activeVisualResponseTurnIds.size > 1 &&
      latestUserMessage?.kind === "message" &&
      latestUserMessage.message.role === "user"
        ? latestUserMessage.message.createdAt
        : input.activeTurnStartedAt;
    rows.push({ kind: "working", id: WORKING_ROW_ID, createdAt: startedAt });
  };
  const appendActiveWorkRows = (): void => {
    if (activeWorkRow === null) {
      return;
    }
    rows.push(activeWorkRow);
    hasActivityRow ||= activeWorkRow.active;
    if (!activeWorkRow.expanded || activeWorkRow.entry.agentSpawn) {
      return;
    }
    rows.push(
      expandedWorkGroupRow(activeWorkRow.groupId, activeWorkRow.createdAt, activeWorkRow.groupedEntries)
    );
  };

  let scannedActivityThrough = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const timelineEntry = entries[index]!;

    if (input.isWorking && index === activeTurnHeaderIndex) {
      appendWorkingRow();
    }
    if (timelineEntry.id === activeWorkPlacementEntryId) {
      appendActiveWorkRows();
    }

    const anchoredTurnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (anchoredTurnFold) {
      rows.push({
        kind: "turn-fold",
        id: `turn-fold:${anchoredTurnFold.turnId}`,
        createdAt: anchoredTurnFold.createdAt,
        turnId: anchoredTurnFold.turnId,
        label: anchoredTurnFold.label,
        expanded: input.expandedTurnIds?.has(anchoredTurnFold.turnId) ?? false
      });
    }
    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    // ── Activity group: a reasoning-bearing run inside one turn ────────────
    const activityTurnId = timelineEntryTurnId(timelineEntry);
    if (index > scannedActivityThrough && activityTurnId && isGroupingEntry(timelineEntry)) {
      const groupEntries = [timelineEntry];
      let cursor = index + 1;
      while (cursor < entries.length) {
        const next = entries[cursor]!;
        if (
          !isGroupingEntry(next) ||
          timelineEntryTurnId(next) !== activityTurnId ||
          collapsedEntryIds.has(next.id) ||
          foldsByAnchorEntryId.has(next.id)
        ) {
          break;
        }
        groupEntries.push(next);
        cursor += 1;
      }
      scannedActivityThrough = cursor - 1;
      // A run with no reasoning row is a plain tool group, not an activity group.
      if (groupEntries.some((entry) => entry.kind === "message")) {
        const active =
          input.isWorking &&
          activityTurnId === unsettledTurnId &&
          cursor === entries.length &&
          !latestToolFailed &&
          (latestVisibleToolEntry === undefined || latestToolKeepsActivityLive);
        const groupId =
          timelineEntry.kind === "work"
            ? workGroupId(timelineEntry.id, timelineEntry.entry)
            : `activity-group:${timelineEntry.id}`;
        rows.push({
          kind: "activity-group",
          id: active ? LIVE_ACTIVITY_ROW_ID : groupId,
          createdAt: timelineEntry.createdAt,
          turnId: activityTurnId,
          groupId,
          entries: groupEntries.flatMap((entry) =>
            entry.kind === "work"
              ? [entry.entry]
              : entry.kind === "message"
                ? [reasoningEntry(entry.message)]
                : []
          ),
          expanded: input.expandedWorkGroupIds?.has(groupId) ?? false,
          active
        });
        hasActivityRow ||= active;
        index = cursor - 1;
        continue;
      }
    }

    if (activeWorkEntryIds.has(timelineEntry.id)) {
      continue;
    }

    // ── Compaction marker ─────────────────────────────────────────────────
    if (isCompactionEntry(timelineEntry) && timelineEntry.kind === "work") {
      rows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        label: timelineEntry.entry.label,
        ...(timelineEntry.entry.compaction ?? {})
      });
      continue;
    }

    // ── Work rows ─────────────────────────────────────────────────────────
    if (timelineEntry.kind === "work") {
      // Hoisted: an error, an answered question and a spawn row are their own
      // rows — an error must never hide inside a collapsed summary (§7.3).
      if (
        timelineEntry.entry.agentSpawn !== undefined ||
        timelineEntry.entry.questionAnswer !== undefined ||
        timelineEntry.entry.tone === "error"
      ) {
        const spawn = timelineEntry.entry.agentSpawn;
        if (spawn && entryBelongsToActiveTurn(timelineEntry, index)) {
          hasActivityRow ||=
            (spawn.workflowId !== null && (input.liveAgentTaskIds?.has(spawn.workflowId) ?? false)) ||
            spawn.agentTaskIds.some((taskId) => input.liveAgentTaskIds?.has(taskId) ?? false);
        }
        rows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          isExpandedToolGroup: false
        });
        continue;
      }

      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < entries.length) {
        const nextEntry = entries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          nextEntry.entry.agentSpawn !== undefined ||
          nextEntry.entry.questionAnswer !== undefined ||
          isCompactionEntry(nextEntry) ||
          nextEntry.entry.tone === "error" ||
          activeWorkEntryIds.has(nextEntry.id) ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      const visibleGroupedEntries = omitSupersededLifecycleMarkers(
        groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, workEntryIsInActiveRun(entry))),
        (entry) => entry
      );
      if (visibleGroupedEntries.length > 0) {
        const activeInProgress = visibleGroupedEntries.filter(workEntryIsInActiveRun);
        if (activeInProgress.length > 0) {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          rows.push({
            kind: "work-live",
            id: `work-live:${workGroupIdentity(timelineEntry.id, timelineEntry.entry)}`,
            createdAt: timelineEntry.createdAt,
            entry: activeInProgress.at(-1)!,
            groupedEntries: visibleGroupedEntries,
            groupId,
            expanded,
            active: true
          });
          hasActivityRow = true;
          if (expanded) {
            rows.push(expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries));
          }
        } else if (visibleGroupedEntries.length === 1 && workLogEntryIsToolLike(visibleGroupedEntries[0]!)) {
          const singleEntry = visibleGroupedEntries[0]!;
          rows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries: visibleGroupedEntries,
            isExpandedToolGroup: false,
            displayLabel:
              toolGroupAction(singleEntry) === "edit"
                ? summarizeToolGroup(visibleGroupedEntries)
                : singleToolCallLabel(singleEntry)
          });
        } else {
          const groupId = workGroupId(timelineEntry.id, timelineEntry.entry);
          const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
          const singleEntry = visibleGroupedEntries.length === 1 ? visibleGroupedEntries[0]! : null;
          const usesSingleToolCallLabel =
            singleEntry !== null &&
            workLogEntryIsToolLike(singleEntry) &&
            toolGroupAction(singleEntry) !== "edit";
          const latestToolEntry = [...visibleGroupedEntries].reverse().find(workLogEntryIsToolLike);
          rows.push({
            kind: "work-toggle",
            id: `work-toggle:${timelineEntry.id}`,
            createdAt: timelineEntry.createdAt,
            turnId: timelineEntry.entry.turnId,
            groupId,
            hiddenCount: visibleGroupedEntries.length,
            expanded,
            summary: usesSingleToolCallLabel
              ? singleToolCallLabel(singleEntry)
              : singleEntry !== null && !workLogEntryIsToolLike(singleEntry)
                ? singleEntry.label
                : summarizeToolGroup(visibleGroupedEntries),
            summaryKind: toolGroupSummaryKind(visibleGroupedEntries),
            hasFailure:
              latestToolEntry !== undefined && workEntryDisplayIndicatesToolFailure(latestToolEntry)
          });
          if (expanded) {
            rows.push(expandedWorkGroupRow(groupId, timelineEntry.createdAt, visibleGroupedEntries));
          }
        }
      }
      index = cursor - 1;
      continue;
    }

    // ── Plan proposal ─────────────────────────────────────────────────────
    if (timelineEntry.kind === "proposed-plan") {
      rows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        planMarkdown: timelineEntry.proposedPlan.planMarkdown,
        implementedAt: timelineEntry.proposedPlan.implementedAt
      });
      continue;
    }

    // ── Message ───────────────────────────────────────────────────────────
    const message = timelineEntry.message;
    const stillInProgress =
      message.role === "assistant" &&
      message.turnId !== null &&
      activeVisualResponseTurnIds.has(message.turnId);
    // While the turn is still running the latest assistant message is only
    // provisionally terminal: withhold the metadata row so commentary does not
    // flash timestamps mid-work.
    const showAssistantMeta =
      message.role === "assistant" &&
      terminalAssistantMessageIds.has(message.id) &&
      !stillInProgress;

    rows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      durationStart: durationStartByMessageId.get(message.id) ?? message.createdAt,
      showAssistantMeta,
      ...(message.role === "user" && revertTurnCountByUserMessageId.has(message.id)
        ? { revertTurnCount: revertTurnCountByUserMessageId.get(message.id) }
        : {})
    });

    // The changed-files card sits at the end of the turn it belongs to (§7.3).
    if (showAssistantMeta) {
      const checkpoint =
        checkpointByAssistantMessageId.get(message.id) ??
        (message.turnId ? checkpointByTurnId.get(message.turnId) : undefined);
      if (checkpoint && checkpoint.files.length > 0) {
        rows.push({
          kind: "turn-diff",
          id: `turn-diff:${checkpoint.checkpointTurnCount}`,
          createdAt: checkpoint.completedAt,
          turnCount: checkpoint.checkpointTurnCount,
          turnId: checkpoint.turnId,
          files: checkpoint.files
        });
      }
    }
  }

  if (input.isWorking && !rows.some((row) => row.kind === "working") && activeTurnHeaderIndex === entries.length) {
    appendWorkingRow();
  }
  // The turn is never represented by an empty timeline (§7.3).
  if (input.isWorking && (!hasActivityRow || latestToolFailed)) {
    rows.push({ kind: "thinking", id: LIVE_ACTIVITY_ROW_ID, createdAt: input.activeTurnStartedAt });
  }

  const withMeta = attachTrailingToolGroupsToAssistant(rows);
  input.queuedMessages?.forEach((queuedMessage, index) => {
    withMeta.push({
      kind: "queued-message",
      id: `queued-message:${queuedMessage.id}`,
      createdAt: queuedMessage.queuedAt,
      queuedMessage,
      isNext: index === 0
    });
  });
  return withMeta;
}

/**
 * A reasoning message inside an activity group is carried as a work-log entry
 * so the group renders one row type.
 *
 * *differs from T3:* T3's `ActivityEntry` is a `TimelineEntry` union, so a
 * group holds messages and work rows side by side; F's contract types
 * `activity-group.entries` as `WorkLogEntry[]`, so the reasoning message is
 * normalised into one on the way in. The text is the entry's `detail`, which
 * is exactly where the reasoning row reads it from.
 */
const reasoningEntryCache = new WeakMap<ThreadMessageItem, WorkLogEntry>();

function reasoningEntry(message: ThreadMessageItem): WorkLogEntry {
  const cached = reasoningEntryCache.get(message);
  if (cached) {
    return cached;
  }
  const entry: WorkLogEntry = {
    id: message.id,
    createdAt: message.createdAt,
    turnId: message.turnId,
    label: "Thought",
    detail: message.text,
    tone: "thinking",
    sourceActivityKind: "reasoning"
  };
  reasoningEntryCache.set(message, entry);
  return entry;
}

/**
 * When a settled turn ends with tool calls after its terminal text, the text
 * and tools are one visual response: the metadata becomes the footer for the
 * whole block instead of separating prose from tools.
 *
 * *T3: `MessagesTimeline.logic.ts:806-900`.*
 */
function attachTrailingToolGroupsToAssistant(
  rows: readonly AgentChatTimelineRow[]
): AgentChatTimelineRow[] {
  const messageRowsWithoutMeta = new Set<string>();
  const metaRowsAfterIndex = new Map<number, Extract<AgentChatTimelineRow, { kind: "assistant-meta" }>>();

  for (const [messageIndex, row] of rows.entries()) {
    if (row.kind !== "message" || row.message.role !== "assistant" || !row.showAssistantMeta) {
      continue;
    }
    const turnId = row.message.turnId;
    if (turnId === null) {
      continue;
    }
    let lastTrailingWorkIndex = -1;
    let hasTrailingToolGroup = false;
    for (let index = messageIndex + 1; index < rows.length; index += 1) {
      const candidate = rows[index];
      if (!candidate) {
        break;
      }
      if (candidate.kind === "message" && candidate.message.role === "reasoning") {
        continue;
      }
      if (candidate.kind === "message") {
        break;
      }
      if (
        (candidate.kind === "work-toggle" || candidate.kind === "activity-group") &&
        candidate.turnId === turnId
      ) {
        hasTrailingToolGroup = true;
        lastTrailingWorkIndex = index;
        continue;
      }
      if (candidate.kind === "work" && candidate.groupedEntries.some((entry) => entry.turnId === turnId)) {
        if (!candidate.isExpandedToolGroup && candidate.groupedEntries.some(workLogEntryIsToolLike)) {
          hasTrailingToolGroup = true;
        }
        if (hasTrailingToolGroup) {
          lastTrailingWorkIndex = index;
        }
      }
    }
    if (lastTrailingWorkIndex < 0) {
      continue;
    }
    messageRowsWithoutMeta.add(row.id);
    metaRowsAfterIndex.set(lastTrailingWorkIndex, {
      kind: "assistant-meta",
      id: `assistant-meta:${row.message.id}`,
      createdAt: rows[lastTrailingWorkIndex]?.createdAt ?? row.message.updatedAt,
      message: row.message
    });
  }

  const result: AgentChatTimelineRow[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind === "message" && messageRowsWithoutMeta.has(row.id)) {
      result.push({ ...row, showAssistantMeta: false });
    } else {
      result.push(row);
    }
    const metaRow = metaRowsAfterIndex.get(index);
    if (metaRow) {
      result.push(metaRow);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layer 2 with state: the streaming fast path
// ---------------------------------------------------------------------------

export interface TimelineRowsProjection {
  readonly input: TimelineRowsInput;
  readonly rows: AgentChatTimelineRow[];
}

function shallowEqualInput(left: TimelineRowsInput, right: TimelineRowsInput): boolean {
  return (
    left.isWorking === right.isWorking &&
    left.activeTurnStartedAt === right.activeTurnStartedAt &&
    left.runningTurnId === right.runningTurnId &&
    left.supportsConversationRollback === right.supportsConversationRollback &&
    left.checkpoints === right.checkpoints &&
    left.liveAgentTaskIds === right.liveAgentTaskIds &&
    left.queuedMessages === right.queuedMessages &&
    left.expandedTurnIds === right.expandedTurnIds &&
    left.expandedWorkGroupIds === right.expandedWorkGroupIds &&
    (left.latestTurn === right.latestTurn ||
      (left.latestTurn != null &&
        right.latestTurn != null &&
        left.latestTurn.turnId === right.latestTurn.turnId &&
        left.latestTurn.state === right.latestTurn.state &&
        left.latestTurn.startedAt === right.latestTurn.startedAt &&
        left.latestTurn.completedAt === right.latestTurn.completedAt))
  );
}

/**
 * Reuse rows when the only change is streamed text.
 *
 * *T3: `MessagesTimeline.logic.ts:1477-1538`.*
 */
function replaceStreamingMessageRows(
  input: TimelineRowsInput,
  previous: TimelineRowsProjection
): AgentChatTimelineRow[] | null {
  if (
    input.timelineEntries.length !== previous.input.timelineEntries.length ||
    !shallowEqualInput(previous.input, input)
  ) {
    return null;
  }
  const replacements = new Map<ThreadMessageItem, ThreadMessageItem>();
  for (const [index, entry] of input.timelineEntries.entries()) {
    const previousEntry = previous.input.timelineEntries[index]!;
    if (entry === previousEntry) {
      continue;
    }
    if (
      entry.kind !== "message" ||
      previousEntry.kind !== "message" ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt
    ) {
      return null;
    }
    if (entry.message === previousEntry.message) {
      continue;
    }
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) {
      return null;
    }
    replacements.set(previousEntry.message, entry.message);
  }
  if (replacements.size === 0) {
    return previous.rows;
  }
  return previous.rows.map((row) => {
    if (row.kind === "activity-group") {
      // A reasoning message inside a group is carried as a derived entry; the
      // cache is keyed on the message, so a replacement rebuilds only that one.
      const replaced = row.entries.map((entry) => entry);
      let changed = false;
      for (const [previousMessage, nextMessage] of replacements) {
        const at = replaced.findIndex((entry) => entry.id === previousMessage.id);
        if (at >= 0) {
          replaced[at] = reasoningEntry(nextMessage);
          changed = true;
        }
      }
      return changed ? { ...row, entries: replaced } : row;
    }
    if (row.kind !== "message" && row.kind !== "assistant-meta") {
      return row;
    }
    const message = replacements.get(row.message);
    return message ? { ...row, message } : row;
  });
}

/** Keep one projection per timeline; reuse rows only when streaming changed. */
export function deriveTimelineRowsWithState(
  input: TimelineRowsInput,
  previous: TimelineRowsProjection | null = null
): TimelineRowsProjection {
  return {
    input,
    rows: (previous === null ? null : replaceStreamingMessageRows(input, previous)) ?? deriveTimelineRows(input)
  };
}

// ---------------------------------------------------------------------------
// Layer 3: stable rows
// ---------------------------------------------------------------------------

export interface StableRowsState {
  byId: Map<string, AgentChatTimelineRow>;
  result: AgentChatTimelineRow[];
}

export const EMPTY_STABLE_ROWS: StableRowsState = { byId: new Map(), result: [] };

/**
 * Replace each row with the previous object when nothing it renders changed,
 * so one streamed token changes exactly one row object.
 *
 * *T3: `MessagesTimeline.logic.ts:1556-1571`.*
 */
export function computeStableRows(
  rows: AgentChatTimelineRow[],
  previous: StableRowsState
): StableRowsState {
  const next = new Map<string, AgentChatTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id);
    const nextRow = previousRow && isRowUnchanged(previousRow, row) ? previousRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Shallow field comparison per row variant — deliberately hand-written, one
 * arm per kind, so adding a row kind is a compile error here rather than a
 * silent "always re-renders".
 *
 * *T3: `MessagesTimeline.logic.ts:1573-1675`.*
 */
export function isRowUnchanged(a: AgentChatTimelineRow, b: AgentChatTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) {
    return false;
  }
  switch (a.kind) {
    case "activity-group": {
      const other = b as typeof a;
      return (
        a.active === other.active &&
        a.expanded === other.expanded &&
        a.groupId === other.groupId &&
        a.turnId === other.turnId &&
        sameArray(a.entries, other.entries)
      );
    }
    case "working":
    case "thinking":
      return a.createdAt === (b as typeof a).createdAt;
    case "assistant-meta": {
      const other = b as typeof a;
      return a.createdAt === other.createdAt && a.message === other.message;
    }
    case "turn-fold": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt && a.label === other.label && a.expanded === other.expanded
      );
    }
    case "context-compaction": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.label === other.label &&
        a.beforeTokens === other.beforeTokens &&
        a.afterTokens === other.afterTokens
      );
    }
    case "turn-diff": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.turnCount === other.turnCount &&
        a.turnId === other.turnId &&
        a.files === other.files
      );
    }
    case "proposed-plan": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.planMarkdown === other.planMarkdown &&
        a.implementedAt === other.implementedAt
      );
    }
    case "queued-message": {
      const other = b as typeof a;
      return a.queuedMessage === other.queuedMessage && a.isNext === other.isNext;
    }
    case "work": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.isExpandedToolGroup === other.isExpandedToolGroup &&
        a.displayLabel === other.displayLabel &&
        sameArray(a.groupedEntries, other.groupedEntries)
      );
    }
    case "work-live": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.groupId === other.groupId &&
        a.expanded === other.expanded &&
        a.active === other.active &&
        a.entry === other.entry &&
        sameArray(a.groupedEntries, other.groupedEntries)
      );
    }
    case "work-toggle": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.turnId === other.turnId &&
        a.groupId === other.groupId &&
        a.hiddenCount === other.hiddenCount &&
        a.expanded === other.expanded &&
        a.summary === other.summary &&
        a.summaryKind === other.summaryKind &&
        a.hasFailure === other.hasFailure
      );
    }
    case "message": {
      const other = b as typeof a;
      return (
        a.createdAt === other.createdAt &&
        a.message === other.message &&
        a.durationStart === other.durationStart &&
        a.showAssistantMeta === other.showAssistantMeta &&
        a.revertTurnCount === other.revertTurnCount
      );
    }
  }
}
