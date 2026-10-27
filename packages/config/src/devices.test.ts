import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DEVICES_SETTINGS,
  DEVICES_SETTINGS_LIMITS,
  createDefaultDeviceLeasesFile,
  createDefaultDevicePoolStateFile,
  createDefaultDevicesSettingsFile,
  defaultDevicesSettings,
  isVphoneSource,
  mergeDevicesSettings,
  parseDeviceLeasesFile,
  parseDevicePoolStateFile,
  parseDevicesSettingsFile,
  readDevicesSettings,
  serializeDeviceLeasesFile,
  serializeDevicePoolStateFile,
  serializeDevicesSettingsFile
} from "./devices.ts";
import {
  androidAvdDir,
  androidSdkDir,
  deviceLeasesPath,
  devicePoolPath,
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
  assert.equal(devicePoolPath("/a"), "/a/daemon/device-pool.json");
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

test("settings: research vphone hosts are keyed by box id, merge field-wise, and a null entry is forgotten", () => {
  const read = readDevicesSettings({
    research: { vphoneHosts: { box1: { enabled: true, extra: 1 }, "../bad": { enabled: true }, box2: "nope" }, future: true }
  });
  assert.deepEqual(read.research.vphoneHosts, { box1: { enabled: true, iphoneSource: null, cloudosSource: null, extra: 1 } });
  assert.equal((read.research as unknown as Record<string, unknown>).future, true);

  const next = mergeDevicesSettings(read, { research: { vphoneHosts: { box1: { cloudosSource: "https://example.test/cloudOS.ipsw" }, box3: { enabled: true } } } });
  assert.deepEqual(next.research.vphoneHosts.box1, { enabled: true, iphoneSource: null, cloudosSource: "https://example.test/cloudOS.ipsw", extra: 1 });
  assert.equal(next.research.vphoneHosts.box3?.enabled, true);
  const forgotten = mergeDevicesSettings(next, { research: { vphoneHosts: { box1: null } } });
  assert.deepEqual(Object.keys(forgotten.research.vphoneHosts), ["box3"]);
  assert.deepEqual(readDevicesSettings({ research: "x" }).research, { vphoneHosts: {} });
});

test("settings: an IPSW source is an absolute path or an https:// URL; anything else reads as unset", () => {
  for (const good of ["/Users/me/iPhone17,3.ipsw", "https://updates.cdn-apple.com/x/iPhone.ipsw"]) assert.equal(isVphoneSource(good), true, good);
  for (const bad of ["-rf", "--iphone-source=/x", "relative/x.ipsw", "http://example.test/x.ipsw", "file:///x.ipsw", "https://", "/a\nb", ""]) {
    assert.equal(isVphoneSource(bad), false, bad);
  }
  const read = readDevicesSettings({ research: { vphoneHosts: { box1: { enabled: true, iphoneSource: "--help", cloudosSource: " /Users/me/cloudOS.ipsw " } } } });
  assert.deepEqual(read.research.vphoneHosts.box1, { enabled: true, iphoneSource: null, cloudosSource: "/Users/me/cloudOS.ipsw" });
});

test("settings: vphone host entries this build does not read (bad key, not an object, past the max) are written back verbatim", () => {
  const hosts: Record<string, unknown> = { "../odd": { enabled: true }, box0: "future-shape" };
  for (let i = 1; i <= 66; i++) hosts[`box${i}`] = { enabled: i % 2 === 0 };
  const file = parseDevicesSettingsFile({ version: 1, settings: { research: { vphoneHosts: hosts } } });
  assert.equal(Object.keys(file.settings.research.vphoneHosts).length, 64);
  assert.deepEqual(Object.keys(file.droppedVphoneHosts ?? {}).sort(), ["../odd", "box0", "box65", "box66"].sort());
  const written = serializeDevicesSettingsFile(file) as { settings: { research: { vphoneHosts: Record<string, unknown> } } };
  assert.deepEqual(written.settings.research.vphoneHosts["../odd"], { enabled: true });
  assert.equal(written.settings.research.vphoneHosts.box0, "future-shape");
  assert.deepEqual(written.settings.research.vphoneHosts.box66, { enabled: true });
  assert.equal(Object.keys(written.settings.research.vphoneHosts).length, 68);
  // Read again: the same 64 are read and the same 4 kept aside.
  const again = parseDevicesSettingsFile(JSON.parse(JSON.stringify(written)));
  assert.deepEqual(Object.keys(again.settings.research.vphoneHosts), Object.keys(file.settings.research.vphoneHosts));
  assert.deepEqual(again.droppedVphoneHosts, file.droppedVphoneHosts);
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

test("rent without asking: one pool switch; a legacy Mac switch is adopted on read and mirrored from patches", () => {
  const legacy = readDevicesSettings({ ios: { rentWithoutAsking: true, monthlyCapUsd: 40 } });
  assert.equal(legacy.pool.rentWithoutAsking, true);
  assert.equal(legacy.pool.monthlyCapUsd, 40);
  // A file that already has the pool's keeps them.
  const both = readDevicesSettings({ ios: { rentWithoutAsking: true, monthlyCapUsd: 40 }, pool: { rentWithoutAsking: false, monthlyCapUsd: 70 } });
  assert.equal(both.pool.rentWithoutAsking, false);
  assert.equal(both.pool.monthlyCapUsd, 70);
  const merged = mergeDevicesSettings(defaultDevicesSettings(), { ios: { rentWithoutAsking: true, monthlyCapUsd: 25 } });
  assert.equal(merged.pool.rentWithoutAsking, true);
  assert.equal(merged.pool.monthlyCapUsd, 25);
  assert.equal(mergeDevicesSettings(defaultDevicesSettings(), { ios: { rentWithoutAsking: true }, pool: { rentWithoutAsking: false } }).pool.rentWithoutAsking, false);
});

test("pool settings: the monthly cap defaults, clamps and falls back alone", () => {
  assert.equal(readDevicesSettings({}).pool.monthlyCapUsd, 100);
  assert.equal(readDevicesSettings({ pool: { monthlyCapUsd: -5 } }).pool.monthlyCapUsd, 0);
  assert.equal(readDevicesSettings({ pool: { monthlyCapUsd: "x", maxHosts: 3 } }).pool.monthlyCapUsd, 100);
  assert.equal(readDevicesSettings({ pool: { monthlyCapUsd: "x", maxHosts: 3 } }).pool.maxHosts, 3);
});

test("device-pool.json: tolerant per section; rejected entries and unknown keys are written back", () => {
  assert.deepEqual(parseDevicePoolStateFile({}).state, createDefaultDevicePoolStateFile().state);
  const raw = {
    version: 1,
    future: { keep: true },
    spend: { note: "an older build's key, kept" },
    rentals: [
      { hostId: "box:a", platform: "android", provider: "blacksmith", size: "16vcpu", hourlyUsd: 1.92, rentedAt: "2026-10-27T00:00:00.000Z", extra: 1 },
      { hostId: 7 }
    ],
    learnedCapacity: [{ platform: "android", provider: "blacksmith", size: "16vcpu", capacity: 9, measuredAt: "2026-10-27T00:00:00.000Z" }, "junk"],
    drainingHostIds: ["box:a", "box:a", 3],
    cache: { linux: { lastWarmAt: "2026-10-20T00:00:00.000Z" }, macos: 5, other: { x: 1 } }
  };
  const file = parseDevicePoolStateFile(raw);
  assert.equal(file.state.rentals.length, 1);
  assert.equal(file.state.rentals[0]!.measured, false);
  assert.equal(file.state.learnedCapacity[0]!.samples, 1);
  assert.deepEqual(file.state.drainingHostIds, ["box:a"]);
  assert.equal(file.state.cache.linux?.lastAutoWarmAt, null);
  assert.equal(file.state.cache.macos, undefined);
  const out = serializeDevicePoolStateFile(file);
  assert.deepEqual(out.future, { keep: true });
  assert.equal((out.rentals as unknown[]).length, 2);
  assert.deepEqual((out.learnedCapacity as unknown[])[1], "junk");
  assert.deepEqual(out.spend, { note: "an older build's key, kept" });
  assert.deepEqual((out.cache as Record<string, unknown>).other, { x: 1 });
  assert.equal((out.rentals as Record<string, unknown>[])[0]!.extra, 1);
  assert.throws(() => parseDevicePoolStateFile({ version: 2 }));
  assert.throws(() => parseDevicePoolStateFile([]));
});
