/**
 * The device pool actor (phase 2 spec goals 3, 5, 6, 10; §4): runs {@link decidePool} over the
 * queued lease requests and the hosts, and does what it answers —
 *
 * - **Queue.** `acquire` queues one request (its deadline is the decision's); a placement resolves it
 *   with the host and a slot reserved until the service has recorded the lease (`done()`); a failure
 *   rejects it with a {@link PoolRefusal} the service words for the agent or the panel.
 * - **Scale up.** One `provision` per new host on the factory that rents the platform; while in
 *   flight it is a `pending` host (its future slots count). A host the factory adds while renting
 *   takes the pending one's place. A failed rental fails the requests it was for, and holds back
 *   rentals ahead of demand for {@link RENTAL_BACKOFF_MS}.
 * - **Scale down.** `destroy()` on idle and drained rented hosts.
 * - **Spend.** Every rented host's $/h accrues into `device-pool.json` per UTC day and month (from
 *   where it was last counted, so a restart loses nothing of a host that came back).
 * - **Learned capacity.** A host the pool rented reports its capacity once ready: recorded per
 *   platform + provider + size, and new hosts are planned with it.
 * - **Drain.** Drained host ids persist; a drained rented host is destroyed once empty.
 * - **Cache warming.** `warmCaches` dispatches the box provider's cache run per OS, tracked as a
 *   `cache-warm` {@link DeviceSetupJob}; a pool host's cache miss warms at most once a day; while the
 *   pool may rent without asking, caches older than {@link CACHE_REFRESH_MS} are refreshed
 *   (the provider evicts caches unused for 7 days).
 *
 * Every change is published as a {@link DevicePoolSummary} (`devices.pool`) when it differs.
 * Ticks run on every host or lease change (`kick`), at each queue deadline, and every
 * {@link POOL_TICK_MS} (spend, idle teardown, warm minimum, cache refresh).
 */

import { randomUUID } from "node:crypto";

import {
  DEVICE_PLATFORM_LABELS,
  DEVICE_PLATFORMS,
  isDevicePlatform,
  type DeviceCapacity,
  type DeviceHostPoolInfo,
  type DevicePlatform,
  type DevicePoolPlatformSummary,
  type DevicePoolSummary,
  type DevicePoolWaiter,
  type DeviceSetupJob,
  type DevicesSettings
} from "@orquester/api";
import type { DevicePoolCacheState, DevicePoolRental } from "@orquester/config";

import { DeviceError, isDeviceError } from "./errors.ts";
import type { DeviceHost, DeviceHostFactory, DeviceHostRegistry, DeviceRentalCaps, DeviceRentalQuote } from "./host.ts";
import {
  decidePool,
  hostCap,
  type PoolDecision,
  type PoolFailureCode,
  type PoolHost,
  type PoolQueued,
  type PoolRentalOffer,
  type PoolRequest
} from "./pool.ts";
import type { DevicePoolStore } from "./store.ts";

/** The periodic tick (spend, idle teardown, warm minimum, cache refresh). */
export const POOL_TICK_MS = 30_000;
/** After a failed rental, no rental ahead of demand for this long. */
export const RENTAL_BACKOFF_MS = 5 * 60_000;
/** Caches older than this are refreshed while the pool rents without asking (evicted after 7 days unused). */
export const CACHE_REFRESH_MS = 6 * 24 * 60 * 60_000;
/** A cache miss warms at most once in this long. */
export const CACHE_MISS_WARM_MS = 24 * 60 * 60_000;
/** A failed automatic warm is retried after this long. */
const CACHE_RETRY_MS = 60 * 60_000;
/** How often a running cache warm's state is read. */
const CACHE_POLL_MS = 20_000;
/** A cache warm still running after this long is given up on. */
const CACHE_POLL_LIMIT_MS = 3 * 60 * 60_000;

/** Which box OS a platform's device hosts run. */
export const DEVICE_CACHE_OS: Readonly<Record<DevicePlatform, "linux" | "macos">> = { android: "linux", ios: "macos" };

/** The box service's device-cache runs (Blacksmith `orquester-device-cache.yml`). */
export interface DeviceCacheWarmer {
  dispatch(request: { os: "linux" | "macos" }): Promise<{ runId: string; htmlUrl: string | null }>;
  status(runId: string): Promise<{ state: "queued" | "running" | "completed" | "gone"; conclusion: string | null; htmlUrl: string | null }>;
}

/** Why a queued request was refused (the service words it). */
export class PoolRefusal extends Error {
  constructor(
    readonly code: PoolFailureCode | "cancelled" | "stopped" | "rental-failed",
    readonly platform: DevicePlatform,
    readonly detail: string | null = null
  ) {
    super(`device pool: ${code}`);
  }
}

export interface PoolAcquireRequest {
  threadId: string;
  platform: DevicePlatform;
  profile: string;
  rentalApproved: boolean;
}

