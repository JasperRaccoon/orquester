import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentHop, WorkflowBlockRun, WorkflowNode, WorkflowRunSummary } from "@orquester/api";

import {
  accountText,
  agentLiveLine,
  blockElapsedMs,
  blockInput,
  blockSkipReason,
  blockStatusView,
  defaultSelectedStep,
  filterRuns,
  formatClock,
  formatStepDuration,
  hopCountText,
  hopsText,
  mergeRunPages,
  retryFromFailedRequest,
  retryRunRequest,
  runActions,
  runFilterCounts,
  runNeedsTicker,
  runOutcomeText,
  runStatusView,
  runTimeline,
  selectionText,
  skipText,
  waitLine
} from "./run-view.ts";

// Local time, Mon 28 Sep 2026 14:30 — every clock below is built in local time too.
const NOW = new Date(2026, 8, 28, 14, 30, 0).getTime();
const at = (hours: number, minutes: number, seconds = 0, day = 28): string =>
  new Date(2026, 8, day, hours, minutes, seconds).toISOString();

function node(id: string, type: WorkflowNode["type"], extra: Record<string, unknown> = {}): WorkflowNode {
  return { id, name: id, type, position: { x: 0, y: 0 }, config: {}, ...extra } as unknown as WorkflowNode;
}

function edge(source: string, target: string, sourceHandle = "success") {
  return { id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle };
}

function block(nodeId: string, overrides: Partial<WorkflowBlockRun> = {}): WorkflowBlockRun {
  return { nodeId, name: nodeId, type: "code", status: "succeeded", attempt: 1, ...overrides };
}

function summary(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "run-1",
    workflowId: "wf",
    workflowName: "Nightly",
    status: "succeeded",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: at(14, 0),
    startedAt: at(14, 0),
    endedAt: at(14, 3, 12),
    durationMs: 192_000,
    ...overrides
  };
}

const hop = (overrides: Partial<AgentHop>): AgentHop => ({
  agent: "claude",
  model: "opus",
  accountId: "acc-1",
  sessionId: "s1",
  startedAt: at(14, 0),
  via: "initial",
  ...overrides
});

describe("time", () => {
  it("says a clock as short as it can", () => {
    assert.equal(formatClock(at(22, 40), NOW), "22:40");
    assert.equal(formatClock(at(9, 5, 0, 29), NOW), "tomorrow 09:05");
    assert.equal(formatClock(at(18, 2, 0, 27), NOW), "yesterday 18:02");
    assert.equal(formatClock(at(14, 45, 0, 30), NOW), "Wed 14:45");
    assert.equal(formatClock(at(8, 0, 0, 3 + 30), NOW), "Sat 08:00");
    assert.equal(formatClock(at(8, 0, 0, 9 + 30), NOW), "Oct 9 08:00");
    assert.equal(formatClock("not a date", NOW), "");
    assert.equal(formatClock(undefined, NOW), "");
  });

  it("keeps seconds while they matter", () => {
    assert.equal(formatStepDuration(40), "<0.1s");
    assert.equal(formatStepDuration(420), "0.4s");
    assert.equal(formatStepDuration(8_400), "8s");
    assert.equal(formatStepDuration(192_000), "3m 12s");
    assert.equal(formatStepDuration(180_000), "3m");
    assert.equal(formatStepDuration(64 * 60_000), "1h 4m");
    assert.equal(formatStepDuration(null), "");
    assert.equal(formatStepDuration(-1), "");
  });

  it("ticks a live block against the clock and freezes a settled one", () => {
    const running = block("a", { status: "running", startedAt: at(14, 18) });
    assert.equal(blockElapsedMs(running, NOW), 12 * 60_000);
    const done = block("a", { startedAt: at(14, 0), endedAt: at(14, 0, 30) });
    assert.equal(blockElapsedMs(done, NOW), 30_000);
    assert.equal(blockElapsedMs(block("a", { status: "pending" }), NOW), null);
    assert.equal(runNeedsTicker(summary({ status: "running" })), true);
    assert.equal(runNeedsTicker(summary(), { a: { status: "waiting" } }), true);
    assert.equal(runNeedsTicker(summary(), { a: { status: "succeeded" } }), false);
  });
});

