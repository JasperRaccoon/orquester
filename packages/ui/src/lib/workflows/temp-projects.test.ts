import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowRunSummary } from "@orquester/api";

import { isWorkflowTempProject, workflowTempProjects } from "./temp-projects.ts";

const run = (id: string, tempProject?: WorkflowRunSummary["tempProject"]): WorkflowRunSummary => ({
  id,
  workflowId: "wf",
  workflowName: "W",
  status: "running",
  trigger: { kind: "manual" },
  test: false,
  queuedAt: "2026-09-28T10:00:00.000Z",
  ...(tempProject ? { tempProject } : {})
});

describe("temporary workflow projects in the sidebar", () => {
  const known = workflowTempProjects({
    summaries: new Map([["wf", { activeRuns: [run("r-active", { path: "/w/ws/wf-nightly-aaaaaaaa/", deleted: false })], lastRun: run("deadbeef-1234") } as never]]),
    recentRuns: { wf: { runs: [run("r-gone", { path: "/w/ws/wf-old-bbbbbbbb", deleted: true })] } as never },
    runs: {}
  });

  it("marks a project a known run names as its temp project", () => {
    assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-nightly-aaaaaaaa", name: "wf-nightly-aaaaaaaa" }, known), true);
  });

  it("never a deleted one, and never a wf- folder on its name alone", () => {
    assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-old-bbbbbbbb", name: "wf-old-bbbbbbbb" }, known), false);
    assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-mine-12345678", name: "wf-mine-12345678" }, known), false);
  });
});
