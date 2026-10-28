/**
 * The Devices fleet view in a DOM: its ways in (the activity bar's button, the phone drawer's
 * row, the top bar's header), and the view itself over a loaded fleet — host cards with their
 * actions, lease cards with chat links and polled thumbnails — plus its loading, error and
 * empty states. jsdom has no IntersectionObserver, so every card counts as on screen.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { DEVICES_PLUGIN_ID, type DevicesStateResponse, type PluginInfo, type SessionSummary } from "@orquester/api";

import type { ApiClient } from "../../lib/api-client";
import { knowledgePlugin } from "../../lib/knowledge/fixtures.test-helpers";
import { fixtureLease, fleetFixture } from "./fixtures.test-helpers";
import type { ThumbnailDeps } from "./thumbnail-poller";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ActivityBar: typeof import("../sidebar/ActivityBar").ActivityBar;
let DevicesDrawerEntry: typeof import("./DevicesFleetEntry").DevicesDrawerEntry;
let DevicesFleetHeader: typeof import("./DevicesFleetEntry").DevicesFleetHeader;
let DevicesFleetView: typeof import("./DevicesFleetView").DevicesFleetView;
let useAppStore: typeof import("../../store/app").useAppStore;
let resetDevices: typeof import("../../lib/devices/store").resetDevices;
let takeSessionDeepLink: typeof import("../../lib/session-deep-link").takeSessionDeepLink;
let selectedDeviceLease: typeof import("../../lib/devices/panel-focus").selectedDeviceLease;
let resetDevicePanelFocus: typeof import("../../lib/devices/panel-focus").resetDevicePanelFocus;

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
  ({ DevicesDrawerEntry, DevicesFleetHeader } = await import("./DevicesFleetEntry"));
  ({ DevicesFleetView } = await import("./DevicesFleetView"));
  ({ useAppStore } = await import("../../store/app"));
  ({ resetDevices } = await import("../../lib/devices/store"));
  ({ takeSessionDeepLink } = await import("../../lib/session-deep-link"));
  ({ selectedDeviceLease, resetDevicePanelFocus } = await import("../../lib/devices/panel-focus"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const devicesPlugin = (enabled: boolean): PluginInfo => ({ ...knowledgePlugin(enabled), id: DEVICES_PLUGIN_ID, name: "Device simulators" });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Only the hosts, leases and chat destinations used by the view contracts below. */
function testFleet() {
  const fleet = fleetFixture(Date.now());
  const hosts = new Set(["local", "box:bs-mac-1", "box:bs-linux-1", "box:bs-linux-3"]);
  const leases = new Set(["emulator-5554", "A1B2-ios-1", "A1B2-ios-2", "A1B2-ios-3", "emulator-5600", "emulator-5700", "emulator-5900"]);
  return { ...fleet, hosts: fleet.hosts.filter((host) => hosts.has(host.id)), leases: fleet.leases.filter((lease) => leases.has(lease.id)) };
}

function stateOf(fleet: ReturnType<typeof fleetFixture>, over: Partial<DevicesStateResponse> = {}): DevicesStateResponse {
  return { enabled: true, hosts: fleet.hosts, leases: fleet.leases, profiles: [], settings: fleet.settings, setupJobs: [], pool: fleet.pool, ...over };
}

interface FakeApi {
  calls: string[];
  fail: boolean;
  state: DevicesStateResponse;
}

function fakeApi(state: DevicesStateResponse): FakeApi & ApiClient {
  const actions = fleetFixture().actions;
  const fake: FakeApi & Record<string, unknown> = {
    calls: [],
    fail: false,
    state,
    connection: { id: "c1" },
    async devicesState() {
      fake.calls.push("devicesState");
      if (fake.fail) throw new Error("connection refused");
      return fake.state;
    },
    async deviceLeaseActions(leaseId: string) {
      fake.calls.push(`actions:${leaseId}`);
      return { leaseId, actions: actions[leaseId] ?? [] };
    },
    deviceHttpRequest: (path: string) => ({ url: `http://daemon.test${path}`, headers: { Authorization: "Bearer t" } }),
    async setDeviceHostDraining(hostId: string, draining: boolean) {
      fake.calls.push(`drain:${hostId}:${draining}`);
      return { host: fake.state.hosts.find((host) => host.id === hostId) };
    },
    async destroyDeviceHost(hostId: string) {
      fake.calls.push(`destroy:${hostId}`);
    },
    async warmDeviceCaches(platform: string) {
      fake.calls.push(`warm:${platform}`);
      return { started: true, message: null };
    }
  };
  return fake as unknown as FakeApi & ApiClient;
}

/** Thumbnails: every fetch answers one frame; timers never fire (one frame per card is enough here). */
function thumbnailDeps(fetched: string[]): ThumbnailDeps {
  return {
    fetch: async (url, init) => {
      fetched.push(`${init.method} ${url} ${init.headers.Authorization ?? "-"}`);
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(4)]) };
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    now: () => 0,
    createObjectURL: () => "blob:frame",
    revokeObjectURL: () => undefined
  };
}