describe("status vocabulary", () => {
  it("maps block states to a tone, a label and a live flag", () => {
    assert.deepEqual(blockStatusView("running"), { tone: "info", label: "Running", icon: "running", live: true });
    assert.equal(blockStatusView("failed").tone, "danger");
    assert.equal(blockStatusView("skipped").tone, "neutral");
    assert.equal(blockStatusView("waiting").live, true);
  });

  it("reads a Stop block's end as a success and a skip with its reason", () => {
    assert.equal(runStatusView({ status: "stopped" }).tone, "ok");
    assert.equal(runStatusView({ status: "interrupted" }).tone, "danger");
    assert.equal(runStatusView({ status: "skipped", skipReason: "overlap" }).label, "Skipped · overlap");
  });

  it("says a run's outcome in one sentence", () => {
    assert.equal(runOutcomeText(summary(), NOW), "Succeeded in 3m");
    assert.equal(
      runOutcomeText(summary({ status: "failed", durationMs: 12 * 60_000, error: "Review failed" }), NOW),
      "Failed after 12m — Review failed"
    );
    assert.equal(
      runOutcomeText(
        summary({
          status: "running",
          endedAt: undefined,
          durationMs: undefined,
          startedAt: at(14, 18),
          current: { nodeId: "r", name: "Codex review", index: 3, total: 7 }
        }),
        NOW
      ),
      "Running · Step 3/7 · Codex review · 12m"
    );
    assert.equal(
      runOutcomeText(summary({ status: "skipped", skipReason: "overlap" }), NOW),
      "Skipped — the previous run was still going"
    );
    assert.equal(
      runOutcomeText(summary({ status: "skipped", skipReason: "missed" }), NOW),
      "Skipped — the daemon was down when it was due"
    );
  });
});

describe("accounts and hops", () => {
  it("names an account, the system login included", () => {
    assert.equal(accountText("claude", "acc-1", "jasperclaude"), "claude/jasperclaude");
    assert.equal(accountText("codex", "system"), "codex/system login");
    assert.equal(accountText("grok", "abc"), "grok/abc");
  });

  it("writes the hops in one line", () => {
    const hops = [
      hop({ accountLabel: "therealeduard465", endedAt: at(14, 10), reason: "usage_limit", resetsAt: at(22, 40) }),
      hop({ accountId: "acc-2", accountLabel: "jasperclaude", via: "switched", endedAt: at(14, 20) })
    ];
    assert.equal(
      hopsText(hops, { status: "succeeded", now: NOW }),
      "claude/therealeduard465 → usage limit (resets 22:40) → claude/jasperclaude → finished"
    );
    assert.equal(
      hopsText(hops, { status: "running", now: NOW }),
      "claude/therealeduard465 → usage limit (resets 22:40) → claude/jasperclaude → working"
    );
    assert.equal(hopCountText(hops), "1 hop");
    assert.equal(hopCountText([hops[0]!]), "");
    assert.equal(hopsText([], {}), "");
  });

  it("ends the chain on its own reason when it failed there", () => {
    const hops = [
      hop({ accountLabel: "a", reason: "usage_limit" }),
      hop({ agent: "codex", accountLabel: "b", via: "handoff", reason: "auth" })
    ];
    assert.equal(hopsText(hops, { status: "failed", now: NOW }), "claude/a → usage limit → codex/b → sign-in failed");
  });

  it("says the account decision and each skip", () => {
    const decision = {
      chosen: { agent: "claude", model: "opus", accountId: "acc-2", accountLabel: "jasperclaude", chainIndex: 0 },
      reason: "soonest weekly reset (4d 2h) under 85%",
      skipped: [
        { agent: "claude", accountId: "acc-1", label: "eduard", why: "threshold" as const, detail: "weekly 90% ≥ 85%" }
      ]
    };
    assert.equal(selectionText(decision, NOW), "claude/jasperclaude · opus — soonest weekly reset (4d 2h) under 85%");
    assert.equal(skipText(decision.skipped[0]!), "claude/eduard — over its usage threshold (weekly 90% ≥ 85%)");
    assert.equal(
      selectionText(
        { chosen: null, reason: "every account is over its threshold", skipped: [], earliestResetAt: at(22, 40) },
        NOW
      ),
      "No eligible account — every account is over its threshold · earliest reset 22:40"
    );
    assert.equal(selectionText(null), "");
  });

  it("gives an agent and a wait their live line", () => {
    assert.equal(agentLiveLine(block("a", { status: "running", startedAt: at(14, 18) }), NOW), "Working · 12m");
    assert.equal(
      agentLiveLine(block("a", { status: "waiting", startedAt: at(14, 0), waitingUntil: at(22, 40) }), NOW),
      "Waiting for a reset · until 22:40"
    );
    assert.equal(agentLiveLine(block("a"), NOW), null);
    assert.equal(
      waitLine(block("w", { status: "waiting", waitingUntil: at(17, 30) }), NOW),
      "Waiting until 17:30 · 3h left"
    );
  });
});

