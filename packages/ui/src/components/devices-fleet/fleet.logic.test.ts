import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS } from "@orquester/api";

import { FIXTURE_NOW, fixtureBoxHost, fixtureHost, fixtureLease } from "./fixtures.test-helpers.ts";
import { costSharers, groupFleet, hostCost, leaseCostShare, poolView } from "./fleet.logic.ts";

describe("fleet grouping", () => {
  it("keeps every leased device with its host, including unknown or disabled hosts", () => {
    const groups = groupFleet(
      [fixtureHost({ status: "disabled" }), fixtureBoxHost("rented"), fixtureBoxHost("off", { status: "disabled" })],
      [fixtureLease("local"), fixtureLease("remote", { hostId: "box:rented" }), fixtureLease("orphan", { hostId: "gone" }), fixtureLease("released", { state: "released" })]
    );
    assert.deepEqual(groups.map((group) => [group.hostId, group.leases.map((lease) => lease.id)]).sort(), [
      ["box:rented", ["remote"]], ["gone", ["orphan"]], ["local", ["local"]]
    ]);
    assert.equal(groups.find((group) => group.hostId === "gone")?.host, null);
  });
});

describe("fleet cost estimates", () => {
  it("a host's cost so far is its $/h times its uptime", () => {
    const host = fixtureBoxHost("h", { hourlyUsd: 0.64, startedMinutesAgo: 90 });
    const cost = hostCost(host, FIXTURE_NOW)!;
    assert.equal(cost.hourlyUsd, 0.64);
    assert.ok(Math.abs(cost.spentUsd - 0.96) < 1e-9);
    assert.equal(hostCost(fixtureHost(), FIXTURE_NOW), null, "this host has no price");
    assert.equal(hostCost(fixtureBoxHost("u", { hourlyUsd: null }), FIXTURE_NOW), null, "nor a host whose provider gave none");
    assert.equal(hostCost(fixtureBoxHost("free", { hourlyUsd: 0 }), FIXTURE_NOW), null, "nor a free one (a paired machine)");
    assert.equal(hostCost(fixtureBoxHost("future", { startedMinutesAgo: -10 }), FIXTURE_NOW)!.spentUsd, 0, "clock skew never goes negative");
  });

  it("a lease shares the host's rate with devices still held, times the lease's age", () => {
    const sharers = costSharers([{ state: "ready" }, { state: "starting" }, { state: "suspended" }, { state: "lost" }]);
    const share = leaseCostShare(fixtureLease("a", { minutesAgo: 30 }), fixtureBoxHost("h", { hourlyUsd: 1.92 }), sharers, FIXTURE_NOW)!;
    assert.ok(Math.abs(share.hourlyUsd - 0.64) < 1e-9);
    assert.ok(Math.abs(share.spentUsd - 0.32) < 1e-9);
  });

  it("the pool header sums working capacity and exposes queue, rate and budget", () => {
    const hosts = [
      fixtureHost({ capacity: { used: 2, total: 4 } }),
      fixtureBoxHost("rented", { hourlyUsd: 2, startedMinutesAgo: 30, capacity: { used: 3, total: 6 } }),
      fixtureBoxHost("lost", { status: "failed", hourlyUsd: null, capacity: { used: 9, total: 12 } })
    ];
    const settings = { ...DEFAULT_DEVICES_SETTINGS, pool: { ...DEFAULT_DEVICES_SETTINGS.pool, placement: "pool-only" as const, maxHourlyUsd: 10, rentWithoutAsking: true } };
    const view = poolView({ hosts: 1, capacity: { used: 3, total: 6 }, hourlyUsd: 2, queue: 3 }, settings, hosts, FIXTURE_NOW);
    assert.deepEqual([view.used, view.total, view.queue, view.hourlyUsd, view.capUsd, view.poolHosts, view.spentUsd], [5, 10, 3, 2, 10, 1, 1]);
    assert.equal(view.placement, "pool-only");
    assert.equal(view.rentWithoutAsking, true);
  });

  it("the pool header works before the pool summary and the settings arrive", () => {
    const host = fixtureBoxHost("h", { hourlyUsd: 2, capacity: { used: 1, total: 6 } });
    const view = poolView(null, null, [host, fixtureHost({ status: "failed", capacity: { used: 0, total: 4 } })], FIXTURE_NOW);
    assert.equal(view.hourlyUsd, 2, "the hosts' prices stand in");
    assert.equal(view.total, 6, "a failed host adds no room");
    assert.equal(view.capUsd, null);
    assert.equal(view.placement, null);
    assert.equal(view.rentWithoutAsking, null);
  });
});
