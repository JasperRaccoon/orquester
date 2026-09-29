/**
 * Render smoke checks for the inspector's frame (`Inspector.tsx`), its "Run
 * behaviour" section (`CommonSettings.tsx`) and its Data tab (`DataTab.tsx`).
 *
 * `lib/workflows/run-behaviour.test.ts` and `inspector-data.test.ts` own the
 * rules (which time limit a block obeys, what can be pinned); this exists
 * because "a Run workflow block edits its time limit but an agent's stale one
 * is explained with a Clear", "the Output opens and the Input stays closed",
 * "a pinned block says so above the latest run" and "a problem bar counts
 * errors and warnings apart" are claims about MARKUP — a prop mistake
 * typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * A collapsed section renders no fields, so the field checks open "Run
 * behaviour" the way a picked problem does: with a pending `reveal`.
 */

import assert from "node:assert/strict";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Workflow, WorkflowBlockRun, WorkflowNode, WorkflowProblem, WorkflowRun, WorkflowRunSummary } from "@orquester/api";

import { OrquesterProvider } from "../../../context/orquester-context";
import type { ApiClient } from "../../../lib/api-client";
import type { WorkflowEditor } from "../../../lib/workflows/editor-store";
import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import { T0, edge, node, workflow } from "../../../lib/workflows/testing";
import { ReadOnlyFieldset, Section } from "../ui/controls";
import { CommonSettings } from "./CommonSettings";
import { DataTabView, type DataTabViewProps } from "./DataTab";
import { Inspector, ProblemBar, type InspectorProps } from "./Inspector";
import { InspectorContext, type InspectorContextValue } from "./inspector-context";

const NOOP = (): void => {};
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const EDITOR = { applyOps: () => null, change: () => true, flush: async () => {} } as unknown as WorkflowEditor;

const withApi = (element: ReactElement): string =>
  renderToStaticMarkup(h(OrquesterProvider, { runtime: "web", api: {} as ApiClient, useTitlebar: false, children: element }));

function inspect(
  target: WorkflowNode,
  element: ReactElement,
  extra: Partial<InspectorContextValue> & { wf?: Workflow } = {}
): string {
  const { wf, ...rest } = extra;
  const value: InspectorContextValue = {
    editor: EDITOR,
    workflow: wf ?? workflow([target]),
    node: target,
    readOnly: false,
    projectPath: "/w/ws/app",
    secretNames: [],
    scope: {} as InspectorContextValue["scope"],
    promptScope: {} as InspectorContextValue["promptScope"],
    problems: [],
    openSecrets: NOOP,
    reveal: null,
    revealField: NOOP,
    ...rest
  };
  return withApi(h(InspectorContext.Provider, { value }, element));
}

/** "Run behaviour", opened as a picked problem on `field` would open it. */
const common = (target: WorkflowNode, field = "notes", extra: Partial<InspectorContextValue> = {}): string =>
  inspect(target, h(CommonSettings), { reveal: { field, nonce: 1 }, ...extra });

// --- Run behaviour: summary and fields ---------------------------------------

{
  const html = inspect(node("c", "code", {}, { retry: { maxTries: 3, delaySeconds: 30 } }), h(CommonSettings));
  assert.ok(html.includes("Run behaviour"));
  assert.match(html, /aria-expanded="false"/, "Run behaviour starts collapsed");
  assert.ok(html.includes("Up to 3 tries, 30 s apart"), "a collapsed Run behaviour says what it holds");
  assert.ok(!html.includes("Disable this block"), "and renders no fields");
}

