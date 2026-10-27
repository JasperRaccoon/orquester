import assert from "node:assert/strict";
import test from "node:test";

import { defaultDevicesSettings, type DevicesSettings } from "@orquester/config";

import {
  ANDROID_HOST_HARD_CAP,
  HOST_START_SECONDS,
  choosePlacement,
  decidePool,
  hostCap,
  plannedCapacity,
  type PlacementHost,
  type PoolDecision,
  type PoolHost,
  type PoolInput,
  type PoolRentalOffer,
  type PoolRequest
} from "./pool.ts";

const settings = (patch: (s: DevicesSettings) => void = () => undefined): DevicesSettings => {
  const s = defaultDevicesSettings();
  s.android.enabled = true;
  s.ios.enabled = true;
  patch(s);
  return s;
};

const host = (id: string, extra: Partial<PlacementHost> = {}): PlacementHost => ({
  id,
  kind: id === "local" ? "local" : "box",
  platforms: id === "local" ? ["android"] : ["ios"],
  status: "ready",
  checks: [],
  used: 0,
  total: 2,
  ...extra
});

test("a platform that is off is disabled", () => {
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local")], settings: settings((s) => void (s.android.enabled = false)), canProvision: false }), { kind: "disabled" });
});

test("local first, then the busiest box host with room (best fit)", () => {
  const hosts = [host("box:a", { used: 0, total: 3 }), host("box:b", { used: 2, total: 3 }), host("box:c", { used: 3, total: 3 })];
  assert.deepEqual(choosePlacement({ platform: "ios", hosts, settings: settings(), canProvision: true }), { kind: "host", hostId: "box:b" });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local")], settings: settings(), canProvision: false }), { kind: "host", hostId: "local" });
});

test("no room: wait for a starting host, set up a fixable one, rent one, or report full / not ready", () => {
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { status: "starting" })], settings: settings(), canProvision: true }), { kind: "wait", hostId: "box:a" });
  const fixable = host("local", {
    status: "needs-setup",
    checks: [
      { id: "kvm", label: "KVM", state: "ok", detail: null },
      { id: "android-sdk", label: "SDK", state: "missing", detail: null, fixActionId: "install-android-sdk" }
    ]
  });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [fixable], settings: settings(), canProvision: false }), { kind: "setup", hostId: "local", actions: ["install-android-sdk"] });
  const unfixable = host("local", { status: "needs-setup", checks: [{ id: "kvm", label: "KVM", state: "missing", detail: null }] });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [unfixable], settings: settings(), canProvision: false }), {
    kind: "not-ready",
    hostId: "local",
    missing: [{ id: "kvm", label: "KVM", state: "missing", detail: null }]
  });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { used: 2 })], settings: settings(), canProvision: true }), { kind: "provision", platform: "ios" });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [host("box:a", { used: 2 })], settings: settings(), canProvision: false }), { kind: "full", hostIds: ["box:a"] });
  assert.deepEqual(choosePlacement({ platform: "ios", hosts: [], settings: settings(), canProvision: false }), { kind: "not-ready", hostId: null, missing: [] });
});

test("placement modes and a named host", () => {
  const hosts = [host("local", { platforms: ["android"] }), host("box:l", { platforms: ["android"] })];
  assert.deepEqual(choosePlacement({ platform: "android", hosts, settings: settings((s) => void (s.pool.placement = "pool-only")), canProvision: false }), { kind: "host", hostId: "box:l" });
  assert.deepEqual(
    choosePlacement({ platform: "android", hosts: [host("local", { used: 2 })], settings: settings((s) => void (s.pool.placement = "local-only")), canProvision: true }),
    { kind: "full", hostIds: ["local"] }
  );
  assert.deepEqual(choosePlacement({ platform: "android", hosts, settings: settings(), canProvision: true, hostId: "box:l" }), { kind: "host", hostId: "box:l" });
  assert.deepEqual(choosePlacement({ platform: "android", hosts: [host("local", { draining: true })], settings: settings(), canProvision: false }), { kind: "not-ready", hostId: "local", missing: [] });
});

