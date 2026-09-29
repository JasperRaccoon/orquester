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
  foldSubagentActivities,
  taskStopRefusal
} from "./roster.ts";
import { activity, agentTask, resetActivityIds } from "./test-helpers.ts";
import type { RuntimeSubagent } from "./thread.ts";

function byId(agents: readonly RuntimeSubagent[], id: string): RuntimeSubagent {
  const agent = agents.find((entry) => entry.id === id);
  assert.ok(agent, `no roster row for ${id}`);
  return agent;
}

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

test("a start row with a NEW launching call after a terminal state is a resume and reopens the run", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_1" })),
    activity("task.completed", agentTask("t1", { status: "failed", summary: "rate limited", toolUseId: "toolu_1" })),
    // The resume: same task id, a new tool call, registered in the background.
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_2", isBackgrounded: true })),
    activity("task.progress", agentTask("t1", { description: "Reading", summary: "Reading the file", toolUseId: "toolu_2" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "running", "the resumed run is live again");
  assert.equal(agent.activationCount, 2, "a resume is a second activation");
  assert.equal(agent.error, null, "the old run's failure does not label the new run");
  assert.equal(agent.completedAt, null);
  assert.equal(agent.progress, "Reading the file");

  const settled = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_1" })),
    activity("task.completed", agentTask("t1", { status: "failed", summary: "rate limited", toolUseId: "toolu_1" })),
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_2", isBackgrounded: true })),
    activity("task.completed", agentTask("t1", { status: "completed", summary: "Done.", toolUseId: "toolu_2" }))
  ]);
  const done = byId(settled, "t1");
  assert.equal(done.status, "completed", "the resumed run's completion is not a duplicate terminal write");
  assert.equal(done.result, "Done.");
  assert.equal(done.error, null);
});

test("a start row that names the SAME launching call after a terminal state is a late delivery", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_1" })),
    activity("task.completed", agentTask("t1", { status: "failed", summary: "boom", toolUseId: "toolu_1" })),
    activity("task.started", agentTask("t1", { title: "Audit", toolUseId: "toolu_1" }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "failed");
  assert.equal(agent.activationCount, 1);
  assert.equal(agent.error, "boom");
});

test("a shell's exit code folds as any integer", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "s1", agentKind: "background", taskType: "local_bash", isBackgrounded: true }),
    activity("task.completed", { taskId: "s1", agentKind: "background", status: "failed", exitCode: -9 })
  ]);
  const shell = byId(agents, "s1");
  assert.equal(shell.exitCode, -9);
  assert.equal(shell.isBackgrounded, true);
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
    activity("task.progress", agentTask("t1", { usage: { totalTokens: 90, inputTokens: 10, outputTokens: 5 } })),
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

test("a scheduled prompt folds to a loop row and an autonomous goal to a goal row, both background", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "loop-1", agentKind: "background", taskType: "scheduled", title: "Every 1 minute: tick" }),
    activity("task.started", { taskId: "goal:g1", agentKind: "background", taskType: "goal", title: "Ship it" }),
    activity("task.started", { taskId: "shell-1", agentKind: "background", taskType: "local_bash", title: "Run dev" }),
    // A later row without its type keeps the row's kind: kinds are sticky.
    activity("task.progress", { taskId: "loop-1", agentKind: "background", summary: "Fired once" })
  ]);
  assert.deepEqual(
    agents.map((agent) => [agent.id, agent.kind, agent.agentKind]),
    [
      ["loop-1", "loop", "background"],
      ["goal:g1", "goal", "background"],
      ["shell-1", "subagent", "background"]
    ]
  );
});