{
  const html = common(node("c", "code", {}, { retry: { maxTries: 3, delaySeconds: 30 } }), "retry");
  assert.match(html, /aria-expanded="true"/, "a reveal on retry opens the section");
  assert.ok(html.includes("data-wf-field=\"retry\""), "retry has an anchor");
  for (const field of ["disabled", "notes"]) assert.ok(html.includes(`data-wf-field="${field}"`), `${field} has an anchor`);
  assert.ok(html.includes("Run it up to") && html.includes("times in all,") && html.includes("between tries."), "retry reads as a sentence");
  assert.match(html, /aria-label="Tries in all"[^>]*value="3"/);
  assert.match(html, /aria-label="Wait between tries"[^>]*value="30"/);
  assert.match(html, /<option value="seconds" selected="">seconds<\/option>/, "30 s shows in seconds");
  assert.ok(html.includes("The first try counts"));
  assert.ok(!html.includes("usage limit"), "the usage-limit rule is only for agents");
  assert.ok(html.includes("data-wf-field=\"projectOverride\"") && html.includes("The workflow&#x27;s project (app)"), "code can run in another project");
  assert.ok(html.includes("For people reading this workflow"), "notes say who reads them");
  assert.ok(!html.includes("Time limit"), "Code without a block-level limit shows none (Limits owns it)");
}

{
  const html = common(node("a", "agent", {}, { retry: { maxTries: 2, delaySeconds: 120 } }), "retry");
  assert.ok(html.includes("A usage limit doesn&#x27;t use a try"), "agents explain how usage limits and retries meet");
  assert.match(html, /<option value="minutes" selected="">minutes<\/option>/, "120 s shows as 2 minutes");
}

// --- Run behaviour: who owns the time limit ----------------------------------

{
  const html = common(node("w", "workflow"), "timeoutMinutes");
  assert.ok(html.includes("data-wf-field=\"timeoutMinutes\""), "Run workflow anchors its time limit");
  assert.match(html, /aria-label="Time limit"/);
  assert.ok(html.includes("Default: none — it waits as long as the other workflow takes"));
  assert.ok(html.includes("its run is cancelled and this block fails"));
  assert.ok(!html.includes("data-wf-field=\"projectOverride\""), "Run workflow has no project of its own");
}

{
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "timeout_too_long", message: "Sub: the timeout is at most 1440 min", nodeId: "w", field: "timeoutMinutes" }
  ];
  const html = inspect(node("w", "workflow", {}, { timeoutMinutes: 2000, name: "Sub" }), h(CommonSettings), { problems });
  assert.match(html, /aria-expanded="true"/, "an error in the section opens it");
  assert.ok(html.includes("the timeout is at most 1440 min") && !html.includes("Sub: the timeout"), "the error shows under the field, name stripped");
}

{
  const html = common(node("c", "code", {}, { timeoutMinutes: 10 }), "timeoutMinutes");
  assert.ok(html.includes("Stops after 10 min"), "a legacy block-level limit still in effect says so");
  assert.ok(html.includes("Move to Limits") && html.includes("Clear (back to 30 min)"));
  assert.ok(!html.includes("aria-label=\"Time limit\""), "Code never edits the block-level limit");
}

{
  const html = common(node("h", "http", {}, { timeoutMinutes: 2 }), "timeoutMinutes");
  assert.ok(html.includes("Move to Response") && html.includes("Clear (back to 5 min)"));
}

{
  const html = common(node("s", "shell", { timeoutMinutes: 5 }, { timeoutMinutes: 10 }), "timeoutMinutes");
  assert.ok(html.includes("Unused time limit: 10 min"));
  assert.ok(html.includes("Timeout under Limits (5 min) is the limit this block uses"));
  assert.ok(html.includes("Clear it") && html.includes("Show the Timeout"));
}

{
  const html = common(node("a", "agent", { maxMinutes: 240 }, { timeoutMinutes: 120 }), "timeoutMinutes");
  assert.ok(html.includes("Unused time limit: 2 h"), "an agent's block-level limit is explained, not edited");
  assert.ok(html.includes("agents don&#x27;t read") && html.includes("The agent&#x27;s own time limit (4 h)"));
  assert.ok(html.includes("Show the agent&#x27;s limit"));
}

{
  const html = common(node("a", "agent"), "timeoutMinutes");
  assert.ok(!html.includes("time limit"), "an agent without one shows no time-limit row");
}