// ---------------------------------------------------------------------------
// decidePool
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const MIN = 60_000;

const poolHost = (id: string, extra: Partial<PoolHost> = {}): PoolHost => ({
  id,
  kind: id === "local" ? "local" : "box",
  platforms: ["android"],
  status: "ready",
  used: 0,
  total: 8,
  draining: false,
  hourlyUsd: id === "local" ? 0 : 1.92,
  startedAt: NOW - 30 * MIN,
  idleSince: null,
  destroyable: id !== "local",
  ...extra
});

const req = (id: string, extra: Partial<PoolRequest> = {}): PoolRequest => ({
  id,
  platform: "android",
  profile: "pixel-9",
  threadId: `t-${id}`,
  requestedAt: NOW,
  rentalApproved: false,
  ...extra
});

const offer = (extra: Partial<PoolRentalOffer> = {}): PoolRentalOffer => ({ provider: "blacksmith", size: "16vcpu", hourlyUsd: 1.92, lifetimeMinutes: 240, preApproved: false, ...extra });

/** Settings with Android on, pool renting without asking within roomy caps (each test narrows). */
const poolSettings = (patch: (s: DevicesSettings) => void = () => undefined): DevicesSettings =>
  settings((s) => {
    s.pool.rentWithoutAsking = true;
    s.pool.maxHosts = 10;
    s.pool.maxHourlyUsd = 100;
    s.pool.monthlyCapUsd = 1000;
    patch(s);
  });

const decide = (input: Partial<PoolInput>): PoolDecision =>
  decidePool({ settings: poolSettings(), hosts: [], requests: [], now: NOW, offers: { android: offer() }, learned: [], monthSpentUsd: 0, ...input });

const placed = (decision: PoolDecision): Record<string, string> => Object.fromEntries(decision.placements.map((entry) => [entry.requestId, entry.hostId]));
const failed = (decision: PoolDecision): Record<string, string> => Object.fromEntries(decision.failures.map((entry) => [entry.requestId, entry.code]));
const queued = (decision: PoolDecision): Record<string, string> => Object.fromEntries(decision.queue.map((entry) => [entry.requestId, `${entry.reason}:${entry.hostId ?? "-"}`]));

test("decidePool placement: local first up to its capacity, then best fit (the most loaded pool host with room)", () => {
  const hosts = [poolHost("local", { total: 2, used: 1 }), poolHost("box:a", { used: 2 }), poolHost("box:b", { used: 6 }), poolHost("box:c", { used: 8 })];
  const decision = decide({ hosts, requests: [req("r1"), req("r2"), req("r3"), req("r4")] });
  assert.deepEqual(placed(decision), { r1: "local", r2: "box:b", r3: "box:b", r4: "box:a" });
  assert.deepEqual(decision.scaleUp.filter((entry) => entry.reason === "demand"), []);
});

test("decidePool placement modes: pool-only skips this host, local-only never rents", () => {
  const hosts = [poolHost("local", { total: 4 }), poolHost("box:a", { used: 1 })];
  assert.deepEqual(placed(decide({ hosts, requests: [req("r1")], settings: poolSettings((s) => void (s.pool.placement = "pool-only")) })), { r1: "box:a" });
  const localOnly = decide({ hosts: [poolHost("local", { total: 1, used: 1 })], requests: [req("r1")], settings: poolSettings((s) => void (s.pool.placement = "local-only")) });
  assert.deepEqual(decision(localOnly), { placements: {}, queue: { r1: "capacity:-" }, failures: {}, scaleUp: [] });
  // A host in local-only mode that is not local takes nothing.
  const onlyBox = decide({ hosts: [poolHost("box:a")], requests: [req("r1")], settings: poolSettings((s) => void (s.pool.placement = "local-only")) });
  assert.deepEqual(failed(onlyBox), { r1: "DEVICE_CAPACITY" });
});

function decision(d: PoolDecision) {
  return { placements: placed(d), queue: queued(d), failures: failed(d), scaleUp: d.scaleUp.map((entry) => `${entry.platform}:${entry.reason}:${entry.count}:${entry.approvedBy}`) };
}

