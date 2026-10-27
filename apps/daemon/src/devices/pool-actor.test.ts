import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { DEVICES_POOL_EVENT, type DevicePoolSummary } from "@orquester/api";

import { DeviceError } from "./errors.ts";
import type { DeviceRentalQuote } from "./host.ts";
import type { DeviceCacheWarmer } from "./pool-actor.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService, type TestDeviceService } from "./testing.ts";

const signal = () => new AbortController().signal;
const T0 = Date.parse("2026-10-27T12:00:00.000Z");
const MIN = 60_000;

const QUOTE: DeviceRentalQuote = {
  platform: "android",
  provider: "blacksmith",
  providerLabel: "Blacksmith",
  size: "16vcpu",
  sizeLabel: "16 vCPU Linux",
  hourlyUsd: 1.92,
  lifetimeMinutes: 240,
  needsApproval: true
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof DeviceError ? error.code : `unexpected: ${String(error)}`;
  }
};

/** A rented Linux box host the factory adds (destroyable: it removes itself). */
function boxFactory(options: { hosts?: FakeDeviceHost[] } = {}) {
  let count = 0;
  const destroyed: string[] = [];
  const factory: FakeHostFactory = new FakeHostFactory("box", ["android"], options.hosts ?? [], () => makeBox(`box:b${++count}`));
  function makeBox(id: string): FakeDeviceHost {
    const host = new FakeDeviceHost(id, "box", ["android"], "Linux host");
    host.total = 8;
    host.destroy = async () => {
      destroyed.push(id);
      factory.ctx?.removeHost(id);
    };
    return host;
  }
  factory.quote = { ...QUOTE };
  return { factory, destroyed, makeBox };
}

async function start(options: { local?: number | null; box?: ReturnType<typeof boxFactory>; pool?: Record<string, unknown>; clock?: { now: number }; warmer?: DeviceCacheWarmer; spend?: { todayUsd: number; monthUsd: number } }) {
  const local = new FakeDeviceHost();
  local.total = options.local ?? 1;
  const factories = [...(options.local === null ? [] : [new FakeHostFactory("local", ["android"], [local])]), ...(options.box ? [options.box.factory] : [])];
  const t = await startTestDeviceService({
    factories,
    settings: { android: { enabled: true }, pool: { maxHosts: 4, maxHourlyUsd: 20, monthlyCapUsd: 100, ...options.pool } },
    deps: {
      ...(options.clock ? { now: () => options.clock!.now } : {}),
      ...(options.warmer ? { cacheWarmer: () => options.warmer! } : {}),
      ...(options.spend ? { poolSpend: () => options.spend! } : {})
    }
  });
  return { t, local };
}

const lastPool = (t: TestDeviceService): DevicePoolSummary => t.events.filter((event) => event.type === DEVICES_POOL_EVENT).at(-1)!.payload as DevicePoolSummary;
const queued = (t: TestDeviceService, count: number) => t.nextEvent((type, payload) => type === DEVICES_POOL_EVENT && (payload as DevicePoolSummary).queue === count);

test("a full host queues the next open (published with its reason); a release hands it the slot", async () => {
  const { t } = await start({});
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const waiting = queued(t, 1);
    const second = t.service.toolOpen("t2", { platform: "android" }, signal());
    const summary = (await waiting) as DevicePoolSummary;
    assert.equal(summary.waiting?.[0]?.threadId, "t2");
    assert.equal(summary.waiting?.[0]?.reason, "capacity");
    assert.equal(summary.platforms?.find((entry) => entry.platform === "android")?.queue, 1);
    await t.service.toolClose("t1", {});
    const opened = await second;
    assert.equal(opened.lease.hostId, "local");
    assert.equal(lastPool(t).queue, 0);
  } finally {
    await t.cleanup();
  }
});