test("a loop and a goal drive work and are no work of their own: never counted, never token-summed", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "loop-1", agentKind: "background", taskType: "scheduled" }),
    activity("task.started", { taskId: "goal:g1", agentKind: "background", taskType: "goal" }),
    // The goal's count is everything its turns and agents spent: summing it
    // with theirs would count those tokens twice.
    activity("task.progress", { taskId: "goal:g1", agentKind: "background", taskType: "goal", usage: { totalTokens: 900 } }),
    activity("task.progress", agentTask("t1", { usage: { totalTokens: 40 } }))
  ]);
  const model = deriveAgentPanelModel({ agents });
  assert.deepEqual(
    model.directAgents.map((agent) => agent.id),
    ["loop-1", "goal:g1", "t1"],
    "listed all the same"
  );
  assert.equal(model.totalTokens, 40);
  assert.equal(model.runningCount, 1);
  assert.equal(model.liveCount, 1);
});

test("a stop that left the task's process running is marked, and a new run forgets it", () => {
  resetActivityIds();
  const note = "Left running when the agent host stopped — stop it from Settings → System.";
  const agents = foldSubagentActivities([
    activity("task.started", { taskId: "shell-1", agentKind: "background", title: "pnpm dev" }),
    activity("task.completed", { taskId: "shell-1", agentKind: "background", status: "stopped", summary: note, leftRunning: true }),
    activity("task.started", { taskId: "shell-2", agentKind: "background", title: "vite" }),
    // Any other completion summary is no such marker: the CLI's own words, its output's line.
    activity("task.completed", { taskId: "shell-2", agentKind: "background", status: "stopped", summary: "VITE v5.4.0 ready in 312 ms" })
  ]);
  assert.equal(byId(agents, "shell-1").leftRunning, true);
  assert.equal(byId(agents, "shell-1").result, note);
  assert.equal("leftRunning" in byId(agents, "shell-2"), false);

  // The CLI reports it running again (a revived shell): a new run, no marker.
  const revived = foldSubagentActivities([
    activity("task.started", { taskId: "shell-1", agentKind: "background", title: "pnpm dev", toolUseId: "call-1" }),
    activity("task.completed", { taskId: "shell-1", agentKind: "background", status: "stopped", summary: note, leftRunning: true }),
    activity("task.progress", { taskId: "shell-1", agentKind: "background", status: "running", summary: "listening" })
  ]);
  assert.equal(byId(revived, "shell-1").status, "running");
  assert.equal("leftRunning" in byId(revived, "shell-1"), false);
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

test("a pending workflow member counts as active work in its phase", () => {
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

test("the cap evicts by rank but returns survivors in first-seen order", () => {
  // R8 m8: the ranked array was returned as the roster, so crossing 100 rows
  // reordered every surviving row (settled ones came back newest-first) —
  // against §7.6's "without reshuffling rows that stay visible".
  resetActivityIds();
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push(activity("task.started", agentTask(`t${String(i).padStart(3, "0")}`)));
    if (i === 1) {
      rows.push(activity("task.updated", agentTask("t001", { status: "idle" })));
    } else if (i > 1) {
      rows.push(
        activity("task.completed", agentTask(`t${String(i).padStart(3, "0")}`, {
          status: "completed"
        }))
      );
    }
  }
  const agents = foldSubagentActivities(rows);
  assert.equal(agents.length, 100);

  assert.deepEqual(agents.map((agent) => agent.id),
    ["t000", "t001", ...Array.from({ length: 98 }, (_, index) => `t${String(index + 22).padStart(3, "0")}`)],
    "older running/idle tasks survive ahead of newer settled tasks, in original order");
});

test("a resume reopens even when the NEW run's in-place progress row precedes the OLD run's terminal row", () => {
  // Owner incident 2026-09-23: a deploy restarted the host under three running
  // subagents; the resumed CLI reported each as `stopped` ("didn't finish
  // before the previous session ended"), the agent relaunched them under the
  // SAME task ids, and the roster kept every one `interrupted` for the rest of
  // the thread's life. Progress rows carry STABLE ids (`task-progress:…`,
  // `task-usage:…`) and are replaced in place, so in list order the relaunched
  // run's progress row — already naming the NEW launching call — sits BEFORE
  // the old run's `stopped` row. Reading the launching call off every task row
  // therefore saw "no change" when the resume's start row arrived.
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Backend", toolUseId: "toolu_old" })),
    // The in-place row: its position is its FIRST emission's, its content the latest.
    activity(
      "task.progress",
      agentTask("t1", { summary: "Confirming test tables", toolUseId: "toolu_new", usageSnapshot: true }),
      { id: "task-usage:thread:t1" }
    ),
    // The resumed CLI's notice for the run the restart killed: no launching call on it.
    activity("task.completed", agentTask("t1", { status: "stopped", summary: "didn't finish" })),
    // The relaunch under the same task id, by a new tool call.
    activity("task.started", agentTask("t1", { title: "Backend", toolUseId: "toolu_new", isBackgrounded: true }))
  ]);
  const agent = byId(agents, "t1");
  assert.equal(agent.status, "running", "the relaunched run is live, not the killed one");
  assert.equal(agent.activationCount, 2);
  assert.equal(agent.completedAt, null);
  assert.equal(agent.result, null, "the 'didn't finish' notice does not label the new run");

  // The same shape, but the start row names the OLD call: a late delivery, no reopen.
  resetActivityIds();
  const late = foldSubagentActivities([
    activity("task.started", agentTask("t1", { title: "Backend", toolUseId: "toolu_old" })),
    activity(
      "task.progress",
      agentTask("t1", { summary: "Confirming", toolUseId: "toolu_old", usageSnapshot: true }),
      { id: "task-usage:thread:t1" }
    ),
    activity("task.completed", agentTask("t1", { status: "stopped", summary: "didn't finish" })),
    activity("task.started", agentTask("t1", { title: "Backend", toolUseId: "toolu_old" }))
  ]);
  assert.equal(byId(late, "t1").status, "interrupted");
  assert.equal(byId(late, "t1").activationCount, 1);
});

// --- a Claude `Workflow` run, as the adapter reports it ---------------------
//
// A coordinator (`local_workflow`) with 1-based phases, and one member per
// agent slot, `<coordinator>:wf:<n>` (1-based, stable across retries), whose
// rows carry an explicit status and name the coordinator their parent.

const WF = "wvg2ao9ra";

function claudeCoordinator(extra: Record<string, unknown> = {}) {
  return agentTask(WF, {
    taskType: "local_workflow",
    workflowName: "jasper-understand-research",
    title: "Understand the research",
    phases: [
      { index: 1, title: "Gather" },
      { index: 2, title: "Combine" }
    ],
    runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js", transcriptDir: "/tmp/wf" },
    ...extra
  });
}

function claudeMember(n: number, extra: Record<string, unknown> = {}) {
  return agentTask(`${WF}:wf:${n}`, {
    taskType: "workflow_agent",
    parentAgentId: WF,
    agentIndex: n,
    phaseIndex: n < 3 ? 1 : 2,
    phaseTitle: n < 3 ? "Gather" : "Combine",
    attempt: 1,
    title: n === 1 ? "analyze:fframes" : n === 2 ? "analyze:codecs" : "combine",
    model: "claude-opus-5-5",
    timelineBypass: true,
    ...extra
  });
}

function claudeWorkflowRun() {
  return [
    activity("task.started", claudeCoordinator({ prompt: "export default async function run() {}" })),
    activity("task.progress", claudeMember(1, { status: "running", lastToolName: "Read" })),
    activity("task.progress", claudeMember(2, { status: "pending" })),
    activity("task.progress", claudeMember(3, { status: "pending" })),
    activity(
      "task.progress",
      claudeMember(1, {
        status: "running",
        summary: "reading frames",
        lastToolName: "Grep",
        usage: { totalTokens: 1200, toolUses: 4, durationMs: 9000 }
      })
    ),
    activity("task.progress", claudeCoordinator({ usage: { totalTokens: 5000 } }))
  ];
}

test("a Claude workflow folds into one group with its 1-based phases", () => {
  resetActivityIds();
  const agents = foldSubagentActivities(claudeWorkflowRun());
  const coordinator = byId(agents, WF);
  assert.equal(coordinator.kind, "workflow");
  assert.equal(coordinator.workflowName, "jasper-understand-research");
  assert.deepEqual(coordinator.phases, [
    { index: 1, title: "Gather" },
    { index: 2, title: "Combine" }
  ]);
  const first = byId(agents, `${WF}:wf:1`);
  assert.equal(first.kind, "workflow_agent");
  assert.equal(first.status, "running");
  assert.equal(first.lastToolName, "Grep");
  assert.equal(first.progress, "reading frames");
  assert.deepEqual(first.usage, { totalTokens: 1200, toolUses: 4, durationMs: 9000 });
  assert.equal(byId(agents, `${WF}:wf:2`).status, "pending");

  const model = deriveAgentPanelModel({ agents });
  assert.deepEqual(model.directAgents, [], "no member leaks into the direct list");
  const group = model.workflows[0]!;
  assert.deepEqual(
    group.phases.map((phase) => [phase.index, phase.title, phase.state, phase.members.map((m) => m.agentIndex)]),
    [
      [1, "Gather", "running", [1, 2]],
      [2, "Combine", "running", [3]]
    ]
  );
  assert.deepEqual(group.unphasedMembers, []);
  // The coordinator aggregates the run: counting it would add one agent and
  // every member token a second time.
  assert.equal(model.runningCount, 3);
  assert.equal(model.totalTokens, 1200);
});

test("a retried workflow slot reopens on its new attempt's start, exactly once", () => {
  resetActivityIds();
  const slot = `${WF}:wf:2`;
  const upToRetry = [
    ...claudeWorkflowRun(),
    activity("task.progress", claudeMember(2, { status: "running" })),
    activity("task.completed", claudeMember(2, { status: "failed", summary: "rate limited" })),
    // The retry: same slot, same (or no) launching call, the next attempt.
    activity("task.started", claudeMember(2, { attempt: 2, prompt: "try again" }))
  ];
  const started = byId(foldSubagentActivities(upToRetry), slot);
  assert.equal(started.status, "running", "the retry's start alone reopens the slot");
  assert.equal(started.activationCount, 2);
  const agents = foldSubagentActivities([
    ...upToRetry,
    activity("task.progress", claudeMember(2, { attempt: 2, status: "running" }))
  ]);
  const retried = byId(agents, slot);
  assert.equal(retried.status, "running");
  assert.equal(retried.attempt, 2);
  assert.equal(retried.activationCount, 2);
  assert.equal(retried.error, null, "the failed attempt's error does not label the retry");
  assert.equal(retried.completedAt, null);
});

test("a later attempt's end settles a slot whose retry start was never seen", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...claudeWorkflowRun(),
    activity("task.completed", claudeMember(2, { status: "failed", summary: "rate limited" })),
    activity("task.completed", claudeMember(2, { attempt: 2, status: "completed", summary: "done" }))
  ]);
  const slot = byId(agents, `${WF}:wf:2`);
  assert.equal(slot.status, "completed");
  assert.equal(slot.result, "done");
  assert.equal(slot.error, null);
  assert.ok(slot.completedAt);
});

