/**
 * Render smoke checks for the workflow editor's form primitives
 * (`ui/controls.tsx`) and the inspector-aware wrappers in
 * `inspector/inspector-context.tsx`.
 *
 * `lib/workflows/durations.test.ts` owns the unit arithmetic; this exists
 * because "a collapsed section shows its summary", "an error and a hint both
 * show, the hint last", "the label points at the input", "a picked problem
 * opens the section that holds it" are claims about MARKUP — a prop mistake
 * typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * Help tips' popovers are portals that mount only when open.
 */

import assert from "node:assert/strict";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkflowProblem } from "@orquester/api";

import {
  ConfigField,
  countProblems,
  InspectorContext,
  InspectorSection,
  type InspectorContextValue
} from "../inspector/inspector-context";
import {
  Callout,
  ChipGroup,
  CopyChip,
  Disclosure,
  DurationInput,
  Field,
  HelpTip,
  KeyValueTable,
  RadioCards,
  Section,
  Segmented,
  TextArea,
  TextInput,
  TimeInput
} from "./controls";

const render = (element: ReactElement): string => renderToStaticMarkup(element);
const NOOP = (): void => {};

/** The id a Field generated (its label is `<label id="<id>-label">`). */
function labelledField(html: string): string | undefined {
  return /<label id="([^"]+)-label"/.exec(html)?.[1];
}

/** The markup between the first `from` and the next `to` (a crude but readable scope). */
function slice(html: string, from: string): string {
  const at = html.indexOf(from);
  assert.notEqual(at, -1, `markup has ${from}`);
  return html.slice(at);
}

// --- Section ---------------------------------------------------------------

{
  const html = render(
    h(Section, {
      title: "Run behaviour",
      collapsible: true,
      defaultOpen: false,
      summary: "Retries 3× every 30 s · Timeout 30 min",
      description: "What happens when it fails or takes too long.",
      children: h("p", null, "BODY")
    })
  );
  assert.match(html, /aria-expanded="false"/);
  assert.ok(html.includes("Retries 3× every 30 s · Timeout 30 min"), "a collapsed section shows its summary");
  assert.ok(html.includes("What happens when it fails or takes too long."), "the description always shows");
  assert.ok(!html.includes("BODY"), "a collapsed section does not render its fields");
}

{
  const html = render(
    h(Section, { title: "Limits", collapsible: true, defaultOpen: true, summary: "HIDDEN SUMMARY", children: h("p", null, "BODY") })
  );
  assert.ok(html.includes("BODY"));
  assert.ok(!html.includes("HIDDEN SUMMARY"), "an open section does not repeat its summary");
}

{
  const html = render(
    h(Section, { title: "Limits", collapsible: true, defaultOpen: false, problems: { errors: 2, warnings: 1 }, children: h("p", null, "BODY") })
  );
  assert.ok(html.includes("BODY"), "a section with errors starts open");
  assert.ok(html.includes('title="2 errors"') && html.includes('title="1 warning"'), "error and warning pills");
  assert.ok(html.includes(" errors</span>"), "the count is named for screen readers");
}

{
  const html = render(
    h(Section, { title: "Limits", collapsible: true, defaultOpen: false, problems: { errors: 0, warnings: 2 }, children: h("p", null, "BODY") })
  );
  assert.ok(!html.includes("BODY"), "warnings alone do not open a section");
  assert.ok(html.includes('title="2 warnings"'));
}

{
  const html = render(h(Section, { title: "Plain", open: false, collapsible: true, children: h("p", null, "BODY") }));
  assert.ok(!html.includes("BODY"), "`open` controls it");
  const sticky = render(h(Section, { title: "Pinned", sticky: true, children: "x" }));
  assert.match(sticky, /sticky top-0/);
}

// --- Field + HelpTip ---------------------------------------------------------