{
  const html = common(node("i", "if", {}, { timeoutMinutes: 3 }), "timeoutMinutes");
  assert.ok(html.includes("If blocks don&#x27;t use a block-level time limit") && html.includes("Clear it"));
  assert.ok(!html.includes("data-wf-field=\"projectOverride\""), "If has no project");
}

{
  const html = common(node("i", "if", {}, { projectOverride: "/w/ws/other" }), "projectOverride");
  assert.ok(html.includes("data-wf-field=\"projectOverride\""), "a stale project override on a type without one still shows");
  assert.ok(html.includes("doesn&#x27;t work in a project folder"));
}

{
  const html = common(node("t", "trigger.schedule", {}, { disabled: true }), "notes");
  assert.ok(html.includes("Status and notes") && html.includes("Disable this trigger"));
  assert.ok(!html.includes("Run it up to") && !html.includes("Try again if it fails"), "triggers have no retries");
}

// --- Read-only: view-only controls keep working ------------------------------

{
  const html = renderToStaticMarkup(
    h(ReadOnlyFieldset, { readOnly: true, children: h(Section, { title: "Limits", collapsible: true, defaultOpen: false, children: "BODY" }) })
  );
  assert.match(html, /<fieldset disabled="">/);
  assert.match(html, /<span role="button" tabindex="0" aria-expanded="false"/, "a read-only section toggle is not a disableable button");
  const editable = renderToStaticMarkup(
    h(ReadOnlyFieldset, { readOnly: false, children: h(Section, { title: "Limits", collapsible: true, defaultOpen: false, children: "BODY" }) })
  );
  assert.match(editable, /<button type="button" aria-expanded="false"/, "outside read-only it stays a button");
}

// --- Data tab ----------------------------------------------------------------

const summary = (overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id: "run-1",
  workflowId: "wf-1",
  workflowName: "Test",
  status: "succeeded",
  trigger: { kind: "manual" },
  test: false,
  queuedAt: T0,
  startedAt: T0,
  ...overrides
});

function blockRun(nodeId: string, name: string, type: WorkflowNode["type"], overrides: Partial<WorkflowBlockRun> = {}): WorkflowBlockRun {
  return { nodeId, name, type, status: "succeeded", attempt: 1, ...overrides };
}

