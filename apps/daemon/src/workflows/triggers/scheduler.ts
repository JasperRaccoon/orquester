// Automated workflows — the schedule trigger (spec §6.1).
//
// croner only COMPUTES fire times (`nextScheduleRun`); this module owns the one timer. Per enabled
// `trigger.schedule` node a cursor lives in `workflow-state.json` under `<workflowId>:<nodeId>`:
// `{cron, timezone, nextRunAt, lastFiredAt}`. Rules:
//
//   - A cursor is (re)computed FROM NOW when the trigger is new, its cron or its workflow's time zone
//     changed, or the workflow was re-enabled — a disabled workflow's cursors are pruned, so a
//     re-enable is a new trigger and never fires a stale past time.
//   - One self-rescheduling timer, armed at the earliest `nextRunAt` but never more than 60 s ahead:
//     a wall-clock jump (suspend, NTP) is noticed within a minute.
//   - On every tick (and at boot) each due trigger is handled ONCE: fired when it is within
//     `MISSED_RUN_GRACE_MINUTES` of its scheduled time, else recorded as a `missed` stub. Its next
//     time is then computed from max(now, scheduledFor) — never a burst of catch-up runs after a
//     long downtime.
//   - The advanced cursor is persisted BEFORE the fire, so a crash between the two loses a run
//     rather than repeating one.

import { describeSchedule, nextScheduleRun, validateCron } from "@orquester/api";
import type { ScheduleCursor } from "@orquester/config";
import type { Clock, FireRequest, TriggerHost, WorkflowLogger } from "../contracts.ts";
import type { WorkflowStateStore } from "../state-store.ts";

/** A due run later than this after its scheduled time is recorded as missed instead of fired. */
export const MISSED_RUN_GRACE_MINUTES = 15;
/** The timer never sleeps longer than this, so a clock jump is noticed. */
export const SCHEDULER_MAX_TIMER_MS = 60_000;

export interface SchedulerDeps {
  host: TriggerHost;
  state: WorkflowStateStore;
  clock: Clock;
  logger: WorkflowLogger;
}

export interface ScheduleTriggerState {
  nextRunAt: string | null;
  lastFiredAt: string | null;
}

export interface Scheduler {
  /** Reconciles cursors, handles anything due (boot catch-up) and arms the timer. */
  start(): Promise<void>;
  /** Cancels the timer; a tick in flight finishes but fires nothing more. */
  stop(): void;
  /** Re-reads the definitions (also wired to `host.onDefinitionsChanged`). */
  rearm(): Promise<void>;
  /** For rail summaries; null when the trigger has no cursor (disabled, unknown). */
  triggerState(workflowId: string, nodeId: string): ScheduleTriggerState | null;
  /** Resolves once every queued reconcile/tick has finished (tests). */
  idle(): Promise<void>;
}