{
  const html = render(
    h(Field, {
      label: "Timeout",
      help: "How long before it is stopped.",
      hint: "Counts from the first try.",
      error: "Must be at least 1 minute.",
      warning: "Longer than the workflow allows.",
      optional: true,
      defaultNote: "30 min",
      children: h(TextInput, { value: "", onValue: NOOP }),
    })
  );
  assert.ok(html.includes('aria-label="About Timeout"'), "help renders a HelpTip named after the label");
  assert.ok(!html.includes("How long before it is stopped."), "the help text waits for a click");
  assert.ok(html.includes(">optional<"));
  const error = html.indexOf("Must be at least 1 minute.");
  const warning = html.indexOf("Longer than the workflow allows.");
  const hint = html.indexOf("Counts from the first try.");
  assert.ok(error > 0 && warning > error && hint > warning, "error, then warning, then the hint — all shown");
  assert.ok(html.includes("Counts from the first try. · Default: 30 min"), "the default note follows the hint");
  const fieldId = labelledField(html);
  assert.ok(fieldId, "the label has an id");
  assert.ok(!html.includes("<label for="), "an auto-wired label never uses for= (it could dangle)");
  assert.ok(
    html.includes(`<input aria-describedby="${fieldId}-notes" aria-labelledby="${fieldId}-label" id="${fieldId}"`),
    "the input takes the field's id, is named by the label and described by the notes"
  );
  assert.ok(html.includes(`id="${fieldId}-notes"`));
}

{
  const html = render(
    h(Field, {
      label: "Two inputs",
      children: [h(TextInput, { key: "a", value: "", onValue: NOOP }), h(TextInput, { key: "b", value: "", onValue: NOOP })]
    })
  );
  const fieldId = labelledField(html);
  assert.equal(html.split(`id="${fieldId}"`).length - 1, 1, "only the first input takes the field's id");
  assert.equal(html.split(`aria-labelledby="${fieldId}-label"`).length - 1, 1, "and only it is named by the label");
}

{
  const html = render(h(Field, { label: "Explicit", htmlFor: "mine", children: h(TextInput, { id: "mine", value: "", onValue: NOOP }) }));
  assert.ok(html.includes('<label for="mine"') && html.includes('id="mine"'), "an explicit htmlFor/id pair is left alone");
  const plain = render(h(Field, { label: "Old", hint: "", error: null, children: "x" }));
  assert.ok(!plain.includes("-notes"), "an empty hint renders no notes");
}

{
  const html = render(h(HelpTip, { label: "Compare by", children: "Explained" }));
  assert.match(html, /aria-label="About Compare by"/);
  assert.match(html, /aria-expanded="false"/);
}

// --- Segmented / RadioCards / ChipGroup -------------------------------------

{
  const html = render(
    h(Segmented<"all" | "first">, {
      label: "Merge mode",
      value: "first",
      onChange: NOOP,
      wrap: true,
      options: [
        { id: "all", label: "All", description: "Waits for every branch." },
        { id: "first", label: "First", description: "Goes on with the first branch that arrives." }
      ]
    })
  );
  assert.ok(html.includes("Goes on with the first branch that arrives."), "the selected option's description shows");
  assert.ok(!html.includes("Waits for every branch."));
  assert.match(html, /flex-wrap/);
  const plain = render(h(Segmented<"a" | "b">, { label: "x", value: "a", onChange: NOOP, className: "mt-3", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }));
  assert.ok(plain.startsWith('<div role="radiogroup"') && plain.includes("mt-3"), "without descriptions it renders as before");
}

{
  const html = render(
    h(RadioCards<"least" | "soonest" | "fixed">, {
      ariaLabel: "Which account runs it",
      value: "least",
      onValue: NOOP,
      options: [
        { value: "least", label: "Most quota left", description: "Picks the account furthest from its limits.", children: h("p", null, "COMPARE BY") },
        { value: "soonest", label: "Quota that resets soonest", children: h("p", null, "RESET WINDOW") },
        { value: "fixed", label: "Fixed order", disabled: true, disabledReason: "Needs two accounts." }
      ]
    })
  );
  assert.match(html, /role="radiogroup" aria-label="Which account runs it"/);
  assert.equal(html.split('aria-checked="true"').length - 1, 1);
  assert.ok(html.includes("COMPARE BY") && !html.includes("RESET WINDOW"), "only the selected card shows its sub-choices");
  assert.ok(html.includes("Needs two accounts."), "the disabled reason is on the card");
  assert.equal(html.split('tabindex="0"').length - 1, 1, "one tab stop (roving)");
}

