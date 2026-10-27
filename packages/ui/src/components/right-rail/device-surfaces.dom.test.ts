import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { DEVICES_PLUGIN_ID, type PluginInfo } from "@orquester/api";

import { fixtureLease } from "../devices-fleet/fixtures.test-helpers";

let createRoot: typeof import("react-dom/client").createRoot;
let devicesStore: typeof import("../../lib/devices/store").devicesStore;
let useAppStore: typeof import("../../store/app").useAppStore;
let DeviceShowButton: typeof import("../agent-chat/timeline/rows/DeviceRowLink").DeviceShowButton;
let MobileSectionOverlay: typeof import("./MobileSections").MobileSectionOverlay;
let mobileSection: typeof import("./mobile-section").mobileSection;
let setMobileSection: typeof import("./mobile-section").setMobileSection;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLCanvasElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event", "localStorage"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: (dom.window as unknown as Record<string, unknown>)[name], configurable: true, writable: true });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ createRoot } = await import("react-dom/client"));
  ({ devicesStore } = await import("../../lib/devices/store"));
  ({ useAppStore } = await import("../../store/app"));
  ({ DeviceShowButton } = await import("../agent-chat/timeline/rows/DeviceRowLink"));
  ({ MobileSectionOverlay } = await import("./MobileSections"));
  ({ mobileSection, setMobileSection } = await import("./mobile-section"));
});

after(() => {
  dom.window.close();
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let root: Root;
let host: HTMLElement;
let previous: ReturnType<typeof useAppStore.getState>;
let previousDevices: ReturnType<typeof devicesStore.getState>;
let previousSection: ReturnType<typeof mobileSection>;

beforeEach(() => {
  previous = useAppStore.getState();
  previousDevices = devicesStore.getState();
  previousSection = mobileSection();
  useAppStore.setState({ api: null, plugins: [plugin] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAppStore.setState(previous, true);
  devicesStore.setState(previousDevices, true);
  setMobileSection(previousSection);
});

const plugin: PluginInfo = {
  id: DEVICES_PLUGIN_ID, name: "Device simulators", description: "", source: { label: "Built in", url: "" },
  provider: "Orquester", scope: "global", updates: false, platform: "supported", enabled: true,
  enabledWorkspaces: [], current: null, previous: null, skippedVersion: null, lastCheckAt: null,
  lastError: null, job: "idle"
};

test("turning the Devices plugin off hides an already selected mobile device panel", async () => {
  setMobileSection("device");
  await act(async () => {
    root.render(createElement(MobileSectionOverlay, { projectPath: "/w/app" }));
  });
  assert.equal(host.querySelector('[data-mobile-section="device"]') !== null, true);

  await act(async () => {
    useAppStore.setState({ plugins: [{ ...plugin, enabled: false }] });
  });
  assert.equal(host.querySelector('[data-mobile-section="device"]') !== null, false);
});

test("a closed lease's row cannot link to another chat that reuses the same device", async () => {
  devicesStore.setState({ leases: [fixtureLease("new-lease", { threadId: "another-chat", key: "local/emulator-5554" })] });
  await act(async () => {
    root.render(createElement("div", null, ["new-lease", undefined, "old-lease"].map((leaseId, index) =>
      createElement("span", { key: index, "data-case": index }, createElement(DeviceShowButton, {
        link: { device: "local/emulator-5554", ...(leaseId ? { leaseId } : {}) }, sessionId: "original-chat"
      }))
    )));
  });
  const disabled = (index: number) => host.querySelector<HTMLButtonElement>(`[data-case="${index}"] button`)?.disabled;
  assert.equal(disabled(0), false, "the explicit live lease is available");
  assert.equal(disabled(1), false, "references without a lease id still resolve by device key");
  assert.equal(disabled(2), true, "the historical lease stays closed when the device is reused");
});