describe("the timeline", () => {
  // Manual → Build → IF(ok) ─true→ Deploy ─→ Notify
  //                        └false→ Alert ──→ Notify (a join)
  const workflow = {
    nodes: [
      node("Start", "trigger.manual"),
      node("Build", "shell"),
      node("Ok", "if"),
      node("Deploy", "agent", { position: { x: 0, y: 0 } }),
      node("Alert", "http", { position: { x: 0, y: 100 } }),
      node("Notify", "code"),
      node("Sticky", "note")
    ],
    edges: [
      edge("Start", "Build"),
      edge("Build", "Ok"),
      edge("Ok", "Deploy", "true"),
      edge("Ok", "Alert", "false"),
      edge("Deploy", "Notify"),
      edge("Alert", "Notify")
    ]
  };

  it("walks the steps in outline order, branches indented under their handle", () => {
    const items = runTimeline({ status: "running", blocks: {} }, workflow, NOW);
    const steps = items.filter((item) => item.kind === "step");
    assert.deepEqual(
      steps.map((item) => [item.nodeId, item.depth, item.branchLabel ?? null]),
      [
        ["Start", 0, null],
        ["Build", 0, null],
        ["Ok", 0, null],
        ["Deploy", 1, "true"],
        ["Alert", 1, "false"],
        ["Notify", 0, null]
      ]
    );
    // The join appears once, and each branch leading to it says it continues there.
    assert.equal(items.filter((item) => item.kind === "join-ref").length, 2);
    assert.equal(
      steps.every((item) => item.total === 6),
      true
    );
    assert.equal(steps.find((item) => item.nodeId === "Start")?.step, 1);
    // A note is not a step.
    assert.equal(
      items.some((item) => item.nodeId === "Sticky"),
      false
    );
  });

  it("carries each block's state, timing, hops, error and skip reason", () => {
    const blocks = {
      Start: block("Start", { type: "trigger.manual", startedAt: at(14, 0), endedAt: at(14, 0) }),
      Build: block("Build", { type: "shell", startedAt: at(14, 0), endedAt: at(14, 1), attempt: 2 }),
      Ok: block("Ok", { type: "if", handle: "false", startedAt: at(14, 1), endedAt: at(14, 1) }),
      Deploy: block("Deploy", { type: "agent", status: "skipped" }),
      Alert: block("Alert", {
        type: "http",
        status: "failed",
        handle: "error",
        error: { kind: "http_status", message: "503 Service Unavailable" },
        startedAt: at(14, 1),
        endedAt: at(14, 1, 2)
      })
    };
    const items = runTimeline({ status: "failed", blocks }, workflow, NOW);
    const byId = (id: string) => items.find((item) => item.kind === "step" && item.nodeId === id)!;
    assert.equal(byId("Build").attempt, 2);
    assert.equal(byId("Build").durationMs, 60_000);
    assert.equal(byId("Deploy").skippedReason, "Ok went to false");
    assert.equal(byId("Alert").error, "503 Service Unavailable");
    assert.equal(byId("Alert").errorKind, "http_status");
    assert.equal(byId("Alert").finishedOn, "failure");
    // Never reached before the run ended.
    assert.equal(byId("Notify").notReached, true);
    assert.equal(byId("Notify").status, "skipped");
    assert.equal(byId("Notify").skippedReason, "Not reached");
    assert.equal(defaultSelectedStep(items), "Alert");
    assert.equal(blockSkipReason(workflow, blocks, "Deploy"), "Ok went to false");
  });

  it("shows a working agent's account, hops and activity", () => {
    const blocks = {
      Start: block("Start"),
      Build: block("Build"),
      Ok: block("Ok", { handle: "true" }),
      Deploy: block("Deploy", {
        type: "agent",
        status: "running",
        startedAt: at(14, 18),
        activity: "Editing src/app.ts",
        sessionId: "s2",
        hops: [
          hop({ accountLabel: "a", reason: "usage_limit", endedAt: at(14, 20) }),
          hop({ accountLabel: "b", via: "switched", sessionId: "s2" })
        ]
      })
    };
    const items = runTimeline({ status: "running", blocks }, workflow, NOW);
    const deploy = items.find((item) => item.nodeId === "Deploy" && item.kind === "step")!;
    assert.equal(deploy.account, "claude/b");
    assert.equal(deploy.hopCount, 1);
    assert.equal(deploy.liveLine, "Editing src/app.ts");
    assert.equal(deploy.durationMs, 12 * 60_000);
    assert.equal(deploy.view.live, true);
    assert.equal(defaultSelectedStep(items), "Deploy");
    // Still-pending blocks of a live run are pending, not "not reached".
    const notify = items.find((item) => item.nodeId === "Notify" && item.kind === "step")!;
    assert.equal(notify.status, "pending");
    assert.equal(notify.notReached, false);
  });

  it("builds a block's input from its live upstreams", () => {
    const blocks = {
      Start: block("Start", { output: { kind: "manual", input: { ticket: "APP-1" } } }),
      Build: block("Build", { output: { stdout: "ok", exitCode: 0 } }),
      Ok: block("Ok", { handle: "true", output: { stdout: "ok" } }),
      Deploy: block("Deploy", { output: { text: "done" } }),
      Alert: block("Alert", { status: "skipped" })
    };
    const run = {
      status: "running" as const,
      blocks,
      triggerPayload: { kind: "manual" as const, input: { ticket: "APP-1" } }
    };
    assert.deepEqual(blockInput(run, workflow, "Start"), {
      kind: "trigger",
      value: { kind: "manual", input: { ticket: "APP-1" } },
      truncated: false,
      from: []
    });
    assert.deepEqual(blockInput(run, workflow, "Build").value, { kind: "manual", input: { ticket: "APP-1" } });
    // Only the edge the IF took is live.
    assert.equal(blockInput(run, workflow, "Deploy").kind, "single");
    assert.equal(blockInput(run, workflow, "Alert").kind, "none");
    // Notify: Deploy's output arrived, Alert was skipped.
    const notify = blockInput(run, workflow, "Notify");
    assert.equal(notify.kind, "single");
    assert.deepEqual(notify.value, { text: "done" });
  });

  it("merges several live inputs by name", () => {
    const wf = {
      nodes: [node("T", "trigger.manual"), node("A", "code"), node("B", "code"), node("M", "merge")],
      edges: [edge("T", "A"), edge("T", "B"), edge("A", "M"), edge("B", "M")]
    };
    const blocks = { T: block("T"), A: block("A", { output: 1 }), B: block("B", { output: 2, outputTruncated: true }) };
    const input = blockInput({ blocks }, wf, "M");
    assert.equal(input.kind, "merge");
    assert.deepEqual(input.value, { A: 1, B: 2 });
    assert.equal(input.truncated, true);
  });
});

