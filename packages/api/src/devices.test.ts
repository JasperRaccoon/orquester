import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ANDROID_DEVICE_PROFILE_IDS, DEFAULT_IOS_DEVICE_PROFILE_IDS } from "@orquester/config";

import { SESSION_TOOL_REFERENCE_KEYS } from "./agent-chat/session-tools.ts";
import { TOOLSETS } from "./agent-tools.ts";
import { BOX_SETUP_STEP_IDS, isBoxPurpose } from "./boxes.ts";
import {
  DEFAULT_DEVICE_PROFILE,
  DEVICE_PROFILES,
  DEVICE_TOOL_REFERENCE_KEY,
  DEVICE_HUB_ROUTE_PATTERN,
  DEVICE_QUERY_TOKEN_ROUTES,
  DEVICE_SCREENSHOT_ROUTE_PATTERN,
  DEVICE_THUMBNAIL_ROUTE_PATTERN,
  deviceQueryTokenAllowed,
  DEVICES_PLUGIN_ID,
  boxDeviceHostId,
  deviceKey,
  deviceProfile,
  deviceRoutes,
  deviceToolReferenceOfActivityData,
  parseDeviceControllerRequest,
  parseDeviceUserActionRequest,
  parseDeviceOpenRequest,
  parseDeviceSetupRequest,
  parseDeviceCacheWarmRequest,
  parseDeviceHostDrainRequest,
  parseDevicesSettingsPatch,
  readDeviceToolReference,
  validateDeviceActionInput
} from "./devices.ts";
import { PLUGIN_IDS, isPluginId } from "./plugins.ts";

test("the plugin id is a built-in plugin", () => {
  assert.ok(PLUGIN_IDS.includes(DEVICES_PLUGIN_ID));
  assert.ok(isPluginId("devices"));
});

test("profiles: ids are unique, each platform's defaults are known profiles of that platform", () => {
  const ids = DEVICE_PROFILES.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [platform, defaults] of [
    ["android", DEFAULT_ANDROID_DEVICE_PROFILE_IDS],
    ["ios", DEFAULT_IOS_DEVICE_PROFILE_IDS]
  ] as const) {
    for (const id of defaults) assert.equal(deviceProfile(id)?.platform, platform, id);
    assert.equal(deviceProfile(DEFAULT_DEVICE_PROFILE[platform])?.platform, platform);
  }
  for (const profile of DEVICE_PROFILES) {
    if (profile.platform === "android") assert.ok(profile.avdDevice && profile.systemImage, profile.id);
    else assert.ok(profile.simDeviceTypes && profile.simDeviceTypes.length > 0, profile.id);
  }
});

test("device keys and box host ids name their host", () => {
  assert.equal(deviceKey("local", "emulator-5554"), "local/emulator-5554");
  assert.equal(boxDeviceHostId("ab12"), "box:ab12");
});

test("routes encode their parameters", () => {
  assert.equal(deviceRoutes.lease("a/b"), "/api/devices/leases/a%2Fb");
  assert.equal(deviceRoutes.hub("box:x1", "/vendor/serve-emu/ws"), "/api/devices/hosts/box%3Ax1/hub/vendor/serve-emu/ws");
  assert.equal(deviceRoutes.socket("local", "vendor/serve-sim/helper/ws"), "/ws-device/local/vendor/serve-sim/helper/ws");
  assert.equal(deviceRoutes.setup("android"), "/api/devices/setup/android");
  assert.equal(deviceRoutes.hostDrain("box:x1"), "/api/devices/hosts/box%3Ax1/drain");
  assert.equal(deviceRoutes.pool, "/api/devices/pool");
  assert.equal(deviceRoutes.cacheWarm, "/api/devices/pool/caches/warm");
  assert.equal(deviceRoutes.userAction("l/1"), "/api/devices/leases/l%2F1/user-action");
  assert.equal(deviceRoutes.thumbnail("l/1"), "/api/devices/leases/l%2F1/thumbnail?w=320");
  assert.equal(deviceRoutes.thumbnail("l1", 200.4), "/api/devices/leases/l1/thumbnail?w=200");
});