describe("the Devices fleet view", () => {
  let root: Root;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    initial = useAppStore.getState();
    resetDevices();
    resetDevicePanelFocus();
    takeSessionDeepLink();
    useAppStore.setState({ plugins: null, api: null, knowledgeView: { open: false, focus: null }, devicesFleetOpen: false, currentProject: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    useAppStore.setState(initial, true);
    resetDevices();
    await settle();
  });

  const render = async (element: React.ReactElement) => {
    await act(async () => root.render(element));
  };
  const click = async (element: Element) => {
    await act(async () => (element as HTMLElement).click());
  };
  const buttonNamed = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name) ?? null;

  /** Connect a fake daemon with the plugin on: the app store loads the devices store from it. */
  const connect = async (state: DevicesStateResponse) => {
    const fleet = testFleet();
    const api = fakeApi(state);
    await act(async () => {
      useAppStore.setState({
        api,
        sessions: fleet.sessions as unknown as SessionSummary[],
        registry: { ...useAppStore.getState().registry, agents: fleet.agents as never }
      });
      useAppStore.setState({ plugins: [devicesPlugin(true)] });
      await settle();
    });
    return api;
  };

  it("the activity bar and the drawer offer Devices only while the plugin is on", async () => {
    await render(createElement("div", null, createElement(ActivityBar), createElement(DevicesDrawerEntry), createElement(DevicesFleetHeader)));
    assert.equal(buttonNamed("Devices") === null, true, "no plugins list yet");
    await act(async () => useAppStore.setState({ plugins: [devicesPlugin(false)] }));
    assert.equal(buttonNamed("Devices") === null, true, "plugin off");
    await act(async () => useAppStore.setState({ plugins: [devicesPlugin(true)] }));
    const [bar, row] = [...document.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === "Devices" || b.textContent?.trim() === "Devices");
    assert.ok(bar && row);

    await click(bar);
    assert.equal(useAppStore.getState().devicesFleetOpen, true);
    assert.equal(bar.getAttribute("aria-pressed"), "true");
    await click(bar);
    assert.equal(useAppStore.getState().devicesFleetOpen, false, "a second click goes back");

    useAppStore.setState({ sidebarDrawerOpen: true });
    await click(row);
    assert.equal(useAppStore.getState().devicesFleetOpen, true);
    assert.equal(useAppStore.getState().sidebarDrawerOpen, false);

    await click(buttonNamed("Close Devices")!);
    assert.equal(useAppStore.getState().devicesFleetOpen, false);
    await click(row);
    await act(async () => useAppStore.setState({ plugins: [devicesPlugin(false)] }));
    assert.equal(useAppStore.getState().devicesFleetOpen, false, "the plugin turning off closes it");
  });

  it("visible cards fetch authenticated thumbnails and their current action log", async () => {
    const fetched: string[] = [];
    const fleet = testFleet();
    // A restarting device may still carry the previous stream; its state must stop polling.
    const starting = fleet.leases.find((lease) => lease.id === "A1B2-ios-3")!;
    starting.stream = { kind: "serve-sim", deviceParam: starting.id };
    const api = await connect(stateOf(fleet));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps(fetched) }));
    await act(settle);

    // Each live card polls the daemon's downscaled thumbnail of its lease (GET); the bearer rides as
    // a header, never as `?token=` in a fetched URL.
    assert.ok(fetched.includes("GET http://daemon.test/api/devices/leases/emulator-5554/thumbnail?w=320 Bearer t"));
    assert.ok(fetched.includes("GET http://daemon.test/api/devices/leases/A1B2-ios-1/thumbnail?w=320 Bearer t"));
    assert.ok(!fetched.some((line) => line.includes("A1B2-ios-3")), "a starting device has nothing to poll");
    const card = document.querySelector('[data-lease-id="emulator-5554"]')!;
    assert.equal(card.querySelector("img")?.getAttribute("src"), "blob:frame");
    // Its action log loads once it is on screen.
    assert.ok(api.calls.includes("actions:emulator-5554"));
    assert.match(card.textContent ?? "", /Tapped @e7 “Add to cart”/);
  });

  it("a card's chat link opens that chat with its Device panel on the lease", async () => {
    await connect(stateOf(testFleet()));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    const card = document.querySelector('[data-lease-id="A1B2-ios-2"]')!;
    const link = [...card.querySelectorAll("button")].find((b) => b.textContent?.includes("iPad split view layout"))!;
    await click(link);
    assert.deepEqual(takeSessionDeepLink(), { sessionId: "chat-4" });
    assert.equal(selectedDeviceLease("chat-4"), "A1B2-ios-2");
  });

  it("host cards drain, warm caches and destroy (after a confirmation naming the cost)", async () => {
    const api = await connect(stateOf(testFleet()));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    const hostCard = (id: string) => document.querySelector(`[data-host-id="${id}"]`)!;
    const inCard = (id: string, name: string) => [...hostCard(id).querySelectorAll("button")].find((b) => b.textContent?.trim() === name) ?? null;

    assert.equal(inCard("local", "Drain") === null, true, "this host has no Drain or Destroy");
    assert.equal(inCard("local", "Destroy") === null, true);
    assert.ok(inCard("box:bs-linux-3", "Resume"), "a draining host offers Resume");

    await click(inCard("box:bs-linux-1", "Drain")!);
    await act(settle);
    await click(inCard("box:bs-mac-1", "Warm caches")!);
    await act(settle);
    assert.deepEqual(api.calls.filter((call) => !call.startsWith("actions:") && call !== "devicesState"), ["drain:box:bs-linux-1:true", "warm:ios"]);

    await click(inCard("box:bs-mac-1", "Destroy")!);
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "a confirmation first");
    assert.match(dialog.textContent ?? "", /\$4\.26/);
    assert.match(dialog.textContent ?? "", /\$1\.92/);
    assert.ok(!api.calls.some((call) => call.startsWith("destroy:")), "destruction waits for confirmation");
    await click(buttonNamed("Destroy host")!);
    await act(settle);
    assert.ok(api.calls.includes("destroy:box:bs-mac-1"));
  });

  it("a deadline drain cannot be resumed and explains the unavailable control", async () => {
    const fleet = testFleet();
    const hosts = fleet.hosts.map((host) => (host.id === "box:bs-linux-3" ? { ...host, pool: { draining: true, drainReason: "deadline" as const, warm: false, idleSince: null } } : host));
    const api = await connect(stateOf(fleet, { hosts }));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    const card = document.querySelector('[data-host-id="box:bs-linux-3"]')!;
    const resume = [...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Resume")!;
    assert.ok(resume, "Resume still shows");
    assert.equal(resume.disabled, true);
    assert.ok(card.querySelector("[data-resume-blocked]")?.getAttribute("title"), "the unavailable control explains why");
    await click(resume);
    await act(settle);
    assert.ok(!api.calls.some((call) => call.startsWith("drain:")), "no request");
  });

  it("a panel Open still waiting for a host groups under Waiting for a device host", async () => {
    const fleet = testFleet();
    const waiting = fixtureLease("queued-1", { hostId: "pool", threadId: "chat-9", state: "starting", deviceId: null, key: null, progress: { step: "queue", label: "Waiting for a free Android device", startedAt: new Date().toISOString() } });
    await connect(stateOf(fleet, { leases: [...fleet.leases, waiting] }));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    const header = document.querySelector('[data-unknown-host="pool"]');
    assert.ok(header);
    assert.match(header.textContent ?? "", /Waiting/i);
    assert.doesNotMatch(header.textContent ?? "", /no longer listed/);
  });

  it("explains how agents get devices when none is leased", async () => {
    const fleet = testFleet();
    await connect(stateOf(fleet, { leases: [], hosts: [fleet.hosts[1]!] }));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    const empty = document.querySelector("[data-fleet-empty]");
    assert.ok(empty);
    assert.match(empty.textContent ?? "", /open_device/);
    assert.ok(document.querySelector('[data-host-id="local"]'), "the hosts still show");
    await click(buttonNamed("Device settings")!);
    assert.equal(useAppStore.getState().settingsOpen, true);
    assert.equal(useAppStore.getState().settingsSection, "devices");
  });

  it("shows a failed load with a retry that recovers", async () => {
    const fleet = testFleet();
    const api = fakeApi(stateOf(fleet));
    api.fail = true;
    await act(async () => {
      useAppStore.setState({ api });
      useAppStore.setState({ plugins: [devicesPlugin(true)] });
      await settle();
    });
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    await act(settle);
    const error = document.querySelector("[data-fleet-error]");
    assert.ok(error, "the error shows");
    assert.match(error.textContent ?? "", /connection refused/);

    api.fail = false;
    await click(buttonNamed("Try again")!);
    await act(settle);
    assert.equal(document.querySelector("[data-fleet-error]") === null, true);
    assert.ok(document.querySelector('[data-lease-id="emulator-5554"]'));
  });

  it("shows loading until the devices state arrives", async () => {
    const state = stateOf(testFleet());
    const api = fakeApi(state);
    let answer!: (value: DevicesStateResponse) => void;
    const pending = new Promise<DevicesStateResponse>((resolve) => { answer = resolve; });
    api.devicesState = () => pending;
    await act(async () => useAppStore.setState({ api, plugins: [devicesPlugin(true)] }));
    await render(createElement(DevicesFleetView, { thumbnailDeps: thumbnailDeps([]) }));
    assert.ok(document.querySelector("[data-fleet-loading]"));
    await act(async () => { answer(state); await settle(); });
    assert.equal(document.querySelector("[data-fleet-loading]") === null, true);
    assert.ok(document.querySelector('[data-lease-id="emulator-5554"]'));
  });
});
