import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { RuntimeSubagent,RuntimeSubagentStatus,ThreadItem } from "@orquester/api/agent-chat";

import {
agentActivityText,
deriveAgentSpawnSummary,
deriveLivenessBanner,
deriveRosterDockView,
isBackgroundShellItems,
liveAgentTaskIds,
resolveSpawnRowAgents
} from "./roster.logic";
import { activity } from "./test-helpers";

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

    const settled = deriveAgentSpawnSummary({
      agents: [agent("a", "completed"), agent("b", "completed")],
      agentCount: 2
    });
    assert.equal(settled.live, false);
  });

  it("keeps a workflow coordinator live between member launches", () => {
    const summary = deriveAgentSpawnSummary({
      agents: [agent("a", "completed")],
      agentCount: 1,
      coordinatorStatus: "running"
    });
    assert.equal(summary.live, true);
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
});

describe("a shell known by its items alone, for a drill-in with no roster row (final review C, M2)", () => {
  const task = (activityKind: string, payload: Record<string, unknown>, agentId?: string): ThreadItem =>
    activity(activityKind, payload, { tone: "info", ...(agentId !== undefined ? { agentId } : {}) });

  it("a Claude shell: its own command item, `bgshell:<id>` — its start, or a chunk alone", () => {
    const start = activity(
      "tool.started",
      { toolUseId: "bgshell:sh1", itemType: "command_execution", title: "Background shell" },
      { agentId: "sh1" }
    );
    const chunk = activity("tool.output", { toolUseId: "bgshell:sh1", streamKind: "command_output", delta: "ok\n" }, { agentId: "sh1" });
    assert.equal(isBackgroundShellItems([start], "sh1"), true);
    assert.equal(isBackgroundShellItems([chunk], "sh1"), true, "retention may have left only its output");
    assert.equal(isBackgroundShellItems([start], "sh2"), false, "another shell's call names only that shell");
  });

  it("a Grok shell, or any shell's launch: task rows naming it, of a shell's kind", () => {
    const grok = task("task.started", { taskId: "gsh", taskType: "shell", agentKind: "background" }, "gsh");
    assert.equal(isBackgroundShellItems([grok], "gsh"), true);
    const monitor = task("task.progress", { taskId: "mon", taskType: "monitor", agentKind: "background" }, "mon");
    assert.equal(isBackgroundShellItems([monitor], "mon"), true, "a monitor is a shell's view too");
    const launch = task("task.started", { taskId: "sh1", taskType: "local_bash", agentKind: "background" });
    assert.equal(isBackgroundShellItems([launch], "sh1"), true, "the parent's launch row of a Claude shell");
  });

  it("never an agent, a loop, a goal — nor an id with nothing in the window", () => {
    const agentStart = task("task.started", { taskId: "a1", taskType: "subagent", agentKind: "agent" }, "a1");
    assert.equal(isBackgroundShellItems([agentStart], "a1"), false);
    const unstampedThenAgent = [
      task("task.progress", { taskId: "a2" }),
      task("task.started", { taskId: "a2", agentKind: "agent" })
    ];
    assert.equal(isBackgroundShellItems(unstampedThenAgent, "a2"), false, "a row naming it an agent makes it one, as the roster reads it");
    assert.equal(isBackgroundShellItems([task("task.started", { taskId: "loop", taskType: "scheduled" }, "loop")], "loop"), false);
    assert.equal(isBackgroundShellItems([task("task.started", { taskId: "goal", taskType: "goal" }, "goal")], "goal"), false);
    assert.equal(isBackgroundShellItems([], "sh1"), false);
  });
});