{
  const html = render(
    h(ChipGroup<"mon" | "tue" | "wed">, {
      ariaLabel: "Days of the week",
      values: ["mon"],
      min: 1,
      onValues: NOOP,
      options: [
        { value: "mon", label: "Mon" },
        { value: "tue", label: "Tue" },
        { value: "wed", label: "Wed" }
      ]
    })
  );
  assert.match(html, /role="group" aria-label="Days of the week"/);
  assert.equal(html.split('aria-pressed="true"').length - 1, 1);
  assert.equal(html.split('aria-pressed="false"').length - 1, 2);
  assert.ok(html.includes('title="Keep at least one"'), "the last pick says why it stays");
}

// --- DurationInput / TimeInput / TextArea -----------------------------------

{
  const hours = render(h(DurationInput, { value: 240, unit: "minutes", units: ["minutes", "hours"], onValue: NOOP, ariaLabel: "Stop after" }));
  assert.ok(hours.includes('value="4"'), "240 min shows as 4");
  assert.ok(/<option value="hours" selected="">hours<\/option>/.test(hours), "…in hours");
  assert.ok(!hours.includes("= "), "no readout when the unit says it plainly");

  const mixed = render(h(DurationInput, { value: 90, unit: "minutes", units: ["minutes", "hours"], onValue: NOOP }));
  assert.ok(mixed.includes('value="90"') && mixed.includes("= 1 h 30 min"), "90 min stays in minutes with a readout");

  const capped = render(h(DurationInput, { value: 10080, unit: "minutes", units: ["minutes", "hours", "days"], max: 10080, onValue: NOOP }));
  assert.ok(capped.includes('value="7"') && capped.includes("max 7 days"));
  assert.ok(/<option value="days" selected="">days<\/option>/.test(capped));

  const empty = render(h(DurationInput, { value: undefined, unit: "seconds", units: ["seconds", "minutes"], placeholder: "300", onValue: NOOP }));
  assert.ok(empty.includes('value=""') && empty.includes('placeholder="300"'));
  assert.ok(/<option value="seconds" selected="">seconds<\/option>/.test(empty));

  const inField = render(h(Field, { label: "Wait", children: h(DurationInput, { value: 5, unit: "minutes", units: ["minutes", "hours"], onValue: NOOP }) }));
  const fieldId = labelledField(inField);
  assert.equal(inField.split(`id="${fieldId}"`).length - 1, 1, "the number, not the unit select, takes the label");
  assert.ok(inField.includes(`<input id="${fieldId}"`));
  assert.ok(inField.includes(`aria-labelledby="${fieldId}-label"`), "the number is named by the label");
  const unitSelect = slice(inField, 'aria-label="Duration unit"');
  assert.ok(!unitSelect.slice(0, 200).includes("aria-labelledby"), "the unit select keeps its own name");
}

{
  const html = render(h(TimeInput, { value: "09:30", onValue: NOOP, ariaLabel: "Time" }));
  assert.ok(html.includes('type="time"') && html.includes('value="09:30"') && html.includes('aria-label="Time"'));
  const area = render(h(TextArea, { value: '{"a":1}', onValue: NOOP, mono: true, invalid: true, rows: 5 }));
  assert.ok(area.includes("font-mono") && area.includes("border-danger/60") && area.includes('rows="5"'));
}

// --- Callout / Disclosure / CopyChip / KeyValueTable ------------------------

