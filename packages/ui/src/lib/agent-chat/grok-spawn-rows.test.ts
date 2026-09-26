/**
 * A Grok `spawn_subagent` call through the real timeline derivation: the
 * launch row is hidden behind the agent's row, as a Claude `Agent` call's is.
 *
 * The rows are the ones daemon ingestion writes for a Grok launch — the
 * normaliser's output folded by the real fold, as the daemon's
 * `adapters/grok/fold-seam.test.ts` produces them (field for field; only the
 * ids and times are the builder's).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { NOTHING_STREAMS } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "./contracts";
import { EMPTY_AGENT_DRILL_IN, projectAgentDrillIn } from "./drill-in.logic";
import { deriveWorkLogEntries } from "./entries.logic";
import { activity, resetBuilders } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

const CALL = "call-s1";
const SUBAGENT_ID = "01a0c1a9-7b2e-7c3d-8e4f-0123456789ab";

const spawnRawInput = { prompt: "Find callers.", description: "find callers", subagent_type: "explore" };

function launchRows(end: "completed" | "failed") {
  const turn = { turnId: "turn-1" };
  const linkage = {
    agentKind: "agent",
    taskType: "subagent",
    agentId: CALL,
    title: "find callers",
    role: "explore",
    toolUseId: CALL
  };
  return [
    activity(
      "tool.started",
      {
        itemType: "collab_agent_tool_call",
        toolUseId: CALL,
        status: "inProgress",
        title: "spawn_subagent",
        detail: "spawn_subagent",
        data: { toolUseId: CALL, vendorTool: "spawn_subagent", readOnly: false, rawInput: spawnRawInput }
      },
      turn
    ),
    activity(
      "task.started",
      { taskId: CALL, detail: "find callers", ...linkage },
      { ...turn, agentId: CALL, tone: "info" }
    ),
    activity(
      "tool.updated",
      {
        itemType: "collab_agent_tool_call",
        toolUseId: CALL,
        status: "inProgress",
        title: "Subagent: find callers",
        detail: "Subagent: find callers",
        data: {},
        truncated: true
      },
      turn
    ),
    activity(
      "tool.completed",
      {
        itemType: "collab_agent_tool_call",
        toolUseId: CALL,
        status: end,
        title: "Subagent: find callers",
        detail: end === "completed" ? "main.js:3" : "max_depth_exceeded",
        data:
          end === "completed"
            ? { toolUseId: CALL, rawOutput: { type: "SubagentCompleted", subagent_id: SUBAGENT_ID } }
            : { toolUseId: CALL }
      },
      { ...turn, ...(end === "failed" ? { tone: "error" as const } : {}) }
    ),
    activity(
      "task.completed",
      {
        taskId: CALL,
        status: end,
        summary: end === "completed" ? "main.js:3" : "max_depth_exceeded",
        detail: end === "completed" ? "main.js:3" : "max_depth_exceeded",
        ...linkage
      },
      { ...turn, agentId: CALL, tone: end === "failed" ? "error" : "info" }
    )
  ];
}

describe("a Grok spawn_subagent call in the parent timeline", () => {
  it("is the agent's row: the launch call's own rows are hidden behind it", () => {
    const entries = deriveWorkLogEntries(launchRows("completed"));
    assert.deepEqual(
      entries.filter((entry) => entry.toolCallId === CALL),
      [],
      "no row of the spawn call itself"
    );
    assert.equal(entries.length, 1, "one row: the agent's");
    assert.deepEqual(entries[0]?.agentSpawn?.agentTaskIds, [CALL]);
  });

  it("keeps a failed launch visible — the only terminal signal must not vanish", () => {
    const entries = deriveWorkLogEntries(launchRows("failed"));
    const launch = entries.filter((entry) => entry.toolCallId === CALL);
    assert.equal(launch.length, 1, "the failed spawn call stays a row");
    assert.ok(entries.some((entry) => entry.agentSpawn?.agentTaskIds.includes(CALL)));
  });

  it("a run the CLI moved to the background, and a poll answering running, add no row of their own", () => {
    const linkage = {
      taskId: CALL,
      agentKind: "agent",
      taskType: "subagent",
      agentId: CALL,
      title: "find callers",
      toolUseId: CALL
    };
    const owned = { turnId: "turn-1", agentId: CALL, tone: "info" as const };
    const rows = launchRows("completed").slice(0, 3);
    rows.push(
      activity("task.updated", { isBackgrounded: true, ...linkage }, owned),
      activity("task.progress", { detail: "find callers", status: "running", ...linkage }, owned)
    );
    const entries = deriveWorkLogEntries(rows);
    assert.equal(entries.length, 1, "still one row: the agent's");
    assert.deepEqual(entries[0]?.agentSpawn?.agentTaskIds, [CALL]);
  });
});

describe("the Grok agent's own drill-in (R8)", () => {
  /** Every entry the drill-in's rows carry, a live row's included. */
  const entriesOf = (rows: readonly AgentChatTimelineRow[]) =>
    rows.flatMap((row) =>
      row.kind === "work" ? row.groupedEntries : row.kind === "work-live" ? [row.entry, ...row.groupedEntries] : []
    );

  for (const end of ["completed", "failed"] as const) {
    it(`never lists the agent itself as a spawn row (${end})`, () => {
      const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
        items: launchRows(end),
        agentId: CALL,
        messageStreaming: NOTHING_STREAMS
      }).stable.result;
      assert.deepEqual(
        entriesOf(rows).filter((entry) => entry.agentSpawn?.agentTaskIds.includes(CALL)),
        [],
        "the header and the roster already say what the agent is"
      );
      assert.ok(!rows.some((row) => row.id === "a2"), "and no bot row labelled with its result");
    });
  }

  it("keeps the parent's spawn row whole: only the agent's OWN view drops it", () => {
    const entries = deriveWorkLogEntries(launchRows("completed"));
    assert.deepEqual(entries[0]?.agentSpawn?.agentTaskIds, [CALL]);
  });
});
