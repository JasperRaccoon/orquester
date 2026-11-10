// Automated workflows — parked runs (spec 2026-11-10 §6.2). A run is PARKED when every block it has
// in flight waits on a gate, a timer, or a child run that is itself parked (so it propagates up
// through sub-workflows). Gate and Wait blocks count as waiting for their whole life in flight (they
// do nothing else), so a run never flickers out of parked while one of them starts or ends.
//
//   - A parked top-level run does not count toward `maxConcurrentRuns`. When it would un-park (a
//     block of its tree is about to work again) while the cap is full, it is HELD — still parked,
//     its work not started — until the queue admits it again, ahead of runs that never started.
//   - Parked time is excluded from `runTimeoutMinutes`: `parkedMs` (finished stretches) and
//     `parkedSince` (the current one) are persisted with the run, so a restart re-arms the run
//     timeout at `startedAt + minutes + parkedMs` — a stretch still open at the restart (the run was
//     parked when the daemon stopped) carries on, the downtime counted as parked.
//   - A parked run still counts for its own workflow's `overlap` / `maxConcurrent` (the engine's
//     overlap decision counts every active run of the workflow).

import type { WorkflowNodeType } from "@orquester/api";

import type { Clock, PersistedRun, WorkflowLogger } from "../contracts.ts";
import { sleepUntil } from "../run-context.ts";

/** One active run, as parking sees it (the engine's ActiveRun). */
export interface ParkingRun {
  readonly run: PersistedRun;
  readonly inFlight: ReadonlySet<string>;
  /** Held: parked, its next work waiting for the run cap. */
  held: boolean;
}

export interface ParkingDeps {
  clock: Clock;
  logger: WorkflowLogger;
  maxConcurrentRuns(): number;
  get(runId: string): ParkingRun | undefined;
  all(): ParkingRun[];
  nodeType(r: ParkingRun, nodeId: string): WorkflowNodeType | undefined;
  /** Walking, not ending, not finished: only such a run can be parked. */
  walking(r: ParkingRun): boolean;
  /** A top-level run that counts toward the cap now (started, not finished, not parked). */
  counts(r: ParkingRun): boolean;
  timeoutMinutes(r: ParkingRun): number | undefined;
  /** Aborted when the run finalizes or the engine stops. */
  lifetime(r: ParkingRun): AbortSignal;
  /** The run's parked fields changed: publish its summary and persist. */
  changed(r: ParkingRun): void;
  /** The run timeout passed (parked time excluded). */
  onTimeout(r: ParkingRun, minutes: number): void;
  /** Re-walk a released run (the engine's `step`). */
  resume(r: ParkingRun): void;
  /** Let the queue look again (a top-level run parked or un-parked): the engine's pump, deferred. */
  wake(): void;
}

/** Blocks that do nothing but wait while in flight. */
const WAITING_TYPES: ReadonlySet<WorkflowNodeType> = new Set<WorkflowNodeType>(["gate", "wait"]);

export interface Parking {
  /** Whether the run is parked now (computed). */
  isParked(r: ParkingRun): boolean;
  /** Recompute (after a block's wait state changed, or a walk step): flips, persists, re-arms, propagates. */
  refresh(r: ParkingRun): void;
  /** Starting `types` would un-park the run's tree while the cap is full: hold it instead. */
  mustHold(r: ParkingRun, types?: readonly (WorkflowNodeType | undefined)[]): boolean;
  /** Hold the run (until `releaseHeld` admits it). */
  hold(r: ParkingRun): void;
  /** For work that resumes inside a block (a retry after its delay): resolves true once admitted, false on abort. */
  admission(r: ParkingRun, signal: AbortSignal): Promise<boolean>;
  /** The queue's turn: release held runs, oldest first, while the cap has room. */
  releaseHeld(): void;
  /** The walk starts (also after a restart): arm the run timeout. */
  start(r: ParkingRun): void;
  /** The run ends: close an open stretch, stop the timer, forget it. */
  finish(r: ParkingRun): void;
}

