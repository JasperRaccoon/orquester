import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveAgentPanelModel, foldSubagentActivities } from "@orquester/api/agent-chat";

import { workingLivenessTitle } from "../../../lib/agent-chat/roster.logic";
import { activity, CLAUDE_WORKFLOW_ID as WF, claudeWorkflow } from "../../../lib/agent-chat/test-helpers";
import {
  partitionRosterRows,
  rosterKindCounts,
  workflowGroupSummary
} from "./roster-summary";

const agent = (status: "running" | "completed" | "idle") => ({ agentKind: "agent" as const, status });
const shell = (status: "running" | "completed" | "failed") => ({ agentKind: "background" as const, status });

describe("rosterKindCounts", () => {
  it("counts agents and shells apart, live ones included", () => {
    const counts = rosterKindCounts([
      agent("running"),
      agent("running"),
      agent("completed"),
      agent("idle"),
      shell("running"),
      shell("completed")
    ]);
    assert.deepEqual(counts, { agents: 4, shells: 2, loops: 0, goals: 0, liveAgents: 2, liveShells: 1 });
  });

  it("counts a loop and a goal as neither an agent nor a shell", () => {
    const counts = rosterKindCounts([
      agent("running"),
      { kind: "loop" as const, agentKind: "background" as const, status: "running" as const },
      { kind: "goal" as const, agentKind: "background" as const, status: "completed" as const },
      shell("running")
    ]);
    assert.deepEqual(counts, { agents: 1, shells: 1, loops: 1, goals: 1, liveAgents: 1, liveShells: 1 });
  });
});

describe("a Claude workflow's counts", () => {
  const run = () => [
    activity("task.started", claudeWorkflow.coordinator()),
    activity("task.progress", claudeWorkflow.member(1, { status: "running", usage: { totalTokens: 1200, toolUses: 4 } })),
    activity("task.progress", claudeWorkflow.member(2, { status: "running", usage: { totalTokens: 800 } })),
    activity("task.progress", claudeWorkflow.member(3, { status: "pending" })),
    // The coordinator's usage aggregates the whole run.
    activity("task.progress", claudeWorkflow.coordinator({ usage: { totalTokens: 2000 } }))
  ];

  it("counts the members as agents and the coordinator with members as none", () => {
    const agents = foldSubagentActivities(run());
    const counts = rosterKindCounts(agents);
    assert.deepEqual(counts, { agents: 3, shells: 0, loops: 0, goals: 0, liveAgents: 3, liveShells: 0 });
    assert.equal(workingLivenessTitle(counts.liveAgents, counts.liveShells), "3 agents working");
    // The same numbers the panel model reports: the footer and the banner agree.
    const model = deriveAgentPanelModel({ agents });
    assert.equal(model.liveCount, counts.liveAgents);
    assert.equal(model.totalTokens, 2000, "Σ tok is the members' — never the aggregate on top");
  });

  it("counts a coordinator with no members yet as the one agent it stands for", () => {
    const agents = foldSubagentActivities([activity("task.started", claudeWorkflow.coordinator())]);
    assert.equal(rosterKindCounts(agents).agents, 1);
    assert.equal(rosterKindCounts(agents).liveAgents, 1);
  });

  it("summarises the group's header from its members", () => {
    const agents = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.member(1, { status: "completed" })),
      activity("task.completed", claudeWorkflow.member(2, { status: "failed" }))
    ]);
    const group = deriveAgentPanelModel({ agents }).workflows[0]!;
    assert.deepEqual(workflowGroupSummary(group), { agents: 3, settled: 2, failed: 1, totalTokens: 2000 });
  });

  it("has no members to settle before the first is reported, and the coordinator's tokens", () => {
    const agents = foldSubagentActivities([
      activity("task.started", claudeWorkflow.coordinator()),
      activity("task.progress", claudeWorkflow.coordinator({ usage: { totalTokens: 300 } }))
    ]);
    const group = deriveAgentPanelModel({ agents }).workflows[0]!;
    assert.equal(group.workflow.id, WF);
    assert.deepEqual(workflowGroupSummary(group), { agents: 0, settled: 0, failed: 0, totalTokens: 300 });
  });
});

describe("partitionRosterRows", () => {
  it("keeps each kind's order while splitting them", () => {
    const rows = [
      { id: "a1", agent: { agentKind: "agent" as const } },
      { id: "s1", agent: { agentKind: "background" as const } },
      { id: "a2", agent: { agentKind: "agent" as const } },
      { id: "s2", agent: { agentKind: "background" as const } }
    ];
    const { agentRows, shellRows } = partitionRosterRows(rows);
    assert.deepEqual(agentRows.map((row) => row.id), ["a1", "a2"]);
    assert.deepEqual(shellRows.map((row) => row.id), ["s1", "s2"]);
  });

  it("renders a loop and a goal with the agents, never as shells", () => {
    const rows = [
      { id: "l1", agent: { kind: "loop" as const, agentKind: "background" as const } },
      { id: "s1", agent: { agentKind: "background" as const } },
      { id: "g1", agent: { kind: "goal" as const, agentKind: "background" as const } }
    ];
    const { agentRows, shellRows } = partitionRosterRows(rows);
    assert.deepEqual(agentRows.map((row) => row.id), ["l1", "g1"]);
    assert.deepEqual(shellRows.map((row) => row.id), ["s1"]);
  });
});
