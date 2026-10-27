import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { AVD_HARDWARE, avdHardware, cutoutSpecInDp, parseIni, patchAvdConfig } from "../../devices/android/avd-config.ts";
import { emulatorArgs } from "../../devices/android/emulator.ts";
import { LOCAL_EXECUTOR } from "../../devices/android/executor.ts";
import { CLOSE_SYSTEM_DIALOGS_SCRIPT, fixDisplayCutout, GUEST_SETTINGS_SCRIPT } from "../../devices/android/golden.ts";
import { BOX_GPU_MODES, boxAvdState, boxGolden } from "../../devices/hosts/box/android-remote.ts";
import { CMDLINE_TOOLS, profileHash } from "../../devices/toolchain/android-sdk.ts";
import {
  ANDROID_AVD_STEP_SCRIPT,
  ANDROID_CACHE_HASH,
  ANDROID_CACHE_KEY,
  ANDROID_CACHE_PATHS,
  ANDROID_CACHE_PROFILES,
  ANDROID_GOLDEN_SNAPSHOT,
  ANDROID_SDK_PACKAGES,
  ANDROID_SDK_STEP_SCRIPT,
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

test("the device tools install the pinned versions from the shipped lockfile without lifecycle scripts", () => {
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
  // v2: AVDs tuned like a box host's (v1 caches held untuned 1080p AVDs).
  assert.match(ANDROID_CACHE_KEY, /^orq-devices-android-[0-9a-f]{16}-v2$/);
  assert.equal(ANDROID_CACHE_KEY, `orq-devices-android-${ANDROID_CACHE_HASH}-v2`);
  assert.match(deviceToolsCacheKey("linux"), /^orq-devices-tools-linux-node22-[0-9a-f]{16}-v1$/);
  assert.notEqual(deviceToolsCacheKey("linux"), deviceToolsCacheKey("macos"));
  assert.equal(deviceToolsCacheKey("linux").replace("linux", "macos"), deviceToolsCacheKey("macos"), "the same tools hash on both");
  assert.equal(appleRunnerCacheKey("17E202"), "orq-devices-apple-runner-17E202-agent-device-0.21.31-v1");
  assert.notEqual(appleRunnerCacheKey("17E202"), appleRunnerCacheKey("17F100"));
  for (const key of [ANDROID_CACHE_KEY, deviceToolsCacheKey("linux"), appleRunnerCacheKey("17E202")]) {
    assert.ok(key.length < 512 && !key.includes(","), key);
  }
});

test("the Android cache holds the API 35 x86_64 image and the default Pixel profiles, from the box host's pinned cmdline-tools", () => {
  assert.deepEqual(ANDROID_SDK_PACKAGES, ["platform-tools", "emulator", "system-images;android-35;google_apis;x86_64"]);
  assert.deepEqual(
    ANDROID_CACHE_PROFILES.map((profile) => profile.id),
    ["pixel-9", "pixel-tablet", "pixel-fold"]
  );
  assert.ok(ANDROID_SDK_STEP_SCRIPT.includes(`'${CMDLINE_TOOLS.url}'`) && ANDROID_SDK_STEP_SCRIPT.includes(`'${CMDLINE_TOOLS.sha256}'`));
});

// Snapshots of the generated scripts: `ORQ_UPDATE_SNAPSHOTS=1` rewrites them (review the diff).
for (const [name, script] of [
  ["android-sdk-step.sh", ANDROID_SDK_STEP_SCRIPT],
  ["android-avd-step.sh", ANDROID_AVD_STEP_SCRIPT]
] as const) {
  test(`snapshot: ${name}`, () => {
    const file = new URL(`./fixtures/${name}`, import.meta.url);
    if (process.env.ORQ_UPDATE_SNAPSHOTS === "1") writeFileSync(file, script);
    assert.equal(script, readFileSync(file, "utf8"), `the generated script changed: rerun with ORQ_UPDATE_SNAPSHOTS=1 and review fixtures/${name}`);
  });
}

test("the AVD script is generated from the box host's own modules: hardware, config hash, flags, guest settings, GPU order", () => {
  for (const profile of ANDROID_CACHE_PROFILES) {
    const hardware = avdHardware(profile);
    assert.ok(
      ANDROID_AVD_STEP_SCRIPT.includes(
        `make_profile 'orq-${profile.id}' '${profile.systemImage}' '${hardware.device}' '${hardware.width}' '${hardware.height}' '${hardware.density}' '${profile.id}' '${profileHash(profile)}'`
      ),
      profile.id
    );
  }
  // Pixel 9 at its real aspect, ⅔ of the panel: 720×1616 @280 (not avdmanager's 1080×2424 @420).
  assert.deepEqual(AVD_HARDWARE["pixel-9"], { device: "pixel_9", width: 720, height: 1616, density: 280 });
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(readFileSync(new URL("../../devices/android/avd-tuning.mjs", import.meta.url), "utf8").trimEnd()), "avd-tuning.mjs embedded verbatim");
  const golden = emulatorArgs({ avd: "x", consolePort: 5554, grpcPort: 8554, golden: true, gpu: "g", snapshot: ANDROID_GOLDEN_SNAPSHOT });
  assert.deepEqual(golden.slice(-2), ["-no-snapshot-load", "-no-snapshot-save"]);
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`setsid emulator '-avd' "$name" '-no-window'`));
  for (const flag of golden.filter((arg) => arg.startsWith("-"))) assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(` '${flag}'`), flag);
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`sh_adb 60 '${GUEST_SETTINGS_SCRIPT}'`));
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`sh_adb 30 '${CLOSE_SYSTEM_DIALOGS_SCRIPT}'`));
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`for gpu in ${BOX_GPU_MODES.box.join(" ")}; do`));
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`adb -s "$SERIAL" emu avd snapshot save ${ANDROID_GOLDEN_SNAPSHOT}`));
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(`ANDROID_AVD_HOME=${BOX_ANDROID_AVD_DIR}`));
  // The emulator's overlays and crashpad database in the box layout, as a box host's env has them (not /tmp/android-$USER).
  assert.ok(ANDROID_AVD_STEP_SCRIPT.includes(` TMPDIR=${BOX_DEVICES_DIR}/tmp ANDROID_TMP=${BOX_DEVICES_DIR}/tmp `));
});