export function scheduleCursorKey(workflowId: string, nodeId: string): string {
  return `${workflowId}:${nodeId}`;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { host, state, clock, logger } = deps;
  let chain: Promise<void> = Promise.resolve();
  let timer: { cancel(): void } | null = null;
  let started = false;
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  /** Read-only mirror of the persisted cursors (the store's own object — never mutated here). */
  let cursors: Record<string, ScheduleCursor> = {};
  /** Keys whose cron could not be scheduled, so the warning is logged once per (cron, zone). */
  const warned = new Map<string, string>();

  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = chain.then(work).catch((error: unknown) => {
      logger.error("workflow scheduler: tick failed", { error: error instanceof Error ? error.message : String(error) });
    });
    chain = next;
    return next;
  }

  function triggers() {
    return host
      .enabledTriggers("trigger.schedule")
      .filter(({ node }) => node.disabled !== true)
      .map(({ workflow, node }) => ({
        workflow,
        node,
        key: scheduleCursorKey(workflow.id, node.id),
        timezone: workflow.settings.timezone || "UTC"
      }));
  }

  function computeNext(key: string, cron: string, timezone: string, from: Date): string | null {
    const problem = validateCron(cron, timezone);
    if (problem !== null) {
      if (warned.get(key) !== `${cron}\u0000${timezone}`) {
        warned.set(key, `${cron}\u0000${timezone}`);
        logger.warn("workflow scheduler: a schedule trigger cannot be scheduled", { trigger: key, problem });
      }
      return null;
    }
    warned.delete(key);
    return nextScheduleRun(cron, timezone, from);
  }

  async function writeCursors(mutate: (draft: Record<string, ScheduleCursor>) => void): Promise<void> {
    await state.update((draft) => {
      mutate(draft.schedules);
      cursors = draft.schedules;
    });
  }

  /** New / changed triggers get a cursor computed from now; gone ones are pruned. */
  async function reconcile(): Promise<void> {
    const now = clock.now();
    const live = triggers();
    const liveKeys = new Set(live.map((trigger) => trigger.key));
    const current = state.get().schedules;
    const updates: Record<string, ScheduleCursor> = {};
    for (const trigger of live) {
      const cursor = current[trigger.key];
      const cron = trigger.node.config.cron;
      if (cursor && cursor.cron === cron && cursor.timezone === trigger.timezone) continue;
      updates[trigger.key] = {
        cron,
        timezone: trigger.timezone,
        nextRunAt: computeNext(trigger.key, cron, trigger.timezone, now),
        lastFiredAt: cursor?.lastFiredAt ?? null
      };
    }
    const stale = Object.keys(current).filter((key) => !liveKeys.has(key));
    for (const key of stale) warned.delete(key);
    if (Object.keys(updates).length === 0 && stale.length === 0) {
      cursors = current;
      return;
    }
    await writeCursors((draft) => {
      for (const key of stale) delete draft[key];
      Object.assign(draft, updates);
    });
  }

  /** Handles every due trigger once, then re-arms. */
  async function tick(): Promise<void> {
    if (stopped) return;
    const now = clock.now();
    const graceMs = MISSED_RUN_GRACE_MINUTES * 60_000;
    for (const trigger of triggers()) {
      if (stopped) return;
      const cursor = cursors[trigger.key];
      if (!cursor || cursor.nextRunAt === null) continue;
      const scheduledFor = new Date(cursor.nextRunAt);
      if (Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() > now.getTime()) continue;
      const late = now.getTime() - scheduledFor.getTime();
      const fire = late <= graceMs;
      const from = new Date(Math.max(now.getTime(), scheduledFor.getTime()));
      const nextRunAt = computeNext(trigger.key, cursor.cron, cursor.timezone, from);
      const firedAt = now.toISOString();
      await writeCursors((draft) => {
        const live = draft[trigger.key];
        // An edit that landed meanwhile owns the cursor.
        if (!live || live.nextRunAt !== cursor.nextRunAt || live.cron !== cursor.cron) return;
        draft[trigger.key] = { ...live, nextRunAt, lastFiredAt: fire ? firedAt : live.lastFiredAt };
      });
      if (stopped) return;
      const request: FireRequest = {
        workflowId: trigger.workflow.id,
        triggerNodeId: trigger.node.id,
        kind: "schedule",
        payload: { kind: "schedule", firedAt, scheduledFor: scheduledFor.toISOString() },
        text: `Scheduled · ${describeSchedule(trigger.node.config.preset, trigger.node.config.cron)}`
      };
      try {
        if (fire) await host.fire(request);
        else await host.recordSkipped(request, "missed");
      } catch (error) {
        logger.error("workflow scheduler: could not start a scheduled run", {
          trigger: trigger.key,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  function arm(): void {
    timer?.cancel();
    timer = null;
    if (stopped || !started) return;
    const now = clock.now().getTime();
    let earliest: number | null = null;
    for (const { key } of triggers()) {
      const at = cursors[key]?.nextRunAt;
      if (!at) continue;
      const ms = new Date(at).getTime();
      if (Number.isNaN(ms)) continue;
      earliest = earliest === null ? ms : Math.min(earliest, ms);
    }
    if (earliest === null) return;
    const delay = Math.min(SCHEDULER_MAX_TIMER_MS, Math.max(0, earliest - now));
    timer = clock.setTimeout(() => {
      timer = null;
      void enqueue(async () => {
        await tick();
        arm();
      });
    }, delay);
  }

  function rearm(): Promise<void> {
    return enqueue(async () => {
      if (stopped) return;
      await reconcile();
      await tick();
      arm();
    });
  }

  return {
    start() {
      if (started) return chain;
      started = true;
      stopped = false;
      cursors = state.get().schedules;
      unsubscribe = host.onDefinitionsChanged(() => void rearm());
      return rearm();
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    rearm,
    triggerState(workflowId, nodeId) {
      const cursor = cursors[scheduleCursorKey(workflowId, nodeId)];
      return cursor ? { nextRunAt: cursor.nextRunAt, lastFiredAt: cursor.lastFiredAt ?? null } : null;
    },
    async idle() {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    }
  };
}
