/**
 * The Usage view in a DOM (a phone: jsdom has no media queries): its ways in and out (the
 * activity bar's button, the drawer's row, the top bar's header, the popover's "Open usage",
 * Settings → Usage), one server-level view at a time with Knowledge and the Devices fleet, and
 * the view's own wiring — the range it asks for, the tab it opens on, its shortcuts, and its
 * too-old, failed and scanning states. The figures themselves are the parts' (stubs here).
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { SessionSummary, UsageHistoryResponse, UsageResponse } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ActivityBar: typeof import("../sidebar/ActivityBar").ActivityBar;
let UsageDrawerEntry: typeof import("./UsageEntry").UsageDrawerEntry;
let UsageHeader: typeof import("./UsageEntry").UsageHeader;
let UsageView: typeof import("./UsageView").UsageView;
let UsageWidget: typeof import("../topbar/UsageWidget").UsageWidget;
let UsageSettings: typeof import("../settings/UsageSettings").UsageSettings;
let MainView: typeof import("../main/MainView").MainView;
let TopBar: typeof import("../topbar/TopBar").TopBar;
let OrquesterProvider: typeof import("../../context/orquester-context").OrquesterProvider;
let useAppStore: typeof import("../../store/app").useAppStore;
let ApiError: typeof import("../../lib/api-client").ApiError;

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
  ({ ActivityBar } = await import("../sidebar/ActivityBar"));
  ({ UsageDrawerEntry, UsageHeader } = await import("./UsageEntry"));
  ({ UsageView } = await import("./UsageView"));
  ({ UsageWidget } = await import("../topbar/UsageWidget"));
  ({ UsageSettings } = await import("../settings/UsageSettings"));
  ({ MainView } = await import("../main/MainView"));
  ({ TopBar } = await import("../topbar/TopBar"));
  ({ OrquesterProvider } = await import("../../context/orquester-context"));
  ({ useAppStore } = await import("../../store/app"));
  ({ ApiError } = await import("../../lib/api-client"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function answer(range: string, over: Partial<UsageHistoryResponse> = {}): UsageHistoryResponse {
  return {
    range,
    resolution: range === "24h" ? "hour" : "day",
    timeZone: "UTC",
    since: "2026-10-04T00:00:00.000Z",
    until: "2026-11-03T00:00:00.000Z",
    periods: ["2026-11-01", "2026-11-02"],
    buckets: [],
    projectBuckets: [],
    sessions: { total: 0, byAgent: {}, byModel: {}, byProject: {}, byProjectAgent: {} },
    sources: [],
    recordedSince: null,
    scanning: false,
    asOf: new Date().toISOString(),
    costSource: "api_equivalent",
    ...over
  };
}

interface FakeApi {
  /** `${range}:${force}` per history request. */
  calls: string[];
  /** The next history answers (or errors), in order; the last one repeats. */
  answers: Array<UsageHistoryResponse | Error>;
}

function fakeApi(answers: FakeApi["answers"] = []): FakeApi & ApiClient {
  const fake: FakeApi & Record<string, unknown> = {
    calls: [],
    answers,
    connection: { id: "c1" },
    async getUsageHistory(range: string, _timeZone: string, force?: boolean) {
      fake.calls.push(`${range}:${force === true}`);
      const next = fake.answers.length > 1 ? fake.answers.shift()! : (fake.answers[0] ?? answer(range));
      if (next instanceof Error) throw next;
      return { ...next, range };
    },
    async getUsage(): Promise<UsageResponse> {
      return { agents: [] };
    },
    async getUsageTokens() {
      return { rows: [], asOf: new Date().toISOString() };
    }
  };
  return fake as unknown as FakeApi & ApiClient;
}

const notFound = () => new ApiError(404, "GET", "/api/usage/history");

