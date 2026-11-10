/**
 * An edge's problem marker, mounted: a 20 px dot that opens the connection —
 * in a 40 px target on a touch screen — and a plain mark where the canvas is
 * read-only.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { CanvasActions } from "./canvas-context";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ProblemMarker: typeof import("./WorkflowEdge").ProblemMarker;
let CanvasActionsContext: typeof import("./canvas-context").CanvasActionsContext;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "MouseEvent", "Event"] as const;
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
  ({ ProblemMarker } = await import("./WorkflowEdge"));
  ({ CanvasActionsContext } = await import("./canvas-context"));
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
let openedEdges: string[];

function render(overrides: Partial<CanvasActions>): void {
  const actions = {
    readOnly: false,
    touch: false,
    openEdge: (edgeId: string) => openedEdges.push(edgeId),
    ...overrides
  } as CanvasActions;
  act(() => {
    root.render(
      createElement(
        CanvasActionsContext.Provider,
        { value: actions },
        createElement(ProblemMarker, { id: "e1", problem: { severity: "error", message: "Loops back to itself" } })
      )
    );
  });
}

beforeEach(() => {
  mount = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(mount);
  root = createRoot(mount);
  openedEdges = [];
});

afterEach(() => {
  act(() => root.unmount());
});

describe("an edge's problem marker", () => {
  it("on a touch screen: the 20 px dot sits in a 40 px target that opens the connection", () => {
    render({ touch: true });
    const button = mount.querySelector("button");
    assert.ok(button);
    assert.equal(button.getAttribute("aria-label"), "Problem: Loops back to itself — open this connection");
    assert.match(button.className, /\bh-10\b/);
    assert.match(button.className, /\bw-10\b/);
    assert.match(button.querySelector("span")?.className ?? "", /\bh-5 w-5\b/);
    act(() => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(openedEdges, ["e1"]);
  });

  it("with a mouse: the 20 px dot is the target", () => {
    render({ touch: false });
    assert.match(mount.querySelector("button")?.className ?? "", /\bh-5 w-5\b/);
  });

  it("read-only: a labelled mark, no button", () => {
    render({ readOnly: true, openEdge: null });
    assert.equal(mount.querySelector("button"), null);
    assert.equal(mount.querySelector('[role="img"]')?.getAttribute("aria-label"), "Problem: Loops back to itself");
  });
});
