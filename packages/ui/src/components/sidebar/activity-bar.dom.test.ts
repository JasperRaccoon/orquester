/**
 * The activity bar's "Projects & agents" dot in a DOM: an agent chat of a project that waits on
 * the user lights it; a Knowledge Graph worker chat (`owner.kind === "knowledge-indexer"`) never
 * does, whatever its activity says — it is the plugin's background machinery, not a project's
 * agent.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { SessionActivity } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ActivityBar: typeof import("./ActivityBar").ActivityBar;
let setSidebarView: typeof import("./sidebar-view").setSidebarView;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "Element", "Node", "navigator", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ActivityBar } = await import("./ActivityBar"));
  ({ setSidebarView } = await import("./sidebar-view"));
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

const WAITING = { state: "waiting", attention: "needs-input", needsAttentionAt: "2026-10-24T10:01:00.000Z" } as unknown as SessionActivity;
const chat = (id: string, projectPath: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "agent-chat",
  refId: "claude",
  title: id,
  projectPath,
  cwd: projectPath,
  status: "running",
  order: 0,
  createdAt: "2026-10-24T10:00:00.000Z",
  ...extra
});
const WORKER = chat("kg-worker", "/appdir/daemon/plugins/knowledge-graph/workers", { owner: { kind: "knowledge-indexer", runId: "kr_1" } });

describe("the activity bar's agents dot", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    // The dot shows only while another view is showing.
    setSidebarView("workflows");
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    setSidebarView("projects");
  });

  /** Whether the projects button carries its dot (a boolean: a failing assert never prints a DOM node). */
  const projectsDot = (): boolean => {
    const button = dom.window.document.querySelector('button[aria-label="Projects & agents"]');
    assert.ok(button, "the projects button");
    return button.querySelector("span") !== null;
  };

  const show = async (sessions: unknown[], activityById: Record<string, SessionActivity>) => {
    useAppStore.setState({
      workspaces: [{ name: "ws", path: "/w/ws", isArchived: false }] as never,
      projects: [{ name: "app", workspace: "ws", path: "/w/ws/app", isArchived: false }] as never,
      sessions: sessions as never,
      activityById
    });
    await act(async () => root.render(createElement(ActivityBar)));
  };

  it("is not lit by a worker chat that waits", async () => {
    await show([WORKER], { "kg-worker": WAITING });
    assert.equal(projectsDot(), false, "no dot");
  });

  it("is not lit by a worker chat that has exited", async () => {
    await show([{ ...WORKER, status: "exited" }], {});
    assert.equal(projectsDot(), false, "no dot");
  });

  it("is lit by a project's chat that waits, beside a waiting worker", async () => {
    await show([WORKER, chat("user-chat", "/w/ws/app")], { "kg-worker": WAITING, "user-chat": WAITING });
    assert.equal(projectsDot(), true, "a dot");
  });
});
