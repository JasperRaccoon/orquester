/**
 * Where a new lease goes (devices spec §6; phase 2 §2.3–2.4 extends it into the pool scheduler).
 * Pure: the service passes the hosts as they are now and acts on the answer.
 *
 * Phase 1 rules, in order:
 * 1. the platform is off in Settings → Devices → `disabled`;
 * 2. a named host (`hostId`) is used alone; research hosts (phase 3 vphone) are used only so;
 * 3. otherwise local first (unless `pool-only`), then the busiest ready box host that still has
 *    room (best fit packs hosts, so idle ones can be torn down);
 * 4. no room, but a host is starting or installing → `wait` for it;
 * 5. a host that needs setup the daemon can do itself (every missing check has a fix action) →
 *    `setup` (the owner enabling the platform is the consent);
 * 6. a factory can rent one more host (and the mode allows the pool) → `provision`;
 * 7. hosts exist but are full → `full` (`DEVICE_CAPACITY`); otherwise `not-ready`
 *    (`PLATFORM_NOT_READY` with the missing checks).
 *
 * Phase 2 (`decidePool`, below) adds the wait queue, scale-up ahead of demand, warm minimums,
 * caps and idle teardown; the service still asks `choosePlacement` first for what the pool does
 * not decide (a platform that is off, a host it can set up, a named host).
 */

import type { DeviceHostKind, DeviceHostStatus, DevicePlatform, DevicePoolWaitReason, DeviceReadinessCheck, DevicesSettings } from "@orquester/api";

/** A host as placement sees it. */
export interface PlacementHost {
  id: string;
  kind: DeviceHostKind;
  platforms: readonly DevicePlatform[];
  status: DeviceHostStatus;
  checks: readonly DeviceReadinessCheck[];
  used: number;
  total: number;
  /** Phase 2: draining hosts take no new lease. */
  draining?: boolean;
  /** Phase 3: a research host (vphone): only a request naming it lands there. */
  research?: boolean;
}

export type Placement =
  | { kind: "host"; hostId: string }
  | { kind: "wait"; hostId: string }
  | { kind: "setup"; hostId: string; actions: string[] }
  | { kind: "provision"; platform: DevicePlatform }
  | { kind: "full"; hostIds: string[] }
  | { kind: "not-ready"; hostId: string | null; missing: DeviceReadinessCheck[] }
  | { kind: "disabled" };

export interface PlacementInput {
  platform: DevicePlatform;
  hosts: readonly PlacementHost[];
  settings: DevicesSettings;
  /** A factory can rent one more host for the platform. */
  canProvision: boolean;
  /** Only this host (the panel's picker on an existing device). */
  hostId?: string;
}

function platformEnabled(settings: DevicesSettings, platform: DevicePlatform): boolean {
  return platform === "android" ? settings.android.enabled : settings.ios.enabled;
}

const hasRoom = (host: PlacementHost): boolean => host.status === "ready" && !host.draining && host.used < host.total;
const missingChecks = (host: PlacementHost): DeviceReadinessCheck[] => host.checks.filter((check) => check.state !== "ok");
const selfFixable = (host: PlacementHost): boolean => {
  const missing = missingChecks(host);
  return missing.length > 0 && missing.every((check) => check.fixActionId !== undefined && check.state !== "working");
};

export function choosePlacement(input: PlacementInput): Placement {
  const { platform, settings } = input;
  if (!platformEnabled(settings, platform)) return { kind: "disabled" };
  const mode = settings.pool.placement;
  let hosts = input.hosts.filter((host) => host.platforms.includes(platform));
  if (input.hostId !== undefined) hosts = hosts.filter((host) => host.id === input.hostId);
  else {
    hosts = hosts.filter((host) => host.research !== true);
    if (mode === "pool-only") hosts = hosts.filter((host) => host.kind !== "local");
    else if (mode === "local-only") hosts = hosts.filter((host) => host.kind === "local");
  }

  const local = hosts.find((host) => host.kind === "local" && hasRoom(host));
  if (local) return { kind: "host", hostId: local.id };
  const fits = hosts
    .filter((host) => host.kind !== "local" && hasRoom(host))
    .sort((a, b) => a.total - a.used - (b.total - b.used) || a.id.localeCompare(b.id));
  if (fits[0]) return { kind: "host", hostId: fits[0].id };

  const coming = hosts.find((host) => host.status === "starting" || host.status === "installing");
  if (coming) return { kind: "wait", hostId: coming.id };
  const fixable = hosts.find((host) => host.status === "needs-setup" && selfFixable(host));
  if (fixable) return { kind: "setup", hostId: fixable.id, actions: missingChecks(fixable).map((check) => check.fixActionId!) };
  if (input.hostId === undefined && input.canProvision && mode !== "local-only") return { kind: "provision", platform };

  const full = hosts.filter((host) => host.status === "ready" && host.used >= host.total);
  if (full.length > 0) return { kind: "full", hostIds: full.map((host) => host.id) };
  const broken = hosts.find((host) => host.status !== "disabled") ?? hosts[0];
  return { kind: "not-ready", hostId: broken?.id ?? null, missing: broken ? missingChecks(broken) : [] };
}

