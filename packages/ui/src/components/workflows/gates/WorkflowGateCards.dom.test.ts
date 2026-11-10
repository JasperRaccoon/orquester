/**
 * A workflow's decisions in its rail card, mounted: "Open run" hands over the
 * gate itself, so a sub-workflow's gate opens its own (child) run in its own
 * workflow.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { WorkflowGateState } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let WorkflowGateCards: typeof import("./WorkflowGateCards").WorkflowGateCards;
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
  ({ WorkflowGateCards } = await import("./WorkflowGateCards"));
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

const T0 = "2026-11-10T10:00:00.000Z";

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
      { id: "reject", label: "Reject", color: "danger", comment: "optional" }
    ],
    decider: { kind: "human", label: "you" },
    phase: "person",
    openedAt: T0,
    escalated: false,
    ...overrides
  };
}

function summary(id: string, workflowId: string) {
  return { id, workflowId, workflowName: workflowId, status: "running" as const, trigger: { kind: "manual" as const }, test: false, queuedAt: T0, startedAt: T0 };
}

let mount: HTMLDivElement;
let root: Root;
let opened: WorkflowGateState[];

function render(): void {
  act(() => {
    root.render(
      createElement(OrquesterProvider, {
        runtime: "web" as never,
        api: { connection: { id: "local" } } as never,
        useTitlebar: false,
        children: createElement(WorkflowGateCards, {
          workflow: { id: "wf-1", name: "Release" },
          variant: "docked",
          now: Date.parse(T0),
          onOpenRun: (value: WorkflowGateState) => opened.push(value),
          openRunDisabledReason: null
        })
      })
    );
  });
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

beforeEach(() => {
  store.resetWorkflows();
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  opened = [];
});

afterEach(() => {
  act(() => root.unmount());
  store.resetWorkflows();
});

describe("a workflow's decisions in its rail card", () => {
  it("a sub-workflow's gate opens its own run, in its own workflow", () => {
    const child = gate({ runId: "child-run", workflowId: "wf-child", workflowName: "Deploy step", rootRunId: "root-run" });
    store.workflowsStore.setState({
      runs: {
        "root-run": { summary: summary("root-run", "wf-1"), detail: null, blocks: {}, takenEdges: [], deadEdges: [], error: null }
      },
      gates: { "child-run": { g1: child } }
    });
    render();
    const open = [...mount.querySelectorAll("button")].find((button) => /Open run/.test(button.textContent ?? ""));
    assert.ok(open, "the card shows its run link");
    click(open);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.runId, "child-run");
    assert.equal(opened[0]?.workflowId, "wf-child", "not the rail card's workflow");
  });
});
