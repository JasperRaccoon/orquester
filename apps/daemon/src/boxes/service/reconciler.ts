/**
 * The reconciler (spec §9.2–9.5): compares what each connected provider reports with the box
 * records, at start, every 5 minutes, after a provider error, whenever a box drops, at the next
 * box deadline, and 60 s after a drop.
 *
 * - An instance carrying Orquester's marker with no live record (none, or `destroyed`) is
 *   destroyed once this process has seen it for {@link ORPHAN_GRACE_MS}, logged and broadcast.
 *   Only instances whose box id has this build's id format count: anything else (another tool's
 *   `orq-…` name, a record this build cannot parse) is left alone.
 * - A live record whose instance is gone becomes `destroyed` (`time-limit` past its deadline, else
 *   `provider-gone`); one the provider reports failed is destroyed (`provider-error`).
 * - A `provisioning` record nobody in this process is setting up (a restart interrupted it) is
 *   resumed when it is a project box with an instance, else torn down; `destroying` records resume
 *   their destroy.
 * - A `ready` box disconnected for {@link UNREACHABLE_AFTER_MS} while its instance runs becomes
 *   `unreachable`; it is `ready` again as soon as it reconnects.
 * - A box past its `deadlineAt` (temporary boxes, macOS jobs) is destroyed (`time-limit`).
 *
 * {@link decideReconcile} is the pure decision; {@link BoxReconciler} gathers its inputs and acts.
 */

import type { BoxDestroyedReason, BoxProviderId } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type {
  BoxHub,
  BoxProviderRegistry,
  ProviderInstanceRef,
  ProviderInstanceStatus,
  ProviderManagedInstance
} from "../contracts.ts";
import { errorLine } from "./errors.ts";
import { PENDING_DESTROY_REASON, type BoxClock, type BoxConnectivity, type BoxLifecycle } from "./lifecycle.ts";
import type { BoxStore } from "./store.ts";
import { isDestroyedReason } from "./summary.ts";

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const ORPHAN_GRACE_MS = 10 * 60_000;
export const UNREACHABLE_AFTER_MS = 60_000;
const LIST_TIMEOUT_MS = 60_000;

/** The box ids `newBoxId` makes; only instances carrying one are ever treated as orphans. */
const BOX_ID_PATTERN = /^[0-9a-f]{12}$/;

export type ReconcileAction =
  | { kind: "destroy-orphan"; provider: BoxProviderId; instance: ProviderManagedInstance }
  /** `ref`: the instance found for a record that had none yet (attached before the destroy). */
  | { kind: "destroy"; boxId: string; reason: BoxDestroyedReason; message: string | null; ref?: ProviderInstanceRef }
  | { kind: "mark-gone"; boxId: string; reason: BoxDestroyedReason; message: string | null }
  | { kind: "resume"; boxId: string; ref?: ProviderInstanceRef }
  | { kind: "mark-unreachable"; boxId: string };

export interface ReconcileInput {
  now: number;
  records: readonly StoredBox[];
  /** Every record id in boxes.json, parsed or not. */
  knownIds: ReadonlySet<string>;
  /** Per connected provider: its managed instances, or null when listing failed. Absent = not connected. */
  listings: ReadonlyMap<string, ProviderManagedInstance[] | null>;
  /** Live statuses fetched for records the listing did not show (see {@link statusTargets}). */
  statuses: ReadonlyMap<string, ProviderInstanceStatus>;
  connected(boxId: string): boolean;
  /** Since when the box has been disconnected, or null when it is connected. */
  disconnectedSince(boxId: string): number | null;
  /** Setup or a destroy is running for the box in this process. */
  busy(boxId: string): boolean;
  /** When this process first saw each orphan candidate ({@link orphanKey}). */
  firstSeen: ReadonlyMap<string, number>;
}

export interface ReconcileDecision {
  actions: ReconcileAction[];
  /** The orphan candidates seen now, with their first-seen times (replaces the input's). */
  firstSeen: Map<string, number>;
}