// ===========================================================================
// Phase 2: the pool scheduler (phase 2 spec goals 3, 4, 5, 8, 10; §4)
// ===========================================================================
//
// `decidePool` is pure: the pool actor (`pool-actor.ts`) hands it every queued request, every host
// (and every rental in flight, as a `pending` host) and the clock, and acts on the answer. Rules:
//
// Placement, per request, oldest first (each takes one slot; the next sees what is left):
// Research hosts (phase 3 vphone) are never placed on.
//   1. this host, unless `pool-only` (a slot is free: ready, not draining, used < total);
//   2. best fit: the most loaded ready pool host with a free slot (packs hosts so idle ones go);
//   3. a starting host's future slot (its total, else the learned/default capacity), soonest first;
//   4. otherwise it needs a new host.
// Scale up, per platform: unless `local-only` and only when a factory quotes a rental —
//   - demand: one host per `perHostCapacity` unmet requests, while `maxHosts` and `maxHourlyUsd`
//     allow. Covered by a standing approval — the factory's own (its quote needs no approval) or the
//     pool's ("Rent device hosts without asking", a known price, this month's spend + the host's
//     whole lifetime within `monthlyCapUsd`) — or by a
//     request whose rental the owner approved (its spend card; one card per host). Unapproved
//     requests with no standing approval fail `approval` at once (the agent's next call asks).
//   - ahead of demand (standing approval only): while the pool is in use and fewer than a quarter
//     of a host's slots are free, one more host; and `minWarmHosts` hosts kept up per platform.
// Waiting: a request no host can take waits until `capacityWaitSeconds` after it was made, then
//   fails `DEVICE_CAPACITY` (`budget` when `maxHourlyUsd` was what blocked a rental); at once when
//   no host could ever free a slot. One waiting on a starting host waits up to `hostWaitSeconds`.
// Scale down (the only idle teardown of rented hosts): a drained rented host with no lease goes; a
//   ready rented host idle for `idleTeardownMinutes` goes unless it is one of the platform's
//   `minWarmHosts`; one that is not ready (unreachable, needs setup) and has no lease goes after
//   the same time (it bills either way). Failed hosts are their factory's to clean up.
// Android hosts never run more than {@link ANDROID_HOST_HARD_CAP} devices (spike §3).

/** No host runs more Android emulators than this (the 17th aborts and may take others down; spike §3). */
export const ANDROID_HOST_HARD_CAP = 16;
/** Devices a new Android pool host is planned with before one was measured (16 vCPU Blacksmith Linux: 8; spike §3). */
export const DEFAULT_ANDROID_POOL_CAPACITY = 8;
/** Seconds from renting a host to its first device (spike §3: ~30–40 s Linux with caches; a Mac takes minutes). */
export const HOST_START_SECONDS: Readonly<Record<DevicePlatform, number>> = { android: 40, ios: 300 };
/** How long a request may wait on a starting host before it fails. */
export const DEFAULT_HOST_WAIT_SECONDS = 600;

