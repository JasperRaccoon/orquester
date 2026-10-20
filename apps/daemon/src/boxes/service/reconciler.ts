/**
 * The reconciler (spec §9.2–9.5): compares what each connected provider reports with the box
 * records, at start, every 5 minutes, after a provider error, whenever a box drops, at the next
 * box deadline or retry, and 60 s after a drop. It runs while the plugin is on, and while it is off
 * as long as any record is not `destroyed` (deadlines and retries still hold; setup is not resumed).
 *
 * - An instance carrying Orquester's marker with no live record (none, or `destroyed`) is
 *   destroyed once this process has seen it for {@link ORPHAN_GRACE_MS}, logged and broadcast.
 *   Only this installation's instances count: those whose name carries its installation id
 *   (`orq-<installationId>-<boxId>`), and older ones without an installation id whose box id has a
 *   record here. Anything else (another appdir's box on the same provider account, another tool's
 *   `orq-…` name, a record this build cannot parse) is left alone. While the store's orphan sweep
 *   is paused (a corrupt boxes.json was moved aside), instances with no record at all are kept.
 * - A live record whose instance is gone becomes `destroyed` (`provider-gone`); one the provider
 *   has reported failed for {@link PROVIDER_ERROR_GRACE_MS} while `orq-agent` is not connected is
 *   destroyed (`provider-error`). A transient error reading never destroys a box.
 * - A `provisioning` record nobody in this process is setting up (a restart interrupted it) is
 *   resumed when it is a project box with an instance, else torn down; `destroying` records resume
 *   their destroy; `destroy-failed` records are retried with a backoff ({@link DESTROY_RETRY_MS}).
 * - A `ready` box disconnected for {@link UNREACHABLE_AFTER_MS} while its instance runs becomes
 *   `unreachable`; it is `ready` again as soon as it reconnects.
 * - A box past its `deadlineAt` (temporary boxes, macOS jobs) is destroyed (`time-limit`), whether
 *   or not its provider could be listed.
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
import {
  DESTROY_CONFIRM_MS,
  instanceMarker,
  PENDING_DESTROY_REASON,
  type BoxClock,
  type BoxConnectivity,
  type BoxLifecycle
} from "./lifecycle.ts";
import type { BoxStore } from "./store.ts";
import { isDestroyedReason } from "./summary.ts";

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const ORPHAN_GRACE_MS = 10 * 60_000;
export const UNREACHABLE_AFTER_MS = 60_000;
/** How long a provider must keep reporting a box failed before it is destroyed. */
export const PROVIDER_ERROR_GRACE_MS = 10 * 60_000;
/** The waits before each retry of a failed destroy; the last repeats. */
export const DESTROY_RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const LIST_TIMEOUT_MS = 60_000;

export type ReconcileAction =
  | { kind: "destroy-orphan"; provider: BoxProviderId; instance: ProviderManagedInstance }
  /** `ref`: the instance found for a record that had none yet (attached before the destroy). */
  | { kind: "destroy"; boxId: string; reason: BoxDestroyedReason; message: string | null; ref?: ProviderInstanceRef }
  | { kind: "mark-gone"; boxId: string; reason: BoxDestroyedReason; message: string | null }
  | { kind: "resume"; boxId: string; ref?: ProviderInstanceRef }
  | { kind: "mark-unreachable"; boxId: string };

/** The next retry of a `destroy-failed` record's destroy. */
export interface DestroyRetry {
  /** Retries issued so far. */
  attempt: number;
  at: number;
}

