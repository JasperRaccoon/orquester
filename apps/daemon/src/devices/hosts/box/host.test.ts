import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import { isDeviceError } from "../../errors.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import type { DeviceHostProgress } from "../../host.ts";
import { BoxDeviceHost, type BoxDeviceHostDeps } from "./host.ts";
import { FakeMacBox } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function boxRecord(overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id: "mac1",
    purpose: "device-host",
    kind: "macos",
    provider: "blacksmith",
    region: "blacksmith",
    size: "6vcpu",
    sizeLabel: "6 vCPU M4 · 24 GB",
    name: "orq-mac1",
    hourlyUsd: 4.8,
    createdAt: "2026-10-27T10:00:00.000Z",
    readyAt: "2026-10-27T10:02:00.000Z",
    deadlineAt: "2026-10-27T14:00:00.000Z",
    state: "ready",
    ...overrides
  } as StoredBox;
}

function lease(id: string, deviceId: string | null): StoredDeviceLease {
  return {
    id,
    threadId: "t1",
    hostId: "box:mac1",
    deviceId,
    platform: "ios",
    profile: "iphone-17-pro",
    name: "iPhone 17 Pro",
    osVersion: "iOS 27.0",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: "2026-10-27T10:05:00.000Z",
    lastUsedAt: "2026-10-27T10:05:00.000Z"
  };
}