test("?token= is accepted on GET/HEAD of the image routes only: never the hub proxy, a POST or another route", () => {
  for (const method of ["GET", "HEAD"]) {
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_SCREENSHOT_ROUTE_PATTERN), true);
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_THUMBNAIL_ROUTE_PATTERN), true);
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_HUB_ROUTE_PATTERN), false);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_SCREENSHOT_ROUTE_PATTERN), false);
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_THUMBNAIL_ROUTE_PATTERN), false);
    assert.equal(deviceQueryTokenAllowed(method, DEVICE_HUB_ROUTE_PATTERN), false);
  }
  assert.equal(deviceQueryTokenAllowed("GET", "/api/devices/leases/:leaseId/user-action"), false);
  assert.equal(deviceQueryTokenAllowed("GET", undefined), false);
  assert.deepEqual([...DEVICE_QUERY_TOKEN_ROUTES].sort(), [DEVICE_SCREENSHOT_ROUTE_PATTERN, DEVICE_THUMBNAIL_ROUTE_PATTERN].sort());
});

test("drain and cache-warm requests", () => {
  assert.deepEqual(parseDeviceHostDrainRequest({ draining: true }), { ok: true, value: { draining: true } });
  assert.equal(parseDeviceHostDrainRequest({ draining: "yes" }).ok, false);
  assert.equal(parseDeviceHostDrainRequest(undefined).ok, false);
  assert.deepEqual(parseDeviceCacheWarmRequest({ platform: "android" }), { ok: true, value: { platform: "android" } });
  assert.equal(parseDeviceCacheWarmRequest({ platform: "windows" }).ok, false);
  assert.equal(parseDeviceCacheWarmRequest({}).ok, false);
});

test("user action requests: each kind with its own field, nothing else", () => {
  assert.deepEqual(parseDeviceUserActionRequest({ kind: "rotate", orientation: "landscape" }), { ok: true, value: { kind: "rotate", orientation: "landscape" } });
  assert.deepEqual(parseDeviceUserActionRequest({ kind: "appearance", appearance: "dark", extra: 1 }), { ok: true, value: { kind: "appearance", appearance: "dark" } });
  assert.deepEqual(parseDeviceUserActionRequest({ kind: "restart_app" }), { ok: true, value: { kind: "restart_app" } });
  assert.deepEqual(parseDeviceUserActionRequest({ kind: "power_off" }), { ok: true, value: { kind: "power_off" } });
  assert.equal(parseDeviceUserActionRequest({ kind: "rotate" }).ok, false);
  assert.equal(parseDeviceUserActionRequest({ kind: "rotate", orientation: "sideways" }).ok, false);
  assert.equal(parseDeviceUserActionRequest({ kind: "appearance", appearance: "sepia" }).ok, false);
  assert.equal(parseDeviceUserActionRequest({ kind: "tap" }).ok, false);
  assert.equal(parseDeviceUserActionRequest(null).ok, false);
});

test("open request: platform-matched profile, deviceId needs hostId, junk refused", () => {
  assert.deepEqual(parseDeviceOpenRequest({ threadId: "t", platform: "android", profile: "pixel-fold", fresh: true }), {
    ok: true,
    value: { threadId: "t", platform: "android", profile: "pixel-fold", fresh: true }
  });
  assert.equal(parseDeviceOpenRequest({ threadId: "t", platform: "ios", profile: "pixel-9" }).ok, false);
  assert.equal(parseDeviceOpenRequest({ threadId: "t", platform: "android", deviceId: "emulator-5554" }).ok, false);
  assert.equal(parseDeviceOpenRequest({ threadId: "t", platform: "android", hostId: "local", deviceId: "emulator-5554", app: "com.example" }).ok, true);
  assert.equal(parseDeviceOpenRequest({ threadId: "t", platform: "android", app: "rm -rf /" }).ok, false);
  assert.equal(parseDeviceOpenRequest({ platform: "android" }).ok, false);
  assert.equal(parseDeviceOpenRequest({ threadId: "t", platform: "windows" }).ok, false);
  assert.equal(parseDeviceOpenRequest("x").ok, false);
});