function entry(wf: Workflow, blocks: Record<string, WorkflowBlockRun>, overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunEntry {
  const s = summary(overrides);
  const takenEdges = wf.edges.map((e) => e.id);
  const detail: WorkflowRun = { ...s, definition: wf, triggerPayload: null, blocks, takenEdges, deadEdges: [] };
  return { summary: s, detail, blocks, takenEdges, deadEdges: [], error: null };
}

const START = node("t", "trigger.manual", {}, { name: "Start" });
const FETCH = node("f", "http", {}, { name: "Fetch" });
const BASE = workflow([START, FETCH], [edge("t", "f")]);

function data(target: WorkflowNode, props: Partial<DataTabViewProps>, extra: Partial<InspectorContextValue> & { wf?: Workflow } = {}): string {
  return inspect(
    target,
    h(DataTabView, {
      latest: undefined,
      run: null,
      onOpenRun: NOOP,
      readWholeOutput: async () => null,
      startTest: async () => ({ runId: null }),
      now: NOW,
      ...props
    }),
    { wf: BASE, ...extra }
  );
}

{
  const html = data(FETCH, {});
  assert.ok(html.includes("Use this block&#x27;s data"));
  assert.ok(html.includes("{{ nodes.Fetch.output }}"), "the reference is a copyable chip");
  assert.ok(html.includes("What it outputs") && html.includes("{ status, headers, body }"), "the catalogue's output description shows before any run");
  assert.ok(html.includes("No run yet"));
  assert.ok(html.includes("Write sample output"), "a pin can be written without a run");
  assert.ok(html.includes("Runs only this block, for real") && html.includes("their pinned outputs where they have one"));
  assert.ok(html.indexOf("Latest run") < html.indexOf("Pinned output"), "without a pin, the pin section comes after the latest run");
}

{
  const run = entry(BASE, {
    t: blockRun("t", "Start", "trigger.manual", { output: { kind: "manual", input: null } }),
    f: blockRun("f", "Fetch", "http", { output: { status: 200 }, attempt: 2 })
  });
  const html = data(FETCH, { latest: run.summary, run });
  assert.ok(html.includes("Succeeded") && html.includes("2h ago"), "the latest run's status and age");
  assert.ok(html.includes("Open run"));
  assert.ok(html.includes("This block:") && html.includes("after 2 tries"));
  assert.match(html, /aria-expanded="false"[^>]*>[\s\S]*?Input[\s\S]*?from Start/, "the Input starts closed, saying where it came from");
  assert.match(html, /aria-expanded="true"[^>]*>[\s\S]*?Output/, "the Output starts open");
  assert.ok(html.includes("Pin this output"));
  assert.ok(html.includes("Use “Pin this output” above, or write one."));
}

{
  const wf = { ...BASE, pinned: { f: { status: 201 } } };
  const run = entry(BASE, { f: blockRun("f", "Fetch", "http", { status: "failed", error: { kind: "network", message: "ECONNREFUSED" } }) }, {
    status: "failed",
    test: true
  });
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "pinned_too_large", message: "Fetch: pinned data is limited to 1024 KiB of JSON", nodeId: "f", field: "pinned.f" }
  ];
  const html = data(FETCH, { latest: run.summary, run }, { wf, problems });
  assert.ok(html.includes("Pinned") && html.includes("Unpin") && html.includes("Edit"));
  assert.ok(html.indexOf("Pinned output") < html.indexOf("Latest run"), "a pinned block shows its pin above the latest run");
  assert.ok(html.includes("pinned data is limited to 1024 KiB"), "a pinned-data problem shows on the pin");
  assert.ok(html.includes("Test run"), "a test run is marked");
  assert.ok(html.includes("ECONNREFUSED"), "a failed block's error shows");
  assert.ok(html.includes("Its own pinned output isn&#x27;t used"), "the test says it runs the block even with a pin");
  assert.ok(!html.includes("Write sample output"));
}

{
  const html = data(START, {});
  assert.ok(html.includes("{{ trigger }}") && html.includes("{{ nodes.Start.output }}"), "a trigger offers both references");
  assert.ok(!html.includes("Pinned output"), "a trigger can't be pinned");
  assert.ok(html.includes("Runs only this trigger, as a manual test") && !html.includes("Its input comes from"), "a trigger's test says what it outputs");
}

{
  const gate = node("i", "if", {}, { name: "Gate" });
  const wf = workflow([START, gate], [edge("t", "i")]);
  const run = entry(wf, { i: blockRun("i", "Gate", "if", { output: { a: 1 }, handle: "true" }) });
  const html = data(gate, { latest: run.summary, run }, { wf });
  assert.ok(html.includes("An If block can&#x27;t be pinned"));
  assert.ok(!html.includes("Pin this output"), "no pin offered where the engine would ignore it");
}

{
  const end = node("s", "stop", {}, { name: "End" });
  const html = data(end, {}, { wf: workflow([START, end], [edge("t", "s")]) });
  assert.ok(html.includes("Nothing runs after it") && !html.includes("{{ nodes.End.output }}"));
}

{
  const run = entry(BASE, { f: blockRun("f", "Fetch", "http", { output: null }) });
  const html = data(FETCH, { latest: run.summary, run });
  assert.ok(!html.includes("Pin this output"), "a null output can't be pinned (set_pinned null unpins)");
  assert.ok(!html.includes("Use “Pin this output” above"));
}

{
  const html = data(FETCH, { latest: summary(), run: null });
  assert.ok(html.includes("Loading the latest run…"));
}

{
  const html = data(FETCH, {}, { readOnly: true });
  assert.ok(!html.includes("Test block") && !html.includes("Write sample output"), "read-only: nothing that edits or runs");
  assert.ok(html.includes("{{ nodes.Fetch.output }}"), "read-only: the reference is still there to copy");
}

