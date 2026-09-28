/**
 * Render smoke checks for the Automated workflows panel and its cards.
 *
 * `lib/workflows/*.test.ts` own the rules; this exists because "a running
 * card shows its step and a progress bar", "the empty state offers the three
 * starters", "every phone target is 40 px" and "the switch says whether the
 * workflow is enabled" are claims about MARKUP — a prop mistake typechecks
 * perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkflowRunSummary, WorkflowSummary } from "@orquester/api";

import type { WorkflowRunsList } from "../../../lib/workflows/store";
import { WorkflowCard, type WorkflowCardProps } from "./WorkflowCard";
import { WorkflowsPanelView, type WorkflowCardActions, type WorkflowsPanelViewProps } from "./WorkflowsPanelView";

const render = (element: ReactElement): string => renderToStaticMarkup(element);
const NOOP = (): void => {};
const NOW = Date.parse("2026-09-28T14:30:00.000Z");
const PROJECT = "/w/acme/app";

function run(overrides: Partial<WorkflowRunSummary> & { id: string }): WorkflowRunSummary {
  return {
    workflowId: "nightly",
    workflowName: "Nightly",
    status: "succeeded",
    trigger: { kind: "schedule", text: "Every 15 min" },
    test: false,
    queuedAt: "2026-09-28T14:00:00.000Z",
    startedAt: "2026-09-28T14:00:00.000Z",
    endedAt: "2026-09-28T14:03:00.000Z",
    durationMs: 180_000,
    ...overrides
  };
}

function workflow(overrides: Partial<WorkflowSummary> & { id: string; name: string }): WorkflowSummary {
  return {
    enabled: true,
    revision: 3,
    project: { kind: "existing", projectPath: PROJECT },
    triggers: [
      {
        nodeId: "t1",
        type: "trigger.schedule",
        text: "Every 15 min",
        nextRunAt: "2026-09-28T14:45:00.000Z"
      }
    ],
    nodeCount: 5,
    errorCount: 0,
    activeRuns: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const IDLE = workflow({
  id: "nightly",
  name: "Nightly review",
  lastRun: run({ id: "r1", status: "failed" })
});
const RUNNING = workflow({
  id: "tagger",
  name: "Release-tag reviewer",
  triggers: [{ nodeId: "g", type: "trigger.git", text: "New tag v* · acme/app" }],
  activeRuns: [
    run({
      id: "r2",
      workflowId: "tagger",
      status: "running",
      endedAt: undefined,
      durationMs: undefined,
      startedAt: "2026-09-28T14:18:00.000Z",
      current: { nodeId: "n3", name: "Codex review", index: 3, total: 7 }
    })
  ]
});
const OFF = workflow({ id: "off", name: "Paused thing", enabled: false, errorCount: 2, triggers: [] });

const ACTIONS: WorkflowCardActions = {
  toggleExpanded: NOOP,
  setEnabled: NOOP,
  run: NOOP,
  edit: NOOP,
  openRun: NOOP,
  duplicate: NOOP,
  remove: NOOP,
  retryRuns: NOOP
};

const card = (overrides: Partial<WorkflowCardProps> & Pick<WorkflowCardProps, "workflow">): string =>
  render(
    createElement(WorkflowCard, {
      variant: "docked",
      now: NOW,
      expanded: false,
      runs: null,
      starting: false,
      editDisabledReason: null,
      onToggleExpanded: NOOP,
      onToggleEnabled: NOOP,
      onRun: NOOP,
      onEdit: NOOP,
      onOpenRun: NOOP,
      onDuplicate: NOOP,
      onDelete: NOOP,
      onRetryRuns: NOOP,
      ...overrides
    })
  );

const panel = (overrides: Partial<WorkflowsPanelViewProps> = {}): string =>
  render(
    createElement(WorkflowsPanelView, {
      variant: "docked",
      query: "",
      onQueryChange: NOOP,
      filter: "all",
      onFilterChange: NOOP,
      projectAvailable: true,
      workflows: [IDLE, RUNNING, OFF],
      total: 3,
      runningCount: 1,
      status: "loaded",
      loadError: null,
      onRetry: NOOP,
      now: NOW,
      expandedId: null,
      expandedRuns: null,
      startingIds: new Set<string>(),
      editDisabledReason: null,
      actions: ACTIONS,
      notice: null,
      onNoticeAction: NOOP,
      onDismissNotice: NOOP,
      onNew: NOOP,
      onSecrets: NOOP,
      onTemplate: NOOP,
      creatingTemplate: null,
      ...overrides
    })
  );

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

{
  const html = card({ workflow: IDLE });
  assert.ok(html.includes('aria-label="Nightly review"'), "the card is named after its workflow");
  assert.ok(/role="switch" aria-checked="true" aria-label="Enable Nightly review"/.test(html), "the switch says it is on");
  assert.ok(html.includes("Every 15 min · next"), "its trigger in words, with its next run");
  assert.ok(html.includes("Failed") && html.includes("bg-danger"), "its last run's status and dot");
  assert.ok(html.includes(">Run now<") && html.includes(">Edit<"), "Run now and Edit");
  assert.ok(html.includes("More actions for Nightly review"), "the more menu is named");
  assert.ok(html.includes('aria-expanded="false"'), "collapsed");
  assert.ok(!html.includes('role="progressbar"'), "no live line while idle");
}

{
  const html = card({ workflow: RUNNING });
  assert.ok(html.includes("Step 3/7 · Codex review · 12m"), "the live line: step, block, time so far");
  assert.ok(/role="progressbar"[^>]*aria-valuenow="36"/.test(html), "a determinate bar at the step's middle");
  assert.ok(html.includes("bg-info/10 text-info"), "the tile turns to the running tone");
  assert.ok(html.includes("New tag v* · acme/app"), "a git trigger in words");
}

{
  const html = card({ workflow: OFF, editDisabledReason: "Open a project to edit workflows in it" });
  assert.ok(/role="switch" aria-checked="false"/.test(html), "off");
  assert.ok(html.includes(">Off<") && html.includes(">2 problems<"), "says it is off, and why it may not turn on");
  assert.ok(html.includes("Manual only"), "no trigger reads as manual only");
  assert.ok(html.includes("Never run"));
  assert.ok(/<button[^>]*disabled=""[^>]*title="Open a project to edit workflows in it"/.test(html), "Edit says why not");
}

{
  const runs: WorkflowRunsList = {
    status: "loaded",
    error: null,
    refreshing: false,
    stale: false,
    before: null,
    runs: [run({ id: "a", status: "succeeded" }), run({ id: "b", status: "cancelled", test: true, trigger: { kind: "manual" } })]
  };
  const html = card({ workflow: IDLE, expanded: true, runs });
  assert.ok(html.includes('aria-expanded="true"') && html.includes("Recent runs"), "expanded: its recent runs");
  assert.ok(html.includes("Every 15 min") && html.includes("Run now") && html.includes(" · test"), "each run's trigger");
  assert.ok(html.includes(">3m<"), "and its duration");
  const loading = card({ workflow: IDLE, expanded: true, runs: null });
  assert.ok(loading.includes("Loading runs…"));
}

{
  // A phone: every target is at least 40 px.
  const html = card({ workflow: IDLE, variant: "sheet" });
  const switchTag = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
  assert.ok(/\bh-10\b/.test(switchTag), "the switch's target is 40 px on a phone");
  const runTag = html.match(/<button[^>]*>(?:(?!<button).)*Run now/)?.[0] ?? "";
  assert.ok(/\bh-10\b/.test(runTag), "Run now is 40 px");
  assert.ok(/h-10 w-10[^"]*"[^>]*title="More actions"|title="More actions"[^>]*h-10 w-10/.test(html), "the more menu is 40 px");
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

{
  const html = panel();
  assert.ok(html.includes('aria-label="Search workflows"'), "a search field");
  assert.ok(html.includes("New<span class=\"sr-only\"> workflow</span>"), "New workflow");
  assert.ok(html.includes(">All<") && html.includes(">This project<") && html.includes(">Running · 1<"), "the filter");
  assert.equal((html.match(/data-workflow-card=/g) ?? []).length, 3, "a card per workflow");
  assert.ok(html.includes(">Secrets"), "Secrets in the footer");
}

{
  const html = panel({ workflows: [], total: 0 });
  assert.ok(html.includes("Automate this project"), "a designed empty state");
  assert.ok(html.includes("Start from scratch"));
  for (const title of ["Nightly agent task", "Jira ticket fixer", "Release-tag reviewer"]) {
    assert.ok(html.includes(title), `the ${title} starter`);
  }
  const noProject = panel({ workflows: [], total: 0, projectAvailable: false });
  assert.equal((noProject.match(/<button[^>]*disabled=""[^>]*title="Open a project to use a starter"/g) ?? []).length, 3);
}

{
  assert.ok(panel({ workflows: [], filter: "running" }).includes("Nothing is running"));
  assert.ok(panel({ workflows: [], query: "deploy" }).includes("No workflows match “deploy”"));
  assert.ok(panel({ status: "loading", workflows: [], total: 0 }).includes('aria-label="Loading workflows"'));
  const failed = panel({ status: "error", workflows: [], total: 0, loadError: "The daemon did not answer." });
  assert.ok(failed.includes("Couldn&#x27;t load workflows") && failed.includes("The daemon did not answer."));
  assert.ok(panel({ projectAvailable: false }).match(/<button[^>]*disabled=""[^>]*>This project</), "no project: no project filter");
}

{
  const html = panel({
    notice: { tone: "info", workflowId: "nightly", action: "run-anyway", text: "“Nightly” is already running." }
  });
  assert.ok(html.includes('role="status"') && html.includes("Run anyway"), "an overlap skip offers Run anyway");
  const error = panel({ notice: { tone: "error", text: "Couldn't run it: boom" } });
  assert.ok(error.includes('role="alert"') && !error.includes("Run anyway"));
}

console.log("workflows panel render checks passed");