/** The script's `cat > "$TUNE/<file>" << 'TAG'` heredocs, written into `dir`. */
function extractTuning(dir: string): void {
  for (const match of ANDROID_AVD_STEP_SCRIPT.matchAll(/cat > "\$TUNE\/([a-z-]+\.mjs)" << '([A-Z_]+)'\n([\s\S]*?)\n\2\n/g)) {
    writeFileSync(join(dir, match[1]!), `${match[3]}\n`);
  }
}

test("the script's tuning (run by node as the workflow runs it) writes what the box host makes and trusts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orq-avd-tune-"));
  try {
    extractTuning(dir);
    const tune = (...args: string[]) => {
      const result = spawnSync(process.execPath, [join(dir, "tune.mjs"), ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const avdHome = join(dir, "avd");
    const sdk = join(dir, "sdk");
    mkdirSync(join(sdk, "emulator"), { recursive: true });
    writeFileSync(join(sdk, "emulator", "source.properties"), "Pkg.Desc = Android Emulator\nPkg.Revision=36.4.9\n");
    for (const profile of ANDROID_CACHE_PROFILES) {
      const hardware = avdHardware(profile);
      const name = `orq-${profile.id}`;
      const avd = join(avdHome, `${name}.avd`);
      mkdirSync(join(avd, "snapshots", ANDROID_GOLDEN_SNAPSHOT), { recursive: true });
      writeFileSync(join(avdHome, `${name}.ini`), `path=${avd}\n`);
      writeFileSync(join(avd, "snapshots", ANDROID_GOLDEN_SNAPSHOT, "snapshot.pb"), "");
      // What avdmanager 22 (cmdline-tools 15859902) writes for the device, unmodified.
      const original = readFileSync(new URL(`./fixtures/avdmanager/${hardware.device}.ini`, import.meta.url), "utf8");
      writeFileSync(join(avd, "config.ini"), original);
      const deviceDensity = tune("patch", join(avd, "config.ini"), name, String(hardware.width), String(hardware.height), String(hardware.density), "swangle_indirect");
      assert.equal(readFileSync(join(avd, "config.ini"), "utf8"), patchAvdConfig(original, { name, hardware }), `${profile.id}: the daemon's own patch`);
      assert.equal(deviceDensity, parseIni(original).get("hw.lcd.density"));
      const config = parseIni(readFileSync(join(avd, "config.ini"), "utf8"));
      assert.deepEqual([config.get("hw.lcd.width"), config.get("hw.lcd.height"), config.get("hw.lcd.density")], [String(hardware.width), String(hardware.height), String(hardware.density)]);
      tune("avd-marker", join(avd, "orq-avd.json"), profile.id, profileHash(profile), deviceDensity);
      tune("golden-marker", join(avd, "orq-box-golden.json"), "swangle_indirect", profileHash(profile), sdk);
      // The box host takes them as the cache's, with the GPU mode the cache recorded.
      assert.equal(await boxAvdState(LOCAL_EXECUTOR, avdHome, profile), "cache");
      assert.deepEqual(await boxGolden(LOCAL_EXECUTOR, avdHome, profile, "cache", "36.4.9"), { snapshot: ANDROID_GOLDEN_SNAPSHOT, gpu: "swangle_indirect", source: "cache" });
      assert.equal(JSON.parse(readFileSync(join(avd, "orq-avd.json"), "utf8")).deviceDensity, Number(deviceDensity));
    }
    const spec = "m 581.5,86.5 a 42,42 0 0 0 -84,0 42,42 0 0 0 84,0 z @left";
    assert.equal(tune("cutout", spec, "420"), cutoutSpecInDp(spec, 420));
    assert.equal(tune("cutout", "", "420"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A fake device for the cutout fix, answering the daemon's `exec` and the script's `adb` alike
 * (state in a JSON file): Pixel 9's emulation overlay, a SystemUI that restarts when killed, the dp
 * cutout taken once `OrqCutout` is enabled.
 */
const FAKE_DEVICE = `import { readFileSync, writeFileSync } from "node:fs";
export function answer(stateFile, command) {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  let out = { exitCode: 0, stdout: "" };
  if (command === "shell dumpsys display") out.stdout = "mCutout cutoutSpec={" + state.spec + "} x\\n";
  else if (command === "shell cmd overlay list") out.stdout = "android\\n[x] com.android.internal.emulation.pixel_9\\n[ ] com.android.internal.emulation.pixel_8\\n";
  else if (command === "shell cmd overlay lookup android android:string/config_mainBuiltInDisplayCutoutRectApproximation") out.stdout = state.rect;
  else if (command === "shell cmd overlay lookup android android:bool/config_fillMainBuiltInDisplayCutout") out.stdout = state.fill;
  else if (command === "shell pidof com.android.systemui") out.stdout = state.systemUiPid + "\\n";
  else if (command === "shell kill " + state.systemUiPid) state.systemUiPid += 208;
  else if (state.fail && command.startsWith("shell cmd overlay fabricate --target android --name " + state.fail + " ")) out = { exitCode: 1, stdout: "Error: no such resource\\n" };
  else if (command === "shell cmd overlay enable com.android.shell:OrqCutout") state.spec = "m 221 33 @left @dp";
  writeFileSync(stateFile, JSON.stringify(state));
  return out;
}
`;

test("the script's cutout fix runs what golden.ts runs: rect and fill overlays, enable/disable, SystemUI restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orq-avd-cutout-"));
  try {
    extractTuning(dir);
    writeFileSync(join(dir, "fake-device.mjs"), FAKE_DEVICE);
    writeFileSync(
      join(dir, "fake-adb.mjs"),
      `import { appendFileSync } from "node:fs";\nimport { answer } from "./fake-device.mjs";\nconst command = process.argv.slice(4).join(" ");\nappendFileSync(process.env.ORQ_FAKE_LOG, command + "\\n");\nconst out = answer(process.env.ORQ_FAKE_STATE, command);\nprocess.stdout.write(out.stdout);\nprocess.exit(out.exitCode);\n`
    );
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "adb"), `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "fake-adb.mjs")}' "$@"\n`);
    chmodSync(join(bin, "adb"), 0o755);
    const { answer } = (await import(pathToFileURL(join(dir, "fake-device.mjs")).href)) as { answer: (stateFile: string, command: string) => { exitCode: number; stdout: string } };
    // The script's own helpers and fix_cutout, with sleeps skipped.
    const fns = ["warn", "sh_adb"].map((name) => new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(ANDROID_AVD_STEP_SCRIPT)?.[0]);
    const fixCutout = /^fix_cutout\(\) \{\n[\s\S]*?\n\}$/m.exec(ANDROID_AVD_STEP_SCRIPT)?.[0];
    assert.ok(fns.every(Boolean) && fixCutout);
    const scenarios = [
      { name: "fixed", state: { rect: "@android:string/config_mainBuiltInDisplayCutoutRectApproximation -> m 484.5,0 h 110 v 141.5 h -110 z @left\n", fill: "true\n" }, golden: "fixed" },
      { name: "no rect, not filled", state: { rect: "\n", fill: "false\n" }, golden: "fixed" },
      { name: "the rect overlay fails", state: { rect: "m 484.5,0 h 110 v 141.5 h -110 z @left\n", fill: "true\n", fail: "OrqCutoutRect" }, golden: /fabricating the cutout overlay failed/ },
      { name: "already in dp", state: { spec: "m 1 2 @left @dp", rect: "", fill: "" }, golden: "kept" }
    ] as const;
    for (const scenario of scenarios) {
      const initial = JSON.stringify({ spec: "m 581.5,86.5 a 42,42 0 0 0 -84,0 42,42 0 0 0 84,0 z @left", systemUiPid: 996, ...scenario.state });
      const stateFile = join(dir, "state.json");
      // golden.ts, as a host runs it.
      writeFileSync(stateFile, initial);
      const daemon: string[] = [];
      const how = fixDisplayCutout({
        exec: async (_adb, args) => {
          const command = args.slice(2).join(" ");
          daemon.push(command);
          return { ...answer(stateFile, command), stderr: "" };
        },
        adb: "adb",
        env: {},
        serial: "emulator-5554",
        cutoutDensity: 420,
        signal: new AbortController().signal
      });
      if (typeof scenario.golden === "string") assert.equal(await how, scenario.golden, scenario.name);
      else await assert.rejects(how, scenario.golden, scenario.name);
      const daemonState = readFileSync(stateFile, "utf8");
      // The script, as the cache workflow runs it.
      writeFileSync(stateFile, initial);
      const log = join(dir, "adb.log");
      writeFileSync(log, "");
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", `set -u\nsleep() { :; }\n${fns.join("\n")}\n${fixCutout}\nfix_cutout 420`], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TUNE: dir, SERIAL: "emulator-5554", ORQ_FAKE_LOG: log, ORQ_FAKE_STATE: stateFile }
      });
      assert.equal(result.status, scenario.golden === "fixed" || scenario.golden === "kept" ? 0 : 1, `${scenario.name}: ${result.stdout}${result.stderr}`);
      assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), daemon, scenario.name);
      assert.equal(readFileSync(stateFile, "utf8"), daemonState, scenario.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