export function orphanKey(provider: string, instance: ProviderManagedInstance): string {
  return `${provider}\u0000${instance.name}\u0000${JSON.stringify(instance.ref)}`;
}

/** The box id an instance carries (its tag, else its `orq-<id>` name). */
export function instanceBoxId(instance: ProviderManagedInstance): string | null {
  if (instance.boxId) return instance.boxId;
  return /^orq-([0-9a-f]{12})$/.exec(instance.name)?.[1] ?? null;
}

function matchInstance(record: StoredBox, instances: readonly ProviderManagedInstance[]): ProviderManagedInstance | undefined {
  return instances.find((instance) => instance.state !== "gone" && (instanceBoxId(instance) === record.id || instance.name === record.name));
}

const LIVE_STATES = new Set(["provisioning", "ready", "unreachable", "destroy-failed"]);

/** The records whose live status must be fetched: live, with an instance ref, missing from a listing that worked. */
export function statusTargets(input: Omit<ReconcileInput, "statuses" | "firstSeen">): StoredBox[] {
  return input.records.filter((record) => {
    if (!LIVE_STATES.has(record.state) || !record.providerRef || input.busy(record.id)) return false;
    const instances = input.listings.get(record.provider);
    return Array.isArray(instances) && matchInstance(record, instances) === undefined;
  });
}

function deadlinePassed(record: StoredBox, now: number): boolean {
  const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : Number.NaN;
  return Number.isFinite(deadline) && deadline <= now;
}

export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  const actions: ReconcileAction[] = [];
  const { now } = input;
  /** Records that still own their instance (not orphans). */
  const owned = new Set<string>();

  for (const record of input.records) {
    const instances = input.listings.get(record.provider);
    if (record.state !== "destroyed") owned.add(record.id);
    if (input.busy(record.id) || !Array.isArray(instances)) continue;
    const instance = matchInstance(record, instances);
    const status = input.statuses.get(record.id) ?? null;
    const gone = record.providerRef !== undefined && instance === undefined && status?.state === "gone";
    const pendingReason = isDestroyedReason(record[PENDING_DESTROY_REASON]) ? record[PENDING_DESTROY_REASON] : "deleted";

    switch (record.state) {
      case "destroying":
        actions.push({ kind: "destroy", boxId: record.id, reason: pendingReason, message: null });
        break;
      case "destroy-failed":
        if (gone) actions.push({ kind: "mark-gone", boxId: record.id, reason: pendingReason, message: null });
        break;
      case "provisioning": {
        if (gone) {
          actions.push({ kind: "mark-gone", boxId: record.id, reason: "provisioning-failed", message: "The machine disappeared during setup." });
        } else if (!record.providerRef && instance === undefined) {
          actions.push({
            kind: "mark-gone",
            boxId: record.id,
            reason: "provisioning-failed",
            message: "Setup was interrupted before the provider created the machine."
          });
        } else if (record.purpose === "temporary") {
          // Nobody waits for it any more: the call that asked for it ended with the restart.
          actions.push({
            kind: "destroy",
            boxId: record.id,
            reason: "provisioning-failed",
            message: "Setup was interrupted by a restart.",
            ...(!record.providerRef && instance ? { ref: instance.ref } : {})
          });
        } else {
          actions.push(!record.providerRef && instance ? { kind: "resume", boxId: record.id, ref: instance.ref } : { kind: "resume", boxId: record.id });
        }
        break;
      }
      case "ready":
      case "unreachable": {
        if (deadlinePassed(record, now)) {
          actions.push({ kind: "destroy", boxId: record.id, reason: "time-limit", message: null });
          break;
        }
        const state = instance?.state ?? status?.state ?? null;
        if (state === "gone") {
          actions.push({ kind: "mark-gone", boxId: record.id, reason: "provider-gone", message: status?.detail ?? null });
        } else if (state === "error") {
          actions.push({ kind: "destroy", boxId: record.id, reason: "provider-error", message: status?.detail ?? null });
        } else if (state === "running" && record.state === "ready" && !input.connected(record.id)) {
          const since = input.disconnectedSince(record.id);
          if (since !== null && now - since >= UNREACHABLE_AFTER_MS) actions.push({ kind: "mark-unreachable", boxId: record.id });
        }
        break;
      }
      default:
        break;
    }
  }

  const firstSeen = new Map<string, number>();
  for (const [provider, instances] of input.listings) {
    if (!Array.isArray(instances)) continue;
    for (const instance of instances) {
      if (instance.state === "gone") continue;
      const boxId = instanceBoxId(instance);
      if (boxId === null || !BOX_ID_PATTERN.test(boxId)) continue;
      if (owned.has(boxId) || input.busy(boxId)) continue;
      // A record this build cannot parse is another version's box, not an orphan.
      if (input.knownIds.has(boxId) && !input.records.some((record) => record.id === boxId)) continue;
      const key = orphanKey(provider, instance);
      const since = input.firstSeen.get(key) ?? now;
      firstSeen.set(key, since);
      if (now - since >= ORPHAN_GRACE_MS) {
        actions.push({ kind: "destroy-orphan", provider: provider as BoxProviderId, instance });
      }
    }
  }
  return { actions, firstSeen };
}