test("a queued request fails DEVICE_CAPACITY at its deadline, naming the leases; an aborted open leaves the queue", async () => {
  const clock = { now: T0 };
  const { t } = await start({ clock, pool: { capacityWaitSeconds: 30 } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    let waiting = queued(t, 1);
    const failing = t.service.toolOpen("t2", { platform: "android" }, signal()).catch((error: DeviceError) => error);
    await waiting;
    clock.now += 31_000;
    t.service.pool.tick();
    const error = (await failing) as DeviceError;
    assert.equal(error.code, "DEVICE_CAPACITY");
    assert.match(error.message, /in use: /);
    const abort = new AbortController();
    waiting = queued(t, 1);
    const aborted = codeOf(t.service.toolOpen("t3", { platform: "android" }, abort.signal));
    await waiting;
    const left = queued(t, 0);
    abort.abort();
    assert.equal(await aborted, "CANCELLED");
    await left;
  } finally {
    await t.cleanup();
  }
});

test("standing approval: the pool rents through the factory, records the rental and learns its capacity", async () => {
  const box = boxFactory();
  const { t } = await start({ box, pool: { rentWithoutAsking: true } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    // No card: the pool's standing approval covers it.
    assert.equal(t.service.toolPlanOpen("t2", "android").rental?.needsApproval, false);
    const opened = await t.service.toolOpen("t2", { platform: "android" }, signal());
    assert.equal(opened.lease.hostId, "box:b1");
    assert.deepEqual(box.factory.provisioned, [{ platform: "android", approved: true }]);
    t.service.pool.tick();
    await t.service.flush();
    const file = JSON.parse(await readFile(join(t.dir, "device-pool.json"), "utf8"));
    assert.deepEqual(
      file.rentals.map((entry: Record<string, unknown>) => [entry.hostId, entry.provider, entry.size, entry.measured]),
      [["box:b1", "blacksmith", "16vcpu", true]]
    );
    assert.deepEqual(
      file.learnedCapacity.map((entry: Record<string, unknown>) => [entry.platform, entry.provider, entry.size, entry.capacity]),
      [["android", "blacksmith", "16vcpu", 8]]
    );
    const summary = t.service.poolSummary();
    assert.equal(summary.hosts, 1);
    assert.deepEqual(summary.capacity, { used: 1, total: 8 });
    assert.equal(summary.hourlyUsd, 1.92);
    assert.equal(summary.utilization, 1 / 8);
    assert.deepEqual(summary.hostIds, ["box:b1"]);
    assert.equal(summary.learnedCapacity?.[0]?.capacity, 8);
    // `GET /api/devices` carries it too.
    assert.equal(t.service.snapshot().pool?.hosts, 1);
  } finally {
    await t.cleanup();
  }
});

test("no standing approval: the spend card's plan shows the price and caps; unapproved fails, approved rents one host", async () => {
  const box = boxFactory();
  const { t } = await start({ box, spend: { todayUsd: 1.5, monthUsd: 12.5 } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const plan = t.service.toolPlanOpen("t2", "android").rental!;
    assert.equal(plan.needsApproval, true);
    assert.equal(plan.hourlyUsd, 1.92);
    assert.deepEqual(plan.caps, { hosts: 0, maxHosts: 4, hourlyUsd: 0, maxHourlyUsd: 20, monthSpentUsd: 12.5, monthlyCapUsd: 100 });
    await assert.rejects(t.service.toolOpen("t2", { platform: "android" }, signal()), (error: DeviceError) => error.code === "PLATFORM_NOT_READY" && /approval/.test(error.message));
    const opened = await t.service.toolOpen("t2", { platform: "android", rentalApproved: true }, signal());
    assert.equal(opened.lease.hostId, "box:b1");
    assert.equal(box.factory.provisioned.length, 1);
    // The new host has room: no card for the next one.
    assert.equal(t.service.toolPlanOpen("t3", "android").rental, null);
    assert.equal(t.service.poolSummary().spend?.monthUsd, 12.5);
    assert.equal(t.service.poolSummary().spend?.todayUsd, 1.5);
  } finally {
    await t.cleanup();
  }
});

test("caps: maxHourlyUsd refuses with the cap named; a failed rental fails its request", async () => {
  const box = boxFactory();
  const { t } = await start({ box, pool: { rentWithoutAsking: true, maxHourlyUsd: 1, capacityWaitSeconds: 0 } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    await assert.rejects(t.service.toolOpen("t2", { platform: "android" }, signal()), (error: DeviceError) => error.code === "DEVICE_CAPACITY" && /\$1\/h cap/.test(error.message));
    assert.equal(box.factory.provisioned.length, 0);
    await t.service.updateSettings({ pool: { maxHourlyUsd: 20 } });
    box.factory.provision = async () => {
      throw new DeviceError("UNAVAILABLE", "the provider is out of runners");
    };
    await assert.rejects(t.service.toolOpen("t2", { platform: "android" }, signal()), (error: DeviceError) => error.code === "UNAVAILABLE" && /out of runners/.test(error.message));
  } finally {
    await t.cleanup();
  }
});

test("drain: no new lease on the host, destroyed once its last lease ends; undrain takes it back", async () => {
  const box = boxFactory();
  const host = box.makeBox("box:x");
  box.factory.hosts.push(host);
  const { t } = await start({ local: null, box, pool: { placement: "pool-only", capacityWaitSeconds: 0 } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const drained = t.service.setHostDraining("box:x", true);
    assert.equal(drained.pool?.draining, true);
    assert.deepEqual(t.service.poolSummary().drainingHostIds, ["box:x"]);
    assert.equal(box.factory.ctx?.keepWarm?.("box:x"), true);
    // Drained: the next open cannot land there (and nothing may be rented).
    assert.equal(await codeOf(t.service.toolOpen("t2", { platform: "android" }, signal())), "PLATFORM_NOT_READY");
    assert.deepEqual(box.destroyed, []);
    t.service.setHostDraining("box:x", false);
    assert.equal(t.service.hostSummaries().find((entry) => entry.id === "box:x")?.pool?.draining, false);
    t.service.setHostDraining("box:x", true);
    await t.service.toolClose("t1", {});
    t.service.pool.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(box.destroyed, ["box:x"]);
    assert.equal(t.service.hosts.get("box:x"), undefined);
    assert.deepEqual(t.service.poolSummary().drainingHostIds, []);
    assert.throws(() => t.service.setHostDraining("box:nope", true), (error: DeviceError) => error.code === "HOST_NOT_FOUND");
  } finally {
    await t.cleanup();
  }
});

test("idle teardown after idleTeardownMinutes, sparing minWarmHosts (and telling the factory)", async () => {
  const clock = { now: T0 };
  const box = boxFactory();
  box.factory.hosts.push(box.makeBox("box:x"));
  const { t } = await start({ local: null, box, clock, pool: { idleTeardownMinutes: 5, minWarmHosts: { android: 1 } } });
  try {
    clock.now += 6 * MIN;
    t.service.pool.tick();
    assert.deepEqual(box.destroyed, []);
    assert.equal(t.service.hostSummaries()[0]?.pool?.warm, true);
    assert.equal(box.factory.ctx?.keepWarm?.("box:x"), true);
    await t.service.updateSettings({ pool: { minWarmHosts: { android: 0 } } });
    t.service.pool.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(box.destroyed, ["box:x"]);
  } finally {
    await t.cleanup();
  }
});

test("host loss: its leases are lost (DEVICE_LOST names open_device) and a queued request gets replacement capacity", async () => {
  const box = boxFactory();
  const small = box.makeBox("box:x");
  small.total = 1;
  box.factory.hosts.push(small);
  const { t } = await start({ local: null, box, pool: { placement: "pool-only", rentWithoutAsking: true, maxHosts: 1 } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const waiting = queued(t, 1);
    const second = t.service.toolOpen("t2", { platform: "android" }, signal());
    assert.equal(((await waiting) as DevicePoolSummary).waiting?.[0]?.reason, "capacity");
    box.factory.ctx!.removeHost("box:x");
    await assert.rejects(t.service.toolAction("t1", undefined, { action: "snapshot" }, signal()), (error: DeviceError) => error.code === "DEVICE_LOST" && /open_device/.test(error.message));
    const opened = await second;
    assert.equal(opened.lease.hostId, "box:b1");
    assert.deepEqual(box.factory.provisioned, [{ platform: "android", approved: true }]);
  } finally {
    await t.cleanup();
  }
});

test("live devices: a ready lease whose device vanished (twice in a row) is lost; a failed or glitched list changes nothing", async () => {
  const { t, local } = await start({ local: 2 });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const real = local.listImpl;
    local.listImpl = async () => {
      throw new Error("adb is down");
    };
    await t.service.reconcileDevices();
    assert.equal(t.service.leaseSummaries()[0]?.state, "ready");
    let calls = 0;
    local.listImpl = async () => (++calls === 1 ? [] : real());
    await t.service.reconcileDevices("local");
    assert.equal(t.service.leaseSummaries()[0]?.state, "ready");
    // Event-driven: the host reports a change, the device is gone.
    local.running.clear();
    local.listImpl = real;
    local.changed();
    await t.service.reconcileDevices("local");
    const lease = t.service.leaseSummaries()[0]!;
    assert.equal(lease.state, "lost");
    assert.match(lease.error ?? "", /device is gone/);
    await assert.rejects(t.service.toolAction("t1", undefined, { action: "snapshot" }, signal()), (error: DeviceError) => error.code === "DEVICE_LOST");
  } finally {
    await t.cleanup();
  }
});

test("cache warming: the owner's Warm caches, a cache miss (once a day) and the weekly refresh", async () => {
  const clock = { now: T0 };
  const dispatched: string[] = [];
  let status: Awaited<ReturnType<DeviceCacheWarmer["status"]>> = { state: "running", conclusion: null, htmlUrl: null };
  const warmer: DeviceCacheWarmer = {
    dispatch: async ({ os }) => {
      dispatched.push(os);
      return { runId: String(dispatched.length), htmlUrl: `https://github.test/runs/${dispatched.length}` };
    },
    status: async () => status
  };
  const box = boxFactory();
  const { t } = await start({ box, clock, warmer });
  try {
    const first = await t.service.warmCaches("android");
    assert.equal(first.started, true);
    assert.deepEqual(dispatched, ["linux"]);
    assert.deepEqual(await t.service.warmCaches("android"), { started: false, message: "A Android cache run is already running." });
    const job = t.service.poolSummary().cacheJobs?.[0];
    assert.equal(job?.kind, "cache-warm");
    assert.equal(job?.state, "running");
    assert.equal(job?.url, "https://github.test/runs/1");
    status = { state: "completed", conclusion: "success", htmlUrl: null };
    await t.service.pool.pollCacheRun(warmer, "android");
    assert.equal(t.service.poolSummary().cacheJobs?.[0]?.state, "done");
    assert.equal(t.service.poolSummary().cacheWarmedAt?.android, new Date(T0).toISOString());

    // A pool host that started without caches: one warm (an hour after the last attempt), then not again that day.
    const host = box.makeBox("box:m");
    host.cacheState = () => "miss";
    box.factory.ctx!.addHost(host);
    clock.now += 61 * MIN;
    t.service.pool.tick();
    assert.deepEqual(dispatched, ["linux", "linux"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await t.service.pool.pollCacheRun(warmer, "android");
    assert.equal(t.service.poolSummary().cacheJobs?.[0]?.state, "done");
    clock.now += 2 * 60 * MIN;
    t.service.pool.tick();
    assert.equal(dispatched.length, 2);

    // Weekly: only while the pool rents without asking.
    clock.now += 7 * 24 * 60 * MIN;
    box.factory.ctx!.removeHost("box:m");
    t.service.pool.tick();
    assert.equal(dispatched.length, 2);
    await t.service.updateSettings({ pool: { rentWithoutAsking: true } });
    t.service.pool.tick();
    assert.equal(dispatched.length, 3);
    await t.service.flush();
    const file = JSON.parse(await readFile(join(t.dir, "device-pool.json"), "utf8"));
    assert.equal(file.cache.linux.lastRunId, "3");
  } finally {
    await t.cleanup();
  }
});

test("Warm caches without the box service is refused", async () => {
  const { t } = await start({});
  try {
    assert.equal(await codeOf(t.service.warmCaches("android")), "UNAVAILABLE");
  } finally {
    await t.cleanup();
  }
});

test("placement is atomic with the lease: concurrent opens never put more leases on a host than it has slots", async () => {
  const { t, local } = await start({ local: 2, pool: { capacityWaitSeconds: 0 } });
  try {
    const results = await Promise.all(["t1", "t2", "t3"].map((thread) => codeOf(t.service.toolOpen(thread, { platform: "android" }, signal()))));
    assert.deepEqual(results.sort(), ["DEVICE_CAPACITY", "resolved", "resolved"]);
    assert.equal(t.service.leaseSummaries().filter((lease) => lease.hostId === "local").length, 2);
    // A named host too (the panel's picker): the second of two concurrent opens is refused.
    await t.service.releaseThread("t1");
    await t.service.releaseThread("t2");
    await t.service.releaseThread("t3");
    local.total = 1;
    const named = await Promise.all(
      ["u1", "u2"].map((thread) => codeOf(t.service.openLease({ threadId: thread, platform: "android", hostId: "local", openedBy: "user", rentalApproved: true }, signal())))
    );
    assert.deepEqual(named.sort(), ["DEVICE_CAPACITY", "resolved"]);
    // The host's capacity shrinking under a placed request is caught too.
    assert.equal(t.service.leaseSummaries().length, 1);
  } finally {
    await t.cleanup();
  }
});
