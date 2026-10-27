/**
 * Settings → Devices in a DOM: the Android checklist offers Install all and per-item fixes, a
 * number field validates before it saves, a profile chip saves the whole list, the Mac host rows
 * need the box provider, and the Fleet group starts collapsed.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICES_PLUGIN_ID,
  type DeviceHostSummary,
  type DevicesSettings as DevicesSettingsValue,
  type DevicesStateResponse,
  type PluginInfo
} from "@orquester/api";

// Loaded once the DOM globals exist: React DOM reads them when it loads.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let DevicesSettings: typeof import("./DevicesSettings").DevicesSettings;
let loadDevices: typeof import("../../lib/devices/store").loadDevices;
let resetDevices: typeof import("../../lib/devices/store").resetDevices;
let useAppStore: typeof import("../../store/app").useAppStore;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "FocusEvent", "Event"] as const;
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
  ({ DevicesSettings } = await import("./DevicesSettings"));
  ({ loadDevices, resetDevices } = await import("../../lib/devices/store"));
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

const devicesPlugin = {
  id: DEVICES_PLUGIN_ID,
  name: "Device simulators",
  scope: "global",
  enabled: true
} as unknown as PluginInfo;

const localHost: DeviceHostSummary = {
  id: "local",
  kind: "local",
  label: "This machine",
  platforms: ["android"],
  status: "needs-setup",
  statusDetail: null,
  readiness: {
    ready: false,
    checkedAt: "2026-10-27T10:00:00.000Z",
    checks: [
      { id: "kvm", label: "KVM", state: "ok", detail: "/dev/kvm" },
      { id: "android-sdk", label: "Android SDK", state: "missing", detail: null, fixActionId: "install-sdk" },
      { id: "tool:agent-device", label: "agent-device", state: "ok", detail: "0.21.31" }
    ]
  },
  capacity: { used: 0, total: 4 }
};

function settings(): DevicesSettingsValue {
  const value = structuredClone(DEFAULT_DEVICES_SETTINGS) as DevicesSettingsValue;
  value.android.enabled = true;
  value.ios.enabled = true;
  return value;
}

describe("DevicesSettings", () => {
  let root: Root;
  let calls: Array<[string, unknown]>;
  let initial: ReturnType<typeof useAppStore.getState>;

  beforeEach(() => {
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.replaceChildren(mount);
    root = createRoot(mount);
    calls = [];
    initial = { ...useAppStore.getState() };
    resetDevices();
  });

  afterEach(() => {
    act(() => root.unmount());
    useAppStore.setState(initial, true);
    resetDevices();
  });

  const show = async () => {
    const state: DevicesStateResponse = { enabled: true, hosts: [localHost], leases: [], profiles: [], settings: settings(), setupJobs: [] };
    const api = {
      connection: { id: "test" },
      devicesState: async () => state,
      updateDevicesSettings: async (patch: unknown) => {
        calls.push(["settings", patch]);
        return { settings: state.settings };
      },
      startDeviceSetup: async (platform: string, req: unknown) => {
        calls.push(["setup", [platform, req]]);
        return { job: null };
      }
    };
    useAppStore.setState({ api: api as never, connectionStatus: "connected", plugins: [devicesPlugin] } as never);
    await loadDevices(api as never);
    await act(async () => root.render(createElement(DevicesSettings)));
  };

  const doc = () => dom.window.document;
  const button = (text: string) => [...doc().querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
  };

  it("Install all and a single item's Install start the Android setup", async () => {
    await show();
    const all = button("Install all");
    assert.ok(all, "Install all shows while something is missing");
    await click(all);
    await click(button("Install")!);
    assert.deepEqual(calls, [
      ["setup", ["android", {}]],
      ["setup", ["android", { actions: ["install-sdk"] }]]
    ]);
    assert.match(doc().body.textContent ?? "", /Android SDK licence/);
    assert.match(doc().body.textContent ?? "", /agent-device/);
  });

  it("a number field refuses an out-of-range value and saves a valid one", async () => {
    await show();
    const input = doc().querySelector<HTMLInputElement>('input[aria-label="Most devices at once"]')!;
    await type(input, "99");
    assert.match([...doc().querySelectorAll("[role=alert]")].map((el) => el.textContent).join("|"), /Between 1 and 32/);
    assert.deepEqual(calls, []);
    await type(input, "4");
    assert.deepEqual(calls, [["settings", { android: { maxLocalDevices: 4 } }]]);
  });

  it("a profile chip saves the list in catalogue order", async () => {
    await show();
    const chip = [...doc().querySelectorAll('[role="checkbox"]')].find((el) => el.textContent?.includes("Pixel Tablet"))!;
    await click(chip);
    assert.deepEqual(calls, [["settings", { android: { profiles: ["pixel-9", "pixel-fold"] } }]]);
  });

  it("without the box provider the Mac host controls point to Plugins", async () => {
    await show();
    assert.ok(button("Set up in Plugins"));
    const lifetime = doc().querySelector<HTMLInputElement>('input[aria-label="Lifetime in minutes"]')!;
    assert.equal(lifetime.disabled, true);
  });

  it("the Fleet group starts collapsed and opens", async () => {
    await show();
    assert.equal(doc().querySelector("[data-devices-fleet]"), null);
    const toggle = [...doc().querySelectorAll("button")].find((b) => b.textContent?.includes("Fleet (preview)"))!;
    await click(toggle);
    assert.ok(doc().querySelector("[data-devices-fleet]"));
    await click(button("Pool only")!);
    assert.deepEqual(calls, [["settings", { pool: { placement: "pool-only" } }]]);
    // The Android (Linux) hosts' own time limit, apart from the Mac hosts' Lifetime.
    const lifetime = doc().querySelector<HTMLInputElement>('input[aria-label="Android host lifetime in minutes"]')!;
    assert.equal(lifetime.value, String(DEFAULT_DEVICES_SETTINGS.pool.androidLifetimeMinutes));
    await type(lifetime, "10");
    assert.match([...doc().querySelectorAll("[role=alert]")].map((el) => el.textContent).join("|"), /Between 30 and 1440/);
    await type(lifetime, "90");
    assert.deepEqual(calls.at(-1), ["settings", { pool: { androidLifetimeMinutes: 90 } }]);
  });
});
