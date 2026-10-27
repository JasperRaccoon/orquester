/**
 * The Device panel in a DOM: the picker explains why a row can't open and opens one that can, a
 * booting device lists its steps, a lost device offers a fresh one, a live device off HTTP says it
 * needs a server connection, and the controller pill hands control over.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { DEFAULT_DEVICES_SETTINGS, DEVICE_PROFILES, type DeviceActionEntry, type DeviceHostSummary, type DeviceLeaseSummary, type DevicesSettings } from "@orquester/api";

let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let DevicePanel: typeof import("./DevicePanel").DevicePanel;
let ControllerPill: typeof import("./DeviceLiveView").ControllerPill;
let DeviceToolbar: typeof import("./DeviceToolbar").DeviceToolbar;
let DeviceAgentOverlay: typeof import("./DeviceAgentOverlay").DeviceAgentOverlay;
let devicesStore: typeof import("../../lib/devices/store").devicesStore;
let resetDevices: typeof import("../../lib/devices/store").resetDevices;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLCanvasElement", "Element", "Node", "navigator", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ DevicePanel } = await import("./DevicePanel"));
  ({ ControllerPill } = await import("./DeviceLiveView"));
  ({ DeviceToolbar } = await import("./DeviceToolbar"));
  ({ DeviceAgentOverlay } = await import("./DeviceAgentOverlay"));
  ({ devicesStore, resetDevices } = await import("../../lib/devices/store"));
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

function lease(overrides: Partial<DeviceLeaseSummary> = {}): DeviceLeaseSummary {
  return {
    id: "l1",
    key: "local/emulator-5554",
    threadId: "chat-1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    lastUsedAt: new Date().toISOString(),
    stream: { kind: "serve-emu", deviceParam: "emulator-5554" },
    ...overrides
  };
}

const localHost: DeviceHostSummary = {
  id: "local",
  kind: "local",
  label: "This machine",
  platforms: ["android"],
  status: "ready",
  statusDetail: null,
  readiness: { ready: true, checks: [], checkedAt: null },
  capacity: { used: 0, total: 4 }
};

describe("DevicePanel", () => {
  let root: Root;
  let host: HTMLElement;
  let calls: string[];
  let initial: ReturnType<typeof useAppStore.getState>;

  function settings(): DevicesSettings {
    const s = structuredClone(DEFAULT_DEVICES_SETTINGS) as DevicesSettings;
    s.android.enabled = true;
    return s;
  }

  function api() {
    return {
      connection: { id: "test" },
      // The desktop app's unix socket: no streams.
      deviceSocketUrl: () => null,
      deviceHttpRequest: () => null,
      deviceLeaseActions: async (leaseId: string) => ({ leaseId, actions: [] }),
      openDeviceLease: async (req: { platform: string; profile?: string }) => {
        calls.push(`open ${req.platform} ${req.profile}`);
        return { lease: lease({ id: "l2", state: "starting", profile: req.profile ?? "pixel-9", stream: undefined }) };
      },
      releaseDeviceLease: async (leaseId: string, shutdown?: boolean) => {
        calls.push(`release ${leaseId} ${shutdown ? "off" : ""}`.trim());
        return { lease: lease({ id: leaseId, state: "released" }) };
      },
      setDeviceController: async (leaseId: string, controller: string) => {
        calls.push(`controller ${leaseId} ${controller}`);
        return { lease: lease({ id: leaseId, controller: controller as "user" }) };
      }
    };
  }

  async function render(leases: DeviceLeaseSummary[], hosts: DeviceHostSummary[] = [localHost]) {
    useAppStore.setState({ api: api() as never, openSettings: ((id: string) => calls.push(`settings ${id}`)) as never });
    devicesStore.setState({ enabled: true, hosts, leases, profiles: DEVICE_PROFILES, settings: settings(), setupJobs: {}, pool: null, actions: {} });
    await act(async () => {
      root.render(createElement(DevicePanel, { sessionId: "chat-1", projectPath: "/w/p", variant: "docked" }));
    });
  }

  beforeEach(() => {
    initial = { ...useAppStore.getState() };
    calls = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetDevices();
    useAppStore.setState(initial, true);
  });

  const text = () => host.textContent ?? "";
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;

  it("the picker opens a ready profile and explains a disabled one with a link to Settings", async () => {
    await render([]);
    const iphones = host.querySelector('section[aria-label="iPhone & iPad"]')!;
    assert.match(iphones.textContent ?? "", /is off/);
    const settingsLink = [...iphones.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Open")!;
    await act(async () => settingsLink.click());
    assert.deepEqual(calls, ["settings devices"]);
    await act(async () => button("Open Pixel 9")!.click());
    assert.ok(calls.includes("open android pixel-9"));
  });

  it("a full host's profile reads Queue with what that means, and opens (the pool queues it)", async () => {
    await render([], [{ ...localHost, capacity: { used: 4, total: 4 } }]);
    const queue = button("Queue Pixel 9")!;
    assert.equal(queue.textContent?.trim(), "Queue");
    assert.equal(queue.disabled, false);
    assert.match(queue.title, /slot.*rent/i);
    assert.equal(button("Open Pixel 9"), undefined);
    await act(async () => queue.click());
    assert.ok(calls.includes("open android pixel-9"));
  });

  it("Cancel releases a starting device before control is available", async () => {
    await render([lease({ state: "starting", stream: undefined, progress: { step: "start-device", label: "Starting device", startedAt: new Date().toISOString() } })]);
    assert.equal(button("Take over"), undefined);
    assert.equal(button("Give back"), undefined);
    await act(async () => button("Cancel")!.click());
    assert.deepEqual(calls, ["release l1"]);
  });

  it("a lost device offers a fresh one, released once it opens", async () => {
    await render([lease({ state: "lost", error: "Its host was destroyed" })]);
    assert.match(text(), /This device is gone/);
    await act(async () => button("Open a new Pixel 9")!.click());
    assert.deepEqual(calls, ["open android pixel-9", "release l1"]);
  });

  it("a live device off HTTP says it needs a server connection and keeps its log", async () => {
    await render([lease()]);
    assert.match(text(), /Live devices need a server connection/);
    assert.ok(host.querySelector('section[aria-label="Device actions"]'));
    // Tabs: middle-click releases.
    const tab = host.querySelector('[role="tab"]')!;
    await act(async () => tab.dispatchEvent(new dom.window.MouseEvent("auxclick", { bubbles: true, button: 1 })));
    assert.deepEqual(calls, ["release l1"]);
  });

  it("toolbar dispatches Rotate and Restart app and refuses disabled Rotate", async () => {
    const pressed: string[] = [];
    const toolbar = (rotate: { enabled: boolean; reason: string | null }) =>
      createElement(DeviceToolbar, {
        layout: "bar",
        platform: "android",
        input: { enabled: true },
        onButton: (name) => pressed.push(name),
        rotate: { ...rotate, onRotate: () => pressed.push("rotate") },
        screenshot: { enabled: true, pending: false, onShot: () => undefined },
        keyboard: { enabled: true, active: false, onToggle: () => undefined },
        view: { mode: "flat", unavailable: null, enabled: true, onMode: () => undefined },
        more: { releasing: false, restarting: false, onRestartApp: () => pressed.push("restart"), onRelease: () => undefined, onPowerOff: () => undefined, onCopyKey: () => undefined }
      });
    await act(async () => root.render(toolbar({ enabled: true, reason: null })));
    await act(async () => button("Rotate")!.click());
    const more = button("More");
    assert.ok(more, "the toolbar offers More actions");
    await act(async () => more.click());
    const restart = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restart app") as HTMLButtonElement | undefined;
    assert.ok(restart, "More lists Restart app");
    await act(async () => restart.click());
    assert.deepEqual(pressed, ["rotate", "restart"]);
    // Disabled while the video is not up: the press is refused and the tooltip says why.
    await act(async () => root.render(toolbar({ enabled: false, reason: "Waiting for video" })));
    await act(async () => button("Rotate")!.click());
    assert.deepEqual(pressed, ["rotate", "restart"]);
    assert.equal(button("Rotate")!.getAttribute("aria-disabled"), "true");
  });

  it("the controller pill: Take over while the agent drives, Give back after", async () => {
    const changes: string[] = [];
    await act(async () => root.render(createElement(ControllerPill, { lease: lease(), agentName: "Claude", busy: false, onChange: (c) => changes.push(c) })));
    assert.match(text(), /Claude is controlling/);
    await act(async () => button("Take over")!.click());
    await act(async () => root.render(createElement(ControllerPill, { lease: lease({ controller: "user" }), agentName: "Claude", busy: false, onChange: (c) => changes.push(c) })));
    assert.match(text(), /You have control/);
    await act(async () => button("Give back")!.click());
    assert.deepEqual(changes, ["user", "agent"]);
  });

  it("animates only new visible actions for 1200ms", async () => {
    const action = (id: string, target: string): DeviceActionEntry => ({
      id, leaseId: "l1", at: "2026-10-27T10:00:00.000Z", actor: "agent", kind: "tap", summary: `Tapped ${target}`, ok: true, target
    });
    const old = action("old", "Old action");
    const fresh = action("fresh", "New action");
    const hidden = action("hidden", "Hidden action");
    const renderOverlay = async (entries: DeviceActionEntry[], active: boolean) => {
      await act(async () => root.render(createElement(DeviceAgentOverlay, {
        entries, active, screen: { width: 400, height: 800 }, orientation: "portrait", project: (x: number, y: number) => ({ x, y })
      })));
    };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await renderOverlay([old], true);
      assert.equal(text(), "", "loaded history is not replayed");
      await renderOverlay([old, fresh], true);
      assert.match(text(), /New action/);
      assert.doesNotMatch(text(), /Old action/);
      await act(async () => mock.timers.tick(1199));
      assert.match(text(), /New action/);
      await act(async () => mock.timers.tick(1));
      assert.equal(text(), "", "the spec's 1200ms lifetime elapsed");
      await renderOverlay([old, fresh, hidden], false);
      await renderOverlay([old, fresh, hidden], true);
      assert.equal(text(), "", "hidden history is not replayed on return");
    } finally {
      mock.timers.reset();
    }
  });
});