describe("actions", () => {
  it("offers what makes sense now", () => {
    assert.deepEqual(runActions(summary({ status: "running" }), {}), {
      cancel: true,
      retry: false,
      retryFromFailed: false,
      deleteTempProject: false
    });
    const failed = summary({ status: "failed", tempProject: { path: "/w/tmp/x", deleted: false } });
    assert.deepEqual(runActions(failed, { a: block("a", { status: "failed" }) }), {
      cancel: false,
      retry: true,
      retryFromFailed: true,
      deleteTempProject: true
    });
    assert.equal(runActions(failed, { a: block("a") }).retryFromFailed, false);
    assert.equal(runActions(summary({ tempProject: { path: "/x", deleted: true } }), {}).deleteTempProject, false);
  });

  it("retries with the same input, or from the same event", () => {
    const manual = summary({ trigger: { kind: "manual", nodeId: "Start" } });
    assert.deepEqual(retryRunRequest(manual, { kind: "manual", input: { ticket: "APP-1" } }), {
      input: { ticket: "APP-1" }
    });
    const git = summary({ trigger: { kind: "git", nodeId: "OnTag" }, test: true });
    assert.deepEqual(
      retryRunRequest(git, {
        kind: "git",
        event: "tag",
        repo: { url: "u", name: "n" },
        ref: "refs/tags/v1",
        sha: "abc"
      }),
      { test: true, retryOf: "run-1", fromNodeId: "OnTag" }
    );
    assert.deepEqual(retryRunRequest(manual, null), {});
    assert.deepEqual(retryFromFailedRequest(manual), { retryOf: "run-1" });
    assert.deepEqual(retryFromFailedRequest(git), { retryOf: "run-1", test: true });
  });
});