test("a late duplicate of the same attempt's start does not reopen a settled slot", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...claudeWorkflowRun(),
    activity("task.completed", claudeMember(1, { status: "completed" })),
    activity("task.started", claudeMember(1))
  ]);
  assert.equal(byId(agents, `${WF}:wf:1`).status, "completed");
  assert.equal(byId(agents, `${WF}:wf:1`).activationCount, 1);
});

test("a stopped workflow cascades its unfinished members to interrupted", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    ...claudeWorkflowRun(),
    activity("task.completed", claudeMember(1, { status: "completed" })),
    activity("task.completed", claudeMember(2, { status: "failed" })),
    activity("task.completed", claudeCoordinator({ status: "stopped" }))
  ]);
  assert.equal(byId(agents, WF).status, "interrupted");
  assert.equal(byId(agents, `${WF}:wf:1`).status, "completed");
  assert.equal(byId(agents, `${WF}:wf:2`).status, "failed");
  assert.equal(byId(agents, `${WF}:wf:3`).status, "interrupted");
  const model = deriveAgentPanelModel({ agents });
  assert.equal(model.liveCount, 0);
  assert.deepEqual(model.workflows[0]!.phases.map((phase) => phase.state), ["done", "done"]);
});

test("a coordinator with no member rows yet stands for the run", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", claudeCoordinator()),
    activity("task.progress", claudeCoordinator({ usage: { totalTokens: 300 } }))
  ]);
  const model = deriveAgentPanelModel({ agents });
  const group = model.workflows[0]!;
  assert.deepEqual(group.phases.map((phase) => [phase.index, phase.state]), [
    [1, "pending"],
    [2, "pending"]
  ]);
  assert.equal(model.runningCount, 1, "it is the only thing known to be working");
  assert.equal(model.totalTokens, 300);
});

