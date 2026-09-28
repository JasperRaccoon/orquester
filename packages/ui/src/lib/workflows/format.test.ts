import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowRunSummary, WorkflowSummary } from "@orquester/api";

import {
  filterWorkflows,
  formatAgo,
  formatDuration,
  formatNextRun,
  liveRunOf,
  runElapsedMs,
  runProgress,
  runStatusLabel,
  runStatusTone,
  runTriggerText,
  triggerLine,
  workflowInProject
} from "./format.ts";
import { initialNewWorkflowDraft, isValidSecretName, normalizeSecretName, resolveNewWorkflow } from "./new-workflow.ts";
import { blankWorkflowRequest, browserTimeZone, createFromTemplate, WORKFLOW_TEMPLATES } from "./templates.ts";

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

describe("durations and times", () => {
  it("formats a duration at a glance", () => {
    assert.equal(formatDuration(8_400), "8s");
    assert.equal(formatDuration(12 * 60_000 + 5_000), "12m");
    assert.equal(formatDuration(64 * 60_000), "1h 4m");
    assert.equal(formatDuration(2 * 3_600_000), "2h");
    assert.equal(formatDuration(51 * 3_600_000), "2d 3h");
    assert.equal(formatDuration(-1), "");
  });

  it("says how long ago, and nothing for garbage", () => {
    assert.equal(formatAgo(new Date(NOW - 20_000).toISOString(), NOW), "just now");
    assert.equal(formatAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW), "3m ago");
    assert.equal(formatAgo(new Date(NOW + 60_000).toISOString(), NOW), "just now", "clock skew clamps");
    assert.equal(formatAgo("not a date", NOW), "");
    assert.equal(formatAgo(undefined, NOW), "");
  });

  it("says when a trigger fires next, in local time", () => {
    const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 8, 28 + dayOffset, h, m).toISOString();
    assert.equal(formatNextRun(at(14, 45), NOW), "in 15m");
    assert.equal(formatNextRun(at(18, 0), NOW), "18:00");
    assert.equal(formatNextRun(at(9, 5, 1), NOW), "tomorrow 09:05");
    assert.equal(formatNextRun(at(9, 5, 3), NOW), "Thu 09:05");
    assert.equal(formatNextRun(at(9, 5, 10), NOW), "Oct 8");
    assert.equal(formatNextRun(at(14, 0), NOW), "due");
    assert.equal(formatNextRun(null, NOW), "");
  });

  it("writes a trigger line with its next run", () => {
    const nextRunAt = new Date(2026, 8, 28, 14, 45).toISOString();
    assert.equal(
      triggerLine({ nodeId: "t", type: "trigger.schedule", text: "Every 15 min", nextRunAt }, NOW),
      "Every 15 min · next in 15m"
    );
    assert.equal(triggerLine({ nodeId: "t", type: "trigger.git", text: "  " }, NOW), "On a git event");
  });
});

describe("runs", () => {
  it("names a status and its tone", () => {
    assert.equal(runStatusTone("succeeded"), "ok");
    assert.equal(runStatusTone("failed"), "danger");
    assert.equal(runStatusTone("running"), "info");
    assert.equal(runStatusTone("skipped"), "neutral");
    assert.equal(runStatusLabel({ status: "skipped", skipReason: "overlap" }), "Skipped · overlap");
    assert.equal(runStatusLabel({ status: "cancelled" }), "Cancelled");
  });

  it("times a run: its duration once ended, the time so far while running", () => {
    assert.equal(runElapsedMs(run(), NOW), 12 * 60_000);
    assert.equal(runElapsedMs(run({ status: "succeeded", durationMs: 4_000 }), NOW), 4_000);
    assert.equal(runElapsedMs(run({ status: "failed", startedAt: undefined }), NOW), null);
  });

  it("draws the live line and its bar", () => {
    const live = runProgress(run({ current: { nodeId: "n", name: "Codex review", index: 3, total: 7 } }), NOW);
    assert.equal(live.line, "Step 3/7 · Codex review · 12m");
    assert.ok(live.fraction !== null && live.fraction > 2 / 7 && live.fraction < 3 / 7);
    assert.deepEqual(runProgress(run({ status: "queued", startedAt: undefined }), NOW), {
      line: "Queued",
      fraction: null
    });
    assert.equal(runProgress(run(), NOW).line, "Starting · 12m");
  });

  it("names what started a run", () => {
    assert.equal(runTriggerText(run({ trigger: { kind: "schedule", text: "Every 15 min" } })), "Every 15 min");
    assert.equal(runTriggerText(run({ trigger: { kind: "manual" } })), "Run now");
    assert.equal(runTriggerText(run({ trigger: { kind: "test" } })), "Test run");
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

  it("matches a project by its path, never a temporary one", () => {
    assert.equal(workflowInProject(list[0]!, "/w/acme/app/"), true);
    assert.equal(workflowInProject(list[1]!, "/w/acme/other"), true, "trailing slashes do not matter");
    assert.equal(workflowInProject(list[2]!, "/w/acme/app"), false);
    assert.equal(workflowInProject(list[0]!, ""), false);
  });

  it("filters by scope, by running, and by the search", () => {
    assert.deepEqual(filterWorkflows(list, "all", "/w/acme/app", "").map((w) => w.id), ["a", "b", "c"]);
    assert.deepEqual(filterWorkflows(list, "project", "/w/acme/app", "").map((w) => w.id), ["a"]);
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
    assert.equal(blankWorkflowRequest("   ", project).name, "Untitled workflow");
    assert.equal(blankWorkflowRequest("x", project).settings?.timezone, browserTimeZone(), "defaults to this browser's zone");
  });

  it("a starter is named after its template (stubbed until buildTemplate lands)", () => {
    const project = { kind: "existing", projectPath: "/w/acme/app" } as const;
    assert.deepEqual(
      WORKFLOW_TEMPLATES.map((t) => t.title),
      ["Nightly agent task", "Jira ticket fixer", "Release-tag reviewer"]
    );
    assert.equal(createFromTemplate("jira-ticket-fixer", project).name, "Jira ticket fixer");
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
    assert.deepEqual(resolveNewWorkflow(draft, P), { ok: false, field: "name", message: "Give the workflow a name." });
    const named = { ...draft, name: "X" };
    assert.equal(resolveNewWorkflow({ ...named, target: "other" }, P).ok, false);
    assert.equal((resolveNewWorkflow({ ...named, target: "temp" }, P) as { field: string }).field, "workspace");
    assert.equal(
      (resolveNewWorkflow({ ...named, target: "temp", workspace: "acme", source: "clone" }, P) as { field: string }).field,
      "cloneUrl"
    );
    assert.equal(resolveNewWorkflow({ ...named, name: "x".repeat(121) }, P).ok, false);
  });

  it("reads secret names the daemon's way", () => {
    assert.equal(normalizeSecretName("jira token-2"), "JIRA_TOKEN_2");
    assert.equal(isValidSecretName("JIRA_TOKEN"), true);
    assert.equal(isValidSecretName("2FA"), false);
    assert.equal(isValidSecretName("lower"), false);
  });
});
