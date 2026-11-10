/**
 * The agent block's Result section, mounted: each outcome and output row is
 * keyed by its entry, not its place, so what is typed in a row (a name that
 * cannot be applied yet) follows its entry when entries move or one is removed.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { AgentBlockConfig, Workflow, WorkflowNode } from "@orquester/api";

import { node, workflow } from "../../../lib/workflows/testing";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let AgentReportSection: typeof import("./AgentReportSettings").AgentReportSection;
let InspectorContext: typeof import("./inspector-context").InspectorContext;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
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
  ({ AgentReportSection } = await import("./AgentReportSettings"));
  ({ InspectorContext } = await import("./inspector-context"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let mount: HTMLDivElement;
let root: Root;
let current: Workflow;

function agent(): WorkflowNode {
  return current.nodes.find((candidate) => candidate.id === "fix")!;
}

/** The inspector around the section; the editor applies each change and draws again. */
function render(): void {
  const editor = {
    change: (recipe: (draft: Workflow) => Workflow) => {
      current = recipe(current);
      render();
    }
  };
  const value = {
    editor,
    workflow: current,
    node: agent(),
    readOnly: false,
    projectPath: "/w/ws/app",
    secretNames: [],
    scope: {},
    promptScope: {},
    problems: [],
    openSecrets: () => undefined,
    reveal: { field: "config.outputs", nonce: 1 }
  } as never;
  act(() => {
    root.render(
      createElement(InspectorContext.Provider, { value }, createElement(AgentReportSection, { config: agent().config as AgentBlockConfig }))
    );
  });
}

function input(label: string): HTMLInputElement {
  const found = mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(found, label);
  return found;
}

function type(target: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(target, value);
    target.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function click(label: string): void {
  const found = mount.querySelector(`button[aria-label="${label}"]`);
  assert.ok(found, label);
  act(() => {
    found.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function outputNames(): string[] {
  return ((agent().config as AgentBlockConfig).outputs ?? []).map((output) => output.name);
}

beforeEach(() => {
  current = workflow([
    node("fix", "agent", {
      outputs: [
        { name: "first", type: "string" },
        { name: "second", type: "string" },
        { name: "third", type: "string" }
      ]
    }, { name: "Fix" })
  ]);
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the Result section's rows", () => {
  it("a draft follows its output when the outputs move", () => {
    render();
    // A name that cannot be applied (another output's) stays as typed, with why.
    type(input("Output 1 name"), "third");
    assert.equal(input("Output 1 name").value, "third");
    assert.deepEqual(outputNames(), ["first", "second", "third"]);
    click("Move output second up");
    assert.deepEqual(outputNames(), ["second", "first", "third"]);
    assert.equal(input("Output 1 name").value, "second", "the moved-up output shows its own name");
    assert.equal(input("Output 2 name").value, "third", "the draft moved with its output");
  });

  it("a draft stays with its output when an earlier one is removed", () => {
    render();
    type(input("Output 3 name"), "second");
    click("Remove output first");
    assert.deepEqual(outputNames(), ["second", "third"]);
    assert.equal(input("Output 1 name").value, "second");
    assert.equal(input("Output 2 name").value, "second", "the draft kept on its output's row");
  });
});