export function createParking(deps: ParkingDeps): Parking {
  const timers = new Map<string, AbortController>();
  /** Held runs, oldest first. */
  const heldOrder: string[] = [];
  const admissions = new Map<string, Set<(admitted: boolean) => void>>();

  const parentOf = (r: ParkingRun): ParkingRun | undefined => (r.run.parentRunId !== undefined ? deps.get(r.run.parentRunId) : undefined);

  const rootOf = (r: ParkingRun): ParkingRun => {
    let cursor = r;
    const seen = new Set<string>([r.run.id]);
    for (let parent = parentOf(cursor); parent && !seen.has(parent.run.id); parent = parentOf(cursor)) {
      seen.add(parent.run.id);
      cursor = parent;
    }
    return cursor;
  };

  const isParked = (r: ParkingRun): boolean => {
    if (!deps.walking(r)) return false;
    if (r.held) return true;
    if (r.inFlight.size === 0) return false;
    for (const id of r.inFlight) {
      const type = deps.nodeType(r, id);
      if (type !== undefined && WAITING_TYPES.has(type)) continue;
      const waitingOn = r.run.blocks[id]?.waitingOn;
      if (waitingOn?.kind === "gate" || waitingOn?.kind === "timer") continue;
      if (waitingOn?.kind === "child-run" && deps.get(waitingOn.runId)?.run.parked === true) continue;
      return false;
    }
    return true;
  };

  const cancelTimer = (r: ParkingRun): void => {
    timers.get(r.run.id)?.abort();
    timers.delete(r.run.id);
  };

  const armTimeout = (r: ParkingRun): void => {
    cancelTimer(r);
    const minutes = deps.timeoutMinutes(r);
    const lifetime = deps.lifetime(r);
    if (typeof minutes !== "number" || !(minutes > 0) || r.run.parked === true || lifetime.aborted) return;
    const startedAt = Date.parse(r.run.startedAt ?? r.run.queuedAt);
    const deadline = new Date(startedAt + minutes * 60_000 + Math.max(0, r.run.parkedMs ?? 0));
    const timer = new AbortController();
    const onEnd = (): void => timer.abort();
    lifetime.addEventListener("abort", onEnd, { once: true });
    timers.set(r.run.id, timer);
    void sleepUntil(deps.clock, deadline, timer.signal).then((reached) => {
      lifetime.removeEventListener("abort", onEnd);
      if (timers.get(r.run.id) === timer) timers.delete(r.run.id);
      if (reached && !lifetime.aborted) deps.onTimeout(r, minutes);
    });
  };

  const settle = (r: ParkingRun, admitted: boolean): void => {
    const set = admissions.get(r.run.id);
    admissions.delete(r.run.id);
    for (const resolve of set ?? []) resolve(admitted);
  };

  const unhold = (r: ParkingRun): void => {
    r.held = false;
    const at = heldOrder.indexOf(r.run.id);
    if (at !== -1) heldOrder.splice(at, 1);
  };

  const parking: Parking = {
    isParked,

    refresh(r) {
      const parked = isParked(r);
      if (parked === (r.run.parked === true)) return;
      const now = deps.clock.now();
      if (parked) {
        r.run.parked = true;
        r.run.parkedSince = now.toISOString();
        cancelTimer(r);
      } else {
        const since = r.run.parkedSince !== undefined ? Date.parse(r.run.parkedSince) : Number.NaN;
        if (Number.isFinite(since)) r.run.parkedMs = Math.max(0, (r.run.parkedMs ?? 0) + Math.max(0, now.getTime() - since));
        delete r.run.parked;
        delete r.run.parkedSince;
        armTimeout(r);
      }
      deps.changed(r);
      const parent = parentOf(r);
      if (parent) parking.refresh(parent);
      if (r.run.depth === 0) deps.wake();
    },

    mustHold(r, types) {
      // Starting only blocks that wait at once never un-parks anything.
      if (types !== undefined && types.every((type) => type !== undefined && WAITING_TYPES.has(type))) return false;
      const root = rootOf(r);
      if (root.run.parked !== true || root.run.depth !== 0) return false;
      const running = deps.all().filter((other) => other !== root && deps.counts(other)).length;
      return running >= deps.maxConcurrentRuns();
    },

    hold(r) {
      if (r.held) return;
      r.held = true;
      heldOrder.push(r.run.id);
      parking.refresh(r);
    },

    admission(r, signal) {
      if (!parking.mustHold(r)) return Promise.resolve(true);
      parking.hold(r);
      return new Promise<boolean>((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        let set = admissions.get(r.run.id);
        if (!set) {
          set = new Set();
          admissions.set(r.run.id, set);
        }
        const done = (admitted: boolean): void => {
          signal.removeEventListener("abort", onAbort);
          resolve(admitted);
        };
        const onAbort = (): void => {
          admissions.get(r.run.id)?.delete(done);
          resolve(false);
        };
        set.add(done);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    releaseHeld() {
      for (const id of [...heldOrder]) {
        const r = deps.get(id);
        if (!r || !r.held) {
          const at = heldOrder.indexOf(id);
          if (at !== -1) heldOrder.splice(at, 1);
          continue;
        }
        if (!deps.walking(r)) {
          unhold(r);
          settle(r, false);
          continue;
        }
        // Room for its top-level run (which is parked while held): admit it.
        const root = rootOf(r);
        const running = deps.all().filter((other) => other !== root && deps.counts(other)).length;
        if (running >= deps.maxConcurrentRuns()) break;
        unhold(r);
        settle(r, true);
        deps.resume(r);
        parking.refresh(r);
      }
    },

    start(r) {
      if (r.run.parked === true && r.run.parkedSince === undefined) r.run.parkedSince = deps.clock.now().toISOString();
      if (r.run.parked !== true && r.run.parkedSince !== undefined) delete r.run.parkedSince;
      armTimeout(r);
    },

    finish(r) {
      cancelTimer(r);
      unhold(r);
      settle(r, false);
      if (r.run.parked === true || r.run.parkedSince !== undefined) {
        const since = r.run.parkedSince !== undefined ? Date.parse(r.run.parkedSince) : Number.NaN;
        if (Number.isFinite(since)) r.run.parkedMs = Math.max(0, (r.run.parkedMs ?? 0) + Math.max(0, deps.clock.now().getTime() - since));
        delete r.run.parked;
        delete r.run.parkedSince;
      }
    }
  };
  return parking;
}
