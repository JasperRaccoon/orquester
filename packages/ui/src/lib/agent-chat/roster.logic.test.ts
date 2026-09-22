import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";

import {
  agentActivityText,
  deriveAgentSpawnSummary,
  deriveLivenessBanner,
  deriveRosterDockView,
  liveAgentTaskIds,
  resolveSpawnRowAgents,
  ROSTER_VISIBLE_ROWS,
  rosterRowLook
} from "./roster.logic";

const agent = (
  id: string,
  status: RuntimeSubagentStatus,
  overrides: Partial<RuntimeSubagent> = {}
): RuntimeSubagent => ({
  id,
  kind: "subagent",
  agentKind: "agent",
  title: id,
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
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

describe("row look", () => {
  it("presents the three in-flight statuses as one steady 'working'", () => {
    assert.equal(rosterRowLook("pending"), "working");
    assert.equal(rosterRowLook("running"), "working");
    assert.equal(rosterRowLook("waiting"), "working");
  });

  it("reads an idle-but-resumable agent as settled, not in-motion", () => {
    assert.equal(rosterRowLook("idle"), "settled");
    assert.equal(rosterRowLook("completed"), "settled");
    assert.equal(rosterRowLook("failed"), "failed");
    assert.equal(rosterRowLook("interrupted"), "stopped");
  });
});

describe("agentActivityText", () => {
  it("prefers progress while live and reverses that order once settled", () => {
    const live = agent("a", "running", { progress: "reading", lastToolName: "Read", result: "done" });
    assert.equal(agentActivityText(live), "reading");
    const settled = agent("a", "completed", { progress: "reading", result: "done" });
    assert.equal(agentActivityText(settled), "done");
  });

  it("is null when nothing was reported", () => {
    assert.equal(agentActivityText(agent("a", "idle")), null);
  });
});

describe("deriveAgentSpawnSummary", () => {
  it("says 'Kicked off' while live and 'Ran' once settled", () => {
    const live = deriveAgentSpawnSummary({
      agents: [agent("a", "running"), agent("b", "running")],
      agentCount: 2
    });
    assert.equal(live.live, true);
    assert.equal(live.lead, "Kicked off 2 subagents");
    assert.equal(live.status, "2 working");

    const settled = deriveAgentSpawnSummary({
      agents: [agent("a", "completed"), agent("b", "completed")],
      agentCount: 2
    });
    assert.equal(settled.lead, "Ran 2 subagents");
    assert.equal(settled.status, "✓ completed");
  });

  it("never reads a missing agent as completed", () => {
    const summary = deriveAgentSpawnSummary({ agents: [], agentCount: 3 });
    assert.equal(summary.status, "Status unavailable");
    assert.equal(summary.tone, "inactive");
  });

  it("never reads an idle agent as completed", () => {
    const summary = deriveAgentSpawnSummary({ agents: [agent("a", "idle")], agentCount: 1 });
    assert.equal(summary.status, "1 idle");
  });

  it("reports failures and stops before idles", () => {
    assert.equal(
      deriveAgentSpawnSummary({
        agents: [agent("a", "failed"), agent("b", "idle")],
        agentCount: 2
      }).status,
      "1 failed"
    );
    assert.equal(
      deriveAgentSpawnSummary({
        agents: [agent("a", "interrupted"), agent("b", "idle")],
        agentCount: 2
      }).status,
      "1 stopped"
    );
  });

  it("keeps a workflow coordinator live between member launches", () => {
    const summary = deriveAgentSpawnSummary({
      agents: [agent("a", "completed")],
      agentCount: 1,
      coordinatorStatus: "running"
    });
    assert.equal(summary.live, true);
    assert.equal(summary.status, "working");
  });
});

describe("spawn row resolution", () => {
  it("resolves ids against the live roster at render time", () => {
    const roster = [agent("t1", "running"), agent("wf", "running", { kind: "workflow" })];
    const resolved = resolveSpawnRowAgents(roster, { workflowId: "wf", agentTaskIds: ["t1", "gone"] });
    assert.deepEqual(resolved.agents.map((a) => a.id), ["t1"]);
    assert.equal(resolved.coordinator?.id, "wf");
  });

  it("names the live task ids the live activity row reads", () => {
    const ids = liveAgentTaskIds([agent("a", "running"), agent("b", "completed")]);
    assert.deepEqual([...ids], ["a"]);
  });
});

describe("the dock", () => {
  it("collapses past five and keeps the visible order stable", () => {
    const roster = Array.from({ length: 8 }, (_, index) => agent(`a${index}`, "running"));
    const view = deriveRosterDockView({ roster, expanded: false, turnSettled: false });
    assert.equal(view.visible.length, ROSTER_VISIBLE_ROWS);
    assert.equal(view.hiddenCount, 3);
    assert.deepEqual(view.visible.map((a) => a.id), ["a0", "a1", "a2", "a3", "a4"]);
  });

  it("shows everything when expanded", () => {
    const roster = Array.from({ length: 8 }, (_, index) => agent(`a${index}`, "running"));
    assert.equal(deriveRosterDockView({ roster, expanded: true, turnSettled: false }).visible.length, 8);
  });

  it("fades settled rows once the turn ends", () => {
    const roster = [agent("a", "completed"), agent("b", "running")];
    const view = deriveRosterDockView({ roster, expanded: false, turnSettled: true });
    assert.deepEqual(view.visible.map((a) => a.id), ["b"]);
  });

  it("exempts a live background row from collapsing AND from fading", () => {
    const roster = [
      agent("bg", "running", { agentKind: "background" }),
      ...Array.from({ length: 8 }, (_, index) => agent(`a${index}`, "running"))
    ];
    const view = deriveRosterDockView({ roster, expanded: false, turnSettled: true });
    assert.deepEqual(view.pinnedBackground.map((a) => a.id), ["bg"]);
    assert.ok(!view.visible.some((a) => a.id === "bg"), "it does not count towards the five");
    assert.equal(view.visible.length, ROSTER_VISIBLE_ROWS);
  });

  it("does fade a SETTLED background row", () => {
    const roster = [agent("bg", "completed", { agentKind: "background" })];
    const view = deriveRosterDockView({ roster, expanded: false, turnSettled: true });
    assert.equal(view.pinnedBackground.length, 0);
    assert.equal(view.visible.length, 0);
  });
});

describe("the liveness banner", () => {
  it("shows only when liveness is non-null and no turn is working", () => {
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: "working",
        isTurnWorking: true,
        liveAgentCount: 2,
        stopping: false
      }).visible,
      false
    );
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: null,
        isTurnWorking: false,
        liveAgentCount: 0,
        stopping: false
      }).visible,
      false
    );
  });

  it("uses the three titles", () => {
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: "working",
        isTurnWorking: false,
        liveAgentCount: 2,
        stopping: false
      }).title,
      "2 agents working"
    );
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: "working",
        isTurnWorking: false,
        liveAgentCount: 0,
        stopping: false
      }).title,
      "Background work"
    );
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: "monitoring",
        isTurnWorking: false,
        liveAgentCount: 0,
        stopping: false
      }).title,
      "Monitoring"
    );
  });

  it("reads 'Stopping…' while an interrupt is in flight", () => {
    assert.equal(
      deriveLivenessBanner({
        backgroundLiveness: "working",
        isTurnWorking: false,
        liveAgentCount: 1,
        stopping: true
      }).stopLabel,
      "Stopping…"
    );
  });
});
