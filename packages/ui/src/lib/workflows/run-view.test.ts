import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentHop, WorkflowBlockRun, WorkflowNode, WorkflowRunSummary } from "@orquester/api";

import {
  blockInput,
  defaultSelectedStep,
  filterRuns,
  mergeRunPages,
  retryFromFailedRequest,
  retryRunRequest,
  runActions,
  runFilterCounts,
  runTimeline
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

  it("preserves failed block details and distinguishes unreached steps in a finished run", () => {
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
    assert.equal(byId("Alert").error, "503 Service Unavailable");
    assert.equal(byId("Alert").errorKind, "http_status");
    // Never reached before the run ended.
    assert.equal(byId("Notify").notReached, true);
    assert.equal(byId("Notify").status, "skipped");
    assert.equal(defaultSelectedStep(items), "Alert");
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
    // Not loaded yet (undefined): never an empty request.
    assert.deepEqual(retryRunRequest({ ...manual, trigger: { kind: "manual", nodeId: "t" } }, undefined), { retryOf: manual.id, fromNodeId: "t" });
    assert.equal(retryRunRequest({ ...manual, trigger: { kind: "manual" } }, undefined), null);
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