export interface ReconcileInput {
  now: number;
  records: readonly StoredBox[];
  /** Every record id in boxes.json, parsed or not. */
  knownIds: ReadonlySet<string>;
  /** This appdir's installation id; null while no box was made since it exists. */
  installationId: string | null;
  /** Until when instances of this installation without any record are kept (null: not paused). */
  orphanSweepPausedUntil: number | null;
  /** Per connected provider: its managed instances, or null when listing failed. Absent = not connected. */
  listings: ReadonlyMap<string, ProviderManagedInstance[] | null>;
  /** Live statuses fetched for records the listing did not show (see {@link statusTargets}). */
  statuses: ReadonlyMap<string, ProviderInstanceStatus>;
  connected(boxId: string): boolean;
  /** Since when the box has been disconnected, or null when it is connected. */
  disconnectedSince(boxId: string): number | null;
  /** Setup or a destroy is running for the box in this process. */
  busy(boxId: string): boolean;
  /** Whether interrupted setups may be resumed (the plugin is on). */
  resumeAllowed: boolean;
  /** When this process first saw each orphan candidate ({@link orphanKey}). */
  firstSeen: ReadonlyMap<string, number>;
  /** Since when each record's instance has read `error`. */
  errorSince: ReadonlyMap<string, number>;
  /** The next destroy retry of each `destroy-failed` record. */
  retries: ReadonlyMap<string, DestroyRetry>;
}

export interface ReconcileDecision {
  actions: ReconcileAction[];
  /** The orphan candidates seen now, with their first-seen times (replaces the input's). */
  firstSeen: Map<string, number>;
  /** Replaces the input's `errorSince`. */
  errorSince: Map<string, number>;
  /** Replaces the input's `retries`. */
  retries: Map<string, DestroyRetry>;
  /** Orphans past their grace kept only because the sweep is paused. */
  kept: { provider: BoxProviderId; instance: ProviderManagedInstance }[];
}

export function orphanKey(provider: string, instance: ProviderManagedInstance): string {
  return `${provider}\u0000${instance.name}\u0000${JSON.stringify(instance.ref)}`;
}

/** The box id an instance carries (its tag, else its name), when it has this build's id format. */
export function instanceBoxId(instance: ProviderManagedInstance): string | null {
  return instanceMarker(instance)?.boxId ?? null;
}

/** Another installation's instance: it names an installation id that is not this one. */
function foreign(instance: ProviderManagedInstance, installationId: string | null): boolean {
  const marked = instanceMarker(instance)?.installationId ?? null;
  return marked !== null && marked !== installationId;
}

function matchInstance(record: StoredBox, instances: readonly ProviderManagedInstance[], installationId: string | null): ProviderManagedInstance | undefined {
  return instances.find(
    (instance) =>
      instance.state !== "gone" &&
      !foreign(instance, installationId) &&
      (instanceBoxId(instance) === record.id || instance.name === record.name)
  );
}

const LIVE_STATES = new Set(["provisioning", "ready", "unreachable", "destroy-failed"]);

/** The records whose live status must be fetched: live, with an instance ref, missing from a listing that worked. */
export function statusTargets(input: Pick<ReconcileInput, "records" | "listings" | "busy" | "installationId">): StoredBox[] {
  return input.records.filter((record) => {
    if (!LIVE_STATES.has(record.state) || !record.providerRef || input.busy(record.id)) return false;
    const instances = input.listings.get(record.provider);
    return Array.isArray(instances) && matchInstance(record, instances, input.installationId) === undefined;
  });
}

function deadlinePassed(record: StoredBox, now: number): boolean {
  const deadline = record.deadlineAt ? Date.parse(record.deadlineAt) : Number.NaN;
  return Number.isFinite(deadline) && deadline <= now;
}

function retryDelay(attempt: number): number {
  return DESTROY_RETRY_MS[Math.min(attempt, DESTROY_RETRY_MS.length - 1)]!;
}

