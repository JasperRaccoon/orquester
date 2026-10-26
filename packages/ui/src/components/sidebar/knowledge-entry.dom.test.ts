/**
 * The ways to the server-level Knowledge view in a DOM: the activity bar's
 * Knowledge button (desktop) and the drawer's Knowledge row (phone). Both show
 * only while the Knowledge Graph plugin is on and are pressed while the view
 * shows; the button toggles it, the row opens it and closes the drawer.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { knowledgePlugin } from "../../lib/knowledge/fixtures.test-helpers";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ActivityBar: typeof import("./ActivityBar").ActivityBar;
let KnowledgeDrawerEntry: typeof import("./Sidebar").KnowledgeDrawerEntry;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
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
  ({ ActivityBar } = await import("./ActivityBar"));
  ({ KnowledgeDrawerEntry } = await import("./Sidebar"));
  ({ useAppStore } = await import("../../store/app"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("the Knowledge entry points", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    useAppStore.setState({ plugins: [knowledgePlugin(true)], knowledgeView: { open: false, focus: null }, currentProject: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
  });

  const render = async (element: React.ReactElement) => {
    await act(async () => root.render(element));
  };
  const knowledgeButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.getAttribute("aria-label") === "Knowledge" || b.textContent?.trim() === "Knowledge"
    ) ?? null;
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };

  it("the activity bar shows Knowledge only while the plugin is on", async () => {
    useAppStore.setState({ plugins: null });
    await render(createElement(ActivityBar));
    assert.equal(knowledgeButton(), null, "no plugins list yet");

    await act(async () => useAppStore.setState({ plugins: [knowledgePlugin(false)] }));
    assert.equal(knowledgeButton(), null, "plugin off");

    await act(async () => useAppStore.setState({ plugins: [knowledgePlugin(true)] }));
    assert.ok(knowledgeButton(), "plugin on");
  });

  it("the activity bar button toggles the view, pressed while it shows, without a project", async () => {
    await render(createElement(ActivityBar));
    const button = knowledgeButton()!;
    assert.equal(button.getAttribute("aria-pressed"), "false");

    await click(button);
    assert.equal(useAppStore.getState().knowledgeView.open, true);
    assert.equal(knowledgeButton()!.getAttribute("aria-pressed"), "true");

    await click(knowledgeButton()!);
    assert.equal(useAppStore.getState().knowledgeView.open, false);
    assert.equal(knowledgeButton()!.getAttribute("aria-pressed"), "false");
  });

  it("the drawer row opens the view and closes the drawer; it is gone with the plugin off", async () => {
    useAppStore.setState({ sidebarDrawerOpen: true });
    await render(createElement(KnowledgeDrawerEntry));
    await click(knowledgeButton()!);
    assert.equal(useAppStore.getState().knowledgeView.open, true);
    assert.equal(useAppStore.getState().sidebarDrawerOpen, false);
    assert.equal(knowledgeButton()!.getAttribute("aria-pressed"), "true");

    await act(async () => useAppStore.setState({ plugins: [knowledgePlugin(false)] }));
    assert.equal(knowledgeButton(), null);
    assert.equal(useAppStore.getState().knowledgeView.open, false, "the plugin turning off closes the view");
  });
});