// --- Problem bar ---------------------------------------------------------------

{
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "a", message: "X: first", nodeId: "x", field: "config.url" },
    { severity: "error", code: "b", message: "X: second", nodeId: "x", field: "config.method" },
    { severity: "warning", code: "c", message: "X: third", nodeId: "x" }
  ];
  const html = renderToStaticMarkup(h(ProblemBar, { problems, onPick: NOOP }));
  assert.ok(html.includes("2 errors · 1 warning"), "errors and warnings are counted apart");
  assert.match(html, /aria-expanded="false"/);
  assert.ok(!html.includes("first"), "the list stays folded");
  const single = renderToStaticMarkup(h(ProblemBar, { problems: [problems[2]!], onPick: NOOP, pickable: (p) => p.field !== undefined }));
  assert.ok(single.includes("third") && !single.includes("X: third"), "one problem shows at once, name stripped");
  assert.ok(!single.includes("<button"), "a problem with no field to go to is not a button");
}

// --- The frame -----------------------------------------------------------------

const frame = (props: Partial<InspectorProps>, wf: Workflow): string =>
  withApi(
    h(Inspector, {
      editor: EDITOR,
      workflow: wf,
      selectedIds: [],
      problems: [],
      readOnly: false,
      projectPath: "/w/ws/app",
      secretNames: [],
      onOpenSecrets: NOOP,
      onOpenRun: NOOP,
      onClose: NOOP,
      onDeleteSelection: NOOP,
      onDuplicateSelection: NOOP,
      onToggleDisabled: NOOP,
      onSelectNode: NOOP,
      ...props
    })
  );

{
  const a = node("a", "code", {}, { name: "A" });
  const b = node("b", "code", {}, { name: "B", disabled: true });
  const c = node("c", "shell", {}, { name: "C" });
  const wf = workflow([a, b, c]);
  assert.ok(frame({ selectedIds: ["a", "c"] }, wf).includes(">Disable<"), "all on: Disable");
  assert.ok(frame({ selectedIds: ["a", "b"] }, wf).includes(">Disable all<"), "mixed: Disable all");
  const off = workflow([{ ...a, disabled: true } as WorkflowNode, b]);
  assert.ok(frame({ selectedIds: ["a", "b"] }, off).includes(">Enable<"), "all off: Enable");
}

{
  const html = frame({}, workflow([START]));
  assert.ok(html.includes("Select a block to see its settings"));
}

{
  const merge = node("m", "merge", {}, { name: "Join", disabled: true });
  const wf = { ...workflow([START, merge], [edge("t", "m")]), pinned: { m: { a: 1 } } };
  const problems: WorkflowProblem[] = [
    { severity: "error", code: "x", message: "Join: broken", nodeId: "m", field: "config.mode" },
    { severity: "warning", code: "y", message: "Join: odd", nodeId: "m", field: "notes" }
  ];
  const html = frame({ selectedIds: ["m"], problems }, wf);
  assert.ok(html.includes("Used in templates as") && html.includes("nodes.Join"), "the name says how templates refer to it");
  assert.ok(html.includes('data-wf-field="name"'), "a problem on the name has somewhere to go");
  assert.ok(html.includes(">Merge<") && html.includes(" · Waits for every branch"), "the header gives the type and a summary");
  assert.ok(html.includes("About the Merge block"), "the full description is behind a help tip");
  assert.ok(html.includes("Pinned output") && html.includes(">Disabled<"), "pinned and disabled show as pills");
  assert.ok(html.includes("1 error · 1 warning"), "the problem bar counts both");
  assert.ok(html.includes("This block is disabled") && html.includes(">Enable<"), "a disabled block says so at the top of Settings");
  assert.match(html, /title="1 error"/, "the Settings tab carries an error pill");
  assert.match(html, /title="1 warning"/, "and a separate warning pill");
}
