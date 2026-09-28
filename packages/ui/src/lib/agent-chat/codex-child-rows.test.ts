/**
 * A Codex collab child's call in the GUI (plan
 * `2026-09-24-follow-ups-adapters-output-composer-history`, Task 3).
 *
 * The agent host writes a Codex child's calls as the child's own rows: the
 * child's thread id as `agentId` on the row and in its payload, the call's
 * `toolUseId` namespaced by the child's thread (`codex-child:<thread>:<item>`,
 * so the child's `call_1` is not the parent's), every row of the call on the
 * parent turn live when it started (`apps/daemon` `adapters/codex/normalise.ts`,
 * `childItemEvents`). These are the rows as ingestion writes them: the child's
 * drill-in must show the call once, its output joined, and the parent's work
 * log none of it — while the parent's own call under the same raw id stays the
 * parent's.
 */
import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import type { ThreadActivityItem,ThreadItem } from "@orquester/api/agent-chat";

import { joinLifecycleDetails } from "../../components/agent-chat/timeline/row-chrome";
import { deriveWorkLogEntries,itemsForAgent } from "./entries.logic";
import { activity,resetBuilders } from "./test-helpers";

const CHILD = "child-thread";
const CHILD_CALL = `codex-child:${CHILD}:call_1`;
const TURN = "parent-turn";

beforeEach(() => {
  resetBuilders();
});

/** Enough output that the completion's `detail` is ingestion's cut preview, not the output. */
const OUTPUT_LINES = Array.from({ length: 30 }, (_, index) => `ok ${index} - parses case ${index}\n`);
const OUTPUT = OUTPUT_LINES.join("");
const PREVIEW = `${OUTPUT.slice(0, 177)}...`;

function threadItems(): ThreadItem[] {
  const owned = { turnId: TURN, agentId: CHILD } as const;
  return [
    // The child's launch record: its anchor in the parent's timeline.
    activity(
      "task.started",
      {
        taskId: CHILD,
        agentId: CHILD,
        agentKind: "agent",
        taskType: "subagent",
        toolUseId: "codex-launch:sub-launch",
        agentPath: "/root/explorer",
        title: "explorer",
        description: "explorer"
      },
      { turnId: TURN, agentId: CHILD, tone: "info" }
    ),
    activity(
      "tool.started",
      {
        itemType: "command_execution",
        toolUseId: CHILD_CALL,
        status: "inProgress",
        title: "pnpm test",
        agentId: CHILD,
        data: { command: "pnpm test", cwd: "/w/p", source: "agent", commandActions: [] }
      },
      { ...owned, status: "inProgress", summary: "pnpm test started" }
    ),
    ...[OUTPUT_LINES.slice(0, 15).join(""), OUTPUT_LINES.slice(15).join("")].map((delta) =>
      activity(
        "tool.output",
        { toolUseId: CHILD_CALL, streamKind: "command_output", delta },
        { ...owned, summary: "Tool output" }
      )
    ),
    activity(
      "tool.completed",
      {
        itemType: "command_execution",
        toolUseId: CHILD_CALL,
        status: "completed",
        title: "pnpm test",
        detail: PREVIEW,
        agentId: CHILD,
        data: { command: "pnpm test", exitCode: 0, item: { aggregatedOutput: OUTPUT } }
      },
      { ...owned, status: "completed", summary: "pnpm test" }
    ),
    // The parent's own call, under the same RAW id as the child's.
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call_1", status: "completed", title: "ls", detail: "a.ts" },
      { turnId: TURN, status: "completed", summary: "ls" }
    )
  ];
}

const activitiesOf = (items: readonly ThreadItem[]): ThreadActivityItem[] =>
  items.filter((item): item is ThreadActivityItem => item.kind === "activity");

describe("a Codex collab child's call (Task 3)", () => {
  it("is one row of the child's drill-in, its output joined — and no row of the parent's work log", () => {
    const items = threadItems();

    // The parent's work log: its own call, never the child's.
    const parentCalls = deriveWorkLogEntries(activitiesOf(items)).flatMap((entry) =>
      entry.toolCallId !== undefined ? [entry.toolCallId] : []
    );
    assert.deepEqual(parentCalls, ["call_1"]);

    // The child's drill-in: its rows only — every row but the parent's own
    // call — the call once, its streamed output joined onto the row ending it.
    const drillIn = itemsForAgent(items, CHILD);
    assert.deepEqual(
      drillIn.map((item) => item.id),
      items.slice(0, -1).map((item) => item.id)
    );
    const rows = joinLifecycleDetails(
      deriveWorkLogEntries(activitiesOf(drillIn), { ownerAgentId: CHILD })
    ).filter((entry) => entry.toolCallId !== undefined);
    assert.deepEqual(
      rows.map((entry) => [entry.toolCallId, entry.toolLifecycleStatus, entry.detail]),
      [[CHILD_CALL, "completed", OUTPUT]]
    );
  });
});

describe("a Codex collab child's own drill-in (R8)", () => {
  it("never lists the child itself as a spawn row: its task rows are stamped with its own id", () => {
    const drillIn = itemsForAgent(threadItems(), CHILD);
    const entries = deriveWorkLogEntries(activitiesOf(drillIn), { ownerAgentId: CHILD });
    assert.deepEqual(
      entries.filter((entry) => entry.agentSpawn?.agentTaskIds.includes(CHILD)).map((entry) => entry.id),
      []
    );
    assert.ok(entries.some((entry) => entry.toolCallId === CHILD_CALL), "its own call is still its row");
  });

  it("the parent's timeline keeps the child's spawn row", () => {
    const entries = deriveWorkLogEntries(activitiesOf(threadItems()));
    assert.ok(entries.some((entry) => entry.agentSpawn?.agentTaskIds.includes(CHILD)));
  });
});
