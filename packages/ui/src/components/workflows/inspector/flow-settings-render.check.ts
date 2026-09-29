/**
 * Render checks for the flow block forms (FlowSettings.tsx): If, Switch,
 * Merge, Stop, Wait, Run workflow and the sticky note.
 *
 * `lib/workflows/flow-settings.test.ts` owns the summaries and label notes;
 * this checks the claims about MARKUP: rules read in words with labelled
 * parts, a Switch case folds to its summary and opens when a problem is in
 * it, "skip" warns before it drops connections, Merge's output example uses
 * the real upstream names, the Wait time zone falls back to the workflow's,
 * Run workflow names a missing workflow, and every validated field is
 * anchored so picking a problem can focus it.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Workflow, WorkflowNode, WorkflowProblem } from "@orquester/api";

import { resetWorkflows, summaryFromRecord, workflowsStore } from "../../../lib/workflows/store";
import { edge, node, workflow } from "../../../lib/workflows/testing";
import { useAppStore } from "../../../store/app";
import {
  IfSettings,
  MergeSettings,
  NoteSettings,
  StopSettings,
  SubWorkflowSettings,
  SwitchSettings,
  WaitSettings
} from "./FlowSettings";
import { ReadOnlyFieldset } from "../ui/controls";
import { InspectorContext, type InspectorContextValue, type InspectorReveal } from "./inspector-context";

// Static rendering cannot run CodeMirror's layout effects.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
};

function problem(field: string, severity: WorkflowProblem["severity"], message: string, nodeId = "n1"): WorkflowProblem {
  return { severity, code: "test", message, nodeId, field };
}

function render(
  Form: React.FC,
  subject: WorkflowNode,
  options: { problems?: WorkflowProblem[]; reveal?: InspectorReveal | null; workflow?: Workflow; readOnly?: boolean } = {}
): string {
  const readOnly = options.readOnly ?? false;
  const value = {
    editor: { change: () => {} },
    workflow: options.workflow ?? workflow([subject]),
    node: subject,
    readOnly,
    projectPath: "/w/ws/app",
    secretNames: [],
    scope: {},
    promptScope: {},
    problems: options.problems ?? [],
    openSecrets: () => {},
    reveal: options.reveal ?? null,
    revealField: () => {}
  } as unknown as InspectorContextValue;
  // As the Inspector mounts Settings: inside a (read-only when asked) fieldset.
  return renderToStaticMarkup(h(InspectorContext.Provider, { value }, h(ReadOnlyFieldset, { readOnly, children: h(Form) })));
}

const has = (html: string, text: string, why?: string): void => assert.ok(html.includes(text), why ?? `markup has ${JSON.stringify(text)}`);
const lacks = (html: string, text: string, why?: string): void => assert.ok(!html.includes(text), why ?? `markup lacks ${JSON.stringify(text)}`);
const count = (html: string, text: string): number => html.split(text).length - 1;

try {
  // --- If ----------------------------------------------------------------------
  {
    const html = render(IfSettings, node("n1", "if", { rules: [{ left: "{{ input.status }}", op: "equals", right: "done" }] }));
    has(html, "Goes to True when the conditions hold, otherwise to False.");
    has(html, "Value");
    has(html, "Check");
    has(html, "Compared with");
    has(html, "Checks <code");
    has(html, "input.status = &quot;done&quot;", "the rule reads in words");
    has(html, 'aria-label="About how rules compare"');
    lacks(html, "True when: all or any rule", "one rule needs no all / any switch");
    lacks(html, "Remove rule", "the only rule can't be removed");
    has(html, 'data-wf-field="config.rules.0"');
  }
  {
    const html = render(
      IfSettings,
      node("n1", "if", {
        combine: "any",
        rules: [
          { left: "{{ input.a }}", op: "isEmpty" },
          { left: "{{ input.b }}", op: "gt", right: "3" }
        ]
      }),
      { problems: [problem("config.rules.1.left", "error", "Check: there is no block named \"X\"")] }
    );
    has(html, "aria-label=\"True when: all or any rule\"");
    has(html, "any rule holds");
    has(html, "Rule 2");
    assert.equal(count(html, "Compared with</span>"), 1, "a unary check has nothing to compare with");
    has(html, 'data-wf-field="config.rules.1.left"');
    has(html, "there is no block named");
    has(html, "input.b &gt; 3");
  }

  // --- Switch ------------------------------------------------------------------
  const cases = [
    { label: "bug", combine: "all", rules: [{ left: "{{ input.labels }}", op: "contains", right: "bug" }] },
    { label: "", combine: "all", rules: [{ left: "{{ input.kind }}", op: "equals", right: "docs" }] },
    { label: "Bug", combine: "any", rules: [{ left: "{{ input.a }}", op: "isTrue" }, { left: "{{ input.b }}", op: "isTrue" }] }
  ];
  {
    const html = render(SwitchSettings, node("n1", "switch", { cases, fallback: true }));
    has(html, "Checked top to bottom; the first case that matches picks the output.");
    assert.equal(count(html, 'aria-label="Show the rules of case'), 3, "several cases start folded");
    has(html, "input.labels contains &quot;bug&quot;", "a folded case shows its rule");
    has(html, "2 rules · any one is enough");
    has(html, "No label — its output is called “case 2”.");
    has(html, "Case 3 has the same label, so their outputs look alike on the canvas.");
    has(html, 'data-wf-field="config.cases.2.label"');
    lacks(html, "Picking this removes", "no default connection, nothing to warn about");
    has(html, 'aria-checked="true"');
    has(html, "Use a “default” output");
  }
  {
    // A problem in case 2 opens that card only; a default connection is named before "skip" drops it.
    const subject = node("n1", "switch", { cases, fallback: true });
    const wf = workflow([node("t", "trigger.manual"), subject, node("x", "stop")], [edge("t", "n1"), edge("n1", "x", "default")]);
    const html = render(SwitchSettings, subject, { workflow: wf, problems: [problem("config.cases.1.rules.0.left", "error", "Switch: broken")] });
    assert.equal(count(html, 'aria-label="Hide the rules of case'), 1, "only the case with the problem opens");
    has(html, 'aria-label="Hide the rules of case 2"');
    has(html, 'data-wf-field="config.cases.1.rules.0.left"');
    has(html, "broken");
    has(html, "Picking this removes the connection from its “default” output.");
  }
  {
    // Folding a case only changes the view: it still works on a read-only workflow (not a disabled <button>).
    const html = render(SwitchSettings, node("n1", "switch", { cases, fallback: true }), { readOnly: true });
    assert.match(html, /<span role="button"[^>]*aria-label="Show the rules of case 1"/);
  }
  {
    const one = render(SwitchSettings, node("n1", "switch", { cases: [cases[0]], fallback: false }));
    has(one, 'data-wf-field="config.cases.0.rules.0"', "a lone case starts open");
    has(one, "Skip everything after this block");
    assert.match(one, /role="radio" aria-checked="true"[^>]*>(?:(?!<\/button>).)*Skip everything after this block/s);
  }

  // --- Merge -------------------------------------------------------------------
  {
    const merge = node("m", "merge", {}, { name: "Join" });
    const wf = workflow(
      [node("t", "trigger.manual"), node("a", "http", {}, { name: "Fetch" }), node("b", "code", {}, { name: "Review" }), merge],
      [edge("t", "a"), edge("t", "b"), edge("a", "m"), edge("b", "m")]
    );
    const html = render(MergeSettings, merge, { workflow: wf });
    has(html, "Wait for every branch");
    has(html, "isn&#x27;t waited for");
    has(html, "Go on with the first branch");
    has(html, "{ &quot;Fetch&quot;: …, &quot;Review&quot;: … }");
    has(html, "{{ nodes.Join.output.Fetch }}");
    lacks(html, "Wire two or more branches");
    has(html, 'data-wf-field="config.mode"');
  }

  // --- Stop --------------------------------------------------------------------
  {
    const html = render(StopSettings, node("n1", "stop", { as: "failure", value: "{{ nodes.X.output }}" }), {
      problems: [problem("config.value", "error", "Done: there is no block named \"X\"")]
    });
    has(html, "blocks still running in other branches are cancelled");
    has(html, "Shown as Stopped in the run history");
    has(html, "Shown as Failed");
    has(html, 'data-wf-field="config.message"');
    has(html, 'data-wf-field="config.value"');
    has(html, "there is no block named");
    has(html, 'aria-label="About Final output"');
    has(html, "Left empty, this block&#x27;s input is the final output.");
  }

  // --- Wait --------------------------------------------------------------------
  {
    const html = render(WaitSettings, node("n1", "wait", { kind: "duration", minutes: 150 }));
    has(html, 'data-wf-field="config.minutes"');
    has(html, "= 2 h 30 min", "150 min reads as 2 h 30 min");
    has(html, "At most 7 days.");
    has(html, "Waits a set time, then passes its input on.");
  }
  {
    const html = render(WaitSettings, node("n1", "wait", { kind: "duration", minutes: 2880 }));
    assert.match(html, /<option value="days" selected="">days<\/option>/, "2880 min shows as 2 days");
  }
  {
    const subject = node("n1", "wait", { kind: "until", time: "18:30" });
    const wf = workflow([subject], [], { settings: { timezone: "Europe/Madrid" } });
    const html = render(WaitSettings, subject, { workflow: wf });
    has(html, 'value="18:30"');
    has(html, "If that time has already passed today, it waits until tomorrow.");
    has(html, '<option value="" selected="">The workflow&#x27;s time zone (Europe/Madrid)</option>', "no zone of its own: the workflow's");
    has(html, 'data-wf-field="config.timezone"');
    has(html, 'data-wf-field="config.time"');
    const labelled = /<select[^>]*aria-labelledby="([^"]+)"[^>]*><option value="" selected="">The workflow/.exec(html);
    assert.ok(labelled, "the time zone select is named by its Field label");
    const labelId = labelled![1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`<label id="${labelId}"[^>]*>Time zone</label>`));
  }
  {
    // An unknown zone stays selectable (so it isn't silently replaced) and its error shows.
    const subject = node("n1", "wait", { kind: "until", time: "09:00", timezone: "Mars/Olympus" });
    const html = render(WaitSettings, subject, { problems: [problem("config.timezone", "error", "Pause: unknown time zone \"Mars/Olympus\"")] });
    has(html, '<option value="Mars/Olympus" selected="">Mars/Olympus (unknown)</option>');
    has(html, "unknown time zone");
  }
  {
    // A valid zone this browser doesn't list (an alias like Etc/UTC or US/Pacific) is kept and not called unknown.
    const html = render(WaitSettings, node("n1", "wait", { kind: "until", time: "09:00", timezone: "US/Pacific" }));
    assert.match(html, /<option value="US\/Pacific" selected="">US\/Pacific<\/option>/);
    lacks(html, "(unknown)");
  }

  // --- Run workflow ------------------------------------------------------------
  {
    const child = workflow([node("t", "trigger.manual")], [], { id: "wf-child", name: "Nightly report", description: "Builds the report." });
    const broken = workflow([node("t", "trigger.manual")], [], { id: "wf-broken", name: "Broken one" });
    workflowsStore.setState({
      summaries: new Map([
        ["wf-child", summaryFromRecord(child)],
        ["wf-broken", { ...summaryFromRecord(broken), errorCount: 2 }]
      ]),
      load: { status: "loaded", error: null, refreshing: false, stale: false }
    });

    const missing = render(SubWorkflowSettings, node("n1", "workflow", { workflowId: "wf-gone" }));
    has(missing, "Missing workflow (id wf-gone)");
    has(missing, 'data-wf-field="config.workflowId"');
    has(missing, 'data-wf-field="config.input"');
    has(missing, "{{ trigger.input }}");
    lacks(missing, "Open</button>", "nothing to open for a missing workflow");

    const chosen = render(SubWorkflowSettings, node("n1", "workflow", { workflowId: "wf-child" }));
    has(chosen, "Builds the report.", "the target's description shows under the picker");
    lacks(chosen, "Open</button>", "no open action without a current project");

    // A server render reads a zustand store's INITIAL state object: give it a current project for this one render.
    const initial = useAppStore.getInitialState() as { currentProject: unknown };
    const before = initial.currentProject;
    initial.currentProject = { path: "/w/ws/app", name: "app", workspace: "ws" };
    try {
      const openable = render(SubWorkflowSettings, node("n1", "workflow", { workflowId: "wf-child" }));
      has(openable, "Open</button>", "an existing workflow opens in the current project");
    } finally {
      initial.currentProject = before;
    }

    const erroring = render(SubWorkflowSettings, node("n1", "workflow", { workflowId: "wf-broken" }));
    has(erroring, "“Broken one” has 2 errors; it won&#x27;t start until they&#x27;re fixed.");

    const unset = render(SubWorkflowSettings, node("n1", "workflow"));
    has(unset, "Pick a workflow");

    resetWorkflows();
  }

  // --- Sticky note -------------------------------------------------------------
  {
    const html = render(NoteSettings, node("n1", "note", { text: "Hello", color: "blue" }));
    has(html, 'aria-label="Yellow"');
    has(html, 'aria-label="Grey"');
    assert.match(html, /aria-checked="true" aria-label="Blue"/);
    has(html, ">Hello</textarea>");
  }
} finally {
  console.error = consoleError;
}