test("controller and setup requests", () => {
  assert.deepEqual(parseDeviceControllerRequest({ controller: "user" }), { ok: true, value: { controller: "user" } });
  assert.equal(parseDeviceControllerRequest({ controller: "robot" }).ok, false);
  assert.deepEqual(parseDeviceSetupRequest(undefined), { ok: true, value: {} });
  assert.deepEqual(parseDeviceSetupRequest({ actions: ["install-android-sdk", "install-android-sdk"] }), {
    ok: true,
    value: { actions: ["install-android-sdk"] }
  });
  assert.equal(parseDeviceSetupRequest({ actions: ["; rm"] }).ok, false);
});

test("settings patch: each field checked against its range; unknown fields refused", () => {
  const good = parseDevicesSettingsPatch({
    android: { enabled: true, maxLocalDevices: 4, profiles: ["pixel-9", "pixel-9"] },
    ios: { rentWithoutAsking: true, monthlyCapUsd: 12.5 },
    pool: { placement: "pool-only", provider: null, minWarmHosts: { android: 1 }, monthlyCapUsd: 50 },
    leaseIdleMinutes: 30
  });
  assert.deepEqual(good, {
    ok: true,
    value: {
      android: { enabled: true, maxLocalDevices: 4, profiles: ["pixel-9"] },
      ios: { rentWithoutAsking: true, monthlyCapUsd: 12.5 },
      pool: { placement: "pool-only", provider: null, minWarmHosts: { android: 1 }, monthlyCapUsd: 50 },
      leaseIdleMinutes: 30
    }
  });
  for (const bad of [
    { android: { maxLocalDevices: 0 } },
    { android: { maxLocalDevices: 2.5 } },
    { android: { profiles: ["iphone-17-pro"] } },
    { ios: { enabled: "yes" } },
    { ios: { size: "" } },
    { pool: { placement: "anywhere" } },
    { pool: { minWarmHosts: { windows: 1 } } },
    { pool: { monthlyCapUsd: -1 } },
    { agents: { unknown: true } },
    { surprise: 1 },
    { maxLeasesPerChat: 99 },
    []
  ]) {
    assert.equal(parseDevicesSettingsPatch(bad).ok, false, JSON.stringify(bad));
  }
});

for (const [name, json] of [
  ["top-level constructor", '{"constructor":{}}'],
  ["top-level __proto__", '{"__proto__":{}}'],
  ["top-level toString", '{"toString":{}}'],
  ["android constructor", '{"android":{"constructor":true}}'],
  ["android __proto__", '{"android":{"__proto__":{}}}'],
  ["pool constructor", '{"pool":{"constructor":true}}'],
  ["pool __proto__", '{"pool":{"__proto__":{}}}'],
  ["warm-host constructor", '{"pool":{"minWarmHosts":{"constructor":1}}}'],
  ["research constructor", '{"research":{"constructor":{}}}'],
  ["research host constructor", '{"research":{"vphoneHosts":{"box1":{"constructor":true}}}}']
] as const) {
  test(`settings patch: refuses inherited property name ${name}`, () => {
    const parsed = parseDevicesSettingsPatch(JSON.parse(json));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.message, /Unknown setting/);
  });
}

test("settings patch: research.vphoneHosts takes per-machine entries field by field, null forgets one", () => {
  assert.deepEqual(
    parseDevicesSettingsPatch({ research: { vphoneHosts: { box1: { enabled: true, iphoneSource: " /Users/me/iPhone17,3.ipsw " }, box2: null } } }),
    { ok: true, value: { research: { vphoneHosts: { box1: { enabled: true, iphoneSource: "/Users/me/iPhone17,3.ipsw" }, box2: null } } } }
  );
  for (const bad of [
    { research: [] },
    { research: { other: {} } },
    { research: { vphoneHosts: { "../x": { enabled: true } } } },
    { research: { vphoneHosts: { box1: { enabled: "yes" } } } },
    { research: { vphoneHosts: { box1: { iphoneSource: "" } } } },
    { research: { vphoneHosts: { box1: { iphoneSource: "a\nb" } } } },
    { research: { vphoneHosts: { box1: { iphoneSource: "-rf" } } } },
    { research: { vphoneHosts: { box1: { cloudosSource: "--help" } } } },
    { research: { vphoneHosts: { box1: { cloudosSource: "http://example.test/cloudOS.ipsw" } } } },
    { research: { vphoneHosts: { box1: { iphoneSource: "iPhone.ipsw" } } } },
    { research: { vphoneHosts: { box1: { force: true } } } },
    { research: { vphoneHosts: { box1: 1 } } }
  ]) {
    assert.equal(parseDevicesSettingsPatch(bad).ok, false, JSON.stringify(bad));
  }
});

