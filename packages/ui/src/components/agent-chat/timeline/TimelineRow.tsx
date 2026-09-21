import React from "react";

import { cn } from "../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import {
  ActivityGroupRow,
  WorkLiveRow,
  WorkRow,
  WorkToggleRow
} from "./rows/ActivityRows";
import {
  AssistantMessageRow,
  AssistantMetaRow,
  QueuedMessageRow,
  ReasoningRow,
  UserMessageRow
} from "./rows/MessageRows";
import {
  CompactionRow,
  ProposedPlanRow,
  ThinkingRow,
  TurnDiffRow,
  TurnFoldRow,
  WorkingRow
} from "./rows/StructureRows";

/**
 * Vertical rhythm is **bottom padding on the row shell**, not a `gap` on the
 * list, so each row kind declares its own relationship to the next one.
 *
 * The pattern is the whole point: *activity rows cling together (8px),
 * conversation turns breathe (16px)*. A stream of twenty tool calls should read
 * as one block of work, not as twenty separate events.
 * *T3: `MessagesTimeline.tsx:1669-1701`.*
 */
export function rowBottomPadding(row: AgentChatTimelineRow): string {
  if (row.kind === "work" && row.isExpandedToolGroup) return "pb-1";
  if ((row.kind === "work-toggle" || row.kind === "work-live") && row.expanded) return "pb-0";
  if (row.kind === "turn-fold" || row.kind === "working") return "pb-1.5";
  if (
    (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
    (row.kind === "message" && row.message.role === "reasoning") ||
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "activity-group" ||
    row.kind === "thinking"
  ) {
    return "pb-2";
  }
  return "pb-4";
}

function RowBody({ row }: { row: AgentChatTimelineRow }): React.ReactElement | null {
  switch (row.kind) {
    case "activity-group":
      return <ActivityGroupRow row={row} />;
    case "work":
      return <WorkRow row={row} />;
    case "work-live":
      return <WorkLiveRow row={row} />;
    case "work-toggle":
      return <WorkToggleRow row={row} />;
    case "turn-fold":
      return <TurnFoldRow row={row} />;
    case "context-compaction":
      return <CompactionRow row={row} />;
    case "message":
      if (row.message.role === "user") return <UserMessageRow row={row} />;
      if (row.message.role === "reasoning") return <ReasoningRow row={row} />;
      return <AssistantMessageRow row={row} />;
    case "assistant-meta":
      return <AssistantMetaRow row={row} />;
    case "turn-diff":
      return <TurnDiffRow row={row} />;
    case "proposed-plan":
      return <ProposedPlanRow row={row} />;
    case "working":
      return <WorkingRow row={row} />;
    case "thinking":
      return <ThinkingRow />;
    case "queued-message":
      return <QueuedMessageRow row={row} />;
    default:
      // An exhaustive switch: a new row kind must be given a body, not silently
      // dropped into an empty div that looks like a rendering bug.
      return null;
  }
}

/**
 * One row.
 *
 * `memo`ised on the row object, which is W11's stable row identity (§7.2:
 * entries → rows → stable rows, each with a per-variant `isRowUnchanged`), so
 * one streamed token re-renders one row. Everything else a row needs travels on
 * the timeline context, never as a prop — a prop would defeat this memo.
 */
export const TimelineRow = React.memo(function TimelineRow({
  row
}: {
  row: AgentChatTimelineRow;
}): React.ReactElement {
  return (
    <div
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      className={cn(
        "mx-auto w-full min-w-0 max-w-3xl overflow-x-clip",
        rowBottomPadding(row),
        (row.kind === "message" && row.message.role === "assistant") || row.kind === "assistant-meta"
          ? "group/assistant"
          : null
      )}
    >
      <RowBody row={row} />
    </div>
  );
});