/** A host as the pool sees it (a rental in flight is a `pending` one). */
export interface PoolHost {
  id: string;
  kind: DeviceHostKind;
  platforms: readonly DevicePlatform[];
  status: DeviceHostStatus;
  used: number;
  /** Its capacity; 0 while unknown (a starting host plans with the learned/default one). */
  total: number;
  draining: boolean;
  /** Estimated $/h; null when unknown (local and own machines: 0). */
  hourlyUsd: number | null;
  /** When it was rented or started (ms); null when unknown. */
  startedAt: number | null;
  /** Since when it has had no lease (ms); null while it has one. */
  idleSince: number | null;
  /** The pool may destroy it (a rented box). */
  destroyable: boolean;
  /** What it was rented as (learned capacity). */
  provider?: string | null;
  size?: string | null;
  /** A rental in flight that has no host yet. */
  pending?: boolean;
  /** Phase 3: a research host (vphone): the pool never places on it (only a request naming it, outside the pool). */
  research?: boolean;
}

/** A lease request waiting for a host. */
export interface PoolRequest {
  id: string;
  platform: DevicePlatform;
  profile: string;
  threadId: string;
  requestedAt: number;
  /** The owner approved a rental for it (its spend card, or the panel's own Open). */
  rentalApproved: boolean;
}

/** What renting one more host for a platform means (from the factory's quote). */
export interface PoolRentalOffer {
  provider: string;
  size: string;
  hourlyUsd: number | null;
  lifetimeMinutes: number;
  /** The factory's own standing approval covers it (its quote's `needsApproval === false`). */
  preApproved: boolean;
}

export interface PoolLearnedCapacity {
  platform: string;
  provider: string;
  size: string;
  capacity: number;
}

export interface PoolInput {
  settings: DevicesSettings;
  hosts: readonly PoolHost[];
  requests: readonly PoolRequest[];
  now: number;
  /** Per platform: what a rental would be; absent or null: no factory can rent one. */
  offers: Partial<Record<DevicePlatform, PoolRentalOffer | null>>;
  learned: readonly PoolLearnedCapacity[];
  /** Spend on rented device hosts so far this month (USD). */
  monthSpentUsd: number;
  /** Default {@link DEFAULT_HOST_WAIT_SECONDS}. */
  hostWaitSeconds?: number;
}

export interface PoolPlacement {
  requestId: string;
  hostId: string;
}

export interface PoolQueued {
  requestId: string;
  reason: DevicePoolWaitReason;
  /** The starting host it waits for; null for a host still to be rented, or for a release. */
  hostId: string | null;
  etaSeconds: number | null;
  /** When it fails if still waiting (ms). */
  deadlineAt: number;
}

export type PoolScaleUpReason = "demand" | "headroom" | "warm";

export interface PoolScaleUp {
  platform: DevicePlatform;
  count: number;
  reason: PoolScaleUpReason;
  /** `standing`: the owner's "Rent device hosts without asking"; `request`: `requestIds[0]`'s approved spend card. */
  approvedBy: "standing" | "request";
  /** The requests the new hosts will take (demand), oldest first. */
  requestIds: string[];
  /** Each new host's $/h. */
  hourlyUsd: number | null;
}

export interface PoolScaleDown {
  hostId: string;
  reason: "idle" | "drained";
}

export type PoolFailureCode = "DEVICE_CAPACITY" | "budget" | "approval" | "disabled";

export interface PoolFailure {
  requestId: string;
  code: PoolFailureCode;
}

export interface PoolDecision {
  placements: PoolPlacement[];
  queue: PoolQueued[];
  scaleUp: PoolScaleUp[];
  scaleDown: PoolScaleDown[];
  failures: PoolFailure[];
  /** Idle rented hosts kept for `minWarmHosts`. */
  warmHostIds: string[];
  /** Devices a new host is planned with, per platform. */
  perHostCapacity: Record<DevicePlatform, number>;
}

const PLATFORMS: readonly DevicePlatform[] = ["ios", "android"];
const EPSILON = 1e-9;

/** The capacity a host may use: Android never above the hard cap. */
export function hostCap(platform: DevicePlatform, total: number): number {
  return platform === "android" ? Math.min(total, ANDROID_HOST_HARD_CAP) : total;
}

/** Devices one new host runs: the learned capacity of the provider + size, else the default. */
export function plannedCapacity(platform: DevicePlatform, settings: DevicesSettings, learned: readonly PoolLearnedCapacity[], provider?: string | null, size?: string | null): number {
  const hit = provider && size ? learned.find((entry) => entry.platform === platform && entry.provider === provider && entry.size === size) : undefined;
  const fallback = platform === "android" ? DEFAULT_ANDROID_POOL_CAPACITY : settings.ios.maxSimulatorsPerHost;
  return Math.max(1, hostCap(platform, Math.round(hit?.capacity ?? fallback)));
}