{
  const html = render(h(Callout, { tone: "warn", title: "This block is disabled", action: h("button", null, "Enable"), children: "Runs skip it." }));
  assert.ok(html.includes("This block is disabled") && html.includes("Runs skip it.") && html.includes(">Enable<"));
  assert.match(html, /border-warn/);
}

{
  const closed = render(h(Disclosure, { summary: "2 changed", children: h("p", null, "INNER") }));
  assert.ok(closed.includes("More options") && closed.includes("2 changed") && !closed.includes("INNER"));
  const open = render(h(Disclosure, { label: "Advanced", defaultOpen: true, summary: "2 changed", children: h("p", null, "INNER") }));
  assert.ok(open.includes("Advanced") && open.includes("INNER") && !open.includes("2 changed"));
}

{
  const html = render(h(CopyChip, { text: "{{ nodes.Fetch.output }}" }));
  assert.ok(html.includes("{{ nodes.Fetch.output }}") && html.includes('aria-label="Copy {{ nodes.Fetch.output }}"'));
}

{
  const html = render(
    h(Field, {
      label: "Environment",
      children: h(KeyValueTable, {
        rows: [
          { name: "TOKEN", value: "{{ secrets.T }}" },
          { name: "bad name", value: "x" }
        ],
        onChange: NOOP,
        addLabel: "Add variable",
        rowMessage: (index: number) => (index === 1 ? { error: "Names are letters, digits and _.", warning: "Shadows a system variable." } : undefined)
      })
    })
  );
  const rowTwo = slice(html, 'value="bad name"');
  assert.ok(rowTwo.includes("Names are letters, digits and _.") && rowTwo.includes("Shadows a system variable."), "row messages sit under their row");
  assert.equal(html.split("Names are letters").length - 1, 1);
  const fieldId = labelledField(html);
  assert.ok(!html.includes(`id="${fieldId}"`), "table inputs never take the enclosing field's id");
  assert.ok(!html.includes("<label for=") && !html.includes("aria-labelledby"), "and the label points at nothing that isn't there");
}

// --- Inspector wrappers -------------------------------------------------------

function problem(field: string, severity: WorkflowProblem["severity"], message: string): WorkflowProblem {
  return { severity, code: "test", message, nodeId: "n1", field } as WorkflowProblem;
}

function inInspector(value: Partial<InspectorContextValue>, element: ReactElement): string {
  return render(h(InspectorContext.Provider, { value: { problems: [], reveal: null, ...value } as InspectorContextValue }, element));
}

{
  const problems = [
    problem("config.chain.0.model", "error", "Agent: pick a model."),
    problem("config.chain.1", "warning", "Agent: unknown account."),
    problem("retry.maxTries", "warning", "Too many tries."),
    problem("config.chainLength", "error", "Not under config.chain.")
  ];
  assert.deepEqual(countProblems(problems, ["config.chain"]), { errors: 1, warnings: 1 });
  assert.deepEqual(countProblems(problems, ["config.chain.0", "config.chain.0.model", "retry"]), { errors: 1, warnings: 1 });

  const withErrors = inInspector({ problems }, h(InspectorSection, { title: "Who runs it", anchors: ["config.chain"], summary: "S", children: h("p", null, "CHAIN") }));
  assert.ok(withErrors.includes("CHAIN") && withErrors.includes('title="1 error"') && withErrors.includes('title="1 warning"'));

  const quiet = inInspector({ problems }, h(InspectorSection, { title: "Run behaviour", anchors: ["timeoutMinutes"], summary: "Defaults", children: h("p", null, "BLOCK") }));
  assert.ok(!quiet.includes("BLOCK") && quiet.includes("Defaults"), "a section with no problems stays collapsed with its summary");

  const revealed = inInspector(
    { problems, reveal: { field: "timeoutMinutes", nonce: 3 } },
    h(InspectorSection, { title: "Run behaviour", anchors: ["timeoutMinutes", "retry"], children: h("p", null, "BLOCK") })
  );
  assert.ok(revealed.includes("BLOCK"), "a pending reveal under its anchors opens it");

  const field = inInspector(
    { problems: [problem("config.maxMinutes", "error", "Agent: at least 1."), problem("config.maxMinutes", "warning", "Overridden by the block timeout.")] },
    h(ConfigField, { path: "config.maxMinutes", label: "Stop after", hint: "Wall-clock time.", children: h(TextInput, { value: "", onValue: NOOP }) })
  );
  assert.ok(field.includes('data-wf-field="config.maxMinutes"'), "ConfigField anchors its path");
  assert.ok(field.includes(">at least 1.<") && field.includes("Overridden by the block timeout.") && field.includes("Wall-clock time."));
}

