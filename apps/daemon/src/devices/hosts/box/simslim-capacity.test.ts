import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAC_HOST_RESERVED_BYTES, PER_SIM_EXTRA_BYTES, SLIM_SIM_BYTES, STOCK_SIM_BYTES, perSimulatorBytes, simulatorCapacity } from "./simslim-capacity.ts";
import type { SimslimTop, SimslimTopSim } from "./simslim.ts";

const GiB = 1024 ** 3;
const MAC_24 = 24 * GiB;

function sim(bytes: number, slim: boolean, udid = `U${bytes}`): SimslimTopSim {
  return { udid, name: "orq-x", state: "Booted", osVersion: "27.0", managedDisabled: slim ? 173 : 0, managedTotal: 176, memory: { processes: slim ? 70 : 258, bytes, cpu: 1 } };
}

function top(...sims: SimslimTopSim[]): SimslimTop {
  return { sims, totalBytes: sims.reduce((total, entry) => total + (entry.memory?.bytes ?? 0), 0) };
}

describe("simulatorCapacity", () => {
  it("fits 8 slim or 3 stock simulators on a 24 GB Mac", () => {
    assert.equal(simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: true, top: null, leased: 0 }).total, 8);
    assert.equal(simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: false, top: null, leased: 0 }).total, 3);
    assert.equal(perSimulatorBytes(true, null), SLIM_SIM_BYTES + PER_SIM_EXTRA_BYTES);
    assert.equal(perSimulatorBytes(false, null), STOCK_SIM_BYTES + PER_SIM_EXTRA_BYTES);
  });

  it("is capped by Settings, and is the setting alone when the RAM is unknown", () => {
    assert.equal(simulatorCapacity({ settingCap: 4, hostBytes: MAC_24, slim: true, top: null, leased: 0 }).total, 4);
    assert.deepEqual(simulatorCapacity({ settingCap: 5, hostBytes: null, slim: true, top: null, leased: 0 }), {
      total: 5,
      perSimBytes: SLIM_SIM_BYTES + PER_SIM_EXTRA_BYTES,
      byMemory: null,
      roomNow: null
    });
  });

  it("admits only while `top` shows headroom: other simulators' memory counts", () => {
    // Two slim leases measured at 0.9 GB each: 16 GB usable − 2 × (0.9 + 1) leaves room for 6 more.
    const leasedTwo = top(sim(0.9 * GiB, true, "A"), sim(0.9 * GiB, true, "B"));
    assert.deepEqual(simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: true, top: leasedTwo, leased: 2 }), {
      total: 8,
      perSimBytes: 2 * GiB,
      byMemory: 8,
      roomNow: 6
    });
    // The owner's stock simulator on their Mac (4 GB + 1) takes 2.5 slim budgets.
    const withOwners = top(sim(0.9 * GiB, true, "A"), sim(0.9 * GiB, true, "B"), sim(4 * GiB, false, "MINE"));
    const owners = simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: true, top: withOwners, leased: 2 });
    assert.equal(owners.roomNow, 3);
    assert.equal(owners.total, 5);
    // Apps that grew to 2.4 GB each: no room now, and the measured budget lowers the ceiling below the 5 running.
    const heavy = top(...Array.from({ length: 5 }, (_, i) => sim(2.4 * GiB, true, `H${i}`)));
    const full = simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: true, top: heavy, leased: 5 });
    assert.deepEqual([full.roomNow, full.byMemory, full.total], [0, 4, 4]);
  });

  it("budgets what this host's simulators really measure when it is more than the default", () => {
    const measured = top(sim(1.6 * GiB, true, "A"), sim(1.4 * GiB, true, "B"), sim(5 * GiB, false, "S"));
    assert.equal(perSimulatorBytes(true, measured), 1.5 * GiB + PER_SIM_EXTRA_BYTES);
    assert.equal(perSimulatorBytes(false, measured), 5 * GiB + PER_SIM_EXTRA_BYTES);
    assert.equal(perSimulatorBytes(true, top(sim(0.7 * GiB, true))), SLIM_SIM_BYTES + PER_SIM_EXTRA_BYTES, "never below the default");
    assert.equal(simulatorCapacity({ settingCap: 16, hostBytes: MAC_24, slim: true, top: measured, leased: 2 }).byMemory, Math.floor((MAC_24 - MAC_HOST_RESERVED_BYTES) / (2.5 * GiB)));
  });

  it("never goes below zero", () => {
    assert.equal(simulatorCapacity({ settingCap: 16, hostBytes: 4 * GiB, slim: true, top: null, leased: 0 }).total, 0);
    assert.equal(simulatorCapacity({ settingCap: 0, hostBytes: MAC_24, slim: true, top: null, leased: 0 }).total, 0);
  });
});