export interface BoxReconcilerDeps {
  store: BoxStore;
  providers: BoxProviderRegistry;
  hub: BoxHub;
  lifecycle: BoxLifecycle;
  connectivity: BoxConnectivity;
  clock: BoxClock;
  fetch?: typeof fetch;
  logger: Pick<Console, "warn" | "error" | "log">;
  /** An orphan was destroyed: tell the clients. */
  publishChanged(): void;
}

export class BoxReconciler {
  private firstSeen = new Map<string, number>();
  private readonly disconnected = new Map<string, number>();
  private readonly unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private active = false;
  /** Boxes never seen connected by this process count as disconnected since it started. */
  private startedAt: number;

  constructor(private readonly deps: BoxReconcilerDeps) {
    this.startedAt = deps.clock.now();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Arm the timers and run once now. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = this.deps.clock.now();
    this.interval = setInterval(() => void this.requestRun(), RECONCILE_INTERVAL_MS);
    this.interval.unref?.();
    void this.requestRun();
  }

  stop(): void {
    this.active = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    for (const timer of this.unreachableTimers.values()) clearTimeout(timer);
    this.unreachableTimers.clear();
  }

  /** Run soon (coalesced with a run in progress). No-op while stopped. */
  requestRun(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce().catch((error) => this.deps.logger.error("Box reconcile failed", errorLine(error)));
        } while (this.again && this.active);
      } finally {
        this.running = null;
        this.armDeadline();
      }
    })();
    return this.running;
  }

  /** The hub saw a box connect or drop. */
  connectionChanged(boxId: string, connected: boolean): void {
    const timer = this.unreachableTimers.get(boxId);
    if (timer) clearTimeout(timer);
    this.unreachableTimers.delete(boxId);
    if (connected) {
      this.disconnected.delete(boxId);
      return;
    }
    this.disconnected.set(boxId, this.deps.clock.now());
    if (!this.active) return;
    // Is it gone? Ask now; and once the unreachable window has passed, ask again.
    void this.requestRun();
    const later = setTimeout(() => {
      this.unreachableTimers.delete(boxId);
      void this.requestRun();
    }, UNREACHABLE_AFTER_MS + 1_000);
    later.unref?.();
    this.unreachableTimers.set(boxId, later);
  }

  /** Re-arm the deadline timer for the nearest future deadline (call after records change). */
  armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (!this.active) return;
    const now = this.deps.clock.now();
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.deps.store.list()) {
      if (record.state === "destroyed" || !record.deadlineAt) continue;
      const at = Date.parse(record.deadlineAt);
      if (Number.isFinite(at) && at > now && at < next) next = at;
    }
    if (!Number.isFinite(next)) return;
    // setTimeout caps at ~24.8 days; a later deadline is re-armed by the periodic run.
    this.deadlineTimer = setTimeout(() => void this.requestRun(), Math.min(next - now + 500, 2 ** 31 - 1));
    this.deadlineTimer.unref?.();
  }

  /** One full pass: list, decide, act. Public for tests and for the routes' "check now". */
  async runOnce(): Promise<ReconcileAction[]> {
    const { store, providers, lifecycle, connectivity } = this.deps;
    const listings = new Map<string, ProviderManagedInstance[] | null>();
    const credentials = new Map<string, Record<string, string>>();
    for (const adapter of providers.values()) {
      const creds = await connectivity.credentials(adapter.id).catch(() => null);
      if (!creds) continue;
      credentials.set(adapter.id, creds);
      try {
        listings.set(adapter.id, await adapter.listManaged(creds, this.callOptions(LIST_TIMEOUT_MS)));
      } catch (error) {
        this.deps.logger.warn(`Box reconcile: listing ${adapter.label} failed`, errorLine(error));
        listings.set(adapter.id, null);
      }
    }
    const base = {
      now: this.deps.clock.now(),
      records: store.list(),
      knownIds: store.ids(),
      listings,
      connected: (boxId: string) => this.deps.hub.get(boxId)?.connected === true,
      disconnectedSince: (boxId: string) =>
        this.deps.hub.get(boxId)?.connected === true ? null : (this.disconnected.get(boxId) ?? this.startedAt),
      busy: (boxId: string) => lifecycle.busy(boxId)
    };
    const statuses = new Map<string, ProviderInstanceStatus>();
    for (const record of statusTargets(base)) {
      const adapter = providers.get(record.provider as BoxProviderId);
      const creds = credentials.get(record.provider);
      if (!adapter || !creds || !record.providerRef) continue;
      try {
        statuses.set(record.id, await adapter.status(creds, record.providerRef, this.callOptions(LIST_TIMEOUT_MS)));
      } catch (error) {
        this.deps.logger.warn(`Box reconcile: status of box ${record.id} failed`, errorLine(error));
      }
    }
    // The records may have moved on while the provider calls ran.
    const decision = decideReconcile({ ...base, records: store.list(), knownIds: store.ids(), statuses, firstSeen: this.firstSeen });
    this.firstSeen = decision.firstSeen;
    for (const action of decision.actions) {
      await this.act(action, credentials).catch((error) => this.deps.logger.error(`Box reconcile: ${action.kind} failed`, errorLine(error)));
    }
    return decision.actions;
  }

  private async act(action: ReconcileAction, credentials: ReadonlyMap<string, Record<string, string>>): Promise<void> {
    const { lifecycle } = this.deps;
    switch (action.kind) {
      case "destroy": {
        const ref = action.ref;
        if (ref) await this.deps.store.update(action.boxId, (record) => void (record.providerRef ??= ref));
        // Not awaited: a destroy waits for the provider's confirmation; the lifecycle tracks it.
        void lifecycle.destroy(action.boxId, action.reason, action.message).catch(() => undefined);
        return;
      }
      case "mark-gone":
        await lifecycle.markGone(action.boxId, action.reason, action.message);
        return;
      case "resume":
        await lifecycle.resume(action.boxId, action.ref);
        return;
      case "mark-unreachable":
        await lifecycle.markUnreachable(action.boxId);
        return;
      case "destroy-orphan": {
        const adapter = this.deps.providers.get(action.provider);
        const creds = credentials.get(action.provider);
        if (!adapter || !creds) return;
        this.deps.logger.warn(
          `Box reconcile: destroying ${action.instance.name} at ${adapter.label}: Orquester has no live record of it (seen for over ${ORPHAN_GRACE_MS / 60_000} min).`
        );
        await adapter.destroy(creds, action.instance.ref, this.callOptions(LIST_TIMEOUT_MS * 2));
        this.firstSeen.delete(orphanKey(action.provider, action.instance));
        this.deps.publishChanged();
        return;
      }
    }
  }

  private callOptions(timeoutMs: number) {
    return { signal: AbortSignal.timeout(timeoutMs), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) };
  }
}
