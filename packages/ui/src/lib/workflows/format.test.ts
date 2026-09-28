import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowRunSummary, WorkflowSummary } from "@orquester/api";

import {
  filterWorkflows,
  liveRunOf,
  runElapsedMs,
  triggerErrorsOf
} from "./format.ts";
import { initialNewWorkflowDraft, resolveNewWorkflow } from "./new-workflow.ts";
import { blankWorkflowRequest } from "./templates.ts";

const NOW = new Date(2026, 8, 28, 14, 30, 0).getTime(); // local time, Mon 28 Sep 2026 14:30

function summary(overrides: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    name: overrides.id,
    enabled: true,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/acme/app" },
    triggers: [],
    nodeCount: 1,
    errorCount: 0,
    activeRuns: [],
    createdAt: "",
    updatedAt: "",
    ...overrides
  };
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "r",
    workflowId: "w",
    workflowName: "",
    status: "running",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: new Date(NOW - 12 * 60_000).toISOString(),
    startedAt: new Date(NOW - 12 * 60_000).toISOString(),
    ...overrides
  };
}

describe("runs", () => {
  it("times a run: its duration once ended, the time so far while running", () => {
    assert.equal(runElapsedMs(run(), NOW), 12 * 60_000);
    assert.equal(runElapsedMs(run({ status: "succeeded", durationMs: 4_000 }), NOW), 4_000);
    assert.equal(runElapsedMs(run({ status: "failed", startedAt: undefined }), NOW), null);
  });

  it("shows the running run over a queued one", () => {
    const queued = run({ id: "q", status: "queued" });
    const running = run({ id: "r", status: "running" });
    assert.equal(liveRunOf(summary({ id: "w", activeRuns: [queued, running] }))?.id, "r");
    assert.equal(liveRunOf(summary({ id: "w" })), null);
  });
});

describe("the list", () => {
  const list = [
    summary({ id: "a", name: "Nightly", triggers: [{ nodeId: "t", type: "trigger.schedule", text: "Every night" }] }),
    summary({ id: "b", name: "Elsewhere", project: { kind: "existing", projectPath: "/w/acme/other/" } }),
    summary({
      id: "c",
      name: "Temp",
      project: { kind: "temp", workspace: "acme", source: { kind: "empty" } },
      activeRuns: [run()]
    })
  ];

  it("filters by scope, by running, and by the search", () => {
    assert.deepEqual(filterWorkflows(list, "all", "/w/acme/app", "").map((w) => w.id), ["a", "b", "c"]);
    assert.deepEqual(filterWorkflows(list, "project", "/w/acme/app/", "").map((w) => w.id), ["a"]);
    assert.deepEqual(filterWorkflows(list, "project", "/w/acme/other", "").map((w) => w.id), ["b"]);
    assert.deepEqual(filterWorkflows(list, "running", "/w/acme/app", "").map((w) => w.id), ["c"]);
    assert.deepEqual(filterWorkflows(list, "all", "", "NIGHT").map((w) => w.id), ["a"], "search reads trigger texts too");
  });
});

describe("new workflows", () => {
  it("a blank workflow is one manual trigger the daemon names and places, in the browser's time zone", () => {
    const project = { kind: "existing", projectPath: "/w/acme/app" } as const;
    assert.deepEqual(blankWorkflowRequest("  Deploy  ", project, "Europe/Madrid"), {
      name: "Deploy",
      project,
      settings: { timezone: "Europe/Madrid" },
      nodes: [{ type: "trigger.manual", config: {} }],
      autoLayout: true
    });
  });
});

describe("the New workflow form", () => {
  const P = "/w/acme/app";

  it("defaults to this project, and resolves each target", () => {
    const draft = { ...initialNewWorkflowDraft(P), name: " Nightly " };
    assert.deepEqual(resolveNewWorkflow(draft, P), {
      ok: true,
      name: "Nightly",
      project: { kind: "existing", projectPath: P }
    });
    assert.equal(initialNewWorkflowDraft("").target, "other", "no project open: pick one");
    assert.deepEqual(resolveNewWorkflow({ ...draft, target: "other", otherPath: "/w/acme/api" }, P), {
      ok: true,
      name: "Nightly",
      project: { kind: "existing", projectPath: "/w/acme/api" }
    });
    assert.deepEqual(
      resolveNewWorkflow({ ...draft, target: "temp", workspace: "acme", source: "clone", cloneUrl: " git@x:y.git ", cloneRef: "" }, P),
      {
        ok: true,
        name: "Nightly",
        project: { kind: "temp", workspace: "acme", source: { kind: "clone", url: "git@x:y.git" } }
      }
    );
  });

  it("names the first thing missing", () => {
    const draft = initialNewWorkflowDraft(P);
    assert.equal((resolveNewWorkflow(draft, P) as { field: string }).field, "name");
    const named = { ...draft, name: "X" };
    assert.equal(resolveNewWorkflow({ ...named, target: "other" }, P).ok, false);
    assert.equal((resolveNewWorkflow({ ...named, target: "temp" }, P) as { field: string }).field, "workspace");
    assert.equal(
      (resolveNewWorkflow({ ...named, target: "temp", workspace: "acme", source: "clone" }, P) as { field: string }).field,
      "cloneUrl"
    );
    assert.equal(resolveNewWorkflow({ ...named, name: "x".repeat(121) }, P).ok, false);
  });
});

describe("triggerErrorsOf", () => {
  it("maps each trigger whose last poll failed to its error, and nothing else", () => {
    const errors = triggerErrorsOf({
      triggers: [
        { nodeId: "git", lastError: "ls-remote: authentication failed" },
        { nodeId: "cron", lastError: null },
        { nodeId: "blank", lastError: "  " }
      ]
    });
    assert.deepEqual([...errors], [["git", "ls-remote: authentication failed"]]);
    assert.equal(triggerErrorsOf(null).size, 0);
  });
});
