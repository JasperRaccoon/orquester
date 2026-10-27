import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  deviceViewKey,
  effectiveDeviceViewMode,
  readDevicePanelPrefs,
  readDeviceViewPrefs,
  writeDevicePanelPrefs,
  writeDeviceViewPrefs
} from "./device-view-prefs.ts";

describe("device view prefs", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
    });
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  it("validates field by field with defaults", () => {
    const key = "android:pixel-9";
    store.set("orq.device.view." + key, JSON.stringify({ mode: "flat", extra: 1 }));
    assert.deepEqual(readDeviceViewPrefs(key), { mode: "flat" });
    store.set("orq.device.view." + key, JSON.stringify({ mode: "4d" }));
    assert.deepEqual(readDeviceViewPrefs(key), { mode: null });
    store.set("orq.device.panel", JSON.stringify({ logOpen: "yes" }));
    assert.deepEqual(readDevicePanelPrefs(), { logOpen: false });
  });
  it("persists per device model and survives corrupt storage", () => {
    const key = deviceViewKey({ platform: "android", profile: "pixel-9" });
    assert.equal(key, "android:pixel-9");
    assert.equal(deviceViewKey({ platform: "ios", profile: "", name: "iPhone 17" }), "ios:iPhone 17");
    writeDeviceViewPrefs(key, { mode: "flat" });
    assert.deepEqual(readDeviceViewPrefs(key), { mode: "flat" });
    assert.deepEqual(readDeviceViewPrefs("android:other"), { mode: null });
    store.set("orq.device.panel", "{not json");
    assert.deepEqual(readDevicePanelPrefs(), { logOpen: false });
    writeDevicePanelPrefs({ logOpen: true });
    assert.deepEqual(readDevicePanelPrefs(), { logOpen: true });
  });
  it("defaults to 3D for H.264 and Flat for MJPEG or screenshots until the user picks", () => {
    assert.equal(effectiveDeviceViewMode({ mode: null }, "serve-emu"), "3d");
    assert.equal(effectiveDeviceViewMode({ mode: null }, "serve-sim-h264"), "3d");
    assert.equal(effectiveDeviceViewMode({ mode: null }, "serve-sim-mjpeg"), "flat");
    assert.equal(effectiveDeviceViewMode({ mode: null }, "screenshots"), "flat");
    assert.equal(effectiveDeviceViewMode({ mode: null }, null), "3d");
    assert.equal(effectiveDeviceViewMode({ mode: "flat" }, "serve-emu"), "flat");
    assert.equal(effectiveDeviceViewMode({ mode: "3d" }, "screenshots"), "3d");
  });
  it("never throws without storage", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    assert.deepEqual(readDeviceViewPrefs("x"), { mode: null });
    writeDeviceViewPrefs("x", { mode: "flat" });
  });
});