console.log("controls render checks passed");

{
  // A Field around a group (chips, radio cards): nothing claims the id, so the label names nothing — and points at nothing.
  const html = render(
    h(Field, {
      label: "Days",
      children: h(ChipGroup, { values: ["mon"], options: [{ value: "mon", label: "Mon" }], onValues: NOOP, ariaLabel: "Days" })
    })
  );
  assert.ok(html.includes('<label id="') && !html.includes("<label for="), "no dangling for= around a group");
  assert.ok(!html.includes("aria-labelledby"), "the group keeps its own aria-label");
  assert.match(html, /role="group" aria-label="Days"/);
}

// --- Re-picking the active choice changes nothing ------------------------------
// A static render has no clicks, so these call the component inside a probe (its hooks run in the
// probe's render) and press the returned buttons' onClick / onKeyDown by hand.

function elementsOf(node: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const child of node) elementsOf(child, found);
  else if (node !== null && typeof node === "object" && "props" in node) {
    const element = node as ReactElement<{ children?: unknown }>;
    found.push(element);
    elementsOf(element.props.children, found);
  }
  return found;
}

function probe(render: () => ReactElement): ReactElement[] {
  let tree: ReactElement | null = null;
  const Probe = (): null => {
    tree = render();
    return null;
  };
  renderToStaticMarkup(h(Probe));
  return elementsOf(tree);
}

const radios = (tree: ReactElement[]): ReactElement<Record<string, unknown>>[] =>
  tree.filter((element) => (element.props as Record<string, unknown>).role === "radio") as ReactElement<Record<string, unknown>>[];

{
  const picked: string[] = [];
  const tree = probe(() =>
    Segmented({
      label: "Kind",
      value: "a",
      onChange: (value: "a" | "b") => picked.push(value),
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" }
      ]
    })
  );
  const [a, b] = radios(tree);
  (a!.props.onClick as () => void)();
  assert.equal(picked.length, 0, "Segmented: clicking the active option does not call onChange");
  (b!.props.onClick as () => void)();
  assert.deepEqual(picked, ["b"], "Segmented: another option does");
}

{
  const picked: string[] = [];
  const onlyOne = probe(() =>
    RadioCards({
      ariaLabel: "Mode",
      value: "a",
      onValue: (value: "a" | "b") => picked.push(value),
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B", disabled: true }
      ]
    })
  );
  const [a, b] = radios(onlyOne);
  (a!.props.onClick as () => void)();
  const key = (name: string) => ({ key: name, preventDefault: NOOP }) as unknown;
  (a!.props.onKeyDown as (event: unknown) => void)(key("ArrowDown"));
  (a!.props.onKeyDown as (event: unknown) => void)(key("Home"));
  assert.equal(picked.length, 0, "RadioCards: re-picking the selected card (click or keys) does not call onValue");
  assert.ok(b, "the disabled card renders");
  const both = probe(() =>
    RadioCards({
      ariaLabel: "Mode",
      value: "a",
      onValue: (value: "a" | "b") => picked.push(value),
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" }
      ]
    })
  );
  const [, second] = radios(both);
  (second!.props.onClick as () => void)();
  assert.deepEqual(picked, ["b"], "RadioCards: another card does");
}
