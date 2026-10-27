import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ANDROID_AVDS,
  ANDROID_CACHE_HASH,
  ANDROID_CACHE_KEY,
  ANDROID_CACHE_PATHS,
  ANDROID_SDK_PACKAGES,
  APPLE_RUNNER_CACHE_PATHS,
  APPLE_RUNNER_STEP_SCRIPT,
  appleRunnerCacheKey,
  BOX_ANDROID_AVD_DIR,
  BOX_ANDROID_SDK_DIR,
  BOX_DEVICE_TOOLS_DIR,
  BOX_DEVICES_DIR,
  boxDeviceToolBin,
  DEVICE_TOOL_VERSIONS,
  DEVICE_TOOLS_STEP_SCRIPT,
  deviceToolsCacheKey,
  KVM_STEP_SCRIPT
} from "./device-cache.ts";

test("the pinned tool versions are the device service's tool-versions.json", () => {
  const json = JSON.parse(readFileSync(new URL("../../devices/tool-versions.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.deepEqual({ ...DEVICE_TOOL_VERSIONS }, json);
  assert.equal(DEVICE_TOOL_VERSIONS["agent-device"], "0.21.31");
  assert.equal(DEVICE_TOOL_VERSIONS["expo-device-hub"], "0.19.0-canary-20261023-1357114");
  // From the shipped lockfile, with no lifecycle script.
  for (const [name, version] of Object.entries(DEVICE_TOOL_VERSIONS)) assert.ok(DEVICE_TOOLS_STEP_SCRIPT.includes(`"${name}": "${version}"`));
  assert.ok(DEVICE_TOOLS_STEP_SCRIPT.includes("npm ci --ignore-scripts"));
  assert.ok(!/npm install/.test(DEVICE_TOOLS_STEP_SCRIPT));
});

test("box paths live under /var/lib/orquester/devices, which the paths step hands to the runner user", () => {
  for (const path of [BOX_ANDROID_SDK_DIR, BOX_ANDROID_AVD_DIR, BOX_DEVICE_TOOLS_DIR]) assert.ok(path.startsWith(`${BOX_DEVICES_DIR}/`));
  assert.equal(BOX_ANDROID_SDK_DIR, "/var/lib/orquester/devices/android-sdk");
  assert.equal(BOX_ANDROID_AVD_DIR, "/var/lib/orquester/devices/avd");
  assert.equal(boxDeviceToolBin("agent-device"), "/var/lib/orquester/devices/tools/node_modules/.bin/agent-device");
  assert.deepEqual(ANDROID_CACHE_PATHS, [BOX_ANDROID_SDK_DIR, BOX_ANDROID_AVD_DIR]);
  assert.deepEqual(APPLE_RUNNER_CACHE_PATHS, ["~/.agent-device/apple-runner"]);
});

test("cache keys: one per content, valid for actions/cache, per OS where it matters", () => {
  assert.match(ANDROID_CACHE_KEY, /^orq-devices-android-[0-9a-f]{16}-v1$/);
  assert.equal(ANDROID_CACHE_KEY, `orq-devices-android-${ANDROID_CACHE_HASH}-v1`);
  assert.match(deviceToolsCacheKey("linux"), /^orq-devices-tools-linux-node22-[0-9a-f]{16}-v1$/);
  assert.notEqual(deviceToolsCacheKey("linux"), deviceToolsCacheKey("macos"));
  assert.equal(deviceToolsCacheKey("linux").replace("linux", "macos"), deviceToolsCacheKey("macos"), "the same tools hash on both");
  assert.equal(appleRunnerCacheKey("17E202"), "orq-devices-apple-runner-17E202-agent-device-0.21.31-v1");
  assert.notEqual(appleRunnerCacheKey("17E202"), appleRunnerCacheKey("17F100"));
  for (const key of [ANDROID_CACHE_KEY, deviceToolsCacheKey("linux"), appleRunnerCacheKey("17E202")]) {
    assert.ok(key.length < 512 && !key.includes(","), key);
  }
});

test("the Android cache holds the API 35 x86_64 image and the three Pixel AVDs", () => {
  assert.deepEqual(ANDROID_SDK_PACKAGES, ["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]);
  // Device ids from `avdmanager list device -c` (cmdline-tools 19).
  assert.deepEqual(ANDROID_AVDS, [
    { name: "orq-pixel-9", device: "pixel_9" },
    { name: "orq-pixel-tablet", device: "pixel_tablet" },
    { name: "orq-pixel-fold", device: "pixel_fold" }
  ]);
});

test("the KVM step installs the udev rule that opens /dev/kvm to every user", () => {
  assert.ok(KVM_STEP_SCRIPT.includes(`'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"'`));
  assert.ok(KVM_STEP_SCRIPT.includes("udevadm control --reload-rules"));
  assert.ok(KVM_STEP_SCRIPT.includes("udevadm trigger --name-match=kvm"));
});

test("the iOS runner build picks the newest iOS runtime and its newest iPhone", () => {
  const code = /node -e '\n([\s\S]*?)\n'\)/.exec(APPLE_RUNNER_STEP_SCRIPT)?.[1];
  assert.ok(code, "the picker's node script");
  const pick = (data: unknown) => spawnSync(process.execPath, ["-e", code], { input: JSON.stringify(data), encoding: "utf8" });
  const iPhone = (id: string) => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${id}`, productFamily: "iPhone" });
  const iPad = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro", productFamily: "iPad" };
  const runtime = (version: string, extra: Record<string, unknown> = {}) => ({
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(/\./g, "-")}`,
    version,
    platform: "iOS",
    isAvailable: true,
    supportedDeviceTypes: [iPhone("iPhone-16"), iPhone("iPhone-17-Pro"), iPad],
    ...extra
  });
  const result = pick({
    runtimes: [
      runtime("26.4.1"),
      runtime("27.0"),
      runtime("26.10"),
      runtime("28.0", { isAvailable: false }),
      { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", version: "30.0", platform: "watchOS", isAvailable: true, supportedDeviceTypes: [] }
    ]
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "com.apple.CoreSimulator.SimRuntime.iOS-27-0 com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro");
  assert.notEqual(pick({ runtimes: [] }).status, 0);
});
