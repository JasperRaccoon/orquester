import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import { isProcessAlive, waitForExit } from "../../android/procs.ts";
import { boxAgentDeviceConfigPath } from "./agent-device-config.ts";
import { BoxAndroidHost, type BoxAndroidHostDeps } from "./android-host.ts";
import { createFakeLinuxBox, type FakeLinuxBox, type FakeLinuxBoxOptions } from "./android-testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const profile = deviceProfile("pixel-9")!;

function linuxRecord(overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id: "linux-box",
    purpose: "device-host",
    kind: "linux",
    provider: "blacksmith",
    region: "blacksmith",
    size: "16vcpu",
    sizeLabel: "16 vCPU x64 · 64 GB",
    name: "orq-linux-box",
    os: "linux",
    kvm: true,
    hourlyUsd: 1.92,
    createdAt: "2026-10-27T10:00:00.000Z",
    readyAt: "2026-10-27T10:00:00.000Z",
    state: "ready",
    ...overrides
  } as StoredBox;
}

function lease(id: string, deviceId: string | null = null): StoredDeviceLease {
  return {
    id,
    threadId: "t",
    hostId: "box:linux-box",
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
  };
}

interface Harness {
  box: FakeLinuxBox;
  appDir: string;
  leases: StoredDeviceLease[];
  settings: DevicesSettings;
  record: StoredBox;
  make(overrides?: Partial<BoxAndroidHostDeps>): BoxAndroidHost;
}

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(options: FakeLinuxBoxOptions = {}, recordOverrides: Partial<StoredBox> = {}): Promise<Harness> {
  const box = await createFakeLinuxBox(options);
  const appDir = await mkdtemp(join(tmpdir(), "orq-android-box-app-"));
  cleanups.push(async () => {
    await box.cleanup();
    await rm(appDir, { recursive: true, force: true });
  });
  const leases: StoredDeviceLease[] = [];
  const settings: DevicesSettings = { ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true, profiles: ["pixel-9"] } };
  const record = linuxRecord(recordOverrides);
  const h: Harness = {
    box,
    appDir,
    leases,
    settings,
    record,
    make: (overrides = {}) => {
      const host = new BoxAndroidHost({
        boxId: "linux-box",
        kind: "box",
        label: "Android host (Blacksmith, 16 vCPU x64)",
        appDir,
        record: () => h.record,
        connection: () => box.connection,
        settings: () => settings,
        activeLeases: () => leases,
        logger: quiet,
        root: box.root,
        localAgentDevice: async () => "/opt/agent-device/bin/agent-device.mjs",
        timing: { bootMs: 20_000, commandMs: 20_000 },
        ...overrides
      });
      // A failed test still stops what its host started (forwards, the hub, emulators).
      cleanups.unshift(() => host.teardown().catch(() => undefined));
      return host;
    }
  };
  return h;
}

const signal = () => AbortSignal.timeout(60_000);

