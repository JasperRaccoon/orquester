/**
 * The gate decision card, mounted (spec 2026-11-10 §6.4): one button per choice
 * saying where it leads, no focus taken when it appears, clicks ignored right
 * after it appears or changes, a comment box for a choice that asks for one
 * (Send off while a required one is empty), and the agent-phase note.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { WorkflowGateState } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let GateDecisionCard: typeof import("./GateDecisionCard").GateDecisionCard;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
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
  ({ GateDecisionCard } = await import("./GateDecisionCard"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const START = Date.parse("2026-11-10T10:00:00.000Z");
let clock = START;

function gate(overrides: Partial<WorkflowGateState> = {}): WorkflowGateState {
  return {
    gateId: "g1",
    runId: "r1",
    workflowId: "wf-1",
    nodeId: "Gate",
    nodeName: "Gate",
    source: "gate",
    question: "Deploy v2?",
    choices: [
      { id: "approve", label: "Approve", color: "primary", comment: "none" },
      { id: "reject", label: "Reject", color: "danger", comment: "optional" },
      { id: "hold", label: "Hold", comment: "required" }
    ],
    decider: { kind: "human", label: "you" },
    phase: "person",
    openedAt: "2026-11-10T09:55:00.000Z",
    escalated: false,
    ...overrides
  };
}

const DESTINATIONS = {
  approve: { kind: "next" as const, text: "→ Deploy", spoken: "goes on to Deploy" },
  reject: { kind: "loop" as const, text: "↺ Fix", spoken: "loops back to Fix" },
  hold: { kind: "end" as const, text: "→ End", spoken: "ends this path" }
};

let mount: HTMLDivElement;
let root: Root;
let decisions: [string, string | undefined][];

function render(value: WorkflowGateState, variant: "docked" | "sheet" | "node" = "docked"): void {
  act(() => {
    root.render(
      createElement(GateDecisionCard, {
        gate: value,
        title: value.question,
        destinations: DESTINATIONS,
        variant,
        now: START,
        clock: () => clock,
        onDecide: async (choice: string, comment: string | undefined) => {
          decisions.push([choice, comment]);
          return { ok: true as const };
        }
      })
    );
  });
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...dom.window.document.querySelectorAll("button")].find((candidate) =>
    name.test(candidate.getAttribute("aria-label") ?? candidate.textContent ?? "")
  );
  assert.ok(found, String(name));
  return found as HTMLButtonElement;
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function type(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  clock = START;
  decisions = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the gate decision card", () => {
  it("shows each choice with where it leads, and takes no focus", () => {
    render(gate());
    const text = mount.textContent ?? "";
    assert.match(text, /Deploy v2\?/);
    assert.match(text, /Approve→ Deploy/);
    assert.match(text, /Reject↺ Fix/);
    assert.match(text, /Hold→ End/);
    assert.equal(button(/^Approve, goes on to Deploy$/).getAttribute("aria-label"), "Approve, goes on to Deploy");
    assert.equal(button(/^Reject, loops back to Fix$/).getAttribute("aria-expanded"), "false");
    assert.equal(dom.window.document.activeElement, dom.window.document.body);
    assert.equal(mount.querySelector("[autofocus]"), null);
  });

  it("ignores a click right after it appears, then decides", async () => {
    render(gate());
    click(button(/^Approve/));
    await flush();
    assert.deepEqual(decisions, []);
    clock += 1_000;
    click(button(/^Approve/));
    await flush();
    assert.deepEqual(decisions, [["approve", undefined]]);
  });

  it("an optional comment: the box opens with focus, Send goes with or without text", async () => {
    render(gate());
    clock += 1_000;
    click(button(/^Reject/));
    const box = mount.querySelector("textarea");
    assert.ok(box);
    assert.equal(dom.window.document.activeElement, box);
    // The box appearing is a change: Send waits out the guard too.
    click(button(/^Send Reject$/));
    await flush();
    assert.deepEqual(decisions, []);
    clock += 1_000;
    type(box, "  needs a fix  ");
    click(button(/^Send Reject$/));
    await flush();
    assert.deepEqual(decisions, [["reject", "needs a fix"]]);
  });

  it("a required comment: Send stays off until there is one", async () => {
    render(gate());
    clock += 1_000;
    click(button(/^Hold/));
    const send = button(/^Send Hold$/);
    assert.equal(send.disabled, true);
    const box = mount.querySelector("textarea")!;
    type(box, "   ");
    assert.equal(button(/^Send Hold$/).disabled, true);
    type(box, "waiting on QA");
    assert.equal(button(/^Send Hold$/).disabled, false);
    clock += 1_000;
    click(button(/^Send Hold$/));
    await flush();
    assert.deepEqual(decisions, [["hold", "waiting on QA"]]);
  });

  it("Enter on a choice does nothing right after it appears", () => {
    render(gate());
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      button(/^Approve/).dispatchEvent(event);
    });
    assert.equal(event.defaultPrevented, true);
    clock += 2_000;
    const later = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      button(/^Approve/).dispatchEvent(later);
    });
    assert.equal(later.defaultPrevented, false);
  });

  it("says an agent is deciding, and that the user may decide first", () => {
    render(gate({ phase: "agent", decider: { kind: "agent", label: "Reviewer (claude)" } }));
    assert.match(mount.textContent ?? "", /Reviewer \(claude\) is deciding; you can decide first\./);
  });

  it("on a phone, every target is finger-sized", () => {
    render(gate(), "sheet");
    assert.match(button(/^Approve/).className, /min-h-11/);
  });
});