describe("the runs list", () => {
  const runs = [
    summary({ id: "a", status: "running" }),
    summary({ id: "b", status: "failed" }),
    summary({ id: "c", status: "interrupted" }),
    summary({ id: "d", status: "stopped" }),
    summary({ id: "e", status: "skipped", skipReason: "overlap" })
  ];

  it("filters by status and counts each filter", () => {
    assert.deepEqual(
      filterRuns(runs, "failed").map((run) => run.id),
      ["b", "c"]
    );
    assert.deepEqual(
      filterRuns(runs, "succeeded").map((run) => run.id),
      ["d"]
    );
    assert.deepEqual(
      filterRuns(runs, "active").map((run) => run.id),
      ["a"]
    );
    assert.deepEqual(runFilterCounts(runs), { all: 5, active: 1, succeeded: 1, failed: 2, cancelled: 0, skipped: 1 });
  });

  it("merges the live page with older pages, the live copy winning, newest first", () => {
    const live = [summary({ id: "new", startedAt: at(14, 20), status: "running" })];
    const older = [
      summary({ id: "old", startedAt: at(13, 0) }),
      summary({ id: "new", startedAt: at(14, 20), status: "queued" }),
      summary({ id: "mid", startedAt: at(13, 30), status: "running" })
    ];
    const known = (id: string) =>
      id === "mid" ? summary({ id: "mid", startedAt: at(13, 30), status: "failed" }) : undefined;
    const merged = mergeRunPages(live, older, known);
    assert.deepEqual(
      merged.map((run) => [run.id, run.status]),
      [
        ["new", "running"],
        ["mid", "failed"],
        ["old", "succeeded"]
      ]
    );
  });
});
