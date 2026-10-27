import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { ANDROID_SYSTEM_IMAGE, DEFAULT_DEVICES_SETTINGS, type DevicesSettings } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { ExecFn } from "../android/exec.ts";
import { isProcessAlive, waitForExit } from "../android/procs.ts";
import { readHostState, writeHostState } from "../android/state.ts";
import type { KvmProbe } from "../android/readiness.ts";
import { createDeviceToolchain, DEVICE_TOOL_VERSIONS } from "../toolchain/index.ts";
import { LocalAndroidHost } from "./local-android.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function touch(path: string, text = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface Harness {
  appDir: string;
  host: LocalAndroidHost;
  exec: string[][];
  leases: StoredDeviceLease[];
  /** serial → process, for the fake `adb emu kill`. */
  emulators: Map<string, ChildProcess>;
  settings: DevicesSettings;
}

async function withHost(options: { kvm?: KvmProbe; java?: boolean; sdk?: boolean }, run: (h: Harness) => Promise<void>): Promise<void> {
  const appDir = await mkdtemp(join(tmpdir(), "orq-devices-local-"));
  const calls: string[][] = [];
  const emulators = new Map<string, ChildProcess>();
  const exec: ExecFn = async (command, args) => {
    const name = command.split("/").at(-1)!;
    calls.push([name, ...args]);
    if (name === "ffmpeg") return { exitCode: 0, stdout: " V....D libx264  libx264 H.264", stderr: "" };
    if (name === "java") return options.java === false ? { exitCode: -1, stdout: "", stderr: "ENOENT" } : { exitCode: 0, stdout: "", stderr: 'openjdk version "17"' };
    if (name === "adb" && args[2] === "emu" && args[3] === "kill") {
      emulators.get(args[1]!)?.kill("SIGTERM");
      return { exitCode: 0, stdout: "OK", stderr: "" };
    }
    if (name === "avdmanager") {
      const path = args[args.indexOf("--path") + 1]!;
      await touch(join(path, "config.ini"), "avd.id=<build>\nhw.lcd.width=1080\nhw.lcd.height=2424\n");
      await touch(join(dirname(path), `${args[args.indexOf("--name") + 1]}.ini`), "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const settings: DevicesSettings = { ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true, profiles: ["pixel-9"] } };
  const leases: StoredDeviceLease[] = [];
  const toolchain = createDeviceToolchain({ appDir, env: { PATH: process.env.PATH }, logger: quiet, exec, nodePath: process.execPath, npmCli: null });
  if (options.sdk) {
    const sdk = toolchain.layout.sdk;
    for (const file of ["cmdline-tools/latest/bin/sdkmanager", "cmdline-tools/latest/bin/avdmanager", "platform-tools/adb", "emulator/emulator", `${ANDROID_SYSTEM_IMAGE.split(";").join("/")}/system.img`]) await touch(join(sdk, file));
  }
  const host = new LocalAndroidHost(
    { appDir, env: { PATH: process.env.PATH }, toolchain, logger: quiet, exec, probeKvm: async () => options.kvm ?? { access: "direct" } },
    { settings: () => settings, activeLeases: () => leases }
  );
  try {
    await run({ appDir, host, exec: calls, leases, emulators, settings });
  } finally {
    await host.dispose();
    for (const child of emulators.values()) child.kill("SIGKILL");
    await rm(appDir, { recursive: true, force: true });
  }
}

const lease = (id: string, deviceId: string): StoredDeviceLease => ({
  id,
  threadId: "t",
  hostId: "local",
  deviceId,
  platform: "android",
  profile: "pixel-9",
  name: "Pixel 9",
  osVersion: "Android 15",
  state: "ready",
  controller: "agent",
  openedBy: "agent",
  createdAt: "a",
  lastUsedAt: "b"
});

/** A stand-in emulator: `sleep` renamed so its comm reads like QEMU, with the appdir marker in its environment. */
async function fakeEmulator(appDir: string, avdHome: string): Promise<ChildProcess> {
  const binary = join(appDir, "bin", "qemu-system-x86_64");
  await mkdir(dirname(binary), { recursive: true });
  await copyFile("/bin/sleep", binary).catch(() => undefined);
  const child = spawn(binary, ["60"], { env: { ANDROID_AVD_HOME: avdHome }, stdio: "ignore", detached: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return child;
}

test("readiness: a fresh appdir needs setup, with a fix action per installable item", async () => {
  await withHost({}, async ({ host }) => {
    assert.equal(host.state().status, "needs-setup");
    const readiness = await host.refreshReadiness();
    assert.equal(readiness.ready, false);
    const byId = new Map(readiness.checks.map((check) => [check.id, check]));
    assert.equal(byId.get("kvm")!.state, "ok");
    assert.equal(byId.get("ffmpeg")!.state, "ok");
    assert.equal(byId.get("android-sdk")!.fixActionId, "install-android-sdk");
    assert.equal(byId.get("avd:pixel-9")!.fixActionId, "create-avd:pixel-9");
    assert.equal(byId.get("tool:expo-device-hub")!.state, "missing");
    assert.equal(host.hubOrigin(), null);
    assert.equal(host.hubToken(), null);
    assert.equal(host.agentDeviceConfigPath(), null);
    assert.deepEqual(host.streamCapabilities(), { iosH264: false });
    assert.equal(host.capacity().used, 0);
  });
});

test("setup: runs the asked fix actions, then names what is still missing; Java blocks SDK installs", async () => {
  await withHost({ sdk: true }, async ({ host }) => {
    await host.refreshReadiness();
    const progress: string[] = [];
    await assert.rejects(
      host.ensureReady(new AbortController().signal, (p) => progress.push(`${p.step}:${p.state}`), ["create-avd:pixel-9"]),
      (error: Error & { code?: string }) => error.code === "PLATFORM_NOT_READY" && /expo-device-hub/.test(error.message)
    );
    assert.deepEqual(progress, ["avd:pixel-9:running", "avd:pixel-9:done"]);
    assert.equal(host.readiness().checks.find((check) => check.id === "avd:pixel-9")!.state, "ok");
    assert.notEqual(host.state().status, "installing");
  });
  await withHost({ java: false }, async ({ host }) => {
    await host.refreshReadiness();
    await assert.rejects(host.ensureReady(new AbortController().signal, () => undefined, ["install-android-sdk"]), /Java 17/);
  });
});

test("boot: refused while the host is not ready, and for iOS profiles", async () => {
  await withHost({}, async ({ host }) => {
    await host.refreshReadiness();
    const profile = { id: "pixel-9", platform: "android" as const, label: "Pixel 9", formFactor: "phone" as const, os: "Android 15" };
    await assert.rejects(host.boot({ leaseId: "L", profile, fresh: true }, new AbortController().signal), /need setup first/);
    await assert.rejects(host.boot({ leaseId: "L", profile: { ...profile, platform: "ios" }, fresh: true }, new AbortController().signal), /not an Android profile/);
    await assert.rejects(host.run("simctl", ["list"]), /does not run on an Android host/);
  });
});

test("restart: reattach to an emulator a live lease holds, reap one no lease holds and a stray; release stops it", async () => {
  await withHost({}, async ({ appDir, host, leases, emulators }) => {
    const avd = createDeviceToolchain({ appDir, env: {}, logger: quiet, npmCli: null }).layout;
    const kept = await fakeEmulator(appDir, avd.avd);
    const orphan = await fakeEmulator(appDir, avd.avd);
    const stray = await fakeEmulator(appDir, avd.avd);
    const foreign = await fakeEmulator(appDir, "/some/other/appdir/avd");
    emulators.set("emulator-5586", kept);
    emulators.set("emulator-5588", orphan);
    emulators.set("foreign", foreign);
    try {
      const record = (serial: string, pid: number, leaseId: string) => ({ serial, pid, pgid: pid, consolePort: Number(serial.slice(9)), grpcPort: 8570, profile: "pixel-9", avd: "orq-pixel-9", leaseId, golden: false, startedAt: "", logPath: "" });
      await mkdir(dirname(avd.stateFile), { recursive: true });
      await writeHostState(avd.stateFile, {
        version: 1,
        hub: { pid: 999_999, port: 1, startedAt: "" },
        emulators: [record("emulator-5586", kept.pid!, "live"), record("emulator-5588", orphan.pid!, "released")],
        extra: { future: 1 }
      });
      leases.push(lease("live", "emulator-5586"));
      await host.reattach();
      assert.equal(await isProcessAlive(kept.pid!), true);
      assert.equal(await waitForExit(orphan.pid!, 5_000), true, "the orphan was stopped");
      assert.equal(await waitForExit(stray.pid!, 15_000), true, "the stray was stopped");
      assert.equal(await isProcessAlive(foreign.pid!), true, "another appdir's emulator is left alone");
      const state = await readHostState(avd.stateFile);
      assert.deepEqual(state.emulators.map((entry) => entry.serial), ["emulator-5586"]);
      assert.equal(state.hub, null);
      assert.deepEqual(state.extra, { future: 1 });
      assert.equal(host.capacity().used, 1);
      const devices = await host.listDevices();
      assert.deepEqual(devices.map((device) => [device.id, device.booted, device.leaseId]), [["emulator-5586", true, "live"]]);
      await host.release(lease("other", "emulator-5586"), { shutdown: true });
      assert.equal(await isProcessAlive(kept.pid!), true, "another lease's release leaves it");
      await host.release(lease("live", "emulator-5586"), { shutdown: true });
      assert.equal(await waitForExit(kept.pid!, 5_000), true);
      assert.equal(host.capacity().used, 0);
    } finally {
      for (const child of [kept, orphan, stray, foreign]) child.kill("SIGKILL");
    }
  });
});

test("uploads land in their own 0700 dir with a safe name", async () => {
  await withHost({}, async ({ host }) => {
    const { path } = await host.uploadFile(Readable.from([Buffer.from("apk")]), "../../evil app.apk");
    assert.match(path, /\/uploads\/[0-9a-f-]{36}\/evil_app\.apk$/);
  });
});

test("agent-device: the pinned CLI under this node with the private env; refused until installed", async () => {
  await withHost({}, async ({ appDir, host }) => {
    assert.throws(() => host.agentDeviceCommand(), /not installed/);
    const toolchain = createDeviceToolchain({ appDir, env: {}, logger: quiet, npmCli: null });
    const dir = join(toolchain.layout.tools, `agent-device@${DEVICE_TOOL_VERSIONS["agent-device"]}`);
    await touch(join(dir, "node_modules", "agent-device", "bin", "agent-device.mjs"));
    await touch(join(dir, ".install-complete"));
    const command = host.agentDeviceCommand();
    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args, [join(dir, "node_modules", "agent-device", "bin", "agent-device.mjs")]);
    assert.equal(command.env.ANDROID_ADB_SERVER_PORT, toolchain.env.ANDROID_ADB_SERVER_PORT);
    assert.equal(command.env.AGENT_DEVICE_STATE_DIR, toolchain.layout.agentDeviceState);
    assert.ok(Object.values(command.env).every((value) => typeof value === "string"));
    // Viewer counts are taken per device without throwing.
    host.viewersChanged("emulator-5586", 2);
    host.viewersChanged("emulator-5586", 0);
  });
});
