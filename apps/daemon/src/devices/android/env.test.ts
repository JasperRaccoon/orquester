import assert from "node:assert/strict";
import test from "node:test";

import { ADB_PORT_BASE, ADB_PORT_SPAN, adbServerPort, androidLayout, appdirMarker, buildAndroidEnv } from "./env.ts";

test("env: every tool home is inside the appdir; the adb port is private; daemon secrets are not passed", () => {
  const layout = androidLayout("/srv/app");
  const env = buildAndroidEnv(layout, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ORQUESTER_SECRET: "s", ANTHROPIC_API_KEY: "k", HOME: "/root" }, { user: "orq", nodePath: "/opt/node/bin/node", adbPort: 16123 });
  assert.equal(env.ORQUESTER_SECRET, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.LANG, "C.UTF-8");
  for (const [key, value] of Object.entries({
    ANDROID_HOME: layout.sdk,
    ANDROID_SDK_ROOT: layout.sdk,
    ANDROID_AVD_HOME: layout.avd,
    ANDROID_USER_HOME: layout.androidUser,
    ANDROID_EMULATOR_HOME: layout.androidUser,
    XDG_RUNTIME_DIR: layout.runtime,
    TMPDIR: layout.tmp,
    HOME: layout.home,
    USER: "orq",
    ANDROID_ADB_SERVER_PORT: "16123",
    EXPO_DEVICE_HUB_STATE_DIR: layout.hubState,
    AGENT_DEVICE_STATE_DIR: layout.agentDeviceState,
    AGENT_DEVICE_HOME: layout.agentDeviceHome,
    AGENT_DEVICE_CLAIMS_DIR: layout.agentDeviceClaims,
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0"
  })) {
    assert.equal(env[key], value, key);
    if (key !== "USER" && !key.endsWith("PORT") && !key.endsWith("_MS")) assert.ok(value.startsWith("/srv/app/"), key);
  }
  assert.equal(env.PATH, `/opt/node/bin:${layout.sdk}/platform-tools:${layout.sdk}/emulator:${layout.sdk}/cmdline-tools/latest/bin:/usr/bin:/bin`);
  assert.deepEqual(appdirMarker(layout), { key: "ANDROID_AVD_HOME", value: layout.avd });
});

test("adb port: stable per appdir, different between appdirs, never the default 5037", () => {
  const a = adbServerPort("/var/lib/orquester");
  assert.equal(adbServerPort("/var/lib/orquester"), a);
  assert.notEqual(adbServerPort("/var/lib/orquester/tmp/devices-local-it/app"), a);
  for (const dir of ["/a", "/b", "/c", "/var/lib/x"]) {
    const port = adbServerPort(dir);
    assert.ok(port >= ADB_PORT_BASE && port < ADB_PORT_BASE + ADB_PORT_SPAN && port !== 5037);
  }
});
