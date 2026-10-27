import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS } from "@orquester/api";

import { FIXTURE_NOW, fixtureBoxHost, fixtureHost, fixtureLease, fleetFixture } from "./fixtures.test-helpers.ts";
import {
  canDestroy,
  canDrain,
  canWarmCaches,
  chatRef,
  costSharers,
  formatAgo,
  formatUptime,
  groupFleet,
  hostCost,
  hostKindLabel,
  hostStatusView,
  resumeBlockedReason,
  lastAction,
  leaseCostShare,
  leaseStateNote,
  meterFill,
  poolView,
  spendTone,
  thumbnailAspect,
  thumbnailPath
} from "./fleet.logic.ts";

const HOUR = 3_600_000;

describe("grouping and order", () => {
  it("puts this host first, then hosts by status and age, each with its leases", () => {
    const { hosts, leases } = fleetFixture();
    const groups = groupFleet(hosts, leases);
    assert.deepEqual(
      groups.map((group) => group.hostId),
      ["local", "box:byo-1", "box:bs-linux-3", "box:bs-mac-1", "box:bs-linux-1", "box:bs-linux-2", "box:bs-mac-2", "box:gone"]
    );
    assert.equal(groups.at(-1)!.host, null, "a lease on a host the list lacks still shows");
    assert.deepEqual(
      groups.find((group) => group.hostId === "box:bs-mac-1")!.leases.map((lease) => lease.id),
      ["A1B2-ios-1", "A1B2-ios-2", "A1B2-ios-3"],
      "ready (oldest first) before starting"
    );
    assert.equal(groups.flatMap((group) => group.leases).length, leases.length);
  });

  it("orders leases live first: ready, starting, suspended, lost", () => {
    const leases = [
      fixtureLease("lost", { state: "lost", minutesAgo: 90 }),
      fixtureLease("susp", { state: "suspended", minutesAgo: 80 }),
      fixtureLease("new", { minutesAgo: 1 }),
      fixtureLease("boot", { state: "starting", minutesAgo: 70 }),
      fixtureLease("old", { minutesAgo: 60 })
    ];
    assert.deepEqual(groupFleet([fixtureHost()], leases)[0]!.leases.map((lease) => lease.id), ["old", "new", "boot", "susp", "lost"]);
  });

  it("leaves out released leases and hosts that are off with nothing on them", () => {
    const groups = groupFleet(
      [fixtureHost({ status: "disabled" }), fixtureBoxHost("idle")],
      [fixtureLease("gone", { state: "released" })]
    );
    assert.deepEqual(groups.map((group) => group.hostId), ["box:idle"]);
    assert.deepEqual(groups[0]!.leases, []);
  });

  it("keeps an off host that still holds a lease, and answers nothing before the first load", () => {
    assert.equal(groupFleet([fixtureHost({ status: "disabled" })], [fixtureLease("a")]).length, 1);
    assert.deepEqual(groupFleet(null, null), []);
  });
});

