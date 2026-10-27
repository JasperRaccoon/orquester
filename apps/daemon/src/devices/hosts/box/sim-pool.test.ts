import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_REFILL_FAILURES, SimPool, poolSimulatorName, profileOfPoolSimulator, type PoolSim, type SimPoolDeps } from "./sim-pool.ts";
import { isPoolSimulator, leaseIdOfSimulator, simDeviceSummary } from "./simctl.ts";

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";

/** A pool over scripted ops: `make` resolves when the test says, and every step is logged. */
function harness(options: { size?: number; targets?: string[]; fail?: (profile: string) => boolean } = {}) {
  const log: string[] = [];
  let idle = true;
  let next = 1;
  let slot: Promise<void> = Promise.resolve();
  let holding = 0;
  let maxHolding = 0;
  const pending: Array<{ profile: string; resolve: () => void }> = [];
  const deps: SimPoolDeps = {
    size: options.size ?? 2,
    targets: () => options.targets ?? ["iphone-17-pro"],
    idle: () => idle,
    logger: { warn: (...args: unknown[]) => void log.push(`warn ${String(args[0])}`) },
    // One holder at a time, like the host's boot queue.
    exclusive: async (signal, work) => {
      const previous = slot;
      let release!: () => void;
      slot = new Promise((resolve) => (release = resolve));
      try {
        await previous;
        signal.throwIfAborted();
        holding += 1;
        maxHolding = Math.max(maxHolding, holding);
        await work();
      } finally {
        holding -= 1;
        release();
      }
    },
    ops: {
      make: (profile, signal) =>
        new Promise<PoolSim>((resolve, reject) => {
          const udid = `P${next++}`;
          log.push(`make ${profile} ${udid}`);
          const entry = {
            profile,
            resolve: () => {
              signal.removeEventListener("abort", onAbort);
              if (options.fail?.(profile)) reject(new Error("simslim on failed"));
              else resolve({ udid, profileId: profile, runtimeId: RUNTIME });
            }
          };
          const onAbort = () => {
            log.push(`abort ${udid}`);
            pending.splice(pending.indexOf(entry), 1);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          pending.push(entry);
        })
    }
  };
  const pool = new SimPool(deps);
  /** Let the next `make` finish, then let the loop run on. */
  const finishNext = async () => {
    for (let i = 0; i < 20 && pending.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    pending.shift()!.resolve();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    pool,
    log,
    pending,
    finishNext,
    setIdle: (value: boolean) => (idle = value),
    maxHolding: () => maxHolding
  };
}

describe("SimPool", () => {
  it("fills each target profile to its size, one simulator at a time", async () => {
    const h = harness({ targets: ["iphone-17-pro", "ipad-pro"] });
    h.pool.kick();
    h.pool.kick(); // a second kick joins the running loop
    for (let i = 0; i < 4; i += 1) await h.finishNext();
    await h.pool.settled();
    assert.deepEqual(h.log, ["make iphone-17-pro P1", "make iphone-17-pro P2", "make ipad-pro P3", "make ipad-pro P4"]);
    assert.deepEqual(h.pool.counts(), { "iphone-17-pro": 2, "ipad-pro": 2 });
    assert.equal(h.maxHolding(), 1);
    assert.equal(h.pool.next(), null);
  });

  it("hands out a ready simulator of the profile and runtime, then refills", async () => {
    const h = harness({ size: 1 });
    h.pool.adopt([{ udid: "OLD", profileId: "iphone-17-pro", runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-2" }]);
    h.pool.adopt([{ udid: "A", profileId: "iphone-17-pro", runtimeId: RUNTIME }]);
    h.pool.adopt([{ udid: "A", profileId: "iphone-17-pro", runtimeId: RUNTIME }]);
    assert.deepEqual(h.pool.counts(), { "iphone-17-pro": 2 }, "adopting twice keeps one");
    assert.equal(h.pool.take("ipad-pro", RUNTIME), null);
    assert.deepEqual(h.pool.take("iphone-17-pro", RUNTIME), { udid: "A", profileId: "iphone-17-pro", runtimeId: RUNTIME });
    assert.equal(h.pool.take("iphone-17-pro", RUNTIME), null, "only the older runtime's is left");
    // The older runtime's simulator still counts toward the size (it is replaced when the box goes).
    assert.equal(h.pool.next(), null);
  });

  it("never starts a refill while the host is busy; a lease boot preempts one in progress", async () => {
    const h = harness();
    h.setIdle(false);
    h.pool.kick();
    await h.pool.settled();
    assert.deepEqual(h.log, [], "busy: nothing starts");

    h.setIdle(true);
    h.pool.kick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.pool.busy, true);
    // A lease boot arrives: the host is no longer idle and the refill is aborted, not counted as a failure.
    h.setIdle(false);
    h.pool.preempt();
    await h.pool.settled();
    assert.deepEqual(h.log, ["make iphone-17-pro P1", "abort P1"]);
    assert.equal(h.pool.busy, false);
    assert.deepEqual(h.pool.counts(), {});
    assert.equal(h.pool.next(), "iphone-17-pro", "no failure recorded");

    // Once idle again the next kick refills.
    h.setIdle(true);
    h.pool.kick();
    await h.finishNext();
    await h.finishNext();
    await h.pool.settled();
    assert.deepEqual(h.pool.counts(), { "iphone-17-pro": 2 });
  });

  it("gives up on a profile after repeated failures until reset", async () => {
    const h = harness({ targets: ["broken", "iphone-17-pro"], size: 1, fail: (profile) => profile === "broken" });
    h.pool.kick();
    for (let i = 0; i < MAX_REFILL_FAILURES + 1; i += 1) await h.finishNext();
    await h.pool.settled();
    assert.deepEqual(h.log.filter((line) => line.startsWith("make")), ["make broken P1", "make broken P2", "make iphone-17-pro P3"]);
    assert.equal(h.log.filter((line) => line.startsWith("warn")).length, MAX_REFILL_FAILURES);
    assert.deepEqual(h.pool.counts(), { "iphone-17-pro": 1 });
    assert.equal(h.pool.next(), null);
    h.pool.reset();
    assert.equal(h.pool.next(), "broken");
  });

  it("stops: no refill starts and one in progress is aborted", async () => {
    const h = harness();
    h.pool.kick();
    await new Promise((resolve) => setImmediate(resolve));
    h.pool.stop();
    await h.pool.settled();
    h.pool.kick();
    await h.pool.settled();
    assert.deepEqual(h.log, ["make iphone-17-pro P1", "abort P1"]);
  });
});

describe("pool simulator names", () => {
  it("are orq-pool-<profile>.<id>, never a lease's, never listed as devices", () => {
    const name = poolSimulatorName("iphone-17-pro", "1a2b3c4d");
    assert.equal(name, "orq-pool-iphone-17-pro.1a2b3c4d");
    assert.equal(profileOfPoolSimulator(name), "iphone-17-pro");
    assert.equal(profileOfPoolSimulator("orq-poolprep-1a2b3c4d"), null);
    assert.equal(profileOfPoolSimulator("orq-L1"), null);
    for (const pool of [name, "orq-poolprep-1a2b3c4d"]) {
      assert.equal(isPoolSimulator(pool), true);
      assert.equal(leaseIdOfSimulator(pool), null);
      assert.equal(simDeviceSummary("box:mac1", { udid: "U", name: pool, state: "Shutdown", runtimeId: RUNTIME, osVersion: "27.0" }, () => null), null);
    }
    assert.equal(leaseIdOfSimulator("orq-L1"), "L1");
  });
});
