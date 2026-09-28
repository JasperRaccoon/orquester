/**
 * Render smoke checks for the phone layout (workflows spec §7.4): the Steps
 * view of the Jira template, its empty states, the top bar, the view switch,
 * the floating toolbar and the key bar. Claims about MARKUP — every step has
 * its "+" per output and its ⋯, the chain reads flat with its failure handler
 * labelled, every touch target is finger-sized — that a prop mistake would
 * typecheck through while rendering nothing.
 *
 * Static markup only (no DOM, no effects, no portals), like every `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildTemplate, createWorkflowFromRequest, type Workflow } from "@orquester/api";

import { sequentialIds } from "../../../lib/workflows/testing";
import { StepsView } from "../steps/StepsView";
import { KeyBar } from "./KeyBar";
import { PhoneToolbar, PhoneTopBar, PhoneViewSwitch } from "./PhoneEditorChrome";

const render = (element: ReactElement): string => renderToStaticMarkup(element);
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const NOOP = (): void => {};
const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

const env = { mintId: sequentialIds("j"), now: new Date("2026-09-28T10:00:00.000Z") };
const jira = createWorkflowFromRequest(buildTemplate("jira-fixer", { projectPath: "/w/a/b", timezone: "UTC" }), env) as Workflow;

const steps = (workflow: Workflow, readOnly = false): string =>
  render(
    createElement(StepsView, {
      workflow,
      problems: [{ code: "x", severity: "error", nodeId: workflow.nodes.find((node) => node.name === "MarkDone")?.id, message: "MarkDone: the source is empty" }],
      summaryContext: {},
      selectedNodeId: workflow.nodes.find((node) => node.name === "FixTickets")?.id ?? null,
      readOnly,
      onOpenStep: NOOP,
      onAddAfter: NOOP,
      onAddFirst: NOOP,
      onStepMenu: NOOP
    })
  );

// --- Steps: the Jira template ------------------------------------------------

{
  const html = steps(jira);
  const words = text(html);
  for (const name of ["Every15Min", "FetchTickets", "FixTickets", "MarkDone", "Failed"]) {
    assert.match(html, new RegExp(`aria-label="${name} — open its settings"`), `${name} is a step card`);
    assert.match(html, new RegExp(`aria-label="More actions for ${name}"`), `${name} has its ⋯ (never long-press only)`);
  }
  assert.equal(count(html, /aria-label="Add a block after FetchTickets( · failure)?"/g), 2, "a + on each output");
  assert.match(words, /On failure → Failed/, "a connected failure output says where it goes");
  assert.match(words, /When FetchTickets, FixTickets or MarkDone fails/, "the shared failure handler says what leads to it");
  assert.doesNotMatch(words, /joins Failed/, "no row per failure edge");
  assert.match(html, /aria-current="true"/, "the open step is marked");
  assert.match(words, /the source is empty/, "a step's first problem shows under it");
  assert.match(html, /bg-danger-600/, "and its badge");
  // Flat: no step is indented (a staircase would pad-left the chain).
  assert.doesNotMatch(html, /data-step-id="[^"]+" style="padding-left:18px"/, "the chain is not a staircase");
  assert.ok(count(html, /min-h-|h-9|h-10|h-11/g) > 10, "finger-sized targets");
}

// --- Steps: read-only has no + ------------------------------------------------

{
  const html = steps(jira, true);
  assert.doesNotMatch(html, /aria-label="Add a block after/, "read-only offers no adding");
}

// --- Steps: empty, and a lone trigger ----------------------------------------

{
  const empty = { ...jira, nodes: [], edges: [] } as Workflow;
  const words = text(steps(empty));
  assert.match(words, /Add a trigger/);
  assert.match(words, /Or start with a step/);

  const trigger = jira.nodes.find((node) => node.name === "Every15Min")!;
  const lone = { ...jira, nodes: [trigger], edges: [] } as Workflow;
  assert.match(text(steps(lone)), /Add the first step/);
}

// --- Chrome ---------------------------------------------------------------------

{
  const top = render(
    createElement(PhoneTopBar, {
      name: "Jira ticket fixer",
      onRename: NOOP,
      enabled: false,
      onToggleEnabled: NOOP,
      enableRefusal: "Fix the problem marked in red to enable it.",
      saveState: "saved",
      onRetrySave: NOOP,
      readOnly: false,
      onBack: null,
      onClose: NOOP,
      onSettings: NOOP,
      onSecrets: NOOP,
      onRuns: NOOP,
      onTidy: NOOP,
      onUndo: NOOP,
      onRedo: NOOP,
      canUndo: true,
      canRedo: false
    })
  );
  assert.match(top, /aria-label="Close the workflow"/);
  assert.match(top, /role="switch"/);
  assert.match(top, /aria-label="More"/);
  assert.match(text(top), /Saved/);
  assert.ok(count(top, /h-11 w-11/g) >= 2, "44 px icon buttons");

  const views = render(createElement(PhoneViewSwitch, { view: "steps", onView: NOOP, liveRuns: 2 }));
  assert.match(views, /aria-checked="true"[^>]*>Steps/, "Steps first, and chosen");
  assert.match(views, /aria-label="2 running"/, "live runs show on Runs");

  const bar = (canvas: boolean): string =>
    render(
      createElement(PhoneToolbar, {
        canvas,
        readOnly: false,
        canUndo: true,
        canRedo: false,
        onAdd: NOOP,
        onUndo: NOOP,
        onRedo: NOOP,
        onFit: NOOP,
        onTidy: NOOP,
        onRun: NOOP,
        runRef: null
      })
    );
  const canvasBar = text(bar(true));
  for (const label of ["Add", "Undo", "Redo", "Fit", "Tidy", "Run"]) assert.match(canvasBar, new RegExp(label));
  assert.doesNotMatch(text(bar(false)), /Fit|Tidy/, "the Steps view has no canvas to fit");
  assert.match(bar(true), /aria-label="Redo" disabled=""/);
}

// --- The key bar ----------------------------------------------------------------------

{
  const html = render(createElement(KeyBar, { templates: true }));
  assert.match(html, /role="toolbar"/);
  assert.match(html, /data-key-id="expr"/);
  assert.match(html, /tabindex="-1"/, "keys never take focus from the editor");
  for (const char of ["{", "}", ";", "|", "$"]) assert.match(html, new RegExp(`data-key-id="\\${char}"`));
  assert.doesNotMatch(render(createElement(KeyBar, { templates: false })), /data-key-id="expr"/);
}

console.log("phone-render.check: ok");
