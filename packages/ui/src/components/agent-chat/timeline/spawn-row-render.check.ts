/**
 * Render checks for the spawn row (§7.6): a batch of agents reads as ONE row
 * that resolves its label, live flag and members from the roster at render
 * time — "Kicked off 3 subagents" live, "Ran 3 subagents" settled (T3's
 * `deriveAgentSpawnSummary`) — in both of its states. T3 renders every work
 * entry carrying `agentSpawn` with its spawn row (`SimpleWorkEntryRow`); a
 * settled batch here used to fall through to a plain tool row, labelled with
 * its entry's merged detail — the latest-merged member row's, usually the
 * last-finished member's result — and no members to open.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeSubagent } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow, WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { TimelineRow } from "./TimelineRow";

function member(id: string, title: string, status: RuntimeSubagent["status"]): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    agentKind: "agent",
    title,
    role: null,
    model: null,
    effort: null,
    status,
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    exitCode: null,
    isBackgrounded: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-21T10:00:00.000Z",
    startedAt: "2026-09-21T10:00:00.000Z",
    completedAt: status === "running" ? null : "2026-09-21T10:01:00.000Z",
    updatedAt: "2026-09-21T10:00:00.000Z"
  };
}

/** The hoisted row a settled turn's batch projects: one `work` row, ids only. */
const spawnEntry: WorkLogEntry = {
  id: "spawn-1",
  createdAt: "2026-09-21T10:00:00.000Z",
  turnId: "turn-1",
  label: "Find the callers",
  tone: "info",
  sourceActivityKind: "task.started",
  taskId: "agent-a",
  agentSpawn: { workflowId: null, agentTaskIds: ["agent-a", "agent-b"] }
};
const settledBatch: AgentChatTimelineRow = {
  kind: "work",
  id: "spawn-1",
  createdAt: spawnEntry.createdAt,
  groupedEntries: [spawnEntry],
  isExpandedToolGroup: false
};

function render(row: AgentChatTimelineRow, roster: RuntimeSubagent[], membersOpen: boolean): string {
  const context = {
    workspaceRoot: undefined,
    readOnly: false,
    roster,
    isExpanded: () => false,
    setExpanded: () => {},
    isAgentRowExpanded: () => membersOpen,
    setAgentRowExpanded: () => {},
    onOpenAgent: () => {},
    onOpenFile: () => {},
    backgroundShell: false
  } as unknown as TimelineRowContextValue;
  return renderToStaticMarkup(
    createElement(TimelineRowContext.Provider, { value: context }, createElement(TimelineRow, { row }) as ReactElement)
  );
}

const done = [member("agent-a", "Find the callers", "completed"), member("agent-b", "Read the tests", "completed")];

const settled = render(settledBatch, done, false);
assert.ok(settled.includes("Ran 2 subagents"), `a settled batch reads as what it did: ${settled}`);
assert.ok(settled.includes("✓ completed"), "with the members' outcome, resolved from the roster");
assert.ok(settled.includes("lucide-bot"), "under the spawn row's glyph");
assert.ok(!settled.includes("ac-sweep"), "and no live sweep once every member is done");

const opened = render(settledBatch, done, true);
assert.ok(opened.includes("Read the tests"), "opened, it lists every member");
assert.equal(
  (opened.match(/<button/g) ?? []).length,
  3,
  "the header and one button per member: each opens that agent's drill-in"
);

// A batch whose members outlive the turn that launched them (background
// agents) still reads as running, as the live row does.
const outliving = render(settledBatch, [member("agent-a", "Find the callers", "running"), done[1]!], false);
assert.ok(outliving.includes("Kicked off 2 subagents"), outliving);
assert.ok(outliving.includes("1 working"));

// A member the roster no longer knows is never read as completed.
const unknown = render(settledBatch, [done[0]!], false);
assert.ok(unknown.includes("Status unavailable"), unknown);

// An old fleet batch whose members the roster evicted (its 100 rows keep the newest settled): the row keeps the
// batch's own text — its entry's merged detail, the latest member row's, what the row showed before — and never
// reads empty.
const merged: AgentChatTimelineRow = {
  ...settledBatch,
  groupedEntries: [{ ...spawnEntry, detail: "Tests cover 80% of parse()" }]
} as AgentChatTimelineRow;
const evicted = render(merged, [], false);
assert.ok(evicted.includes("Ran 2 subagents"), evicted);
assert.ok(evicted.includes("Tests cover 80% of parse()"), `its own text, in place of "Status unavailable": ${evicted}`);
assert.ok(!evicted.includes("Status unavailable"));
const evictedOpen = render(merged, [], true);
assert.ok(evictedOpen.includes("Tests cover 80% of parse()"), "opened, it keeps the text");
assert.ok(!evictedOpen.includes("No agent rows reported"), "and says where its agents went");
assert.ok(evictedOpen.includes("no longer in the roster"), evictedOpen);

console.log("agent-chat spawn row render checks passed");
