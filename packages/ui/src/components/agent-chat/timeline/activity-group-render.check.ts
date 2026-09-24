import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentChatTimelineRow, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { deriveTimelineEntriesFromItems } from "../../../lib/agent-chat/entries.logic";
import { deriveTimelineRows } from "../../../lib/agent-chat/rows.logic";
import { activity, message, stamp } from "../../../lib/agent-chat/test-helpers";
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

// A call still running inside an activity group — a reasoning block before it in the same turn — as the timeline
// derives it from the thread's items, the group opened.
function runningGroup(items: Parameters<typeof deriveTimelineEntriesFromItems>[0]): ActivityGroup {
  const rows = deriveTimelineRows({
    timelineEntries: deriveTimelineEntriesFromItems(items).entries,
    latestTurn: { turnId: "turn-1", state: "running", startedAt: stamp(1), completedAt: null },
    runningTurnId: "turn-1",
    isWorking: true,
    activeTurnStartedAt: stamp(1),
    supportsConversationRollback: false
  });
  const group = rows.find((candidate): candidate is ActivityGroup => candidate.kind === "activity-group");
  assert.ok(group, `an activity group: ${rows.map((candidate) => candidate.kind).join(", ")}`);
  return { ...group, expanded: true };
}
const prompt = message("user", "build it", { id: "u-1", createdAt: stamp(1) });
const thought = message("reasoning", "I'll build first.", { id: "r-1", turnId: "turn-1", createdAt: stamp(2) });

// Its output joins its start row, and a line that merely reads like a failure is not the call failing: it is judged
// when it completes. Neither the header nor the opened rows may mark it failed.
const building = render(
  createElement(ActivityGroupRow, {
    row: runningGroup([
      prompt,
      thought,
      activity("tool.started", { itemType: "command_execution", toolUseId: "call-1", title: "npm run build", command: "npm run build", status: "inProgress" }, { id: "start", turnId: "turn-1", createdAt: stamp(3) }),
      activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta: "cat: x: No such file or directory\n" }, { id: "c1", turnId: "turn-1", summary: "Tool output", createdAt: stamp(4) }),
      activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta: "line 2\n" }, { id: "c2", turnId: "turn-1", summary: "Tool output", createdAt: stamp(5) })
    ])
  }),
  false
);
assert.match(building, /aria-expanded="true"[^>]*>[\s\S]*?Running npm[\s\S]*?<\/button>/, "the header names the command, live");
assert.ok(!building.includes("tool call failed"), "no row — the header or an opened one — marks the running call failed");
assert.ok(!building.includes("Tool call failed"), "and no failure glyph");

// Claude's start frame names its tool before any of its input has streamed ("Bash: {}"): the header and the opened
// row read the call's title until the input's own update.
const claudeCall = render(
  createElement(ActivityGroupRow, {
    row: runningGroup([
      prompt,
      thought,
      activity("tool.started", { itemType: "command_execution", toolUseId: "toolu_1", title: "Command run", detail: "Bash: {}", status: "inProgress", data: { toolName: "Bash", input: {} } }, { id: "start-2", turnId: "turn-1", createdAt: stamp(3) })
    ])
  }),
  false
);
assert.match(claudeCall, /aria-expanded="true"[^>]*>[\s\S]*?Command run[\s\S]*?<\/button>/, "the header reads the call's title");
assert.ok(!claudeCall.includes("Bash: {}"), "never the empty input's echo");

console.log("agent-chat activity group render checks passed");