/** A placed request: its host, and the slot held until the lease exists. */
export interface PoolAcquired {
  host: DeviceHost;
  /** The lease was recorded (or the open gave up): the reserved slot is freed. */
  done(): void;
}

export interface DevicePoolDeps {
  store: DevicePoolStore;
  hosts: DeviceHostRegistry;
  factories: readonly DeviceHostFactory[];
  settings(): DevicesSettings;
  /** Live leases on a host. */
  leasesOn(hostId: string): number;
  /** Publish the summary (`devices.pool`). */
  publish(summary: DevicePoolSummary): void;
  /** The box service's cache runs; null while unavailable. */
  cacheWarmer?: () => DeviceCacheWarmer | null;
  now(): number;
  id?(): string;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Run timers (default true; tests call `tick()`). */
  timers?: boolean;
  /** Overrides {@link CACHE_POLL_MS} (tests). */
  cachePollMs?: number;
}

interface Waiter {
  request: PoolRequest;
  resolve(value: PoolAcquired): void;
  reject(error: PoolRefusal): void;
  queued: PoolQueued | null;
  signal: AbortSignal;
  onAbort: () => void;
}

interface PendingRental {
  id: string;
  platform: DevicePlatform;
  startedAt: number;
  offer: PoolRentalOffer;
  /** The host the factory added while renting (it stands in for this placeholder). */
  hostId: string | null;
  /** The requests it was rented for. */
  requestIds: string[];
}

interface CacheRun {
  job: DeviceSetupJob;
  runId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
}

const round = (usd: number): number => Math.round(usd * 1e4) / 1e4;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
const parseMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

