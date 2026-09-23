import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentChatTimelineRow, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { message } from "../../../lib/agent-chat/test-helpers";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { ActivityGroupRow } from "./rows/ActivityRows";
import { ReasoningRow } from "./rows/MessageRows";

type ActivityGroup = Extract<AgentChatTimelineRow, { kind: "activity-group" }>;

const tool: WorkLogEntry = {
  id: "tool-1",
  createdAt: "2026-09-23T10:00:00.000Z",
  turnId: "turn-1",
  label: "Ran command",
  detail: "Done",
  tone: "tool",
  sourceActivityKind: "tool.completed",
  itemType: "command_execution",
  toolLifecycleStatus: "completed"
};
const reasoning: WorkLogEntry = {
  id: "reasoning-1",
  createdAt: "2026-09-23T10:00:01.000Z",
  turnId: "turn-1",
  label: "Thought",
  detail: "## Next step\nCheck the manifest and report.",
  tone: "thinking",
  sourceActivityKind: "reasoning"
};
const row: ActivityGroup = {
  kind: "activity-group",
  id: "activity-1",
  createdAt: tool.createdAt,
  turnId: "turn-1",
  groupId: "group-1",
  entries: [tool, reasoning],
  expanded: true,
  active: true
};

function render(element: ReactElement, thoughtExpanded: boolean): string {
  const context = {
    workspaceRoot: undefined,
    isExpanded: () => false,
    setExpanded: () => {},
    isReasoningExpanded: () => thoughtExpanded,
    setReasoningExpanded: () => {},
    onOpenFile: () => {},
    backgroundShell: false
  } as unknown as TimelineRowContextValue;
  return renderToStaticMarkup(
    createElement(
      TimelineRowContext.Provider,
      { value: context },
      element
    )
  );
}

const live = render(createElement(ActivityGroupRow, { row }), false);
assert.match(live, /aria-expanded="true"[^>]*>[\s\S]*?Thinking[\s\S]*?<\/button>/);
assert.ok(!live.includes("Check the manifest and report."), "a collapsed thought does not flood the tool group");
assert.ok(live.includes("Next step"), "the collapsed thought gives a short preview");

const settled = render(createElement(ActivityGroupRow, { row: { ...row, active: false } }), true);
assert.ok(settled.includes("Check the manifest and report."), "opening a thought reveals its full text");
assert.ok(settled.includes("<h2"), "reasoning uses the same Markdown renderer as assistant text");

const oneLine = message("reasoning", "**A long single line that needs disclosure**", {
  id: "reasoning-standalone",
  turnId: "turn-1"
});
const oneLineRow: Extract<AgentChatTimelineRow, { kind: "message" }> = {
  kind: "message",
  id: oneLine.id,
  createdAt: oneLine.createdAt,
  message: oneLine,
  durationStart: oneLine.createdAt,
  showAssistantMeta: false
};
const oneLineCollapsed = render(createElement(ReasoningRow, { row: oneLineRow }), false);
assert.ok(oneLineCollapsed.includes('aria-expanded="false"'), "one-line reasoning can still be opened");
const oneLineExpanded = render(createElement(ReasoningRow, { row: oneLineRow }), true);
assert.ok(oneLineExpanded.includes("<strong>"), "standalone reasoning also renders as Markdown");

console.log("agent-chat activity group render checks passed");
