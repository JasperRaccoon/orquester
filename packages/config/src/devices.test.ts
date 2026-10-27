import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICES_SETTINGS_LIMITS,
  createDefaultDeviceLeasesFile,
  createDefaultDevicesSettingsFile,
  defaultDevicesSettings,
  mergeDevicesSettings,
  parseDeviceLeasesFile,
  parseDevicesSettingsFile,
  readDevicesSettings,
  serializeDeviceLeasesFile,
  serializeDevicesSettingsFile
} from "./devices.ts";
import {
  androidAvdDir,
  androidSdkDir,
  deviceLeasesPath,
  deviceScreenshotsDir,
  devicesDir,
  devicesHubStatePath,
  devicesRuntimeDir,
  devicesSettingsPath,
  devicesToolsDir
} from "./index.ts";

test("device paths live under the daemon appdir", () => {
  assert.equal(devicesDir("/a"), "/a/daemon/devices");
  assert.equal(devicesToolsDir("/a"), "/a/daemon/devices/tools");
  assert.equal(androidSdkDir("/a"), "/a/daemon/devices/android-sdk");
  assert.equal(androidAvdDir("/a"), "/a/daemon/devices/avd");
  assert.equal(devicesRuntimeDir("/a"), "/a/daemon/devices/runtime");
  assert.equal(devicesHubStatePath("/a"), "/a/daemon/devices/hub.json");
  assert.equal(deviceScreenshotsDir("/a"), "/a/daemon/devices/screenshots");
  assert.equal(devicesSettingsPath("/a/"), "/a/daemon/devices.json");
  assert.equal(deviceLeasesPath("/a"), "/a/daemon/device-leases.json");
});

test("settings: an empty or missing value reads as the defaults", () => {
  assert.deepEqual(readDevicesSettings(undefined), DEFAULT_DEVICES_SETTINGS);
  assert.deepEqual(readDevicesSettings({}), DEFAULT_DEVICES_SETTINGS);
  assert.deepEqual(parseDevicesSettingsFile({}).settings, DEFAULT_DEVICES_SETTINGS);
  assert.deepEqual(createDefaultDevicesSettingsFile().settings, DEFAULT_DEVICES_SETTINGS);
  // The defaults are not shared mutable state.
  const copy = defaultDevicesSettings();
  copy.android.profiles.push("x");
  assert.notDeepEqual(copy, DEFAULT_DEVICES_SETTINGS);
});

test("settings: each bad field falls back alone, numbers are clamped, unknown keys survive a round trip", () => {
  const raw = {
    version: 1,
    future: { keep: true },
    settings: {
      android: { enabled: true, maxLocalDevices: 999, profiles: ["pixel-9", "pixel-9", "galaxy-s26"], skin: "x" },
      ios: { enabled: "yes", size: 4, monthlyCapUsd: -3 },
      agents: "nonsense",
      leaseIdleMinutes: "60",
      pool: { placement: "everywhere", minWarmHosts: { android: 2.6 }, maxHosts: 10 },
      fleetView: { thumbnails: true }
    }
  };
  const file = parseDevicesSettingsFile(raw);
  const s = file.settings;
  assert.equal(s.android.enabled, true);
  assert.equal(s.android.maxLocalDevices, DEVICES_SETTINGS_LIMITS.maxLocalDevices.max);
  assert.deepEqual(s.android.profiles, ["pixel-9", "galaxy-s26"]);
  assert.equal(s.ios.enabled, false);
  assert.equal(s.ios.size, DEFAULT_DEVICES_SETTINGS.ios.size);
  assert.equal(s.ios.monthlyCapUsd, 0);
  assert.deepEqual(s.agents, DEFAULT_DEVICES_SETTINGS.agents);
  assert.equal(s.leaseIdleMinutes, DEFAULT_DEVICES_SETTINGS.leaseIdleMinutes);
  assert.equal(s.pool.placement, "prefer-local");
  assert.deepEqual(s.pool.minWarmHosts, { android: 3, ios: 0 });
  assert.equal(s.pool.maxHosts, 10);

  const written = serializeDevicesSettingsFile(file);
  assert.deepEqual(written.future, { keep: true });
  const settings = written.settings as Record<string, Record<string, unknown>>;
  assert.equal(settings.android!.skin, "x");
  assert.deepEqual(settings.fleetView, { thumbnails: true });
  assert.deepEqual(parseDevicesSettingsFile(JSON.parse(JSON.stringify(written))).settings, s);
});