test("phases derived from members are labelled from 1 whatever base they use", () => {
  for (const base of [0, 1]) {
    resetActivityIds();
    const agents = foldSubagentActivities([
      activity("task.started", agentTask("wf", { taskType: "local_workflow" })),
      activity("task.progress", agentTask("m1", { parentAgentId: "wf", phaseIndex: base, status: "running" })),
      activity("task.progress", agentTask("m2", { parentAgentId: "wf", phaseIndex: base + 1, status: "running" })),
      activity(
        "task.progress",
        agentTask("m3", { parentAgentId: "wf", phaseIndex: base + 1, phaseTitle: "Combine", status: "running" })
      )
    ]);
    const group = deriveAgentPanelModel({ agents }).workflows[0]!;
    assert.deepEqual(
      group.phases.map((phase) => [phase.index, phase.title]),
      [
        [base, "Phase 1"],
        [base + 1, "Combine"]
      ],
      `base ${base}`
    );
  }
});

// --- /task/stop: which rows a single Stop may name --------------------------

test("taskStopRefusal: a live workflow run, subagent or shell can be stopped", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", claudeCoordinator()),
    activity("task.progress", claudeMember(1, { status: "running" })),
    activity("task.started", agentTask("sub-1", { title: "Reviewer" })),
    activity("task.started", { taskId: "sh-1", agentKind: "background", taskType: "local_bash", title: "pnpm dev" })
  ]);
  assert.equal(taskStopRefusal(agents, WF), null);
  assert.equal(taskStopRefusal(agents, "sub-1"), null);
  assert.equal(taskStopRefusal(agents, "sh-1"), null);
});

