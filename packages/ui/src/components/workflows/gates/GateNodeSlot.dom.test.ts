/**
 * The decision in a block on the run canvas (spec 2026-11-10 §6.4): a click in
 * it is the decision's, never the block's (it neither selects nor opens it);
 * on a phone the block shows a 40 px "Decide" row that opens the whole card
 * in a bottom sheet.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { WorkflowGateState } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let slot: typeof import("./GateNodeSlot");
let PhoneLayoutContext: typeof import("../phone/phone-context").PhoneLayoutContext;
let OrquesterProvider: typeof import("../../../context/orquester-context").OrquesterProvider;
let store: typeof import("../../../lib/workflows/store");

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  slot = await import("./GateNodeSlot");
  ({ PhoneLayoutContext } = await import("../phone/phone-context"));
  ({ OrquesterProvider } = await import("../../../context/orquester-context"));
  store = await import("../../../lib/workflows/store");
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const gate: WorkflowGateState = {
  gateId: "g1",
  runId: "r1",
  workflowId: "wf-1",
  nodeId: "Gate",
  nodeName: "Gate",
  source: "gate",
  question: "Deploy v2?",
  choices: [
    { id: "approve", label: "Approve", color: "primary", comment: "none" },
    { id: "reject", label: "Reject", color: "danger", comment: "optional" }
  ],
  decider: { kind: "human", label: "you" },
  phase: "person",
  openedAt: "2026-11-10T09:55:00.000Z",
  escalated: false
};

let mount: HTMLDivElement;
let root: Root;
/** Clicks that reached the block around the slot (React Flow's node selects and opens on them). */
let blockClicks: number;

function render(phone: boolean): void {
  const canvas = { runId: "r1", definition: null, loopLimits: null, now: Date.parse("2026-11-10T10:00:00.000Z") };
  const block = createElement(
    "div",
    { "data-block": "", onClick: () => (blockClicks += 1), onDoubleClick: () => (blockClicks += 1) },
    createElement(slot.GateNodeSlot, { nodeId: "Gate", gateBlock: true })
  );
  act(() => {
    root.render(
      createElement(OrquesterProvider, {
        runtime: "web" as never,
        api: { connection: { id: "local" } } as never,
        useTitlebar: false,
        children: createElement(
          PhoneLayoutContext.Provider,
          { value: phone },
          createElement(slot.GateCanvasContext.Provider, { value: canvas }, block)
        )
      })
    );
  });
}

function buttons(): HTMLButtonElement[] {
  return [...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[];
}

function button(name: RegExp, within: ParentNode = dom.window.document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((candidate) =>
    name.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? "")
  );
  assert.ok(found, String(name));
  return found as HTMLButtonElement;
}

function click(target: Element, type = "click"): void {
  act(() => {
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, detail: 1 }));
  });
}

beforeEach(() => {
  store.resetWorkflows();
  store.workflowsStore.setState({ gates: { r1: { g1: gate } } });
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  blockClicks = 0;
});

afterEach(() => {
  act(() => root.unmount());
  store.resetWorkflows();
});

describe("the decision in a block on the run canvas", () => {
  it("on a desktop: the card's clicks stay the card's, and its targets are 32 px", () => {
    render(false);
    const approve = button(/^Approve/);
    assert.match(approve.className, /min-h-8/);
    click(approve);
    click(button(/^Reject/));
    click(button(/^Reject/), "dblclick");
    click(mount.querySelector("[data-gate-card]")!);
    assert.equal(blockClicks, 0, "the block is neither selected nor opened");
  });

  it("on a phone: a 40 px Decide row opens the whole card in a sheet", () => {
    render(true);
    const row = button(/^Decide: Deploy v2\?$/);
    assert.match(row.className, /min-h-10/);
    assert.equal(row.getAttribute("aria-haspopup"), "dialog");
    assert.equal(mount.querySelector("[data-gate-card]"), null, "no tiny card in the block");
    assert.equal(buttons().some((candidate) => /^Approve/.test(candidate.getAttribute("aria-label") ?? "")), false);

    click(row);
    const sheet = dom.window.document.querySelector('[role="dialog"]');
    assert.ok(sheet, "the sheet opened");
    assert.equal(sheet.getAttribute("aria-label"), "Deploy v2?");
    const approve = button(/^Approve/, sheet);
    assert.match(approve.className, /min-h-11/);
    // Clicks in the sheet (portaled out of the block) do not reach the block either.
    click(button(/^Reject/, sheet));
    assert.equal(blockClicks, 0, "the step's own sheet does not open over the decision");
  });
});