const isStarting = (host: PoolHost): boolean => host.pending === true || host.status === "starting" || host.status === "installing";
const isPoolHost = (host: PoolHost): boolean => host.kind === "box";
const platformOn = (settings: DevicesSettings, platform: DevicePlatform): boolean => (platform === "android" ? settings.android.enabled : settings.ios.enabled);

/** The worst case of one rental: its $/h over its whole lifetime. */
const worstCaseUsd = (offer: PoolRentalOffer): number => ((offer.hourlyUsd ?? 0) * offer.lifetimeMinutes) / 60;

export function decidePool(input: PoolInput): PoolDecision {
  const { settings, now } = input;
  const pool = settings.pool;
  const mode = pool.placement;
  const hostWaitMs = (input.hostWaitSeconds ?? DEFAULT_HOST_WAIT_SECONDS) * 1000;
  const decision: PoolDecision = {
    placements: [],
    queue: [],
    scaleUp: [],
    scaleDown: [],
    failures: [],
    warmHostIds: [],
    perHostCapacity: { ios: 0, android: 0 }
  };
  for (const platform of PLATFORMS) {
    const offer = input.offers[platform];
    decision.perHostCapacity[platform] = plannedCapacity(platform, settings, input.learned, offer?.provider, offer?.size);
  }

  const inScope = (host: PoolHost, platform: DevicePlatform): boolean =>
    host.platforms.includes(platform) && host.research !== true && (mode === "pool-only" ? host.kind !== "local" : mode === "local-only" ? host.kind === "local" : true);
  /** Slots left per host this round (ready hosts now; starting ones later). */
  const free = new Map<string, number>();
  const future = new Map<string, number>();
  /** Hosts this decision gave a request to (not idle). */
  const busy = new Set<string>();
  const slotsOf = (host: PoolHost, platform: DevicePlatform): number => {
    const total = host.total > 0 ? host.total : isStarting(host) ? plannedCapacity(platform, settings, input.learned, host.provider, host.size) : 0;
    return Math.max(0, hostCap(platform, total) - host.used);
  };
  const eta = (host: PoolHost, platform: DevicePlatform): number =>
    Math.max(0, Math.round(((host.startedAt ?? now) + HOST_START_SECONDS[platform] * 1000 - now) / 1000));

  // --- Placement ---------------------------------------------------------------------------------
  const unmet = new Map<DevicePlatform, PoolRequest[]>();
  const requests = [...input.requests].sort((a, b) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id));
  for (const request of requests) {
    const { platform } = request;
    if (!platformOn(settings, platform)) {
      decision.failures.push({ requestId: request.id, code: "disabled" });
      continue;
    }
    const hosts = input.hosts.filter((host) => inScope(host, platform) && !host.draining);
    const room = (host: PoolHost): number => {
      if (!free.has(host.id)) free.set(host.id, host.status === "ready" && !host.pending ? slotsOf(host, platform) : 0);
      return free.get(host.id)!;
    };
    const take = (host: PoolHost): void => {
      free.set(host.id, room(host) - 1);
      busy.add(host.id);
      decision.placements.push({ requestId: request.id, hostId: host.id });
    };
    const local = mode === "pool-only" ? undefined : hosts.find((host) => host.kind === "local" && room(host) > 0);
    if (local) {
      take(local);
      continue;
    }
    const fit = hosts
      .filter((host) => host.kind !== "local" && room(host) > 0)
      .sort((a, b) => room(a) - room(b) || a.id.localeCompare(b.id))[0];
    if (fit) {
      take(fit);
      continue;
    }
    const coming = hosts
      .filter(isStarting)
      .filter((host) => {
        if (!future.has(host.id)) future.set(host.id, slotsOf(host, platform));
        return future.get(host.id)! > 0;
      })
      .sort((a, b) => eta(a, platform) - eta(b, platform) || a.id.localeCompare(b.id))[0];
    if (coming) {
      future.set(coming.id, future.get(coming.id)! - 1);
      busy.add(coming.id);
      if (now - request.requestedAt >= hostWaitMs) {
        decision.failures.push({ requestId: request.id, code: "DEVICE_CAPACITY" });
        continue;
      }
      decision.queue.push({
        requestId: request.id,
        reason: "host-starting",
        hostId: coming.pending ? null : coming.id,
        etaSeconds: eta(coming, platform),
        deadlineAt: request.requestedAt + hostWaitMs
      });
      continue;
    }
    unmet.set(platform, [...(unmet.get(platform) ?? []), request]);
  }

  // --- Scale up ----------------------------------------------------------------------------------
  const poolHosts = input.hosts.filter(isPoolHost);
  let hostCount = poolHosts.length;
  let hourly = poolHosts.reduce((sum, host) => sum + (host.hourlyUsd ?? 0), 0);
  let plannedWorstUsd = 0;
  /** New hosts planned per platform, and their slots left after the demand they take. */
  const planned = new Map<DevicePlatform, { hosts: number; spare: number }>();
  const offerOf = (platform: DevicePlatform): PoolRentalOffer | null => (mode === "local-only" ? null : (input.offers[platform] ?? null));
  // The factory's own standing approval (its spend rules: e.g. "Rent Mac hosts without asking" within
  // `ios.monthlyCapUsd`), or the pool's ("Rent device hosts without asking" within `pool.monthlyCapUsd`).
  const standing = (offer: PoolRentalOffer): boolean =>
    offer.preApproved ||
    (offer.hourlyUsd !== null && pool.rentWithoutAsking && input.monthSpentUsd + plannedWorstUsd + worstCaseUsd(offer) <= pool.monthlyCapUsd + EPSILON);
  /** What blocks one more rental (a hard cap), or null. */
  const capBlock = (offer: PoolRentalOffer): "capacity" | "budget" | null => {
    if (hostCount + 1 > pool.maxHosts) return "capacity";
    if (hourly + (offer.hourlyUsd ?? 0) > pool.maxHourlyUsd + EPSILON) return "budget";
    return null;
  };
  const rent = (platform: DevicePlatform, offer: PoolRentalOffer, entry: Omit<PoolScaleUp, "platform" | "count" | "hourlyUsd">, taken: number): void => {
    hostCount += 1;
    hourly += offer.hourlyUsd ?? 0;
    plannedWorstUsd += worstCaseUsd(offer);
    const plan = planned.get(platform) ?? { hosts: 0, spare: 0 };
    planned.set(platform, { hosts: plan.hosts + 1, spare: plan.spare + decision.perHostCapacity[platform] - taken });
    const last = decision.scaleUp.at(-1);
    if (entry.approvedBy === "standing" && last && last.platform === platform && last.reason === entry.reason && last.approvedBy === "standing") {
      last.count += 1;
      last.requestIds.push(...entry.requestIds);
    } else {
      decision.scaleUp.push({ platform, count: 1, hourlyUsd: offer.hourlyUsd, ...entry });
    }
  };

  for (const platform of PLATFORMS) {
    let remaining = unmet.get(platform) ?? [];
    if (remaining.length === 0) continue;
    const offer = offerOf(platform);
    const per = decision.perHostCapacity[platform];
    let blocked: "capacity" | "budget" | "approval" | null = offer ? null : "capacity";
    while (offer && remaining.length > 0) {
      const cap = capBlock(offer);
      if (cap) {
        blocked = cap;
        break;
      }
      let group: PoolRequest[];
      let approvedBy: PoolScaleUp["approvedBy"];
      if (standing(offer)) {
        group = remaining.slice(0, per);
        approvedBy = "standing";
      } else {
        // One approved card rents one host; the host then serves whoever is next in line too.
        const approver = remaining.find((request) => request.rentalApproved);
        if (!approver) {
          blocked = "approval";
          break;
        }
        group = [approver, ...remaining.filter((request) => request !== approver)].slice(0, per);
        approvedBy = "request";
      }
      rent(platform, offer, { reason: "demand", approvedBy, requestIds: group.map((request) => request.id) }, group.length);
      for (const request of group) {
        decision.queue.push({ requestId: request.id, reason: "host-starting", hostId: null, etaSeconds: HOST_START_SECONDS[platform], deadlineAt: request.requestedAt + hostWaitMs });
      }
      remaining = remaining.filter((request) => !group.includes(request));
    }
    // What is left waits for a release (or fails).
    const couldFree = input.hosts.some((host) => inScope(host, platform) && !host.draining && (host.status === "ready" || isStarting(host)) && (host.used > 0 || isStarting(host)));
    for (const request of remaining) {
      if (blocked === "approval") {
        decision.failures.push({ requestId: request.id, code: "approval" });
        continue;
      }
      const reason: DevicePoolWaitReason = blocked === "budget" ? "budget" : "capacity";
      const deadlineAt = request.requestedAt + pool.capacityWaitSeconds * 1000;
      if (now >= deadlineAt || !couldFree) {
        decision.failures.push({ requestId: request.id, code: reason === "budget" ? "budget" : "DEVICE_CAPACITY" });
        continue;
      }
      decision.queue.push({ requestId: request.id, reason, hostId: null, etaSeconds: null, deadlineAt });
    }
  }

  // Ahead of demand: headroom while in use, and the warm minimum (standing approval only).
  for (const platform of PLATFORMS) {
    const offer = offerOf(platform);
    if (!offer || !platformOn(settings, platform)) continue;
    const mine = poolHosts.filter((host) => host.platforms.includes(platform) && !host.draining && (host.status === "ready" || isStarting(host)));
    const plan = planned.get(platform) ?? { hosts: 0, spare: 0 };
    const up = mine.length + plan.hosts;
    const inUse = plan.hosts > 0 || mine.some((host) => host.used > 0 || busy.has(host.id));
    const spare =
      plan.spare +
      mine.reduce((sum, host) => sum + (host.status === "ready" && !host.pending ? (free.get(host.id) ?? slotsOf(host, platform)) : (future.get(host.id) ?? slotsOf(host, platform))), 0);
    const headroom = Math.max(1, Math.ceil(decision.perHostCapacity[platform] / 4));
    const wantWarm = Math.max(0, pool.minWarmHosts[platform] - up);
    const wantHeadroom = inUse && spare < headroom ? 1 : 0;
    for (let index = 0; index < Math.max(wantWarm, wantHeadroom); index += 1) {
      if (capBlock(offer) || !standing(offer)) break;
      rent(platform, offer, { reason: index < wantWarm ? "warm" : "headroom", approvedBy: "standing", requestIds: [] }, 0);
    }
  }

  // --- Scale down --------------------------------------------------------------------------------
  const gone = new Set<string>();
  for (const host of poolHosts) {
    if (host.destroyable && !host.pending && host.draining && host.used === 0 && !busy.has(host.id)) {
      decision.scaleDown.push({ hostId: host.id, reason: "drained" });
      gone.add(host.id);
    }
  }
  const idleMs = pool.idleTeardownMinutes * 60_000;
  const settled = new Set<DeviceHostStatus>(["ready", "starting", "installing", "failed", "stopping"]);
  for (const host of poolHosts) {
    const since = host.idleSince ?? host.startedAt ?? now;
    if (host.destroyable && !host.pending && !gone.has(host.id) && !settled.has(host.status) && host.used === 0 && !busy.has(host.id) && now - since >= idleMs) {
      decision.scaleDown.push({ hostId: host.id, reason: "idle" });
      gone.add(host.id);
    }
  }
  for (const platform of PLATFORMS) {
    const keep = mode === "local-only" ? 0 : pool.minWarmHosts[platform];
    const up = poolHosts.filter((host) => host.platforms.includes(platform) && !host.draining && !gone.has(host.id) && (host.status === "ready" || isStarting(host)));
    let count = up.length + (planned.get(platform)?.hosts ?? 0);
    const idle = up
      .filter((host) => host.status === "ready" && !host.pending && host.used === 0 && !busy.has(host.id))
      .sort((a, b) => (a.idleSince ?? a.startedAt ?? now) - (b.idleSince ?? b.startedAt ?? now) || a.id.localeCompare(b.id));
    for (const host of idle) {
      const since = host.idleSince ?? host.startedAt ?? now;
      if (host.destroyable && !gone.has(host.id) && now - since >= idleMs && count - 1 >= keep) {
        decision.scaleDown.push({ hostId: host.id, reason: "idle" });
        gone.add(host.id);
        count -= 1;
      } else if (!gone.has(host.id) && !decision.warmHostIds.includes(host.id) && decision.warmHostIds.filter((id) => up.some((entry) => entry.id === id)).length < keep) {
        decision.warmHostIds.push(host.id);
      }
    }
  }
  return decision;
}
