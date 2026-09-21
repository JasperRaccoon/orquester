/**
 * The subagent roster fold (§7.6). Parity cases ported from T3 Code (MIT):
 * `packages/client-runtime/src/state/subagentRuntime.test.ts`, adjusted for
 * the one deliberate difference — this design LISTS background rows instead of
 * dropping them.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  foldSubagentActivities,
  isBackgroundTaskActivity
} from "./roster.ts";
import { ROSTER_LIMIT } from "./thread.ts";
import { activity, agentTask, resetActivityIds } from "./test-helpers.ts";
import type { RuntimeSubagent } from "./thread.ts";

function byId(agents: readonly RuntimeSubagent[], id: string): RuntimeSubagent {
  const agent = agents.find((entry) => entry.id === id);
  assert.ok(agent, `no roster row for ${id}`);
  return agent;
}

test("isBackgroundTaskActivity reads the host stamp only", () => {
  assert.equal(isBackgroundTaskActivity({ agentKind: "agent" }), false);
  assert.equal(isBackgroundTaskActivity({ agentKind: "background" }), true);
  assert.equal(isBackgroundTaskActivity({}), true, "an unstamped row is background");
});

test("builds an agent from start → progress → completion", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Reviewer", model: "opus" })),
    activity("task.progress", agentTask("t1", { summary: "reading files", lastToolName: "Read" })),
    activity(
      "task.completed",
      agentTask("t1", { status: "completed", summary: "done", usage: { totalTokens: 120 } })
    )
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.title, "Reviewer");
  assert.equal(agent.model, "opus");
  assert.equal(agent.status, "completed");
  assert.equal(agent.activationCount, 1);
  assert.equal(agent.result, "done");
  assert.equal(agent.lastToolName, "Read");
  assert.equal(agent.usage?.totalTokens, 120);
  assert.ok(agent.startedAt);
  assert.ok(agent.completedAt);
});

test("a task.completed {status: stopped} folds to interrupted", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.completed", agentTask("t1", { status: "stopped" }))
  ]);
  assert.equal(byId(agents, "t1").status, "interrupted");
});

test("a status that resolves through the prototype chain is not a status", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.completed", agentTask("t1", { status: "toString" }))
  ]);
  assert.equal(byId(agents, "t1").status, "completed");
});

test("progress can create an agent when its start row aged out of retention", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.progress", agentTask("t1", { summary: "still working" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "running");
  assert.equal(agent.activationCount, 1);
});

test("completion before start stays terminal; a late start only fills metadata", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.completed", agentTask("t1", { status: "failed", summary: "boom" })),
    activity("task.started", agentTask("t1", { title: "Late title" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "failed");
  assert.equal(agent.title, "Late title");
  assert.equal(agent.error, "boom");
});

test("duplicate terminal events are idempotent: timestamps do not slide", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.completed", agentTask("t1", { status: "completed", summary: "first" })),
    activity("task.completed", agentTask("t1", { status: "failed", summary: "second" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "completed");
  assert.equal(agent.result, "first", "duplicate completions keep the FIRST result");
});

test("a completion after a terminal task.updated still enriches result and usage", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.updated", agentTask("t1", { status: "completed" })),
    activity(
      "task.completed",
      agentTask("t1", { status: "completed", summary: "the answer", usage: { totalTokens: 9 } })
    )
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.result, "the answer");
  assert.equal(agent.usage?.totalTokens, 9);
});

test("reactivation increments the run count and clears the previous result", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.completed", agentTask("t1", { status: "completed", summary: "run one" })),
    activity("task.updated", agentTask("t1", { status: "running" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "running");
  assert.equal(agent.activationCount, 2);
  assert.equal(agent.result, null);
  assert.equal(agent.completedAt, null);
});

test("idle is non-terminal: an idle agent resumes without losing identity", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Child" })),
    activity("task.updated", agentTask("t1", { status: "idle" })),
    activity("task.started", agentTask("t1"))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "running");
  assert.equal(agent.title, "Child");
  assert.equal(agent.activationCount, 2);
});

test("usage max-merges field-wise and a partial terminal frame keeps the breakdown", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity(
      "task.progress",
      agentTask("t1", { usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 } })
    ),
    // A late duplicate must not shrink or double-count.
    activity("task.progress", agentTask("t1", { usage: { totalTokens: 100 } })),
    activity("task.completed", agentTask("t1", { status: "completed", usage: { totalTokens: 150 } }))
  ]);
  const agent = byId(agents, "t1");
  assert.deepEqual(agent.usage, { totalTokens: 150, inputTokens: 60, outputTokens: 40 });
});

test("metadata is never downgraded to null by a later partial event", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Reviewer", model: "opus", role: "review" })),
    activity("task.progress", agentTask("t1"))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.title, "Reviewer");
  assert.equal(agent.model, "opus");
  assert.equal(agent.role, "review");
});

test("recent activity is a deduped ring of six bounded entries", () => {
  resetActivityIds();
  const rows = [activity("task.started", agentTask("t1"))];
  for (let i = 0; i < 10; i += 1) {
    rows.push(activity("task.progress", agentTask("t1", { summary: `step ${i}` })));
  }
  rows.push(activity("task.progress", agentTask("t1", { summary: "step 9" })));
  rows.push(activity("task.progress", agentTask("t1", { summary: "x".repeat(400) })));
  const agent = byId(foldSubagentActivities(rows), "t1");
  assert.equal(agent.recentActivity.length, 6);
  const last = agent.recentActivity[5]!;
  assert.equal(last.summary.length, 180);
  assert.ok(last.summary.endsWith("…"));
});

test("tool.progress is the agent-owned heartbeat and never creates a row", () => {
  resetActivityIds();
  const orphan = foldSubagentActivities([
    activity("tool.progress", { taskId: "ghost", toolName: "Bash" })
  ]);
  assert.deepEqual(orphan, []);

  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("tool.progress", { taskId: "t1", toolName: "Bash" })
  ]);
  assert.equal(byId(agents, "t1").lastToolName, "Bash");
});

test("provider endedAt wins over ingestion time on the settling transition", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.updated", agentTask("t1", { status: "completed", endedAt: "2020-01-01T00:00:00.000Z" }))
  ]);
  assert.equal(byId(agents, "t1").completedAt, "2020-01-01T00:00:00.000Z");
});

test("a non-http session url is dropped at the fold boundary", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity(
      "task.started",
      agentTask("t1", {
        runHandles: { runId: "r", sessionUrl: "javascript:alert(1)" }
      })
    )
  ]);
  assert.deepEqual(byId(agents, "t1").runHandles, { runId: "r" });
});

test("malformed rows are skipped individually without failing the fold", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", null),
    activity("task.started", "nope"),
    activity("task.started", { agentKind: "agent" }),
    activity("task.started", agentTask("t1"))
  ]);
  assert.deepEqual(agents.map((agent) => agent.id), ["t1"]);
});

// --- differs from T3: background rows are listed, not dropped (§7.6) --------

test("background rows join the roster, stamped agentKind background", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "shell-1", agentKind: "background", title: "Run dev" }),
    activity("task.started", agentTask("t1", { title: "Reviewer" }))
  ]);
  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.agentKind]),
    [
      ["shell-1", "background"],
      ["t1", "agent"]
    ]
  );
});

test("an unstamped row is background, and a later agent stamp promotes it", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "t1" }),
    activity("task.progress", agentTask("t1", { summary: "now known to be an agent" }))
  ]);
  assert.equal(byId(agents, "t1").agentKind, "agent");
});

test("a stampless later row never demotes a known agent", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1")),
    activity("task.completed", { taskId: "t1", status: "completed" })
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.agentKind, "agent");
  assert.equal(agent.status, "completed");
});

// --- session liveness ------------------------------------------------------

test("a dead session interrupts live rows but preserves idle and settled", () => {
  resetActivityIds();
  const rows = [
    activity("task.started", agentTask("live")),
    activity("task.started", agentTask("waiting")),
    activity("task.updated", agentTask("waiting", { status: "waiting" })),
    activity("task.started", agentTask("idle")),
    activity("task.updated", agentTask("idle", { status: "idle" })),
    activity("task.started", agentTask("done")),
    activity("task.completed", agentTask("done", { status: "completed" }))
  ];
  const live = foldSubagentActivities(rows, { sessionLive: true });
  assert.equal(byId(live, "live").status, "running");

  const dead = foldSubagentActivities(rows, { sessionLive: false });
  assert.equal(byId(dead, "live").status, "interrupted");
  assert.equal(byId(dead, "waiting").status, "interrupted");
  assert.equal(byId(dead, "idle").status, "idle", "a resumable child stays resumable");
  assert.equal(byId(dead, "done").status, "completed");
  assert.ok(byId(dead, "live").completedAt);
});

// --- workflows -------------------------------------------------------------

function workflowRows() {
  return [
    activity(
      "task.started",
      agentTask("wf", { taskType: "local_workflow", workflowName: "Ship it", phases: [{ index: 0, title: "Plan" }] })
    ),
    activity("task.started", agentTask("m1", { parentAgentId: "wf", phaseIndex: 0, agentIndex: 0 })),
    activity("task.started", agentTask("m2", { parentAgentId: "wf", phaseIndex: 0, agentIndex: 1 }))
  ];
}

test("a settled coordinator cascades onto members with no terminal row", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...workflowRows(),
    activity("task.completed", agentTask("m1", { status: "completed" })),
    activity("task.completed", agentTask("wf", { status: "failed" }))
  ]);
  assert.equal(byId(agents, "wf").status, "failed");
  assert.equal(byId(agents, "m1").status, "completed", "a member's own outcome is kept");
  assert.equal(byId(agents, "m2").status, "interrupted");
});

test("an attempt bump reactivates the same workflow slot exactly once", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("m1", { parentAgentId: "wf", attempt: 1 })),
    activity("task.completed", agentTask("m1", { status: "failed", summary: "nope" })),
    activity("task.updated", agentTask("m1", { attempt: 2, status: "running" }))
  ]);
  const agent = byId(agents, "m1");
  assert.equal(agent.attempt, 2);
  assert.equal(agent.activationCount, 2);
  assert.equal(agent.error, null);
  assert.equal(agent.status, "running");
});

test("deriveAgentPanelModel groups members by phase and keeps direct spawns", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...workflowRows(),
    activity("task.started", agentTask("solo"))
  ]);
  const model = deriveAgentPanelModel({ agents });
  assert.equal(model.workflows.length, 1);
  const group = model.workflows[0]!;
  assert.equal(group.workflow.id, "wf");
  assert.deepEqual(group.phases.map((phase) => [phase.index, phase.state, phase.members.length]), [
    [0, "running", 2]
  ]);
  assert.deepEqual(model.directAgents.map((agent) => agent.id), ["solo"]);
  assert.equal(model.hasAgents, true);
});

test("a member with an unknown phase index lands in unphasedMembers, never vanishes", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...workflowRows(),
    activity("task.started", agentTask("m3", { parentAgentId: "wf", phaseIndex: 7 }))
  ]);
  const group = deriveAgentPanelModel({ agents }).workflows[0]!;
  assert.deepEqual(group.unphasedMembers.map((member) => member.id), ["m3"]);
});

test("a phase with only pending members never reads as running", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("wf", { taskType: "local_workflow" })),
    activity("task.updated", agentTask("m1", { parentAgentId: "wf", phaseIndex: 0, status: "pending" }))
  ]);
  const group = deriveAgentPanelModel({ agents }).workflows[0]!;
  // `pending` is an active status, so the phase is running — but a phase with
  // NO members must stay pending.
  assert.equal(group.phases[0]?.state, "running");
  assert.equal(group.phases[0]?.activeCount, 1);
});

test("a workflow coordinator with members is not counted or token-summed", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...workflowRows(),
    activity("task.progress", agentTask("wf", { usage: { totalTokens: 100 } })),
    activity("task.progress", agentTask("m1", { usage: { totalTokens: 10 } })),
    activity("task.progress", agentTask("m2", { usage: { totalTokens: 20 } }))
  ]);
  const model = deriveAgentPanelModel({ agents });
  assert.equal(model.totalTokens, 30);
  assert.equal(model.runningCount, 2);
  assert.equal(model.liveCount, 2);
});

test("an orphaned member falls back to the direct list", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("m1", { parentAgentId: "gone" }))
  ]);
  const model = deriveAgentPanelModel({ agents });
  assert.deepEqual(model.directAgents.map((agent) => agent.id), ["m1"]);
});

test("direct agents stay in first-seen order as their activity changes", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("a")),
    activity("task.started", agentTask("b")),
    activity("task.completed", agentTask("a", { status: "completed" })),
    activity("task.progress", agentTask("b", { summary: "still going" }))
  ]);
  assert.deepEqual(
    deriveAgentPanelModel({ agents }).directAgents.map((agent) => agent.id),
    ["a", "b"]
  );
});

test("counts split waiting and idle out of running and settled", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.updated", agentTask("r", { status: "running" })),
    activity("task.updated", agentTask("w", { status: "waiting" })),
    activity("task.updated", agentTask("i", { status: "idle" })),
    activity("task.updated", agentTask("d", { status: "completed" }))
  ]);
  const model = deriveAgentPanelModel({ agents });
  assert.deepEqual(
    [model.runningCount, model.waitingCount, model.idleCount, model.settledCount, model.liveCount],
    [1, 1, 1, 1, 2]
  );
});

test("emptyAgentPanelModel is what an agent-less thread reads", () => {
  assert.deepEqual(deriveAgentPanelModel({ agents: [] }), emptyAgentPanelModel());
  assert.equal(emptyAgentPanelModel().hasAgents, false);
});

test("the roster caps at ROSTER_LIMIT, evicting live rows last", () => {
  resetActivityIds();
  const rows = [];
  for (let i = 0; i < ROSTER_LIMIT + 20; i += 1) {
    rows.push(activity("task.started", agentTask(`t${i}`)));
    // Settle everything but the last ten so the ranking has something to do.
    if (i < ROSTER_LIMIT + 10) {
      rows.push(activity("task.completed", agentTask(`t${i}`, { status: "completed" })));
    }
  }
  const agents = foldSubagentActivities(rows);
  assert.equal(agents.length, ROSTER_LIMIT);
  const live = agents.filter((agent) => agent.status === "running");
  assert.equal(live.length, 10, "every live row survives the cap");
});

test("the cap evicts by rank but returns survivors in first-seen order", () => {
  // R8 m8: the ranked array was returned as the roster, so crossing 100 rows
  // reordered every surviving row (settled ones came back newest-first) —
  // against §7.6's "without reshuffling rows that stay visible".
  resetActivityIds();
  const rows = [];
  for (let i = 0; i < ROSTER_LIMIT + 20; i += 1) {
    rows.push(activity("task.started", agentTask(`t${String(i).padStart(3, "0")}`)));
    if (i < ROSTER_LIMIT + 10) {
      rows.push(
        activity("task.completed", agentTask(`t${String(i).padStart(3, "0")}`, {
          status: "completed"
        }))
      );
    }
  }
  const agents = foldSubagentActivities(rows);
  assert.equal(agents.length, ROSTER_LIMIT);

  const firstSeen = agents.map((agent) => agent.firstSeenAt);
  const sorted = [...firstSeen].sort();
  assert.deepEqual(firstSeen, sorted, "survivors keep their original insertion order");
});
