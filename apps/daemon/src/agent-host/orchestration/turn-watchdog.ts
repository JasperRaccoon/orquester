/**
 * Agent host — the turn liveness watchdog (spec §3.1 "Turn liveness watchdogs
 * pause on the user").
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/Layers/GrokAdapter.ts`
 * `:94-101` (the two windows and why), `:507-510` (`hasLivenessPause`),
 * `:729-777` (`settleStalledTurn` re-checks the pause immediately before
 * cancelling) and `:778-812` (the watchdog sleeps on the remaining window and
 * wakes on activity).
 *
 * Differs from T3 in one way that matters: T3 runs it inside the Grok adapter,
 * so only Grok gets it. Here it is host-side, fed from the same runtime event
 * stream ingestion reads, so every adapter is covered and no adapter can forget
 * it (§4.1 "enforced by the orchestration layer").
 *
 * Three rules, all load-bearing:
 * - **10 minutes** with no activity, **30 minutes** while a tool call is open;
 * - the deadline does not start until the protocol has produced observable
 *   progress;
 * - it is **paused entirely** while an approval or user-input request is
 *   pending — a turn waiting on a human is not a stalled turn, and a watchdog
 *   that ignored that would cancel every request the user left open over lunch.
 */

import { isToolLifecycleItemType, type RuntimeEvent } from "@orquester/api/agent-chat";

import { TURN_LIVENESS_WINDOWS } from "../support/deadline.ts";
import type { Clock } from "./runtime-seams.ts";

export interface TurnWatchdogOptions {
  threadId: string;
  clock: Clock;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  idleMs?: number;
  activeToolMs?: number;
  /** Cancel the provider turn and settle it as failed with this message. */
  onStalled: (input: { threadId: string; turnId: string; elapsedMs: number; windowMs: number }) => void;
}

export interface TurnWatchdog {
  /** Feed every runtime event for this thread, in order. */
  observe(event: RuntimeEvent): void;
  /** The turn the watchdog is currently arming for, if any. */
  readonly turnId: string | null;
  readonly paused: boolean;
  stop(): void;
}

export function createTurnWatchdog(options: TurnWatchdogOptions): TurnWatchdog {
  const idleMs = options.idleMs ?? TURN_LIVENESS_WINDOWS.idleMs;
  const activeToolMs = options.activeToolMs ?? TURN_LIVENESS_WINDOWS.activeToolMs;

  let turnId: string | null = null;
  let observedProgress = false;
  let lastActivityAt = 0;
  let handle: unknown = null;
  const openTools = new Set<string>();
  const openRequests = new Set<string>();

  const paused = (): boolean => openRequests.size > 0;
  const windowMs = (): number => (openTools.size > 0 ? activeToolMs : idleMs);

  const disarm = (): void => {
    if (handle !== null) {
      options.clearTimer(handle);
      handle = null;
    }
  };

  const arm = (): void => {
    disarm();
    if (turnId === null || !observedProgress || paused()) {
      return;
    }
    const elapsed = options.clock.now().getTime() - lastActivityAt;
    const remaining = Math.max(0, windowMs() - elapsed);
    handle = options.setTimer(() => {
      handle = null;
      // Re-check the pause immediately before cancelling: a request may have
      // opened while the timer was sleeping.
      if (turnId === null || paused()) {
        arm();
        return;
      }
      const now = options.clock.now().getTime();
      const sinceActivity = now - lastActivityAt;
      if (sinceActivity < windowMs()) {
        arm();
        return;
      }
      const stalledTurnId = turnId;
      turnId = null;
      observedProgress = false;
      openTools.clear();
      options.onStalled({
        threadId: options.threadId,
        turnId: stalledTurnId,
        elapsedMs: sinceActivity,
        windowMs: windowMs()
      });
    }, remaining);
  };

  const touch = (): void => {
    lastActivityAt = options.clock.now().getTime();
    observedProgress = true;
    arm();
  };

  return {
    observe(event: RuntimeEvent): void {
      switch (event.type) {
        case "turn.started": {
          turnId = event.turnId ?? turnId;
          observedProgress = false;
          openTools.clear();
          lastActivityAt = options.clock.now().getTime();
          // The deadline does not start until the protocol produces observable
          // progress, so `turn.started` alone does not arm it.
          disarm();
          return;
        }
        case "turn.completed":
        case "turn.aborted":
        case "session.exited": {
          turnId = null;
          observedProgress = false;
          openTools.clear();
          openRequests.clear();
          disarm();
          return;
        }
        case "item.started": {
          if (event.itemId && isToolLifecycleItemType(event.payload.itemType)) {
            openTools.add(event.itemId);
          }
          touch();
          return;
        }
        case "item.completed": {
          if (event.itemId) {
            openTools.delete(event.itemId);
          }
          touch();
          return;
        }
        case "request.opened":
        case "user-input.requested": {
          if (event.requestId) {
            openRequests.add(event.requestId);
          }
          // Paused: a turn waiting on a human is not a stalled turn.
          disarm();
          lastActivityAt = options.clock.now().getTime();
          observedProgress = true;
          return;
        }
        case "request.resolved":
        case "user-input.resolved": {
          if (event.requestId) {
            openRequests.delete(event.requestId);
          }
          touch();
          return;
        }
        default:
          touch();
      }
    },

    get turnId(): string | null {
      return turnId;
    },

    get paused(): boolean {
      return paused();
    },

    stop(): void {
      turnId = null;
      observedProgress = false;
      openTools.clear();
      openRequests.clear();
      disarm();
    }
  };
}

/** The message a stalled turn is settled with (§3.1). */
export function stalledTurnMessage(elapsedMs: number, windowMs: number): string {
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const elapsedMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return `The agent produced no activity for ${elapsedMinutes} minutes (the limit is ${minutes}). The turn was cancelled.`;
}