describe("BoxDeviceHost", () => {
  let appDir: string;
  let box: FakeMacBox;
  let leases: StoredDeviceLease[];
  let settings: DevicesSettings;
  /** The agent-device CLI "installed" on this machine. */
  let localCli: string;

  const makeHost = (overrides: Partial<BoxDeviceHostDeps> = {}) => {
    const connection = box.connection();
    return new BoxDeviceHost({
      boxId: "mac1",
      kind: "box",
      label: "Mac host (Blacksmith, 6 vCPU M4)",
      platform: "ios",
      appDir,
      toolchain: { toolBin: () => localCli } as unknown as DeviceToolchain,
      record: () => boxRecord(),
      connection: () => connection,
      settings: () => settings,
      activeLeases: () => leases,
      logger: quiet,
      fetch: box.fetch,
      now: () => Date.parse("2026-10-27T11:00:00.000Z"),
      timing: { hubPollMs: 2, framePollMs: 1, frameWaitMs: 2_000 },
      ...overrides
    });
  };

  const prepared = async (host: BoxDeviceHost) => {
    const progress: DeviceHostProgress[] = [];
    await host.ensureReady(new AbortController().signal, (entry) => progress.push(entry));
    await host.warmSettled();
    return progress;
  };

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "orq-box-host-"));
    localCli = join(appDir, "agent-device.mjs");
    await writeFile(localCli, "");
    box = new FakeMacBox();
    leases = [];
    settings = { ...DEFAULT_DEVICES_SETTINGS, ios: { ...DEFAULT_DEVICES_SETTINGS.ios, enabled: true } };
  });

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  it("prepares a fresh Mac: probe, tool install, hub, agent-device, then warms the runner", async () => {
    const host = makeHost();
    assert.equal(host.state().status, "starting");
    const progress = await prepared(host);

    const prep = box.log.slice(0, box.log.indexOf("agent-device-start") + 1);
    assert.deepEqual(prep, [
      "probe",
      "install-tools",
      "hub-start --port 0 --host 127.0.0.1 --require-token --hide-sidebar --hide-boot-device --platform ios --transport mjpeg --max-dimension 1000 --mjpeg-quality 0.6",
      "agent-device-start"
    ]);
    assert.equal(host.state().status, "ready");
    assert.equal(host.readiness().ready, true);
    assert.equal(host.hubOrigin(), `http://127.0.0.1:${box.hubPort + 1000}`);
    assert.equal(host.hubToken(), box.hubToken);
    assert.deepEqual(host.streamCapabilities(), { iosH264: false });
    assert.ok(progress.some((entry) => entry.step === "ready" && entry.percent === 100));
    // The actions layer runs agent-device here, against the box's daemon through the config file.
    assert.deepEqual(host.agentDeviceCommand(), { command: process.execPath, args: [localCli], env: {} });

    // Warm-up: a scratch simulator opens Settings and snapshots through this host's daemon, then goes.
    const warm = box.log.slice(box.log.indexOf("agent-device-start") + 1);
    assert.ok(warm.some((line) => line.startsWith("simctl create orq-warm-runner com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max com.apple.CoreSimulator.SimRuntime.iOS-27-0")));
    assert.ok(warm.some((line) => line.startsWith("agent-device open com.apple.Preferences --platform ios --udid ")));
    assert.ok(warm.includes("agent-device snapshot -i --session orq-warm"));
    assert.equal(box.sims.size, 0);

    // Once per box: a restarted daemon's host does not warm again.
    await host.dispose();
    box.log.length = 0;
    const again = makeHost();
    await prepared(again);
    assert.ok(!box.log.some((line) => line.includes("orq-warm-runner")), "warmed once per box");
  });

  it("skips the runner build on a Blacksmith box that restored the runner cache", async () => {
    box = new FakeMacBox({ toolsInstalled: true });
    box.dirs.add("/Users/runner/.agent-device/apple-runner/derived/ios-simulator");
    const host = makeHost();
    await prepared(host);
    assert.ok(!box.log.some((line) => line.includes("orq-warm-runner")));
    assert.match(box.files.get("/var/lib/orquester/devices/apple-runner-warmed") ?? "", /^agent-device \S+; Xcode 26\.6/);
  });

  it("never puts a token in argv or env, and writes the agent-device config 0600", async () => {
    const host = makeHost();
    await prepared(host);
    for (const exec of box.execs) {
      const text = JSON.stringify({ args: exec.args, env: exec.env, command: exec.command });
      assert.ok(!text.includes(box.hubToken) && !text.includes(box.agentToken), `a token leaked into ${exec.command}`);
    }
    const hubExec = box.execs.find((exec) => exec.detach?.procId === "orq-devices-hub");
    assert.ok(hubExec?.envUnset?.includes("EXPO_DEVICE_HUB_SESSION_TOKEN"));

    const file = host.agentDeviceConfigPath();
    assert.ok(file);
    assert.equal(file, join(appDir, "daemon", "devices", "hosts", "box-mac1", "agent-device.json"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { daemonBaseUrl: `http://127.0.0.1:${box.agentPort + 1000}`, daemonAuthToken: box.agentToken });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);

    await host.dispose();
    await assert.rejects(stat(file));
  });

  it("skips the install when the cache restored the tools, and reattaches a running hub after a restart", async () => {
    box = new FakeMacBox({ toolsInstalled: true });
    const first = makeHost();
    await prepared(first);
    assert.ok(!box.log.includes("install-tools"));
    await first.dispose();

    box.log.length = 0;
    const second = makeHost();
    await second.ensureReady(new AbortController().signal, () => undefined);
    assert.ok(!box.log.some((line) => line.startsWith("hub-start")), "the running hub is reused");
    assert.equal(second.hubToken(), box.hubToken);
    assert.equal(second.state().status, "ready");
  });

  it("boots a lease's simulator: create from the profile, boot, bootstatus, a real frame, serve-sim", async () => {
    const host = makeHost();
    await prepared(host);
    box.log.length = 0;
    const steps: string[] = [];
    const result = await host.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal, (progress) => steps.push(progress.step));
    const udid = result.deviceId;
    assert.deepEqual(box.log, [
      "simctl list -j devicetypes runtimes",
      "simctl list -j devices",
      "simctl create orq-L1 com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      `simctl boot ${udid}`,
      `simctl bootstatus ${udid} -b`,
      `frame ${udid}`,
      `frame ${udid}`,
      `hub /vendor/serve-sim/grid/api/start ${udid}`
    ]);
    assert.deepEqual(steps, ["create-device", "boot", "first-frame", "connect-video"]);
    assert.deepEqual(result.stream, { kind: "serve-sim", deviceParam: udid });
    assert.equal(result.osVersion, "iOS 27.0");
    assert.equal(box.sims.get(udid)?.state, "Booted");

    leases = [lease("L1", udid)];
    const devices = await host.listDevices();
    assert.deepEqual(
      devices.map((device) => ({ id: device.id, profile: device.profile, booted: device.booted })),
      [{ id: udid, profile: "iphone-17-pro", booted: true }]
    );
    assert.deepEqual(host.capacity(), { used: 1, total: 3 });

    box.log.length = 0;
    await host.release(leases[0]!, { shutdown: false });
    assert.deepEqual(box.log, ["simctl list -j devices", `hub /vendor/serve-sim/grid/api/shutdown ${udid}`, `simctl shutdown ${udid}`, `simctl shutdown ${udid}`, `simctl delete ${udid}`]);
    assert.equal(box.sims.size, 0);
  });

  it("boots one simulator at a time per host", async () => {
    const host = makeHost();
    await prepared(host);
    box.log.length = 0;
    const steps: string[] = [];
    const [a, b] = await Promise.all([
      host.boot({ leaseId: "A", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal),
      host.boot({ leaseId: "B", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal, (progress) => steps.push(progress.step))
    ]);
    const at = (line: string) => box.log.indexOf(line);
    // The second boot starts after the first one's last frame check.
    assert.ok(at(`simctl boot ${b.deviceId}`) > box.log.lastIndexOf(`frame ${a.deviceId}`));
    assert.ok(steps.includes("boot-queue"));
  });

  it("refuses a profile this Xcode has no simulator for, and cleans up a failed boot", async () => {
    const host = makeHost();
    await prepared(host);
    await assert.rejects(
      host.boot({ leaseId: "L2", profile: deviceProfile("iphone-duo")!, fresh: true }, new AbortController().signal),
      (error) => isDeviceError(error) && error.code === "PLATFORM_NOT_READY" && /iPhone Duo/.test(error.message)
    );
    box.failNext = "boot";
    await assert.rejects(host.boot({ leaseId: "L3", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal), /simctl boot failed/);
    assert.equal(box.sims.size, 0, "the failed lease's simulator was deleted");
  });

  it("deletes leftover simulators of leases that are gone when it prepares", async () => {
    box.sims.set("OLD", { udid: "OLD", name: "orq-gone-lease", state: "Booted", runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0" });
    box.sims.set("KEEP", { udid: "KEEP", name: "orq-L9", state: "Booted", runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0" });
    box.sims.set("MINE", { udid: "MINE", name: "My iPhone", state: "Shutdown", runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0" });
    leases = [lease("L9", "KEEP")];
    const host = makeHost();
    await prepared(host);
    assert.deepEqual([...box.sims.keys()].sort(), ["KEEP", "MINE"]);
  });

  it("uploads a zipped build and resolves the .app inside", async () => {
    const host = makeHost();
    await prepared(host);
    box.log.length = 0;
    const { path } = await host.uploadFile(Readable.from([Buffer.from("zip")]), "../Demo App.zip");
    const written = box.log[0]!.replace(/^write /, "");
    assert.match(written, /^\/var\/lib\/orquester\/devices\/uploads\/[0-9a-f-]{36}\/Demo_App\.zip$/);
    assert.ok(box.log[1]!.startsWith(`ditto -x -k ${written}`));
    assert.ok(path.endsWith("/unpacked/Payload/Demo.app"));
  });

  it("runs simctl, refuses adb, and reports unreachable while the link is down", async () => {
    const host = makeHost();
    await prepared(host);
    const listed = await host.run("simctl", ["list", "-j", "devices"]);
    assert.equal(listed.exitCode, 0);
    await assert.rejects(host.run("adb", ["devices"]), (error) => isDeviceError(error) && error.code === "INVALID_ARGUMENT");
    box.setConnected(false);
    assert.equal(host.state().status, "unreachable");
    await assert.rejects(host.boot({ leaseId: "L4", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal), /unreachable/);
    box.setConnected(true);
    assert.equal(host.state().status, "ready");
  });

  it("streams H.264 on a physical Mac and fails clearly without Node 22", async () => {
    box = new FakeMacBox({ vm: false });
    const physical = makeHost({ kind: "byo", label: "Studio (your Mac)", record: () => boxRecord({ provider: "byo", purpose: "machine" }) });
    await prepared(physical);
    assert.deepEqual(physical.streamCapabilities(), { iosH264: true });
    assert.ok(box.log.some((line) => line.startsWith("hub-start") && line.endsWith("--transport h264")));
    assert.ok(box.execs.some((exec) => exec.env?.TOOLS === "/Users/runner/.orquester/devices/tools"), "own machines keep device state in ~/.orquester/devices");
    await physical.stopHelpers();
    assert.equal(physical.state().status, "needs-setup");
    assert.equal(physical.hubOrigin(), null);
    assert.ok(box.log.some((line) => line.startsWith("agent-device daemon stop --state-dir /Users/runner/.orquester/devices/agent-device")));

    box = new FakeMacBox({ nodeVersion: "v20.1.0" });
    const old = makeHost();
    await assert.rejects(old.ensureReady(new AbortController().signal, () => undefined), /Node\.js 22 or newer \(it has v20\.1\.0\)/);
    assert.equal(old.state().status, "failed");
  });

  it("drains near its box's time limit", () => {
    const host = makeHost({ record: () => boxRecord({ deadlineAt: "2026-10-27T11:10:00.000Z" }) });
    assert.deepEqual(host.pool(), { draining: true, warm: false, idleSince: null });
    assert.equal(makeHost().pool(), null);
  });
});