describe("BoxAndroidHost (fake Linux box)", { concurrency: false }, () => {
  it("prepares a box the device caches restored: nothing installed, hub and agent-device forwarded, the token in no argv or env", async () => {
    const h = await harness();
    const host = h.make();
    const steps: string[] = [];
    await host.prepare(h.box.connection, signal(), (progress) => steps.push(`${progress.step}:${progress.state}`));
    assert.equal(host.state().status, "ready");
    assert.equal(host.readiness().ready, true, JSON.stringify(host.readiness().checks.filter((check) => check.state !== "ok")));
    assert.equal(host.cacheState(), "hit");
    assert.deepEqual(host.streamCapabilities(), { iosH264: false });
    assert.ok(steps.includes("tools:skipped") && steps.includes("android-sdk:skipped"));
    // Nothing installed: no npm, sdkmanager, avdmanager or apt.
    assert.ok(!h.box.execs.some((args) => /npm ci|npm install|sdkmanager|avdmanager|apt-get install/.test(args.join(" "))), h.box.execs.map((a) => a.join(" ")).join("\n"));
    // 16 vCPU: 8 emulators (one per two vCPUs), never more than 16.
    assert.equal(host.capacity().total <= 8 && host.capacity().total >= 1, true);
    // The hub, through its forward, wants its token.
    const origin = host.hubOrigin()!;
    const token = host.hubToken()!;
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${origin}/api/devices`)).status, 401);
    assert.equal((await fetch(`${origin}/api/devices`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    // Secrets: never in an argument or an env value of any command; the hub log is redacted.
    const config = host.agentDeviceConfigPath()!;
    assert.equal(config, boxAgentDeviceConfigPath(h.appDir, host.id));
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    const agentToken = (JSON.parse(await readFile(config, "utf8")) as { daemonAuthToken: string; daemonBaseUrl: string }).daemonAuthToken;
    for (const secret of [token, agentToken]) {
      assert.ok(!h.box.execs.some((args) => args.some((arg) => arg.includes(secret))));
      assert.ok(!h.box.envValues.some((value) => value.includes(secret)));
    }
    const hubLog = await readFile(join(h.box.root, "logs", "hub.log"), "utf8");
    assert.ok(hubLog.includes("token=<redacted>") && !hubLog.includes(token));
    assert.deepEqual(host.agentDeviceCommand(), { command: process.execPath, args: ["/opt/agent-device/bin/agent-device.mjs"], env: {} });
    await host.teardown();
  });

  it("boots read-only instances from orq-golden with its GPU mode; adb runs with the box's private env; release stops them", async () => {
    const h = await harness();
    const host = h.make();
    await host.prepare(h.box.connection, signal());
    const [a, b] = await Promise.all(
      ["lease-a", "lease-b"].map(async (id) => {
        h.leases.push(lease(id));
        const result = await host.boot({ leaseId: id, profile, fresh: true }, signal());
        h.leases.find((entry) => entry.id === id)!.deviceId = result.deviceId;
        return result;
      })
    );
    assert.notEqual(a!.deviceId, b!.deviceId);
    assert.deepEqual(a!.stream, { kind: "serve-emu", deviceParam: a!.deviceId });
    // A cache AVD keeps its device's full resolution: 1080×2424 @420.
    assert.deepEqual(a!.screen, { width: 411, height: 923, scale: 2.625 });
    const args = await h.box.emulatorArgs();
    assert.equal(args.length, 2);
    for (const line of args) {
      assert.match(line, /^-read-only -avd orq-pixel-9 /);
      assert.match(line, /-gpu swiftshader_indirect/);
      assert.match(line, /-snapshot orq-golden -no-snapshot-save$/);
    }
    assert.equal(host.capacity().used, 2);
    const prop = await host.run("adb", ["-s", a!.deviceId, "shell", "getprop", "sys.boot_completed"]);
    assert.equal(prop.stdout.trim(), "1");
    await assert.rejects(host.run("simctl", ["list"]), /no simctl/);
    const devices = await host.listDevices();
    assert.deepEqual(devices.filter((device) => device.booted).map((device) => device.leaseId).sort(), ["lease-a", "lease-b"]);
    const pidOf = async (serial: string) => Number(await readFile(join(h.box.root, `emu-${serial.slice(9)}.pid`), "utf8"));
    const pidA = await pidOf(a!.deviceId);
    await host.release(h.leases[0]!);
    assert.equal(await waitForExit(pidA, 5_000), true);
    assert.equal(host.capacity().used, 1);
    // A lost lease naming a serial a golden boot holds now leaves that emulator running.
    const recordB = (host as unknown as { emulators: Map<string, { leaseId: string | null; golden: boolean }> }).emulators.get(b!.deviceId)!;
    Object.assign(recordB, { leaseId: null, golden: true });
    await host.release({ ...lease("lost-one"), deviceId: b!.deviceId, state: "lost" });
    assert.equal(await isProcessAlive(await pidOf(b!.deviceId)), true);
    Object.assign(recordB, { leaseId: "lease-b", golden: false });
    await host.teardown();
    assert.equal(host.capacity().used, 0);
  });

  it("boots cold when the snapshot does not load", async () => {
    const h = await harness();
    const host = h.make();
    await host.prepare(h.box.connection, signal());
    await h.box.failSnapshotLoads();
    h.leases.push(lease("lease-c"));
    const result = await host.boot({ leaseId: "lease-c", profile, fresh: true }, signal());
    const args = await h.box.emulatorArgs();
    assert.equal(args.length, 2);
    assert.match(args[0]!, /-snapshot orq-golden/);
    assert.match(args[1]!, /-no-snapshot-load -no-snapshot-save$/);
    assert.match(result.deviceId, /^emulator-\d+$/);
    await host.teardown();
  });

  it("reattaches after a daemon restart: the same hub and token, the leased emulator kept, an orphan stopped", async () => {
    const h = await harness();
    const first = h.make();
    await first.prepare(h.box.connection, signal());
    const booted = [];
    for (const id of ["keep", "orphan"]) {
      h.leases.push(lease(id));
      const result = await first.boot({ leaseId: id, profile, fresh: true }, signal());
      h.leases.at(-1)!.deviceId = result.deviceId;
      booted.push(result.deviceId);
    }
    const token = first.hubToken();
    const pid = async (serial: string) => Number(await readFile(join(h.box.root, `emu-${serial.slice(9)}.pid`), "utf8"));
    const [keepPid, orphanPid] = [await pid(booted[0]!), await pid(booted[1]!)];
    await first.dispose();
    // The orphan's lease ended while the daemon was down.
    h.leases.splice(1, 1);
    const second = h.make();
    await second.prepare(h.box.connection, signal());
    assert.equal(second.hubToken(), token, "the running hub was reattached");
    assert.equal(await isProcessAlive(keepPid), true);
    assert.equal(await waitForExit(orphanPid, 5_000), true, "the orphan was stopped");
    assert.equal(second.capacity().used, 1);
    await second.teardown();
    assert.equal(await waitForExit(keepPid, 5_000), true);
  });

  it("fails at once without KVM (the box record's report or the probe), naming the reason", async () => {
    const reported = await harness({}, { kvm: false });
    const host = reported.make();
    await assert.rejects(host.prepare(reported.box.connection, signal()), /cannot run Android emulators: it has no usable \/dev\/kvm/);
    assert.equal(host.state().status, "failed");
    await host.dispose();
    const probed = await harness({ kvm: "missing" }, { kvm: undefined });
    const other = probed.make();
    await assert.rejects(other.prepare(probed.box.connection, signal()), /no usable \/dev\/kvm/);
    await other.dispose();
  });

  it("needs ffmpeg: without sudo it asks the owner to install it", async () => {
    const h = await harness({ ffmpeg: "missing" });
    const host = h.make();
    await assert.rejects(host.prepare(h.box.connection, signal()), /needs ffmpeg with libx264/);
    assert.equal(host.state().status, "needs-setup");
    await host.dispose();
  });

  it("an own machine caps capacity at its owner's setting; refuses boots while tearing down", async () => {
    const h = await harness({ cpus: 32 }, { provider: "byo", purpose: "machine" });
    h.settings.android.maxLocalDevices = 3;
    const host = h.make({ kind: "byo" });
    await host.prepare(h.box.connection, signal());
    assert.equal(host.capacity().total <= 3, true);
    assert.equal(host.cacheState(), "unknown");
    const teardown = host.teardown();
    await assert.rejects(host.boot({ leaseId: "late", profile, fresh: true }, signal()), /being turned off/);
    await teardown;
  });
});
