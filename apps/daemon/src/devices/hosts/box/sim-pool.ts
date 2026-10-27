/**
 * The pre-slimmed simulator pool of one Mac device host (devices phase 2 §2 goal 7): up to `size`
 * shut-down, slimmed, booted-once simulators per profile, so a lease's boot starts from one (a
 * renamed `orq-pool-*` simulator boots in a fraction of a fresh one's time: its first-boot data
 * migration and the slimming are done).
 *
 * Refills run in the background, one simulator at a time, holding the host's boot slot (never
 * beside another boot): a refill starts only while no lease boot is running or queued, and a lease
 * boot preempts one in progress ({@link SimPool.preempt}: aborted, its simulator deleted by `make`).
 * A profile whose refill fails {@link MAX_REFILL_FAILURES} times in a row is left alone until
 * {@link SimPool.reset} (the next prepare).
 *
 * Pool simulators are not primed with agent-device: on the integration Mac the first `open` +
 * `snapshot -i` took 5.5 s on an unprimed slim simulator and 5.4 s on a primed one (the XCTest
 * runner is built once per host, not per simulator), so priming would only cost refill time.
 *
 * Names (`simctl.ts`): `orq-poolprep-<id>` while being made, `orq-pool-<profileId>.<id>` when
 * ready, so a daemon restart adopts ready ones ({@link SimPool.adopt}) and deletes half-made ones.
 */

import { POOL_SIM_PREFIX } from "./simctl.ts";

export interface PoolSim {
  udid: string;
  profileId: string;
  runtimeId: string;
}

export interface SimPoolOps {
  /** Make one ready pool simulator of the profile; on failure or abort it deletes what it made. */
  make(profileId: string, signal: AbortSignal): Promise<PoolSim>;
}

export interface SimPoolDeps {
  ops: SimPoolOps;
  /** Ready simulators kept per profile. */
  size: number;
  /** The profiles to keep stocked now. */
  targets(): readonly string[];
  /** Whether a refill may start now: the host is ready and no lease boot runs or waits. */
  idle(): boolean;
  /** Run `work` holding the host's boot slot (rejects when `signal` aborts while waiting). */
  exclusive(signal: AbortSignal, work: () => Promise<void>): Promise<void>;
  logger: Pick<Console, "warn">;
}

export const MAX_REFILL_FAILURES = 2;

/** `orq-pool-<profileId>.<id>`. */
export function poolSimulatorName(profileId: string, id: string): string {
  return `${POOL_SIM_PREFIX}${profileId}.${id}`;
}

/** The profile of a ready pool simulator's name, or null. */
export function profileOfPoolSimulator(name: string): string | null {
  if (!name.startsWith(POOL_SIM_PREFIX)) return null;
  const rest = name.slice(POOL_SIM_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  return dot > 0 ? rest.slice(0, dot) : null;
}

export class SimPool {
  private readonly ready = new Map<string, PoolSim[]>();
  private readonly failures = new Map<string, number>();
  private running: Promise<void> | null = null;
  private refilling: AbortController | null = null;
  private stopped = false;

  constructor(private readonly deps: SimPoolDeps) {}

  /** Ready simulators per profile. */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.ready].map(([profile, sims]) => [profile, sims.length]));
  }

  /** Whether a refill is running now. */
  get busy(): boolean {
    return this.refilling !== null;
  }

  /** Simulators found ready in the box (after a restart). */
  adopt(sims: readonly PoolSim[]): void {
    for (const sim of sims) {
      const list = this.ready.get(sim.profileId) ?? [];
      if (!list.some((entry) => entry.udid === sim.udid)) list.push(sim);
      this.ready.set(sim.profileId, list);
    }
  }

  /** A ready simulator of the profile on the runtime, now the caller's; null when none. */
  take(profileId: string, runtimeId: string): PoolSim | null {
    const list = this.ready.get(profileId) ?? [];
    const at = list.findIndex((sim) => sim.runtimeId === runtimeId);
    if (at < 0) return null;
    const [sim] = list.splice(at, 1);
    return sim ?? null;
  }

  /** Ready simulators the pool no longer wants (a runtime that is not the newest any more, a profile turned off). */
  surplus(keep: (sim: PoolSim) => boolean): PoolSim[] {
    const out: PoolSim[] = [];
    for (const [profile, list] of this.ready) {
      const kept = list.filter((sim) => keep(sim));
      out.push(...list.filter((sim) => !kept.includes(sim)));
      this.ready.set(profile, kept);
    }
    return out;
  }

  /** A lease boot is coming: abort a refill in progress so the boot slot frees now. */
  preempt(): void {
    this.refilling?.abort(new Error("preempted by a lease boot"));
  }

  /** Forget refill failures (the host was prepared again). */
  reset(): void {
    this.failures.clear();
    this.stopped = false;
  }

  /** Refill in the background if something is missing and the host is idle. */
  kick(): void {
    if (this.running || this.stopped) return;
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once the refill loop in progress ends (tests, the integration run). */
  async settled(): Promise<void> {
    await this.running;
  }

  /** Stop refilling (dispose, helpers stopped); ready simulators stay in the box for the next prepare. */
  stop(): void {
    this.stopped = true;
    this.preempt();
  }

  /** The profile to refill next: the first target below size that has not failed too often. */
  next(): string | null {
    for (const profile of this.deps.targets()) {
      if ((this.failures.get(profile) ?? 0) >= MAX_REFILL_FAILURES) continue;
      if ((this.ready.get(profile)?.length ?? 0) < this.deps.size) return profile;
    }
    return null;
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.stopped || !this.deps.idle()) return;
      const profile = this.next();
      if (!profile) return;
      const controller = new AbortController();
      this.refilling = controller;
      try {
        await this.deps.exclusive(controller.signal, async () => {
          // A lease boot may have queued while this waited for the slot.
          controller.signal.throwIfAborted();
          // Made (even if a preempt came just too late): it is ready either way.
          this.adopt([await this.deps.ops.make(profile, controller.signal)]);
          this.failures.delete(profile);
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failures = (this.failures.get(profile) ?? 0) + 1;
        this.failures.set(profile, failures);
        this.deps.logger.warn(`[devices] making a pool simulator of ${profile} failed (${failures}/${MAX_REFILL_FAILURES})`, error instanceof Error ? error.message : String(error));
      } finally {
        if (this.refilling === controller) this.refilling = null;
      }
    }
  }
}