describe("the Usage view", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    localStorage.clear();
    useAppStore.setState({
      api: null,
      plugins: null,
      currentProject: null,
      currentWorkspace: null,
      recentProjects: [],
      knowledgeView: { open: false, focus: null },
      devicesFleetOpen: false,
      usageViewOpen: false,
      usageViewTab: null
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
    await settle();
  });

  const store = () => useAppStore.getState();
  const render = async (element: React.ReactElement) => {
    await act(async () => {
      root.render(element);
      await settle();
    });
  };
  const click = async (element: Element) => {
    await act(async () => {
      (element as HTMLElement).click();
      await settle();
    });
  };
  const buttonNamed = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name) ?? null;
  const checkedIn = (group: string) =>
    document.querySelector(`[role="radiogroup"][aria-label="${group}"] [aria-checked="true"]`)?.textContent ?? null;
  const press = async (init: KeyboardEventInit, target: EventTarget = window) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      await settle();
    });
  };

  it("the activity bar toggles it, the drawer row opens it, and the header closes it", async () => {
    await render(createElement("div", null, createElement(ActivityBar), createElement(UsageDrawerEntry), createElement(UsageHeader)));
    const [bar, row] = [...document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Usage" || b.textContent?.trim() === "Usage");
    assert.ok(bar && row, "offered with no plugin");

    await click(bar);
    assert.equal(store().usageViewOpen, true);
    assert.equal(bar.getAttribute("aria-pressed"), "true");
    await click(bar);
    assert.equal(store().usageViewOpen, false, "a second click goes back");

    useAppStore.setState({ sidebarDrawerOpen: true });
    await click(row);
    assert.equal(store().usageViewOpen, true);
    assert.equal(store().sidebarDrawerOpen, false);

    await click(buttonNamed("Close Usage")!);
    assert.equal(store().usageViewOpen, false);
  });

  it("is one server-level view at a time with Knowledge and the Devices fleet", () => {
    store().openKnowledge();
    store().openUsageView();
    assert.equal(store().usageViewOpen, true);
    assert.equal(store().knowledgeView.open, false, "Usage takes Knowledge's place");
    store().openDevicesFleet();
    assert.equal(store().devicesFleetOpen, true);
    assert.equal(store().usageViewOpen, false, "the fleet takes Usage's place");
    store().openUsageView();
    assert.equal(store().devicesFleetOpen, false, "and the other way round");
    store().openKnowledge();
    assert.equal(store().knowledgeView.open, true);
    assert.equal(store().usageViewOpen, false);
  });

  it("going to a tab or to another daemon leaves it", async () => {
    useAppStore.setState({ currentProject: { name: "app", workspace: "acme", path: "/w/acme/app" } as never, sessions: [] });
    store().openUsageView();
    store().activateTab("tab-1");
    assert.equal(store().usageViewOpen, false);

    const target = { id: "target", name: "Target", kind: "local", endpoint: "unix:/x", status: "disconnected" } as const;
    useAppStore.setState({ connect: async () => undefined, connectionStatus: "disconnected" });
    await store().initConnections({ localConnection: target, localTransporter: { kind: "stub" } as never, defaultUseTitlebar: false });
    useAppStore.setState({ activeConnectionId: "previous", connections: [target, { ...target, id: "previous" }], usageViewOpen: true });
    await store().selectConnection("target");
    assert.equal(store().usageViewOpen, false);
  });

  it("covers the main area under its own header in the shell", async () => {
    const api = fakeApi();
    useAppStore.setState({ api, activeConnectionId: "c1", sessions: [] as SessionSummary[] });
    await render(
      createElement(OrquesterProvider, {
        runtime: "web",
        api,
        useTitlebar: false,
        children: [createElement(TopBar, { key: "top" }), createElement(MainView, { key: "main" })]
      })
    );
    assert.equal(buttonNamed("Close Usage"), null);
    await act(async () => store().openUsageView());
    await act(async () => {
      await import("./UsageView");
      await settle();
    });
    assert.ok(buttonNamed("Close Usage"), "the header takes the project's place");
    assert.ok(document.querySelector("[data-usage-view]"), "the view mounts");
    assert.deepEqual(api.calls, ["30d:false"], "the default range");

    await click(buttonNamed("Close Usage")!);
    assert.equal(document.querySelector("[data-usage-view]"), null);
  });

  it("opens on the tab asked for, keeps the saved range, and switches by keyboard", async () => {
    localStorage.setItem("orquester:usage-view", JSON.stringify({ tab: "tokens", range: "7d" }));
    const api = fakeApi();
    useAppStore.setState({ api, activeConnectionId: "c1" });
    store().openUsageView("limits");
    await render(createElement(UsageView));
    assert.equal(checkedIn("Usage tab"), "Limits");
    assert.deepEqual(api.calls, ["7d:false"]);
    assert.equal(document.querySelector('[role="radiogroup"][aria-label="Period"]')?.closest('[aria-hidden="true"]') != null, true, "no period on Limits");

    await press({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true });
    assert.deepEqual(api.calls, ["7d:false"], "ranges do nothing on Limits");
    await press({ key: "c" });
    assert.equal(checkedIn("Usage tab"), "Cost");
    await press({ key: "$", code: "Digit4", ctrlKey: true, shiftKey: true });
    assert.equal(checkedIn("Period"), "90d");
    assert.equal(api.calls.at(-1), "90d:false");

    const input = document.createElement("input");
    document.body.appendChild(input);
    await press({ key: "t" }, input);
    assert.equal(checkedIn("Usage tab"), "Cost", "typing is not a shortcut");
    assert.deepEqual(JSON.parse(localStorage.getItem("orquester:usage-view")!), { tab: "cost", range: "90d", hiddenAgents: [], breakdown: "model" });

    // Asked again while it shows (the popover's link): the view moves to that tab.
    await act(async () => store().openUsageView("limits"));
    assert.equal(checkedIn("Usage tab"), "Limits");
  });

  it("says when the daemon is too old, and offers a retry that recovers after a failure", async () => {
    const old = fakeApi([notFound()]);
    useAppStore.setState({ api: old, activeConnectionId: "c1" });
    await render(createElement(UsageView));
    assert.ok(document.querySelector('[data-usage-notice="too-old"]'));
    assert.equal(buttonNamed("Retry"), null, "nothing to retry: the route is missing");
    await act(async () => root.unmount());

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const flaky = fakeApi([new Error("connection refused"), answer("30d")]);
    useAppStore.setState({ api: flaky });
    await render(createElement(UsageView));
    assert.ok(document.querySelector('[data-usage-notice="failed"]'));
    await click(buttonNamed("Retry")!);
    assert.equal(document.querySelector("[data-usage-notice]"), null);
    assert.deepEqual(flaky.calls, ["30d:false", "30d:false"]);
  });

  it("refetches a scanning answer with refresh=1, showing it updates meanwhile", async () => {
    let finish!: (value: UsageHistoryResponse) => void;
    const api = fakeApi([answer("30d", { scanning: true })]);
    const first = api.getUsageHistory.bind(api);
    api.getUsageHistory = ((range: string, timeZone: string, force?: boolean) =>
      force ? (api.calls.push(`${range}:true`), new Promise<UsageHistoryResponse>((resolve) => (finish = resolve))) : first(range, timeZone, force)) as never;
    useAppStore.setState({ api, activeConnectionId: "c1" });
    await render(createElement(UsageView));
    assert.deepEqual(api.calls, ["30d:false", "30d:true"]);
    assert.ok(document.querySelector('[role="status"]'), "updating");
    assert.equal(buttonNamed("Refresh usage")?.getAttribute("aria-busy"), "true");
    await act(async () => {
      finish(answer("30d"));
      await settle();
    });
    assert.equal(document.querySelector('[role="status"]'), null);
    assert.deepEqual(api.calls, ["30d:false", "30d:true"], "a fresh answer is not refetched");
  });

  it("the popover's Open usage and Settings → Usage open it", async () => {
    const usage: UsageResponse = {
      agents: [{ id: "claude", available: true, stale: false, session: { percent: 12 }, weekly: null, asOf: new Date().toISOString() }]
    };
    useAppStore.setState({ api: fakeApi(), usage });
    await render(createElement("div", null, createElement(UsageWidget), createElement(UsageSettings)));
    const chip = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-expanded") !== null || b.textContent?.includes("12%"))!;
    await click(chip);
    await click(buttonNamed("Open usage")!);
    assert.equal(store().usageViewOpen, true);
    assert.equal(store().usageViewTab, "limits", "from the Windows tab");
    assert.equal(buttonNamed("Open usage"), null, "the popover closed");

    store().closeUsageView();
    useAppStore.setState({ settingsOpen: true });
    await click(buttonNamed("View usage history")!);
    assert.equal(store().settingsOpen, false);
    assert.equal(store().usageViewOpen, true);
  });
});