export class DevicePool {
  private readonly waiters = new Map<string, Waiter>();
  private readonly reserved = new Map<string, number>();
  private readonly pending = new Map<string, PendingRental>();
  /** Hosts whose `destroy` is in flight. */
  private readonly destroying = new Set<string>();
  /** Since when each host has had no lease (ms). */
  private readonly idleSince = new Map<string, number>();
  /** Hosts present at the last tick (a new box host may be a pending rental's). */
  private readonly seen = new Set<string>();
  private readonly rentalFailedAt = new Map<DevicePlatform, number>();
  private readonly cacheRuns = new Map<DevicePlatform, CacheRun>();
  private readonly cacheAttemptAt = new Map<DevicePlatform, number>();
  private lastDecision: PoolDecision | null = null;
  private lastPublished = "";
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private kicked = false;
  private started = false;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly deps: DevicePoolDeps) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Load `device-pool.json`, forget rentals and drains of hosts that did not come back, tick. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.deps.store.load();
    this.started = true;
    const state = this.deps.store.state();
    const present = new Set(this.deps.hosts.list().map((host) => host.id));
    const rentals = state.rentals.filter((rental) => present.has(rental.hostId));
    const draining = state.drainingHostIds.filter((id) => present.has(id));
    if (rentals.length !== state.rentals.length || draining.length !== state.drainingHostIds.length) {
      state.rentals = rentals;
      state.drainingHostIds = draining;
      void this.deps.store.persist();
    }
    for (const id of present) this.seen.add(id);
    if (this.deps.timers !== false) {
      this.tickTimer = setInterval(() => this.tick(), POOL_TICK_MS);
      this.tickTimer.unref?.();
    }
    this.tick();
  }

  /** Stop: queued requests fail, rentals in flight are aborted, timers end; the record is flushed. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.tickTimer = null;
    this.deadlineTimer = null;
    this.abort.abort();
    for (const run of this.cacheRuns.values()) if (run.timer) clearTimeout(run.timer);
    for (const waiter of [...this.waiters.values()]) this.finish(waiter, new PoolRefusal("stopped", waiter.request.platform));
    if (this.started) {
      this.accrue(this.deps.now());
      await this.deps.store.persist();
    }
  }

  /** Something changed (a host, a lease, the settings): tick once soon. */
  kick(): void {
    if (!this.started || this.stopped || this.kicked) return;
    this.kicked = true;
    queueMicrotask(() => {
      this.kicked = false;
      this.tick();
    });
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * Queue a lease request: resolves once a host has a slot for it (reserved until `done()`), or
   * rejects with a {@link PoolRefusal}.
   */
  acquire(input: PoolAcquireRequest, signal: AbortSignal): Promise<PoolAcquired> {
    if (!this.started || this.stopped) return Promise.reject(new PoolRefusal("stopped", input.platform));
    if (signal.aborted) return Promise.reject(new PoolRefusal("cancelled", input.platform));
    const request: PoolRequest = { id: this.newId(), requestedAt: this.deps.now(), ...input };
    return new Promise<PoolAcquired>((resolve, reject) => {
      const waiter: Waiter = {
        request,
        resolve,
        reject,
        queued: null,
        signal,
        onAbort: () => {
          if (!this.waiters.has(request.id)) return;
          this.finish(waiter, new PoolRefusal("cancelled", request.platform));
          this.kick();
        }
      };
      this.waiters.set(request.id, waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.tick();
    });
  }

  /**
   * What opening a device on `platform` would rent now, for the spend card: the quote (its
   * `needsApproval` is the pool's view, `caps` filled) when this request would need a new host;
   * null when an existing or starting host takes it, or nothing can be rented.
   */
  planRental(platform: DevicePlatform, threadId: string, profile: string): DeviceRentalQuote | null {
    if (!this.started || this.stopped) return null;
    const factory = this.provisioner(platform);
    if (!factory) return null;
    const probe: PoolRequest = { id: "plan", platform, profile, threadId, requestedAt: this.deps.now(), rentalApproved: false };
    const decision = this.decide([...this.requests(), probe]);
    const failure = decision.failures.find((entry) => entry.requestId === probe.id);
    const rented = decision.scaleUp.find((entry) => entry.requestIds.includes(probe.id));
    if (failure?.code !== "approval" && !rented) return null;
    const quote = factory.provisionQuote?.(platform) ?? null;
    if (!quote) return null;
    return { ...quote, needsApproval: failure?.code === "approval", caps: this.caps() };
  }

  // -------------------------------------------------------------------------
  // Drain
  // -------------------------------------------------------------------------

  isDraining(hostId: string): boolean {
    return this.deps.store.state().drainingHostIds.includes(hostId);
  }

  /** No new leases on the host; a rented one is destroyed once its leases end. */
  drain(hostId: string): void {
    const state = this.deps.store.state();
    if (state.drainingHostIds.includes(hostId)) return;
    state.drainingHostIds = [...state.drainingHostIds, hostId];
    void this.deps.store.persist();
    this.kick();
  }

  undrain(hostId: string): void {
    const state = this.deps.store.state();
    if (!state.drainingHostIds.includes(hostId)) return;
    state.drainingHostIds = state.drainingHostIds.filter((id) => id !== hostId);
    void this.deps.store.persist();
    this.kick();
  }

  /** A host's place in the fleet (`DeviceHostSummary.pool`): null for this host while it is not drained. */
  poolInfo(host: DeviceHost): DeviceHostPoolInfo | null {
    const draining = this.isDraining(host.id);
    if (host.kind === "local" && !draining) return null;
    const since = this.idleSince.get(host.id);
    return {
      draining,
      warm: this.lastDecision?.warmHostIds.includes(host.id) ?? false,
      idleSince: since !== undefined && this.deps.leasesOn(host.id) === 0 ? new Date(since).toISOString() : null
    };
  }

  // -------------------------------------------------------------------------
  // Cache warming
  // -------------------------------------------------------------------------

  /**
   * Start (or join) the cache-warm runs: `platform`'s, or every enabled platform's (both when none
   * is). Throws when the box service is unavailable.
   */
  async warmCaches(platform?: DevicePlatform): Promise<DeviceSetupJob[]> {
    const warmer = this.deps.cacheWarmer?.() ?? null;
    if (!warmer) throw new DeviceError("UNAVAILABLE", "Warming device caches needs Ephemeral AI VMs on, with Blacksmith set up.");
    const settings = this.deps.settings();
    let platforms: DevicePlatform[] = platform ? [platform] : DEVICE_PLATFORMS.filter((entry) => (entry === "android" ? settings.android.enabled : settings.ios.enabled));
    if (platforms.length === 0) platforms = [...DEVICE_PLATFORMS];
    const jobs: DeviceSetupJob[] = [];
    for (const entry of platforms) jobs.push(await this.startCacheRun(warmer, entry));
    return jobs.map((job) => structuredClone(job));
  }

  cacheJobs(): DeviceSetupJob[] {
    return [...this.cacheRuns.values()].map((run) => structuredClone(run.job));
  }

  private async startCacheRun(warmer: DeviceCacheWarmer, platform: DevicePlatform, trigger: "owner" | "miss" | "refresh" = "owner"): Promise<DeviceSetupJob> {
    const running = this.cacheRuns.get(platform);
    if (running?.job.state === "running") return running.job;
    const os = DEVICE_CACHE_OS[platform];
    const now = this.deps.now();
    const job: DeviceSetupJob = {
      id: this.newId(),
      kind: "cache-warm",
      url: null,
      platform,
      hostId: "pool",
      state: "running",
      steps: [
        { id: "dispatch", label: `Start the ${DEVICE_PLATFORM_LABELS[platform]} cache run`, state: "running", detail: trigger === "owner" ? null : trigger === "miss" ? "A pool host started without caches." : "Weekly refresh." },
        { id: "run", label: "Build and save the caches", state: "pending", detail: null }
      ],
      percent: null,
      logLine: null,
      error: null,
      startedAt: new Date(now).toISOString(),
      finishedAt: null
    };
    const run: CacheRun = { job, runId: null, timer: null, startedAt: now };
    this.cacheRuns.set(platform, run);
    this.cacheAttemptAt.set(platform, now);
    this.publish();
    try {
      const started = await warmer.dispatch({ os });
      run.runId = started.runId;
      job.url = started.htmlUrl;
      job.steps[0]!.state = "done";
      job.steps[1]!.state = "running";
      const cache = this.cacheState(platform);
      cache.lastWarmAt = new Date(this.deps.now()).toISOString();
      cache.lastRunId = started.runId;
      cache.lastConclusion = null;
      if (trigger === "miss") cache.lastAutoWarmAt = cache.lastWarmAt;
      void this.deps.store.persist();
      this.scheduleCachePoll(warmer, platform, run);
    } catch (error) {
      this.finishCacheRun(run, "failed", `The cache run could not start: ${errorText(error)}`);
    }
    this.publish();
    return job;
  }

  private scheduleCachePoll(warmer: DeviceCacheWarmer, platform: DevicePlatform, run: CacheRun): void {
    if (this.stopped || this.deps.timers === false) return;
    run.timer = setTimeout(() => void this.pollCacheRun(warmer, platform, run), this.deps.cachePollMs ?? CACHE_POLL_MS);
    run.timer.unref?.();
  }

  /** Read a cache run's state once (the timer calls it; tests too). */
  async pollCacheRun(warmer: DeviceCacheWarmer, platform: DevicePlatform, run: CacheRun | undefined = this.cacheRuns.get(platform)): Promise<void> {
    if (!run || run.job.state !== "running" || !run.runId || this.stopped) return;
    try {
      const status = await warmer.status(run.runId);
      if (status.htmlUrl) run.job.url = status.htmlUrl;
      if (status.state === "completed" || status.state === "gone") {
        const ok = status.state === "completed" && status.conclusion === "success";
        this.cacheState(platform).lastConclusion = status.conclusion ?? status.state;
        void this.deps.store.persist();
        this.finishCacheRun(run, ok ? "done" : "failed", ok ? null : status.state === "gone" ? "The cache run is gone." : `The cache run ended: ${status.conclusion ?? "unknown"}.`);
        this.publish();
        return;
      }
      run.job.logLine = status.state === "queued" ? "Waiting for a runner" : "Building the caches";
    } catch (error) {
      run.job.logLine = `Could not read the run: ${errorText(error)}`;
    }
    if (this.deps.now() - run.startedAt > CACHE_POLL_LIMIT_MS) {
      this.finishCacheRun(run, "failed", "The cache run did not finish in 3 hours.");
    } else {
      this.scheduleCachePoll(warmer, platform, run);
    }
    this.publish();
  }

  private finishCacheRun(run: CacheRun, state: "done" | "failed", error: string | null): void {
    run.job.state = state;
    run.job.error = error;
    run.job.percent = state === "done" ? 100 : run.job.percent;
    run.job.finishedAt = new Date(this.deps.now()).toISOString();
    for (const step of run.job.steps) {
      if (step.state === "running") step.state = state === "done" ? "done" : "failed";
      else if (step.state === "pending") step.state = state === "done" ? "done" : "skipped";
    }
  }

  private cacheState(platform: DevicePlatform): DevicePoolCacheState {
    const cache = this.deps.store.state().cache;
    const os = DEVICE_CACHE_OS[platform];
    cache[os] ??= { lastWarmAt: null, lastAutoWarmAt: null, lastRunId: null, lastConclusion: null };
    return cache[os]!;
  }

  /** A cache miss (once a day) and the weekly refresh while the pool rents without asking. */
  private autoWarm(now: number, settings: DevicesSettings): void {
    const warmer = this.deps.cacheWarmer?.() ?? null;
    if (!warmer) return;
    for (const platform of DEVICE_PLATFORMS) {
      if (this.cacheRuns.get(platform)?.job.state === "running") continue;
      const attempted = this.cacheAttemptAt.get(platform);
      if (attempted !== undefined && now - attempted < CACHE_RETRY_MS) continue;
      const cache = this.deps.store.state().cache[DEVICE_CACHE_OS[platform]];
      const missed = this.deps.hosts.list().some((host) => host.kind === "box" && host.platforms.includes(platform) && host.cacheState?.() === "miss");
      const lastAuto = parseMs(cache?.lastAutoWarmAt);
      if (missed && (lastAuto === null || now - lastAuto >= CACHE_MISS_WARM_MS)) {
        void this.startCacheRun(warmer, platform, "miss");
        continue;
      }
      const enabled = platform === "android" ? settings.android.enabled : settings.ios.enabled;
      const rents = enabled && settings.pool.placement !== "local-only" && settings.pool.rentWithoutAsking && this.provisioner(platform) !== null;
      const last = parseMs(cache?.lastWarmAt);
      if (rents && (last === null || now - last >= CACHE_REFRESH_MS)) void this.startCacheRun(warmer, platform, "refresh");
    }
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /** Decide and act once (synchronous; rentals and teardowns run on in the background). */
  tick(): void {
    if (!this.started || this.stopped) return;
    const now = this.deps.now();
    const settings = this.deps.settings();
    this.track(now);
    this.accrue(now);
    this.learn(now);
    const decision = this.decide(this.requests());
    this.lastDecision = decision;
    this.act(decision, now);
    this.autoWarm(now, settings);
    this.scheduleDeadline(decision, now);
    this.publish();
  }

  private requests(): PoolRequest[] {
    return [...this.waiters.values()].map((waiter) => waiter.request);
  }

  private decide(requests: PoolRequest[]): PoolDecision {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const offers: Partial<Record<DevicePlatform, PoolRentalOffer | null>> = {};
    for (const platform of DEVICE_PLATFORMS) offers[platform] = this.offer(platform);
    const state = this.deps.store.state();
    return decidePool({
      settings,
      hosts: this.poolHosts(),
      requests,
      now,
      offers,
      learned: state.learnedCapacity,
      monthSpentUsd: state.spend.months[monthKey(now)] ?? 0
    });
  }

  private offer(platform: DevicePlatform): PoolRentalOffer | null {
    const factory = this.provisioner(platform);
    if (!factory) return null;
    // A factory that cannot quote now cannot rent now (its provider is off or not set up).
    const quote = factory.provisionQuote?.(platform) ?? null;
    if (!quote) return null;
    return { provider: quote.provider, size: quote.size, hourlyUsd: quote.hourlyUsd, lifetimeMinutes: quote.lifetimeMinutes, preApproved: !quote.needsApproval };
  }

  private provisioner(platform: DevicePlatform): DeviceHostFactory | null {
    return this.deps.factories.find((factory) => factory.provision !== undefined && factory.platforms.includes(platform)) ?? null;
  }

  private poolHosts(): PoolHost[] {
    const state = this.deps.store.state();
    const out: PoolHost[] = [];
    const standIns = new Set([...this.pending.values()].flatMap((rental) => (rental.hostId ? [rental.hostId] : [])));
    for (const host of this.deps.hosts.list()) {
      if (this.destroying.has(host.id)) continue;
      const capacity = host.capacity();
      const leases = this.deps.leasesOn(host.id);
      const rental = state.rentals.find((entry) => entry.hostId === host.id);
      const box = host.box?.() ?? null;
      const status = host.state().status;
      const pendingFor = standIns.has(host.id) ? [...this.pending.values()].find((entry) => entry.hostId === host.id) : undefined;
      out.push({
        id: host.id,
        kind: host.kind,
        platforms: host.platforms,
        // A host the factory added while renting is still starting until the rental resolves.
        status: pendingFor && status === "ready" ? "starting" : status,
        used: Math.max(capacity.used, leases) + (this.reserved.get(host.id) ?? 0),
        total: capacity.total,
        draining: state.drainingHostIds.includes(host.id) || host.pool?.()?.draining === true,
        hourlyUsd: host.kind === "box" ? (box?.hourlyUsd ?? rental?.hourlyUsd ?? null) : 0,
        startedAt: parseMs(box?.startedAt) ?? parseMs(rental?.rentedAt) ?? pendingFor?.startedAt ?? null,
        idleSince: this.idleSince.get(host.id) ?? null,
        destroyable: host.kind === "box" && typeof host.destroy === "function",
        provider: rental?.provider ?? pendingFor?.offer.provider ?? box?.provider ?? null,
        size: rental?.size ?? pendingFor?.offer.size ?? null
      });
    }
    for (const rental of this.pending.values()) {
      if (rental.hostId) continue;
      out.push({
        id: rental.id,
        kind: "box",
        platforms: [rental.platform],
        status: "starting",
        used: 0,
        total: 0,
        draining: false,
        hourlyUsd: rental.offer.hourlyUsd,
        startedAt: rental.startedAt,
        idleSince: null,
        destroyable: false,
        provider: rental.offer.provider,
        size: rental.offer.size,
        pending: true
      });
    }
    return out;
  }

  /** Idle clocks, new hosts standing in for rentals, drains of hosts that went. */
  private track(now: number): void {
    const present = new Set<string>();
    for (const host of this.deps.hosts.list()) {
      present.add(host.id);
      if (this.deps.leasesOn(host.id) + (this.reserved.get(host.id) ?? 0) > 0) this.idleSince.delete(host.id);
      else if (!this.idleSince.has(host.id)) this.idleSince.set(host.id, now);
      if (!this.seen.has(host.id)) {
        this.seen.add(host.id);
        // A box host that appears while a rental of its platform is in flight is that rental's.
        const rental = [...this.pending.values()].find((entry) => entry.hostId === null && host.kind === "box" && host.platforms.includes(entry.platform));
        if (rental) rental.hostId = host.id;
      }
    }
    const state = this.deps.store.state();
    let changed = false;
    for (const id of [...this.seen]) {
      if (present.has(id)) continue;
      this.seen.delete(id);
      this.idleSince.delete(id);
      this.destroying.delete(id);
      if (state.drainingHostIds.includes(id)) {
        state.drainingHostIds = state.drainingHostIds.filter((entry) => entry !== id);
        changed = true;
      }
      if (state.rentals.some((rental) => rental.hostId === id)) {
        state.rentals = state.rentals.filter((rental) => rental.hostId !== id);
        changed = true;
      }
      for (const rental of this.pending.values()) if (rental.hostId === id) rental.hostId = null;
    }
    if (changed) void this.deps.store.persist();
  }

  /** Accrue every rented host's $/h since it was last counted (split at UTC day boundaries). */
  private accrue(now: number): void {
    const state = this.deps.store.state();
    let changed = false;
    for (const host of this.deps.hosts.list()) {
      if (host.kind !== "box") continue;
      const box = host.box?.() ?? null;
      let rental = state.rentals.find((entry) => entry.hostId === host.id);
      if (!rental) {
        // A box host the pool did not rent (from before a restart, or rented elsewhere): counted from now.
        rental = {
          hostId: host.id,
          platform: host.platforms[0] ?? "ios",
          provider: box?.provider ?? "unknown",
          size: "unknown",
          hourlyUsd: box?.hourlyUsd ?? null,
          rentedAt: box?.startedAt ?? new Date(now).toISOString(),
          accruedUntil: new Date(now).toISOString(),
          measured: true
        } satisfies DevicePoolRental;
        state.rentals.push(rental);
        changed = true;
        continue;
      }
      const hourly = box?.hourlyUsd ?? rental.hourlyUsd;
      const from = parseMs(rental.accruedUntil) ?? parseMs(rental.rentedAt) ?? now;
      if (hourly === null || hourly <= 0 || now <= from) {
        if (rental.accruedUntil === null) {
          rental.accruedUntil = new Date(now).toISOString();
          changed = true;
        }
        continue;
      }
      let at = from;
      while (at < now) {
        const nextDay = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate() + 1);
        const end = Math.min(now, nextDay);
        const usd = (hourly * (end - at)) / 3_600_000;
        const day = dayKey(at);
        const month = monthKey(at);
        state.spend.days[day] = round((state.spend.days[day] ?? 0) + usd);
        state.spend.months[month] = round((state.spend.months[month] ?? 0) + usd);
        at = end;
      }
      rental.accruedUntil = new Date(now).toISOString();
      changed = true;
    }
    if (changed) {
      // Keep about a year of days.
      const days = Object.keys(state.spend.days).sort();
      for (const day of days.slice(0, Math.max(0, days.length - 400))) delete state.spend.days[day];
      void this.deps.store.persist();
    }
  }

  /** A ready host the pool rented reports its capacity once: recorded for its provider + size. */
  private learn(now: number): void {
    const state = this.deps.store.state();
    let changed = false;
    for (const rental of state.rentals) {
      if (rental.measured || !isDevicePlatform(rental.platform)) continue;
      const host = this.deps.hosts.get(rental.hostId);
      if (!host || host.state().status !== "ready") continue;
      const total = host.capacity().total;
      if (total <= 0) continue;
      const capacity = hostCap(rental.platform, total);
      const existing = state.learnedCapacity.find((entry) => entry.platform === rental.platform && entry.provider === rental.provider && entry.size === rental.size);
      if (existing) {
        existing.capacity = capacity;
        existing.measuredAt = new Date(now).toISOString();
        existing.samples += 1;
      } else {
        state.learnedCapacity.push({ platform: rental.platform, provider: rental.provider, size: rental.size, capacity, measuredAt: new Date(now).toISOString(), samples: 1 });
      }
      rental.measured = true;
      changed = true;
    }
    if (changed) void this.deps.store.persist();
  }

  private act(decision: PoolDecision, now: number): void {
    for (const placement of decision.placements) {
      const waiter = this.waiters.get(placement.requestId);
      const host = this.deps.hosts.get(placement.hostId);
      if (!waiter || !host) continue;
      this.reserved.set(host.id, (this.reserved.get(host.id) ?? 0) + 1);
      this.idleSince.delete(host.id);
      let held = true;
      this.finish(waiter, null);
      waiter.resolve({
        host,
        done: () => {
          if (!held) return;
          held = false;
          const left = (this.reserved.get(host.id) ?? 1) - 1;
          if (left > 0) this.reserved.set(host.id, left);
          else this.reserved.delete(host.id);
          this.kick();
        }
      });
    }
    for (const failure of decision.failures) {
      const waiter = this.waiters.get(failure.requestId);
      if (waiter) this.finish(waiter, new PoolRefusal(failure.code, waiter.request.platform));
    }
    for (const queued of decision.queue) {
      const waiter = this.waiters.get(queued.requestId);
      if (waiter) waiter.queued = queued;
    }
    for (const up of decision.scaleUp) {
      // Right after a failed rental, nothing is rented ahead of demand.
      const failed = this.rentalFailedAt.get(up.platform);
      if (up.reason !== "demand" && failed !== undefined && now - failed < RENTAL_BACKOFF_MS) continue;
      const per = Math.max(1, decision.perHostCapacity[up.platform]);
      for (let index = 0; index < up.count; index += 1) {
        this.rent(up.platform, up.approvedBy === "request" ? up.requestIds : up.requestIds.slice(index * per, (index + 1) * per), now);
      }
    }
    for (const down of decision.scaleDown) this.teardown(down.hostId, down.reason);
  }

  private rent(platform: DevicePlatform, requestIds: string[], now: number): void {
    const factory = this.provisioner(platform);
    const offer = this.offer(platform);
    if (!factory?.provision || !offer) return;
    const rental: PendingRental = { id: `pending:${this.newId()}`, platform, startedAt: now, offer, hostId: null, requestIds };
    this.pending.set(rental.id, rental);
    const threadId = requestIds.map((id) => this.waiters.get(id)?.request.threadId).find((id) => id !== undefined) ?? "";
    this.deps.logger.info(`[devices] renting a ${DEVICE_PLATFORM_LABELS[platform]} pool host (${offer.provider} ${offer.size})`);
    factory
      .provision({ platform, approved: true, threadId }, this.abort.signal)
      .then((host) => {
        const state = this.deps.store.state();
        if (!state.rentals.some((entry) => entry.hostId === host.id)) {
          state.rentals = state.rentals.filter((entry) => entry.hostId !== host.id);
          state.rentals.push({
            hostId: host.id,
            platform,
            provider: offer.provider,
            size: offer.size,
            hourlyUsd: offer.hourlyUsd,
            rentedAt: new Date(rental.startedAt).toISOString(),
            accruedUntil: new Date(this.deps.now()).toISOString(),
            measured: false
          });
        } else {
          // The accrual adopted it before the rental resolved: it is the pool's.
          const adopted = state.rentals.find((entry) => entry.hostId === host.id)!;
          Object.assign(adopted, { platform, provider: offer.provider, size: offer.size, hourlyUsd: adopted.hourlyUsd ?? offer.hourlyUsd, measured: false });
        }
        this.seen.add(host.id);
        void this.deps.store.persist();
      })
      .catch((error) => {
        if (this.stopped) return;
        this.rentalFailedAt.set(platform, this.deps.now());
        const detail = isDeviceError(error) ? error.message : errorText(error);
        this.deps.logger.warn(`[devices] renting a ${DEVICE_PLATFORM_LABELS[platform]} pool host failed`, detail);
        for (const id of requestIds) {
          const waiter = this.waiters.get(id);
          if (waiter) this.finish(waiter, new PoolRefusal("rental-failed", platform, detail));
        }
      })
      .finally(() => {
        this.pending.delete(rental.id);
        this.kick();
      });
  }

  private teardown(hostId: string, reason: "idle" | "drained"): void {
    const host = this.deps.hosts.get(hostId);
    if (!host?.destroy || this.destroying.has(hostId)) return;
    this.destroying.add(hostId);
    this.deps.logger.info(`[devices] destroying ${host.label}: ${reason === "idle" ? "idle" : "drained"}`);
    host
      .destroy()
      .catch((error) => {
        this.destroying.delete(hostId);
        this.deps.logger.warn(`[devices] destroying ${host.label} failed`, errorText(error));
      })
      .finally(() => this.kick());
  }

  private scheduleDeadline(decision: PoolDecision, now: number): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (this.deps.timers === false) return;
    const next = Math.min(...decision.queue.map((entry) => entry.deadlineAt));
    if (!Number.isFinite(next)) return;
    this.deadlineTimer = setTimeout(() => this.tick(), Math.max(10, next - now + 10));
    this.deadlineTimer.unref?.();
  }

  /** Take a waiter off the queue; reject it with `refusal` when given. */
  private finish(waiter: Waiter, refusal: PoolRefusal | null): void {
    this.waiters.delete(waiter.request.id);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (refusal) waiter.reject(refusal);
  }

  // -------------------------------------------------------------------------
  // The summary
  // -------------------------------------------------------------------------

  private caps(): DeviceRentalCaps {
    const settings = this.deps.settings();
    const hosts = this.poolHosts().filter((host) => host.kind === "box");
    return {
      hosts: hosts.length,
      maxHosts: settings.pool.maxHosts,
      hourlyUsd: round(hosts.reduce((sum, host) => sum + (host.hourlyUsd ?? 0), 0)),
      maxHourlyUsd: settings.pool.maxHourlyUsd,
      monthSpentUsd: round(this.deps.store.state().spend.months[monthKey(this.deps.now())] ?? 0),
      monthlyCapUsd: settings.pool.monthlyCapUsd
    };
  }

  summary(): DevicePoolSummary {
    const now = this.deps.now();
    const settings = this.deps.settings();
    const state = this.deps.store.state();
    const hosts = this.poolHosts();
    const rented = hosts.filter((host) => host.kind === "box");
    const readyPool = rented.filter((host) => host.status === "ready" && !host.pending);
    const capacityOf = (list: PoolHost[], platform?: DevicePlatform): DeviceCapacity =>
      list.reduce(
        (sum, host) => {
          const used = Math.max(0, host.used - (this.reserved.get(host.id) ?? 0));
          const total = host.draining ? used : platform ? hostCap(platform, host.total) : host.platforms.includes("android") ? hostCap("android", host.total) : host.total;
          return { used: sum.used + used, total: sum.total + total };
        },
        { used: 0, total: 0 }
      );
    const capacity = capacityOf(readyPool);
    const waiting: DevicePoolWaiter[] = [...this.waiters.values()]
      .sort((a, b) => a.request.requestedAt - b.request.requestedAt)
      .map((waiter) => ({
        id: waiter.request.id,
        threadId: waiter.request.threadId,
        platform: waiter.request.platform,
        profile: waiter.request.profile,
        requestedAt: new Date(waiter.request.requestedAt).toISOString(),
        deadlineAt: new Date(waiter.queued?.deadlineAt ?? waiter.request.requestedAt + settings.pool.capacityWaitSeconds * 1000).toISOString(),
        reason: waiter.queued?.reason ?? "capacity",
        hostId: waiter.queued?.hostId ?? null,
        etaSeconds: waiter.queued?.etaSeconds ?? null
      }));
    const platforms: DevicePoolPlatformSummary[] = DEVICE_PLATFORMS.map((platform) => {
      const mine = rented.filter((host) => host.platforms.includes(platform));
      const local = hosts.find((host) => host.kind === "local" && host.platforms.includes(platform));
      return {
        platform,
        hosts: mine.length,
        starting: mine.filter((host) => host.pending || host.status === "starting" || host.status === "installing").length,
        capacity: capacityOf(mine.filter((host) => host.status === "ready" && !host.pending), platform),
        local: local ? { used: Math.max(0, local.used - (this.reserved.get(local.id) ?? 0)), total: hostCap(platform, local.total) } : null,
        queue: waiting.filter((entry) => entry.platform === platform).length,
        minWarmHosts: settings.pool.minWarmHosts[platform],
        perHostCapacity: this.lastDecision?.perHostCapacity[platform] ?? 0
      };
    });
    const cacheWarmedAt: Partial<Record<DevicePlatform, string | null>> = {};
    for (const platform of DEVICE_PLATFORMS) cacheWarmedAt[platform] = state.cache[DEVICE_CACHE_OS[platform]]?.lastWarmAt ?? null;
    return {
      hosts: rented.length,
      capacity,
      hourlyUsd: round(rented.reduce((sum, host) => sum + (host.hourlyUsd ?? 0), 0)),
      queue: waiting.length,
      utilization: capacity.total > 0 ? Math.min(1, capacity.used / capacity.total) : 0,
      hostIds: rented.filter((host) => !host.pending).map((host) => host.id),
      drainingHostIds: [...state.drainingHostIds],
      platforms,
      spend: {
        day: dayKey(now),
        todayUsd: round(state.spend.days[dayKey(now)] ?? 0),
        month: monthKey(now),
        monthUsd: round(state.spend.months[monthKey(now)] ?? 0),
        monthlyCapUsd: settings.pool.monthlyCapUsd,
        maxHourlyUsd: settings.pool.maxHourlyUsd
      },
      waiting,
      learnedCapacity: state.learnedCapacity.flatMap((entry) =>
        isDevicePlatform(entry.platform) ? [{ platform: entry.platform, provider: entry.provider, size: entry.size, capacity: entry.capacity, measuredAt: entry.measuredAt }] : []
      ),
      cacheJobs: this.cacheJobs(),
      cacheWarmedAt,
      updatedAt: new Date(now).toISOString()
    };
  }

  /** Publish the summary when it changed (its clock aside). */
  publish(): void {
    if (!this.started || this.stopped) return;
    const summary = this.summary();
    const { updatedAt: _updatedAt, ...rest } = summary;
    const key = JSON.stringify(rest);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.deps.publish(summary);
  }

  private newId(): string {
    return this.deps.id?.() ?? randomUUID();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
