import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { RuntimeSubagent,RuntimeSubagentStatus,ThreadItem } from "@orquester/api/agent-chat";
import { foldSubagentActivities } from "@orquester/api/agent-chat";

import {
agentActivityText,
deriveAgentSpawnSummary,
deriveRosterDockView,
failedTaskStopId,
isBackgroundShellItems,
pendingTaskStops,
resolveSpawnRowAgents,
taskStopControl
} from "./roster.logic";
import { activity,CLAUDE_WORKFLOW_ID as WF,claudeWorkflow } from "./test-helpers";

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
});

describe("deriveAgentSpawnSummary", () => {

  it("keeps a workflow coordinator live between member launches", () => {
    const summary = deriveAgentSpawnSummary({
      agents: [agent("a", "completed")],
      agentCount: 1,
      coordinatorStatus: "running"
    });
    assert.equal(summary.live, true);
  });
});

describe("a Claude workflow's spawn row", () => {
  const spawn = { workflowId: WF, agentTaskIds: [WF, `${WF}:wf:1`] };
  const run = () => [
    activity("task.started", claudeWorkflow.coordinator({ prompt: "export default async () => {}" })),
    // Members first appear by progress snapshot, some pending.
    activity("task.progress", claudeWorkflow.member(1, { status: "running" })),
    activity("task.progress", claudeWorkflow.member(2, { status: "pending" })),
    activity("task.progress", claudeWorkflow.member(3, { status: "pending" }))
  ];

  it("counts the members, never the coordinator, including members the timeline never saw", () => {
    const resolved = resolveSpawnRowAgents(foldSubagentActivities(run()), spawn);
    assert.equal(resolved.coordinator?.id, WF);
    assert.deepEqual(resolved.agents.map((a) => a.id), [`${WF}:wf:1`, `${WF}:wf:2`, `${WF}:wf:3`]);
    assert.equal(resolved.agentCount, 3);
  });

  it("preserves a known member count before roster details arrive", () => {
    const roster = foldSubagentActivities([activity("task.started", claudeWorkflow.coordinator())]);
    const resolved = resolveSpawnRowAgents(roster, spawn);
    assert.deepEqual(resolved.agents, []);
    assert.equal(resolved.agentCount, 1, "the one member id the timeline saw still counts");
  });

  it("summarizes a stopped workflow as inactive", () => {
    const summary = deriveAgentSpawnSummary({
      agents: [agent("one", "completed"), agent("two", "interrupted")],
      agentCount: 2,
      coordinatorStatus: "interrupted"
    });
    assert.equal(summary.live, false);
    assert.equal(summary.tone, "inactive");
  });

  it("reports failure when a member or coordinator failed", () => {
    const failedMember = deriveAgentSpawnSummary({
      agents: [agent("one", "completed"), agent("two", "failed")],
      agentCount: 2,
      coordinatorStatus: "completed"
    });
    assert.equal(failedMember.tone, "failed");
    const failedRun = deriveAgentSpawnSummary({
      agents: [],
      agentCount: 0,
      coordinatorStatus: "failed"
    });
    assert.equal(failedRun.tone, "failed");
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

describe("the per-task Stop (/task/stop)", () => {
  const liveRun = () =>
    foldSubagentActivities([
      activity("task.started", claudeWorkflow.coordinator()),
      activity("task.progress", claudeWorkflow.member(1, { status: "running" }))
    ]);
  const on = { canStopTasks: true, stoppingTaskIds: [] as string[] };

  it("shows on a live run where the provider can stop one task, and reads Stopping… while in flight", () => {
    const agents = liveRun();
    assert.equal(taskStopControl(agents, WF, on), "ready");
    assert.equal(taskStopControl(agents, WF, { ...on, stoppingTaskIds: [WF] }), "stopping");
  });

  it("hides where the provider cannot, on a member, and on a run that settled", () => {
    const agents = liveRun();
    assert.equal(taskStopControl(agents, WF, { ...on, canStopTasks: false }), "hidden");
    assert.equal(taskStopControl(agents, `${WF}:wf:1`, on), "hidden", "a member is never stopped on its own");
    const settled = foldSubagentActivities([
      activity("task.started", claudeWorkflow.coordinator()),
      activity("task.completed", claudeWorkflow.coordinator({ status: "stopped" }))
    ]);
    assert.equal(taskStopControl(settled, WF, { ...on, stoppingTaskIds: [WF] }), "hidden");
  });

  it("drops evicted pending stops and preserves other tasks when one fails", () => {
    const agents = [agent("a", "running"), agent("b", "running")];
    assert.deepEqual(pendingTaskStops(["a", "b", "gone"], agents), ["a", "b"]);
    assert.deepEqual(pendingTaskStops(["a", "b"], agents, "b"), ["a"]);
  });

  it("ignores unrelated activities and malformed task-stop failures", () => {
    assert.equal(failedTaskStopId(activity("provider.task.stop.failed", { taskId: WF })), null);
    assert.equal(failedTaskStopId(activity("task-stop.requested", { targetTaskId: WF })), null);
  });
});