export function decideReconcile(input: ReconcileInput): ReconcileDecision {
  const actions: ReconcileAction[] = [];
  const { now } = input;
  /** Records that still own their instance (not orphans). */
  const owned = new Set<string>();
  const errorSince = new Map<string, number>();
  const retries = new Map<string, DestroyRetry>();

  for (const record of input.records) {
    if (record.state !== "destroyed") owned.add(record.id);
    const previousError = input.errorSince.get(record.id);
    const previousRetry = input.retries.get(record.id);
    if (input.busy(record.id)) {
      if (previousError !== undefined) errorSince.set(record.id, previousError);
      // A retry in flight is `destroying`: its backoff carries over to the next failure.
      if (previousRetry) retries.set(record.id, previousRetry);
      continue;
    }
    const instances = input.listings.get(record.provider);
    const listed = Array.isArray(instances);
    const instance = listed ? matchInstance(record, instances, input.installationId) : undefined;
    const status = input.statuses.get(record.id) ?? null;
    const gone = listed && record.providerRef !== undefined && instance === undefined && status?.state === "gone";
    const pendingReason = isDestroyedReason(record[PENDING_DESTROY_REASON]) ? record[PENDING_DESTROY_REASON] : "deleted";
    const foundRef = !record.providerRef && instance ? { ref: instance.ref } : {};

    switch (record.state) {
      case "destroying":
        actions.push({ kind: "destroy", boxId: record.id, reason: pendingReason, message: null });
        break;
      case "destroy-failed": {
        if (gone) {
          actions.push({ kind: "mark-gone", boxId: record.id, reason: pendingReason, message: null });
          break;
        }
        // First seen failed: the destroy that failed just ran, so the first retry waits.
        if (!previousRetry) {
          retries.set(record.id, { attempt: 0, at: now + retryDelay(0) });
          break;
        }
        if (now < previousRetry.at) {
          retries.set(record.id, previousRetry);
          break;
        }
        actions.push({ kind: "destroy", boxId: record.id, reason: pendingReason, message: null, ...foundRef });
        retries.set(record.id, { attempt: previousRetry.attempt + 1, at: now + retryDelay(previousRetry.attempt + 1) });
        break;
      }
      case "provisioning": {
        if (deadlinePassed(record, now)) {
          actions.push({ kind: "destroy", boxId: record.id, reason: "time-limit", message: null, ...foundRef });
          break;
        }
        if (!listed) break;
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
          actions.push({ kind: "destroy", boxId: record.id, reason: "provisioning-failed", message: "Setup was interrupted by a restart.", ...foundRef });
        } else if (input.resumeAllowed) {
          actions.push({ kind: "resume", boxId: record.id, ...foundRef });
        }
        break;
      }
      case "ready":
      case "unreachable": {
        // Checked before anything the listing says: a box past its time limit goes even when its provider cannot be listed.
        if (deadlinePassed(record, now)) {
          actions.push({ kind: "destroy", boxId: record.id, reason: "time-limit", message: null });
          break;
        }
        if (!listed) {
          if (previousError !== undefined) errorSince.set(record.id, previousError);
          break;
        }
        const state = instance?.state ?? status?.state ?? null;
        if (state === "gone") {
          actions.push({ kind: "mark-gone", boxId: record.id, reason: "provider-gone", message: status?.detail ?? null });
        } else if (state === "error") {
          const since = previousError ?? now;
          errorSince.set(record.id, since);
          // A box whose orq-agent is connected is plainly alive, whatever the provider's status says.
          if (now - since >= PROVIDER_ERROR_GRACE_MS && !input.connected(record.id)) {
            actions.push({ kind: "destroy", boxId: record.id, reason: "provider-error", message: status?.detail ?? null });
          }
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
  const kept: ReconcileDecision["kept"] = [];
  const paused = input.orphanSweepPausedUntil !== null && input.orphanSweepPausedUntil > now;
  for (const [provider, instances] of input.listings) {
    if (!Array.isArray(instances)) continue;
    for (const instance of instances) {
      if (instance.state === "gone") continue;
      const marker = instanceMarker(instance);
      if (marker === null) continue;
      const { boxId } = marker;
      if (marker.installationId !== null && marker.installationId !== input.installationId) continue;
      if (owned.has(boxId) || input.busy(boxId)) continue;
      const recorded = input.records.some((record) => record.id === boxId);
      // A record this build cannot parse is another version's box, not an orphan.
      if (input.knownIds.has(boxId) && !recorded) continue;
      // Made before installation ids, with no record here: it may be another appdir's box.
      if (marker.installationId === null && !recorded) continue;
      const key = orphanKey(provider, instance);
      const since = input.firstSeen.get(key) ?? now;
      firstSeen.set(key, since);
      if (now - since < ORPHAN_GRACE_MS) continue;
      if (paused && !recorded) {
        kept.push({ provider: provider as BoxProviderId, instance });
        continue;
      }
      actions.push({ kind: "destroy-orphan", provider: provider as BoxProviderId, instance });
    }
  }
  return { actions, firstSeen, errorSince, retries, kept };
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
  /** The plugin switch: interrupted setups are resumed only while it is on. */
  enabled(): boolean;
  /** An orphan was destroyed: tell the clients. */
  publishChanged(): void;
}

export class BoxReconciler {
  private firstSeen = new Map<string, number>();
  private errorSince = new Map<string, number>();
  private retries = new Map<string, DestroyRetry>();
  private readonly disconnected = new Map<string, number>();
  private readonly unreachableTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Orphan destroys in flight, by {@link orphanKey}. */
  private readonly orphanDestroys = new Map<string, Promise<void>>();
  /** Kept orphans already logged (the sweep is paused), by {@link orphanKey}. */
  private readonly keptLogged = new Set<string>();
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

  /** Every orphan destroy started so far has finished (tests). */
  async settled(): Promise<void> {
    while (this.orphanDestroys.size > 0) await Promise.allSettled([...this.orphanDestroys.values()]);
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

  /** Re-arm the wake-up timer for the nearest future deadline, destroy retry or error grace (call after records change). */
  armDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    if (!this.active) return;
    const now = this.deps.clock.now();
    let next = Number.POSITIVE_INFINITY;
    const consider = (at: number) => {
      if (Number.isFinite(at) && at > now && at < next) next = at;
    };
    for (const record of this.deps.store.list()) {
      if (record.state === "destroyed" || !record.deadlineAt) continue;
      consider(Date.parse(record.deadlineAt));
    }
    for (const retry of this.retries.values()) consider(retry.at);
    for (const since of this.errorSince.values()) consider(since + PROVIDER_ERROR_GRACE_MS);
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
      installationId: store.installationId(),
      orphanSweepPausedUntil: store.orphanSweepPausedUntil(),
      listings,
      connected: (boxId: string) => this.deps.hub.get(boxId)?.connected === true,
      disconnectedSince: (boxId: string) =>
        this.deps.hub.get(boxId)?.connected === true ? null : (this.disconnected.get(boxId) ?? this.startedAt),
      busy: (boxId: string) => lifecycle.busy(boxId),
      resumeAllowed: this.deps.enabled()
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
    const decision = decideReconcile({
      ...base,
      now: this.deps.clock.now(),
      records: store.list(),
      knownIds: store.ids(),
      statuses,
      firstSeen: this.firstSeen,
      errorSince: this.errorSince,
      retries: this.retries
    });
    this.firstSeen = decision.firstSeen;
    this.errorSince = decision.errorSince;
    this.retries = decision.retries;
    for (const { provider, instance } of decision.kept) {
      const key = orphanKey(provider, instance);
      if (this.keptLogged.has(key)) continue;
      this.keptLogged.add(key);
      const label = providers.get(provider)?.label ?? provider;
      this.deps.logger.warn(
        `Box reconcile: keeping ${instance.name} at ${label} although Orquester has no record of it: boxes.json was moved aside recently, so it may still be wanted. Destroy it in the provider's console if not.`
      );
    }
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
        const key = orphanKey(action.provider, action.instance);
        if (!adapter || !creds || this.orphanDestroys.has(key)) return;
        this.deps.logger.warn(
          `Box reconcile: destroying ${action.instance.name} at ${adapter.label}: Orquester has no live record of it (seen for over ${ORPHAN_GRACE_MS / 60_000} min).`
        );
        // In the background, with a destroy's full budget (a Blacksmith cancel and force-cancel take minutes).
        const run = adapter
          .destroy(creds, action.instance.ref, this.callOptions(DESTROY_CONFIRM_MS))
          .then(() => {
            this.firstSeen.delete(key);
            this.deps.publishChanged();
          })
          .catch((error) => this.deps.logger.error(`Box reconcile: destroying ${action.instance.name} at ${adapter.label} failed`, errorLine(error)))
          .finally(() => this.orphanDestroys.delete(key));
        this.orphanDestroys.set(key, run);
        return;
      }
    }
  }

  private callOptions(timeoutMs: number) {
    return { signal: AbortSignal.timeout(timeoutMs), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) };
  }
}
