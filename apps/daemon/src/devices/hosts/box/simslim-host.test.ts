/** `BoxDeviceHost` with simslim: slim boots, the pre-slimmed pool, capacity from `simslim top`. */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import type { DeviceToolchain } from "../../toolchain/index.ts";
import { BoxDeviceHost, type BoxDeviceHostDeps } from "./host.ts";
import { ORQ_SLIM_PROFILE_JSON } from "./simslim.ts";
import { FakeMacBox } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const PROFILE = "/var/lib/orquester/devices/simslim-profile.json";

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

function lease(id: string, deviceId: string): StoredDeviceLease {
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

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("BoxDeviceHost with simslim", () => {
  let appDir: string;
  let box: FakeMacBox;
  let leases: StoredDeviceLease[];
  let settings: DevicesSettings;
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

  /** Prepared, warmed, and the pool's first fill done. */
  const prepared = async (host: BoxDeviceHost) => {
    await host.ensureReady(new AbortController().signal, () => undefined);
    await host.warmSettled();
    return host.poolSettled();
  };

  const poolSims = () => [...box.sims.values()].filter((sim) => sim.name.startsWith("orq-pool-"));

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "orq-simslim-host-"));
    localCli = join(appDir, "agent-device.mjs");
    await writeFile(localCli, "");
    box = new FakeMacBox({ simslim: true });
    leases = [];
    settings = { ...DEFAULT_DEVICES_SETTINGS, ios: { ...DEFAULT_DEVICES_SETTINGS.ios, enabled: true } };
  });

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  it("installs simslim and its profile, then fills the pool for the default profile one at a time", async () => {
    const host = makeHost();
    assert.deepEqual(await prepared(host), { "iphone-17-pro": 2 });
    assert.equal(box.files.get(PROFILE), ORQ_SLIM_PROFILE_JSON);
    assert.deepEqual(
      host.readiness().checks.find((check) => check.id === "tool:simslim"),
      { id: "tool:simslim", label: "simslim (slim simulators)", state: "ok", detail: "0.13.0", fixActionId: "install-tools" }
    );
    const sims = poolSims();
    assert.equal(sims.length, 2);
    for (const sim of sims) {
      assert.match(sim.name, /^orq-pool-iphone-17-pro\.[0-9a-f]{8}$/);
      assert.deepEqual([sim.state, sim.slim, sim.runtimeId], ["Shutdown", true, RUNTIME]);
    }
    // Each one: created as orq-poolprep-*, slimmed while shut down (one boot, back to shut down), renamed.
    const making = box.log.filter((line) => /^simctl (create orq-poolprep|rename)|^simslim on/.test(line));
    assert.equal(making.length, 6);
    assert.match(making[0]!, /^simctl create orq-poolprep-[0-9a-f]{8} com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-17-Pro /);
    assert.match(making[1]!, /^simslim on \S+ --preserve-boot-state$/);
    assert.match(making[2]!, /^simctl rename \S+ orq-pool-iphone-17-pro\./);
    // Pool simulators are not devices.
    assert.deepEqual(await host.listDevices(), []);
  });

  it("boots a lease from the pool (rename, boot; no create, no slimming), verifies it, then refills", async () => {
    const host = makeHost();
    await prepared(host);
    const pooled = new Set(poolSims().map((sim) => sim.udid));
    box.log.length = 0;
    const result = await host.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
    const udid = result.deviceId;
    assert.ok(pooled.has(udid), "a pool simulator");
    assert.equal(box.sims.get(udid)?.name, "orq-L1");
    const bootLog = box.log.slice(0, box.log.indexOf(`hub /vendor/serve-sim/grid/api/start ${udid}`) + 1);
    assert.deepEqual(bootLog, [
      "simctl list -j devicetypes runtimes",
      "simctl list -j devices",
      `simctl rename ${udid} orq-L1`,
      `simctl boot ${udid}`,
      `simctl bootstatus ${udid} -b`,
      `frame ${udid}`,
      `frame ${udid}`,
      `hub /vendor/serve-sim/grid/api/start ${udid}`
    ]);

    assert.deepEqual(await host.poolSettled(), { "iphone-17-pro": 2 }, "refilled after the boot");
    await until(() => box.log.includes(`simslim verify ${udid} --json`), "the slim check");

    // Capacity: one slim simulator booted (0.9 GB) on 24 GB: the settings cap of 8 holds.
    leases = [lease("L1", udid)];
    await host.refreshReadiness();
    assert.ok(box.log.includes("simslim top --json"));
    assert.deepEqual(host.capacity(), { used: 1, total: 8 });
    settings = { ...settings, ios: { ...settings.ios, maxSimulatorsPerHost: 3 } };
    assert.deepEqual(host.capacity(), { used: 1, total: 3 });
  });

  it("slims a new simulator while shut down when the pool is empty, and boots it stock if slimming fails", async () => {
    const host = makeHost({ simPoolSize: 0 });
    await prepared(host);
    assert.equal(poolSims().length, 0);
    box.log.length = 0;
    const slim = await host.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
    const created = box.log.slice(0, 5);
    assert.deepEqual(created, [
      "simctl list -j devicetypes runtimes",
      "simctl list -j devices",
      `simctl create orq-L1 com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro ${RUNTIME}`,
      `simslim on ${slim.deviceId}`,
      `simctl bootstatus ${slim.deviceId} -b`
    ]);
    assert.ok(!box.log.includes(`simctl boot ${slim.deviceId}`), "simslim's boot is the boot");
    assert.equal(box.sims.get(slim.deviceId)?.slim, true);

    box.failNext = "simslim on";
    box.log.length = 0;
    const stock = await host.boot({ leaseId: "L2", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
    assert.ok(box.log.includes(`simslim on ${stock.deviceId}`));
    assert.ok(box.log.includes(`simctl boot ${stock.deviceId}`));
    assert.equal(box.sims.get(stock.deviceId)?.state, "Booted");
    // The background check finds it not slim and slims it live.
    await until(() => box.log.includes(`simslim on ${stock.deviceId} --no-reboot`), "the live repair");
  });

  it("a lease boot preempts a refill in progress, whose half-made simulator is deleted", async () => {
    let release!: () => void;
    box.holdSlim = new Promise((resolve) => (release = resolve));
    const host = makeHost();
    await host.ensureReady(new AbortController().signal, () => undefined);
    await host.warmSettled();
    await until(() => box.log.some((line) => line.endsWith("--preserve-boot-state")), "a refill");
    const preparing = [...box.sims.values()].find((sim) => sim.name.startsWith("orq-poolprep-"))!;
    assert.ok(preparing);

    box.holdSlim = null;
    const steps: string[] = [];
    const result = await host.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal, (progress) => steps.push(progress.step));
    assert.equal(box.sims.has(preparing.udid), false, "the preempted simulator is gone");
    assert.equal(box.sims.get(result.deviceId)?.name, "orq-L1");
    assert.equal(box.sims.get(result.deviceId)?.slim, true);
    release();
    assert.deepEqual(await host.poolSettled(), { "iphone-17-pro": 2 });
    assert.equal([...box.sims.values()].filter((sim) => sim.name.startsWith("orq-poolprep-")).length, 0);
    assert.ok(steps.includes("boot"));
  });

  it("after a restart adopts ready pool simulators and deletes half-made or booted ones", async () => {
    box.sims.set("READY", { udid: "READY", name: "orq-pool-iphone-17-pro.aaaaaaaa", state: "Shutdown", runtimeId: RUNTIME, slim: true });
    box.sims.set("HALF", { udid: "HALF", name: "orq-poolprep-bbbbbbbb", state: "Booted", runtimeId: RUNTIME });
    box.sims.set("USED", { udid: "USED", name: "orq-pool-iphone-17-pro.cccccccc", state: "Booted", runtimeId: RUNTIME, slim: true });
    const host = makeHost();
    assert.deepEqual(await prepared(host), { "iphone-17-pro": 2 });
    assert.ok(box.sims.has("READY"));
    assert.ok(!box.sims.has("HALF") && !box.sims.has("USED"));
    assert.equal(box.log.filter((line) => line.endsWith("--preserve-boot-state")).length, 1, "one more made");
    const result = await host.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
    assert.equal(result.deviceId, "READY", "the adopted one is used");
  });

  it("keeps no pool on the owner's own Mac, and boots stock where simslim cannot run", async () => {
    const own = makeHost({ kind: "byo", label: "Studio (your Mac)", record: () => boxRecord({ provider: "byo", purpose: "machine" }) });
    assert.deepEqual(await prepared(own), {});
    assert.equal(poolSims().length, 0);
    assert.ok(box.execs.some((exec) => exec.command === "/Users/runner/.orquester/devices/tools/simslim/v0.13.0/simslim"), "own machines keep simslim in ~/.orquester/devices");
    await own.dispose();

    box = new FakeMacBox();
    const intel = makeHost();
    assert.deepEqual(await prepared(intel), {});
    const check = intel.readiness().checks.find((entry) => entry.id === "tool:simslim");
    assert.deepEqual([check?.state, check?.detail], ["ok", "Not used on this Mac (test Mac): simulators run stock"]);
    box.log.length = 0;
    const result = await intel.boot({ leaseId: "L1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
    assert.ok(box.log.includes(`simctl boot ${result.deviceId}`));
    assert.ok(!box.log.some((line) => line.startsWith("simslim")));
    // Stock simulators: 24 GB fits 3.
    assert.deepEqual(intel.capacity(), { used: 0, total: 3 });
  });
});
