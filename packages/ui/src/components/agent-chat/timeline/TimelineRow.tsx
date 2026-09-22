import React from "react";

import { cn } from "../../../lib/cn";
import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { isCompactCommandMessage } from "./row-chrome";
import { rowBottomPadding } from "./row-format";
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
  CompactRequestRow,
  CompactionRow,
  ProposedPlanRow,
  ThinkingRow,
  TurnDiffRow,
  TurnFoldRow,
  WorkingRow
} from "./rows/StructureRows";

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
      // §4.6.5(b): the submission is persisted verbatim as `/compact` and
      // **re-recognised at render time** so it reads as a compaction marker
      // rather than a literal slash-command bubble.
      if (isCompactCommandMessage(row.message)) return <CompactRequestRow row={row} />;
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
      return <ThinkingRow row={row} />;
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
  row,
  enter = false
}: {
  row: AgentChatTimelineRow;
  /**
   * This row arrived after the first paint, so it plays the one-shot 200ms
   * rise. Decided once per row id and never flipped, or the memo would break
   * and a settled row would re-animate. Re-opening a thread replays nothing.
   */
  enter?: boolean;
}): React.ReactElement {
  return (
    <div
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      className={cn(
        "mx-auto w-full min-w-0 max-w-3xl overflow-x-clip",
        enter && "ac-enter",
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