describe("hosts", () => {
  it("name their kind", () => {
    assert.equal(hostKindLabel(fixtureHost()), "This host");
    assert.equal(hostKindLabel(fixtureBoxHost("l")), "Blacksmith Linux");
    assert.equal(hostKindLabel(fixtureBoxHost("m", { platforms: ["ios"] })), "Blacksmith macOS");
    assert.equal(hostKindLabel(fixtureHost({ kind: "byo", platforms: ["ios"] })), "Your machine");
    assert.equal(hostKindLabel({ kind: "box", platforms: ["android"], box: undefined }), "Rented Linux");
  });

  it("read their status in the fleet's words", () => {
    const view = (over: Parameters<typeof fixtureHost>[0]) => hostStatusView(fixtureHost(over));
    assert.deepEqual(view({}), { key: "ready", label: "Ready", tone: "ok", detail: null });
    assert.equal(view({ kind: "box", pool: { draining: true, warm: false, idleSince: null } }).key, "draining");
    const deadline = view({ kind: "box", pool: { draining: true, drainReason: "deadline", warm: false, idleSince: null } });
    assert.deepEqual([deadline.key, deadline.label], ["draining", "Ending soon (deadline)"]);
    assert.match(deadline.detail ?? "", /time limit/);
    assert.deepEqual(view({ kind: "box", status: "starting", statusDetail: "Restoring caches" }), {
      key: "provisioning",
      label: "Provisioning",
      tone: "info",
      detail: "Restoring caches"
    });
    assert.equal(view({ status: "installing" }).key, "provisioning");
    assert.equal(view({ kind: "box", status: "unreachable" }).key, "suspended");
    assert.equal(view({ status: "needs-setup" }).key, "offline");
    assert.equal(view({ status: "disabled" }).label, "Off");
    assert.deepEqual(view({ kind: "box", status: "failed" }), { key: "lost", label: "Lost", tone: "danger", detail: "The host is gone; its devices ended." });
    assert.equal(view({ status: "failed", statusDetail: "hub crashed" }).label, "Failed");
    assert.equal(view({ status: "stopping" }).key, "stopping");
  });

  it("offer Drain, Destroy and Warm caches where they apply", () => {
    const pool = fixtureBoxHost("p");
    assert.equal(canDrain(pool), true);
    assert.equal(canDestroy(pool), true);
    assert.equal(canWarmCaches(pool), true);
    const local = fixtureHost();
    assert.deepEqual([canDrain(local), canDestroy(local), canWarmCaches(local)], [false, false, false]);
    const byo = fixtureHost({ kind: "byo" });
    assert.deepEqual([canDrain(byo), canDestroy(byo), canWarmCaches(byo)], [true, false, false]);
    assert.equal(canDestroy(fixtureBoxHost("s", { status: "stopping" })), false);
    assert.equal(canDrain(fixtureBoxHost("f", { status: "failed" })), false);
    assert.equal(canWarmCaches(fixtureBoxHost("x", { pool: undefined })), false);
    // Resume is off (with the reason) only for a host drained near its deadline.
    assert.equal(resumeBlockedReason(fixtureBoxHost("o", { pool: { draining: true, drainReason: "owner", warm: false, idleSince: null } })), null);
    assert.equal(resumeBlockedReason(fixtureBoxHost("n")), null);
    assert.match(resumeBlockedReason(fixtureBoxHost("d", { pool: { draining: true, drainReason: "deadline", warm: false, idleSince: null } })) ?? "", /^Can't resume: near its time limit/);
  });
});

describe("cost math", () => {
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

  it("a lease's share splits the host's $/h across the leases on it, times the lease's age", () => {
    const host = fixtureBoxHost("h", { hourlyUsd: 1.92 });
    const lease = fixtureLease("a", { minutesAgo: 30 });
    const share = leaseCostShare(lease, host, 3, FIXTURE_NOW)!;
    assert.ok(Math.abs(share.hourlyUsd - 0.64) < 1e-9);
    assert.ok(Math.abs(share.spentUsd - 0.32) < 1e-9);
    assert.equal(leaseCostShare(lease, host, 0, FIXTURE_NOW)!.hourlyUsd, 1.92, "a lone lease carries the host");
    assert.equal(leaseCostShare(lease, fixtureHost(), 1, FIXTURE_NOW), null);
    assert.equal(leaseCostShare(lease, null, 1, FIXTURE_NOW), null);
  });

  it("only leases that hold a device share the cost", () => {
    assert.equal(costSharers([{ state: "ready" }, { state: "starting" }, { state: "suspended" }, { state: "lost" }]), 3);
  });

  it("the pool header sums capacity over working hosts and compares spend with the cap", () => {
    const fleet = fleetFixture();
    const view = poolView(fleet.pool, fleet.settings, fleet.hosts, FIXTURE_NOW);
    assert.equal(view.placementLabel, "This host first");
    assert.equal(view.used, 2 + 3 + 5 + 0 + 1 + 1 + 1);
    assert.equal(view.total, 4 + 8 + 6 + 6 + 6 + 8 + 4);
    assert.equal(view.queue, 3);
    assert.equal(view.hourlyUsd, 7.68);
    assert.equal(view.capUsd, 10);
    assert.ok(Math.abs(view.spendRatio - 0.768) < 1e-9);
    assert.equal(view.spendTone, "warn");
    assert.equal(view.rentWithoutAsking, true);
    assert.equal(view.poolHosts, 6);
    const spent = (1.92 * 133 + 0.64 * 95 + 0.64 * 2 + 0.64 * 240 + 1.92 * 61) / 60;
    assert.ok(Math.abs(view.spentUsd - spent) < 1e-9);
  });

  it("the pool header works before the pool summary and the settings arrive", () => {
    const host = fixtureBoxHost("h", { hourlyUsd: 2, capacity: { used: 1, total: 6 } });
    const view = poolView(null, null, [host, fixtureHost({ status: "failed", capacity: { used: 0, total: 4 } })], FIXTURE_NOW);
    assert.equal(view.hourlyUsd, 2, "the hosts' prices stand in");
    assert.equal(view.total, 6, "a failed host adds no room");
    assert.equal(view.capUsd, null);
    assert.equal(view.spendRatio, 0);
    assert.equal(view.placementLabel, "—");
    assert.equal(view.rentWithoutAsking, null);
    assert.equal(poolView(null, { ...DEFAULT_DEVICES_SETTINGS, pool: { ...DEFAULT_DEVICES_SETTINGS.pool, maxHourlyUsd: 0 } }, [host], FIXTURE_NOW).spendTone, "danger");
  });

  it("meters and tones", () => {
    assert.deepEqual([spendTone(0), spendTone(0.74), spendTone(0.75), spendTone(1), spendTone(1.4)], ["ok", "ok", "warn", "danger", "danger"]);
    assert.deepEqual([meterFill(0, 0), meterFill(3, 6), meterFill(9, 6), meterFill(-1, 6)], [0, 0.5, 1, 0]);
  });
});

describe("time words", () => {
  it("uptime", () => {
    assert.deepEqual([0, 59_000, 60_000, 42 * 60_000, HOUR, 3 * HOUR + 5 * 60_000, 50 * HOUR].map(formatUptime), ["<1m", "<1m", "1m", "42m", "1h 0m", "3h 5m", "2d 2h"]);
  });

  it("ago", () => {
    const at = (ms: number) => new Date(FIXTURE_NOW - ms).toISOString();
    assert.deepEqual([at(1_000), at(12_000), at(4 * 60_000), at(2 * HOUR), at(72 * HOUR), at(-5_000)].map((iso) => formatAgo(iso, FIXTURE_NOW)), [
      "just now",
      "12s ago",
      "4m ago",
      "2h ago",
      "3d ago",
      "just now"
    ]);
    assert.equal(formatAgo("garbage", FIXTURE_NOW), "");
  });
});

describe("leases", () => {
  it("poll their thumbnail through the daemon's downscaled thumbnail route", () => {
    assert.equal(thumbnailPath(fixtureLease("emulator-5554")), "/api/devices/leases/emulator-5554/thumbnail?w=320");
    assert.equal(thumbnailPath(fixtureLease("emulator-5554"), 160), "/api/devices/leases/emulator-5554/thumbnail?w=160");
    assert.equal(
      thumbnailPath(fixtureLease("A1B2 C", { hostId: "box:m1", platform: "ios" })),
      "/api/devices/leases/A1B2%20C/thumbnail?w=320"
    );
    assert.equal(thumbnailPath(fixtureLease("s", { state: "starting" })), null);
    assert.equal(thumbnailPath(fixtureLease("n", { stream: undefined })), null);
    assert.equal(thumbnailPath(fixtureLease("v", { stream: { kind: "vphone", deviceParam: "v" } })), null);
  });

  it("frame their thumbnail at the screen's shape, else the form factor's", () => {
    assert.equal(thumbnailAspect(fixtureLease("a", { screen: { width: 400, height: 800, scale: 2 } })), 0.5);
    assert.equal(thumbnailAspect(fixtureLease("t", { profile: "pixel-tablet" })), 3 / 4);
    assert.equal(thumbnailAspect(fixtureLease("p", { profile: "unknown" })), 9 / 19.5);
  });

  it("say what covers a thumbnail that is not live", () => {
    assert.equal(leaseStateNote(fixtureLease("r")), null);
    assert.deepEqual(leaseStateNote(fixtureLease("s", { state: "starting", progress: { step: "rent-host", label: "Renting a Mac host…", startedAt: "" } })), {
      label: "Renting a Mac host…",
      tone: "info"
    });
    assert.equal(leaseStateNote(fixtureLease("s", { state: "starting" }))!.label, "Starting…");
    assert.equal(leaseStateNote(fixtureLease("u", { state: "suspended" }))!.tone, "warn");
    assert.equal(leaseStateNote(fixtureLease("l", { state: "lost", error: "gone" }))!.label, "gone");
  });

  it("name their chat and agent", () => {
    const sessions = [{ id: "c1", title: "Checkout", refId: "claude" }, { id: "c2", title: "  ", refId: "mystery" }];
    const agents = [{ id: "claude", name: "Claude Code" }];
    assert.deepEqual(chatRef("c1", sessions, agents), { title: "Checkout", agentName: "Claude Code", known: true });
    assert.deepEqual(chatRef("c2", sessions, agents), { title: "Untitled chat", agentName: "mystery", known: true });
    assert.deepEqual(chatRef("c3", sessions, agents), { title: "Chat not open", agentName: null, known: false });
  });

  it("show their newest action", () => {
    const { actions } = fleetFixture();
    assert.equal(lastAction(actions["emulator-5554"])!.summary, "Tapped @e7 “Add to cart”");
    assert.equal(lastAction(undefined), null);
    assert.equal(lastAction([]), null);
  });
});
