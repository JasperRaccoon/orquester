import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldSubagentActivities } from "@orquester/api/agent-chat";

import { activity, CLAUDE_WORKFLOW_ID as WF, claudeWorkflow } from "../../../lib/agent-chat/test-helpers";
import { agentActivityText, rosterRoleChip, rosterRowMetrics } from "./format";

function member(rows: ReturnType<typeof activity>[], n: number) {
  const row = foldSubagentActivities(rows).find((agent) => agent.id === `${WF}:wf:${n}`);
  assert.ok(row);
  return row;
}

describe("a Claude workflow member's row", () => {
  const started = [
    activity("task.started", claudeWorkflow.coordinator()),
    activity(
      "task.progress",
      claudeWorkflow.member(1, {
        status: "running",
        lastToolName: "Grep",
        usage: { totalTokens: 12_400, toolUses: 7, durationMs: 30_000 }
      })
    )
  ];

  it("shows its label, its phase, model, tokens and tools", () => {
    const agent = member(started, 1);
    assert.equal(agent.title, "analyze:fframes");
    assert.equal(rosterRoleChip(agent), "Gather");
    assert.deepEqual(rosterRowMetrics(agent), ["opus-5-5", "12.4k tok", "7 tools"]);
    assert.equal(agentActivityText(agent), "▸ Grep");
  });

  it("marks a retry by its attempt, once", () => {
    const agent = member(
      [
        ...started,
        activity("task.completed", claudeWorkflow.member(1, { status: "failed" })),
        activity("task.started", claudeWorkflow.member(1, { attempt: 2 })),
        activity("task.progress", claudeWorkflow.member(1, { attempt: 2, status: "running", summary: "retrying" }))
      ],
      1
    );
    assert.deepEqual(rosterRowMetrics(agent), ["opus-5-5", "12.4k tok", "7 tools", "attempt 2"]);
    assert.equal(agentActivityText(agent), "retrying");
  });

  it("keeps a direct agent's reactivation as its run count", () => {
    const [direct] = foldSubagentActivities([
      activity("task.started", { taskId: "t1", agentKind: "agent", toolUseId: "call-1" }),
      activity("task.completed", { taskId: "t1", agentKind: "agent", status: "stopped" }),
      activity("task.started", { taskId: "t1", agentKind: "agent", toolUseId: "call-2" })
    ]);
    assert.ok(direct);
    assert.deepEqual(rosterRowMetrics(direct), ["— tok", "run 2"]);
    assert.equal(rosterRoleChip(direct), null);
  });
});