test("settings: a file that is not version 1 or not an object throws (it is moved aside, never overwritten)", () => {
  assert.throws(() => parseDevicesSettingsFile(null));
  assert.throws(() => parseDevicesSettingsFile([]));
  assert.throws(() => parseDevicesSettingsFile({ version: 2, settings: {} }));
});

test("settings: a patch merges field-wise and keeps the keys it does not name", () => {
  const current = readDevicesSettings({ android: { custom: 1 }, pool: { custom: 2 } });
  const next = mergeDevicesSettings(current, {
    android: { enabled: true },
    ios: { rentWithoutAsking: true, monthlyCapUsd: 50 },
    pool: { minWarmHosts: { ios: 1 } },
    maxLeasesPerChat: 2
  });
  assert.equal(next.android.enabled, true);
  assert.equal(next.android.maxLocalDevices, DEFAULT_DEVICES_SETTINGS.android.maxLocalDevices);
  assert.equal((next.android as unknown as Record<string, unknown>).custom, 1);
  assert.equal((next.pool as unknown as Record<string, unknown>).custom, 2);
  assert.equal(next.ios.rentWithoutAsking, true);
  assert.equal(next.ios.monthlyCapUsd, 50);
  assert.deepEqual(next.pool.minWarmHosts, { android: 0, ios: 1 });
  assert.equal(next.maxLeasesPerChat, 2);
  // The input is not mutated.
  assert.equal(current.android.enabled, false);
});

const lease = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: "t1",
  hostId: "local",
  deviceId: "emulator-5554",
  platform: "android",
  profile: "pixel-9",
  name: "Pixel 9",
  osVersion: "Android 15",
  state: "ready",
  controller: "agent",
  openedBy: "agent",
  createdAt: "2026-10-27T10:00:00.000Z",
  lastUsedAt: "2026-10-27T10:00:00.000Z",
  ...extra
});

test("leases: entry-wise tolerant; rejected entries and unknown keys are written back verbatim", () => {
  const bad = { id: "", threadId: 3 };
  const raw = {
    version: 1,
    note: "kept",
    leases: [lease("a", { future: { x: 1 }, state: "suspended-v9" }), bad, lease("a"), lease("b", { deviceId: null })]
  };
  const file = parseDeviceLeasesFile(raw);
  assert.deepEqual(
    file.leases.map((entry) => entry.id),
    ["a", "b"]
  );
  assert.equal(file.leases[0]!.state, "suspended-v9");
  assert.deepEqual((file.leases[0] as Record<string, unknown>).future, { x: 1 });
  assert.equal(file.leases[1]!.deviceId, null);
  assert.equal(file.rejected.length, 2);
  const written = serializeDeviceLeasesFile(file);
  assert.equal(written.note, "kept");
  assert.equal((written.leases as unknown[]).length, 4);
  assert.deepEqual(parseDeviceLeasesFile(JSON.parse(JSON.stringify(written))).leases, file.leases);
});

test("leases: defaults fill optional fields; a broken outer shape throws", () => {
  const minimal = { id: "x", threadId: "t", hostId: "local", platform: "ios", state: "starting", createdAt: "a", lastUsedAt: "b" };
  const file = parseDeviceLeasesFile({ leases: [minimal] });
  assert.deepEqual(file.leases[0], {
    ...minimal,
    deviceId: null,
    profile: "",
    name: "",
    osVersion: "",
    controller: "agent",
    openedBy: "agent"
  });
  assert.deepEqual(parseDeviceLeasesFile({}), createDefaultDeviceLeasesFile());
  assert.throws(() => parseDeviceLeasesFile({ leases: {} }));
  assert.throws(() => parseDeviceLeasesFile({ version: 2, leases: [] }));
  assert.throws(() => parseDeviceLeasesFile("nope"));
});
