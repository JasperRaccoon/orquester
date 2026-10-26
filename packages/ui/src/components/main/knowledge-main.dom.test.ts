/**
 * The server-level Knowledge view in the shell, in a DOM (a phone: jsdom has no
 * media queries): with no project open it takes the main area and the top bar
 * shows its header in the project's place; closing it brings the landing view
 * back. The view stays mounted while closed, hidden.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { ApiClient } from "../../lib/api-client";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let MainView: typeof import("./MainView").MainView;
let TopBar: typeof import("../topbar/TopBar").TopBar;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
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
  ({ MainView } = await import("./MainView"));
  ({ TopBar } = await import("../topbar/TopBar"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
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

describe("the Knowledge view in the shell", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    // No plugins list yet: the view shows its loading state, nothing is fetched.
    useAppStore.setState({ api: null, plugins: null, currentProject: null, currentWorkspace: null, recentProjects: [] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
  });

  const render = async () => {
    await act(async () =>
      root.render(
        createElement(OrquesterProvider, {
          runtime: "web",
          api: {} as ApiClient,
          useTitlebar: false,
          children: [createElement(TopBar, { key: "top" }), createElement(MainView, { key: "main" })]
        })
      )
    );
  };
  const text = () => document.body.textContent ?? "";
  const close = () => document.querySelector<HTMLButtonElement>('button[aria-label="Close Knowledge"]');
  /** Lets the lazy view's chunk resolve and render. */
  const loaded = async () => {
    for (let i = 0; i < 20 && !text().includes("Loading…"); i++) {
      await act(async () => new Promise<void>((resolve) => setImmediate(resolve)));
    }
  };

  it("fills the main area with no project open, under its own header, and closes back to the landing view", async () => {
    await render();
    assert.equal(close(), null);
    assert.match(text(), /Select a project/);

    await act(async () => useAppStore.getState().openKnowledge());
    await loaded();
    assert.ok(close(), "the header's close button");
    assert.doesNotMatch(text(), /Select a project/, "the header takes the project's place");
    assert.match(text(), /Loading…/, "the view itself");

    await act(async () => close()!.click());
    assert.equal(useAppStore.getState().knowledgeView.open, false);
    assert.equal(close(), null);
    assert.match(text(), /Select a project/);
    const view = [...document.querySelectorAll("main > div")];
    assert.equal(view.length, 2, "the landing view, and the Knowledge view kept mounted");
    assert.ok(view[1]!.className.split(" ").includes("hidden"), "hidden while closed");
  });
});