test("decidePool: draining hosts and hosts that are not ready take no new lease", () => {
  const hosts = [poolHost("box:a", { draining: true }), poolHost("box:b", { status: "unreachable" }), poolHost("box:c", { status: "failed" })];
  const d = decide({ hosts, requests: [req("r1")] });
  assert.deepEqual(placed(d), {});
  assert.deepEqual(queued(d), { r1: "host-starting:-" });
  assert.deepEqual(d.scaleUp.map((entry) => [entry.reason, entry.count, entry.requestIds]), [["demand", 1, ["r1"]]]);
});

test("decidePool: Android never above 16 per host, whatever the host reports", () => {
  const d = decide({ hosts: [poolHost("box:big", { total: 32, used: 15 })], requests: [req("r1"), req("r2")], settings: poolSettings((s) => void (s.pool.maxHosts = 1)) });
  assert.deepEqual(placed(d), { r1: "box:big" });
  assert.deepEqual(queued(d), { r2: "capacity:-" });
  // Learned capacities are clamped too.
  assert.equal(plannedCapacity("android", poolSettings(), [{ platform: "android", provider: "blacksmith", size: "32vcpu", capacity: 30 }], "blacksmith", "32vcpu"), ANDROID_HOST_HARD_CAP);
  assert.equal(hostCap("ios", 30), 30);
});

test("decidePool: starting hosts' future slots are used before renting; queued with an ETA", () => {
  const starting = poolHost("box:s", { status: "starting", total: 0, used: 0, startedAt: NOW - 10_000 });
  const d = decide({ hosts: [starting], requests: [req("r1"), req("r2")], learned: [{ platform: "android", provider: "blacksmith", size: "16vcpu", capacity: 1 }] });
  // A starting host with no reported total plans with the default (8): both wait on it.
  assert.deepEqual(queued(d), { r1: "host-starting:box:s", r2: "host-starting:box:s" });
  assert.equal(d.queue[0]!.etaSeconds, HOST_START_SECONDS.android - 10);
  // Its learned capacity (1, for what it was rented as) leaves the second request to a new host.
  const learnedHost = { ...starting, provider: "blacksmith", size: "16vcpu" };
  const e = decide({ hosts: [learnedHost], requests: [req("r1"), req("r2")], learned: [{ platform: "android", provider: "blacksmith", size: "16vcpu", capacity: 1 }] });
  assert.deepEqual(queued(e), { r1: "host-starting:box:s", r2: "host-starting:-" });
  // (and, with 1 device per host, one more ahead of demand.)
  assert.deepEqual(e.scaleUp.map((entry) => [entry.reason, entry.requestIds]), [["demand", ["r2"]], ["headroom", []]]);
  // A pending rental (no host yet) is a starting host too.
  const pending = poolHost("pending:1", { status: "starting", total: 0, pending: true, startedAt: NOW });
  assert.deepEqual(queued(decide({ hosts: [pending], requests: [req("r1")] })), { r1: "host-starting:-" });
  // Waiting on a starting host is cut at hostWaitSeconds.
  assert.deepEqual(failed(decide({ hosts: [starting], requests: [req("r1", { requestedAt: NOW - 11 * MIN })] })), { r1: "DEVICE_CAPACITY" });
});

test("decidePool scale up: one host per perHostCapacity unmet requests, learned capacity first", () => {
  const requests = Array.from({ length: 10 }, (_, index) => req(`r${index}`));
  const d = decide({ requests });
  assert.deepEqual(d.scaleUp.map((entry) => [entry.reason, entry.count, entry.approvedBy, entry.requestIds.length]), [["demand", 2, "standing", 10]]);
  assert.equal(d.perHostCapacity.android, 8);
  const learned = decide({ requests, learned: [{ platform: "android", provider: "blacksmith", size: "16vcpu", capacity: 12 }] });
  assert.equal(learned.perHostCapacity.android, 12);
  assert.equal(learned.scaleUp[0]!.count, 1);
  // Headroom: the new host has 2 slots left (≥ 12/4 = 3? no) → one more ahead of demand.
  const tight = decide({ requests: Array.from({ length: 7 }, (_, index) => req(`r${index}`)) });
  assert.deepEqual(tight.scaleUp.map((entry) => [entry.reason, entry.count]), [["demand", 1], ["headroom", 1]]);
});