test("device action input: each kind names what it needs", () => {
  assert.equal(validateDeviceActionInput({ action: "snapshot" }), null);
  assert.equal(validateDeviceActionInput({ action: "tap", ref: "@e7" }), null);
  assert.equal(validateDeviceActionInput({ action: "tap", x: 10, y: 20 }), null);
  assert.match(validateDeviceActionInput({ action: "tap" }) ?? "", /ref/);
  assert.match(validateDeviceActionInput({ action: "tap", ref: "@e1", x: 1, y: 2 }) ?? "", /not both/);
  assert.match(validateDeviceActionInput({ action: "tap", x: 1 }) ?? "", /x/);
  assert.match(validateDeviceActionInput({ action: "fill", ref: "@e1" }) ?? "", /text/);
  assert.match(validateDeviceActionInput({ action: "press" }) ?? "", /home/);
  assert.equal(validateDeviceActionInput({ action: "swipe", from: { x: 1, y: 1 }, to: { x: 1, y: 100 } }), null);
  assert.match(validateDeviceActionInput({ action: "swipe", from: { x: 1, y: 1 } }) ?? "", /direction/);
  assert.match(validateDeviceActionInput({ action: "permissions", app: "a", permission: "camera" }) ?? "", /grant/);
  assert.match(validateDeviceActionInput({ action: "wait" }) ?? "", /text/);
});

test("deviceRef: kept through slimming, read back only from a marked session-tool row", () => {
  assert.ok(SESSION_TOOL_REFERENCE_KEYS.includes(DEVICE_TOOL_REFERENCE_KEY));
  assert.deepEqual(readDeviceToolReference({ device: "local/emulator-5554", screenshotId: "s1", leaseId: "l1", extra: 1 }), {
    device: "local/emulator-5554",
    leaseId: "l1",
    screenshotId: "s1"
  });
  assert.deepEqual(readDeviceToolReference({ device: "local/x", screenshotId: "../etc" }), { device: "local/x" });
  assert.equal(readDeviceToolReference({ device: "" }), undefined);
  assert.equal(readDeviceToolReference("x"), undefined);
  const result = { content: [{ type: "text", text: JSON.stringify({ deviceRef: { device: "local/e", screenshotId: "s2" } }) }] };
  assert.deepEqual(deviceToolReferenceOfActivityData({ sessionTool: { name: "device_action" }, result }), { device: "local/e", screenshotId: "s2" });
  assert.equal(deviceToolReferenceOfActivityData({ result }), undefined);
});

test("deviceRef: the row's words (name, action, summary) are kept only when valid", () => {
  assert.deepEqual(
    readDeviceToolReference({ device: "local/e", leaseId: "l1", name: " Pixel 9 ", action: "tap", summary: "Tapped @e7 “Search”" }),
    { device: "local/e", leaseId: "l1", name: "Pixel 9", action: "tap", summary: "Tapped @e7 “Search”" }
  );
  assert.deepEqual(readDeviceToolReference({ device: "local/e", name: "Pixel\n9", action: "hack", summary: "x".repeat(201) }), { device: "local/e" });
  assert.deepEqual(readDeviceToolReference({ device: "local/e", name: "", summary: "a\u0007b", action: 3 }), { device: "local/e" });
  assert.deepEqual(readDeviceToolReference({ device: "local/e", name: "n".repeat(121) }), { device: "local/e" });
});

test("contracts other modules gained: the devices toolset, the device-host box purpose and setup step", () => {
  const devices = TOOLSETS.find((toolset) => toolset.id === "devices");
  assert.deepEqual(
    devices?.tools.map((tool) => tool.name),
    ["list_devices", "open_device", "device_action", "device_install", "close_device"]
  );
  assert.equal(devices?.label, "Devices");
  assert.ok(isBoxPurpose("device-host"));
  assert.ok(BOX_SETUP_STEP_IDS.indexOf("devices") === BOX_SETUP_STEP_IDS.indexOf("connect") + 1);
});
