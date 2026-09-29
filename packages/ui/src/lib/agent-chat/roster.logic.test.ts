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
taskStopControl,
workingLivenessTitle
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

  it("is null when nothing was reported", () => {
    assert.equal(agentActivityText(agent("a", "idle")), null);
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

describe("spawn row resolution", () => {
  it("resolves ids against the live roster at render time", () => {
    const roster = [agent("t1", "running"), agent("wf", "running", { kind: "workflow" })];
    const resolved = resolveSpawnRowAgents(roster, { workflowId: "wf", agentTaskIds: ["t1", "gone"] });
    assert.deepEqual(resolved.agents.map((a) => a.id), ["t1"]);
    assert.equal(resolved.coordinator?.id, "wf");
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
  const summarise = (roster: RuntimeSubagent[]) => {
    const resolved = resolveSpawnRowAgents(roster, spawn);
    return {
      resolved,
      summary: deriveAgentSpawnSummary({
        agents: resolved.agents,
        agentCount: resolved.agentCount,
        coordinatorStatus: resolved.coordinator?.status
      })
    };
  };

  it("counts the members, never the coordinator, including members the timeline never saw", () => {
    const { resolved, summary } = summarise(foldSubagentActivities(run()));
    assert.equal(resolved.coordinator?.id, WF);
    assert.deepEqual(resolved.agents.map((a) => a.id), [`${WF}:wf:1`, `${WF}:wf:2`, `${WF}:wf:3`]);
    assert.equal(resolved.agentCount, 3);
    assert.equal(summary.lead, "Kicked off 3 subagents");
    assert.equal(summary.status, "3 working");
    assert.equal(summary.tone, "working");
  });

  it("reads 'working' before the first member is reported", () => {
    const roster = foldSubagentActivities([activity("task.started", claudeWorkflow.coordinator())]);
    const { resolved, summary } = summarise(roster);
    assert.deepEqual(resolved.agents, []);
    assert.equal(resolved.agentCount, 1, "the one member id the timeline saw still counts");
    assert.equal(summary.live, true);
    assert.equal(summary.status, "working");
  });

  it("stays live between phases, and a retried member works again", () => {
    const roster = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.member(1, { status: "completed" })),
      activity("task.completed", claudeWorkflow.member(2, { status: "failed" })),
      activity("task.completed", claudeWorkflow.member(3, { status: "completed" }))
    ]);
    assert.equal(summarise(roster).summary.status, "working", "the coordinator runs on");
    const retried = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.member(2, { status: "failed" })),
      activity("task.started", claudeWorkflow.member(2, { attempt: 2, prompt: "again" }))
    ]);
    assert.equal(summarise(retried).summary.status, "3 working");
  });

  it("says the workflow stopped, its members cascaded to stopped", () => {
    const roster = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.member(1, { status: "completed" })),
      activity("task.completed", claudeWorkflow.coordinator({ status: "stopped" }))
    ]);
    const { resolved, summary } = summarise(roster);
    assert.deepEqual(resolved.agents.map((a) => a.status), ["completed", "interrupted", "interrupted"]);
    assert.equal(summary.live, false);
    assert.equal(summary.lead, "Ran 3 subagents");
    assert.equal(summary.status, "Workflow stopped");
  });

  it("names a failed member once the workflow completes, and a failed workflow as such", () => {
    const failedMember = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.member(1, { status: "completed" })),
      activity("task.completed", claudeWorkflow.member(2, { status: "failed" })),
      activity("task.completed", claudeWorkflow.member(3, { status: "completed" })),
      activity("task.completed", claudeWorkflow.coordinator({ status: "completed" }))
    ]);
    assert.equal(summarise(failedMember).summary.status, "1 failed");
    assert.equal(summarise(failedMember).summary.tone, "failed");
    const failedRun = foldSubagentActivities([
      ...run(),
      activity("task.completed", claudeWorkflow.coordinator({ status: "failed" }))
    ]);
    assert.equal(summarise(failedRun).summary.status, "Workflow failed");
  });
});

describe("the working banner's title", () => {
  it("names agents and shells apart", () => {
    assert.equal(workingLivenessTitle(3), "3 agents working");
    assert.equal(workingLivenessTitle(1, 2), "1 agent and 2 shells running");
    assert.equal(workingLivenessTitle(0), "Background work");
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

  it("keeps a stop pending while its row works, and lets it go once it settles, leaves or failed", () => {
    const agents = [agent("a", "running"), agent("b", "running"), agent("c", "completed")];
    const stopping = ["a", "b"];
    assert.equal(pendingTaskStops(stopping, agents), stopping, "nothing changed: the same value");
    assert.deepEqual(pendingTaskStops(["a", "c", "gone"], agents), ["a"]);
    assert.deepEqual(pendingTaskStops(stopping, agents, "b"), ["a"]);
  });

  it("reads the task a stop failure names, and nothing else", () => {
    assert.equal(failedTaskStopId(activity("provider.task.stop.failed", { targetTaskId: WF })), WF);
    assert.equal(failedTaskStopId(activity("provider.task.stop.failed", { taskId: WF })), null);
    assert.equal(failedTaskStopId(activity("task-stop.requested", { targetTaskId: WF })), null);
  });
});