test("decidePool caps: maxHosts waits then fails DEVICE_CAPACITY; maxHourlyUsd fails budget", () => {
  const full = poolHost("box:a", { used: 8 });
  const capped = decide({ hosts: [full], requests: [req("r1")], settings: poolSettings((s) => void (s.pool.maxHosts = 1)) });
  assert.deepEqual(decision(capped), { placements: {}, queue: { r1: "capacity:-" }, failures: {}, scaleUp: [] });
  assert.equal(capped.queue[0]!.deadlineAt, NOW + 120_000);
  const late = decide({ hosts: [full], requests: [req("r1", { requestedAt: NOW - 121_000 })], settings: poolSettings((s) => void (s.pool.maxHosts = 1)) });
  assert.deepEqual(failed(late), { r1: "DEVICE_CAPACITY" });
  const budget = decide({ hosts: [full], requests: [req("r1")], settings: poolSettings((s) => void (s.pool.maxHourlyUsd = 3)) });
  assert.deepEqual(queued(budget), { r1: "budget:-" });
  assert.deepEqual(failed(decide({ hosts: [full], requests: [req("r1", { requestedAt: NOW - 121_000 })], settings: poolSettings((s) => void (s.pool.maxHourlyUsd = 3)) })), { r1: "budget" });
  // Nothing could ever free a slot: fail at once.
  assert.deepEqual(failed(decide({ requests: [req("r1")], settings: poolSettings((s) => void (s.pool.maxHosts = 0)) })), { r1: "DEVICE_CAPACITY" });
  assert.deepEqual(failed(decide({ requests: [req("r1")], settings: poolSettings((s) => void (s.pool.maxHourlyUsd = 1)) })), { r1: "budget" });
  // No factory can rent: wait for a release.
  assert.deepEqual(queued(decide({ hosts: [poolHost("local", { total: 1, used: 1 })], requests: [req("r1")], offers: {} })), { r1: "capacity:-" });
  // capacityWaitSeconds 0: no wait.
  assert.deepEqual(failed(decide({ hosts: [poolHost("local", { total: 1, used: 1 })], requests: [req("r1")], offers: {}, settings: poolSettings((s) => void (s.pool.capacityWaitSeconds = 0)) })), { r1: "DEVICE_CAPACITY" });
});

test("decidePool approval: standing approval within the monthly cap, else one approved request per host", () => {
  const noStanding = poolSettings((s) => void (s.pool.rentWithoutAsking = false));
  assert.deepEqual(failed(decide({ requests: [req("r1"), req("r2")], settings: noStanding })), { r1: "approval", r2: "approval" });
  // An approved request rents one host, which serves the next ones in line too.
  const approved = decide({ requests: [req("r1"), req("r2", { rentalApproved: true }), req("r3")], settings: noStanding });
  assert.deepEqual(approved.scaleUp.map((entry) => [entry.approvedBy, entry.count, entry.requestIds]), [["request", 1, ["r2", "r1", "r3"]]]);
  assert.deepEqual(failed(approved), {});
  // The factory's own standing approval counts (an iOS quote with needsApproval false).
  assert.equal(decide({ requests: [req("r1")], settings: noStanding, offers: { android: offer({ preApproved: true }) } }).scaleUp[0]!.approvedBy, "standing");
  // Over the monthly cap: a card again (unknown price too).
  assert.deepEqual(failed(decide({ requests: [req("r1")], monthSpentUsd: 995 })), { r1: "approval" });
  assert.deepEqual(failed(decide({ requests: [req("r1")], offers: { android: offer({ hourlyUsd: null }) } })), { r1: "approval" });
  assert.equal(decide({ requests: [req("r1", { rentalApproved: true })], monthSpentUsd: 995 }).scaleUp[0]!.approvedBy, "request");
  // Caps still bind an approved request.
  assert.deepEqual(failed(decide({ requests: [req("r1", { rentalApproved: true })], settings: poolSettings((s) => void (s.pool.maxHosts = 0)) })), { r1: "DEVICE_CAPACITY" });
});