test("taskStopRefusal: a workflow's member is refused, even once its coordinator is gone", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", claudeCoordinator()),
    activity("task.progress", claudeMember(1, { status: "running" })),
    ...workflowRows()
  ]);
  assert.match(taskStopRefusal(agents, `${WF}:wf:1`) ?? "", /Stop the whole workflow/);
  // A member of another adapter's workflow: its parent is a workflow row.
  assert.match(taskStopRefusal(agents, "m1") ?? "", /Stop the whole workflow/);
  // The member's synthetic id alone says so when the coordinator was evicted.
  const orphan = agents.filter((agent) => agent.id !== WF);
  assert.match(taskStopRefusal(orphan, `${WF}:wf:1`) ?? "", /Stop the whole workflow/);
});

test("taskStopRefusal: an unknown, a settled or a driver row is refused", () => {
  resetActivityIds();
  const agents = foldSubagentActivities([
    activity("task.started", claudeCoordinator()),
    activity("task.completed", claudeCoordinator({ status: "stopped" })),
    activity("task.started", { taskId: "loop-1", agentKind: "background", taskType: "scheduled", title: "tick" })
  ]);
  assert.equal(taskStopRefusal(agents, "nope"), "This thread lists no such task.");
  assert.equal(taskStopRefusal(agents, WF), "This task is no longer running.");
  assert.match(taskStopRefusal(agents, "loop-1") ?? "", /loop or a goal/);
});