test("decidePool warm minimum: hosts kept up ahead of demand, only with standing approval and within caps", () => {
  const warm = poolSettings((s) => void (s.pool.minWarmHosts.android = 2));
  assert.deepEqual(decide({ settings: warm }).scaleUp.map((entry) => [entry.reason, entry.count]), [["warm", 2]]);
  assert.deepEqual(decide({ settings: warm, hosts: [poolHost("box:a"), poolHost("box:b", { status: "starting" })] }).scaleUp, []);
  assert.deepEqual(decide({ settings: poolSettings((s) => ((s.pool.minWarmHosts.android = 2), (s.pool.rentWithoutAsking = false))) }).scaleUp, []);
  assert.deepEqual(decide({ settings: poolSettings((s) => ((s.pool.minWarmHosts.android = 2), (s.pool.maxHosts = 1))) }).scaleUp.map((entry) => entry.count), [1]);
  assert.deepEqual(decide({ settings: poolSettings((s) => ((s.pool.minWarmHosts.android = 2), (s.pool.placement = "local-only"))) }).scaleUp, []);
  assert.deepEqual(decide({ settings: poolSettings((s) => ((s.pool.minWarmHosts.android = 2), (s.android.enabled = false))) }).scaleUp, []);
});

test("decidePool scale down: idle hosts after idleTeardownMinutes, keeping minWarmHosts; drained empty hosts at once", () => {
  const idle = (id: string, minutes: number, extra: Partial<PoolHost> = {}) => poolHost(id, { idleSince: NOW - minutes * MIN, ...extra });
  const hosts = [idle("box:a", 30), idle("box:b", 25), idle("box:c", 5), poolHost("box:d", { used: 3 })];
  assert.deepEqual(decide({ hosts }).scaleDown, [
    { hostId: "box:a", reason: "idle" },
    { hostId: "box:b", reason: "idle" }
  ]);
  const kept = decide({ hosts, settings: poolSettings((s) => void (s.pool.minWarmHosts.android = 3)) });
  assert.deepEqual(kept.scaleDown, [{ hostId: "box:a", reason: "idle" }]);
  assert.deepEqual(kept.warmHostIds, ["box:b", "box:c"]);
  // Not destroyable (an own machine), or this host: never torn down.
  assert.deepEqual(decide({ hosts: [idle("box:own", 60, { destroyable: false }), idle("local", 60)] }).scaleDown, []);
  // Drained and empty: destroyed whatever the idle clock says; drained with leases: kept.
  assert.deepEqual(decide({ hosts: [poolHost("box:x", { draining: true }), poolHost("box:y", { draining: true, used: 1 })] }).scaleDown, [{ hostId: "box:x", reason: "drained" }]);
  // A host that just got a request is not idle.
  assert.deepEqual(decide({ hosts: [idle("box:a", 60)], requests: [req("r1")] }).scaleDown, []);
});

test("decidePool: a platform switched off fails its queued requests; platforms are planned apart", () => {
  const off = decide({ requests: [req("r1")], settings: poolSettings((s) => void (s.android.enabled = false)) });
  assert.deepEqual(failed(off), { r1: "disabled" });
  const mixed = decide({
    hosts: [poolHost("box:mac", { platforms: ["ios"], total: 3, used: 3, hourlyUsd: 4.8 })],
    requests: [req("a1"), req("i1", { platform: "ios", profile: "iphone-17-pro" })],
    offers: { android: offer(), ios: offer({ size: "6vcpu", hourlyUsd: 4.8 }) }
  });
  assert.deepEqual(mixed.scaleUp.map((entry) => [entry.platform, entry.reason, entry.requestIds]), [
    ["ios", "demand", ["i1"]],
    ["android", "demand", ["a1"]]
  ]);
  assert.equal(mixed.perHostCapacity.ios, 3);
});
