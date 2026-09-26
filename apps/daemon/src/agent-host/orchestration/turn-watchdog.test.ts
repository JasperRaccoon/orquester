import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { TURN_LIVENESS_WINDOWS } from "../support/deadline.ts";
import { createTurnWatchdog } from "./turn-watchdog.ts";
import { createTestClock, createTestTimers } from "./testing/fakes.ts";

function harness(options: { waitingOnUser?: () => boolean } = {}) {
  const clock = createTestClock(0);
  const timers = createTestTimers();
  const stalled: Array<{ turnId: string; elapsedMs: number }> = [];
  const watchdog = createTurnWatchdog({
    threadId: "t1",
    clock,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle),
    onStalled: ({ turnId, elapsedMs }) => stalled.push({ turnId, elapsedMs }),
    ...(options.waitingOnUser !== undefined ? { waitingOnUser: options.waitingOnUser } : {})
  });
  const at = (ms: number): void => {
    clock.set(ms);
    timers.runDue(ms);
  };
  return { clock, timers, watchdog, stalled, at };
}

const event = (type: RuntimeEvent["type"], extra: Record<string, unknown> = {}): RuntimeEvent =>
  ({
    eventId: "e",
    threadId: "t1",
    createdAt: "1970-01-01T00:00:00.000Z",
    type,
    payload: {},
    ...extra
  }) as RuntimeEvent;

describe("turn liveness watchdog (§3.1)", () => {
  it("does not arm until the protocol produces observable progress", () => {
    const { watchdog, timers, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    assert.equal(timers.pending, 0, "turn.started alone does not start the deadline");
    at(TURN_LIVENESS_WINDOWS.idleMs * 2);
    assert.deepEqual(stalled, []);
  });

  it("cancels a turn that goes silent for the idle window", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.turnId, "turn-1");
  });

  it("widens to the tool window while a tool call is open", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(
      event("item.started", {
        turnId: "turn-1",
        itemId: "i1",
        payload: { itemType: "command_execution" }
      })
    );
    at(TURN_LIVENESS_WINDOWS.idleMs + 1_000);
    assert.deepEqual(stalled, [], "the idle window does not apply while a tool runs");
    at(TURN_LIVENESS_WINDOWS.activeToolMs);
    assert.equal(stalled.length, 1);
  });

  it("is paused entirely while an approval is open", () => {
    const { watchdog, at, stalled, timers } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("request.opened", { turnId: "turn-1", requestId: "r1" }));
    assert.equal(watchdog.paused, true);
    assert.equal(timers.pending, 0);
    at(TURN_LIVENESS_WINDOWS.activeToolMs * 3);
    assert.deepEqual(stalled, [], "a turn waiting on a human is not a stalled turn");

    watchdog.observe(event("request.resolved", { turnId: "turn-1", requestId: "r1" }));
    assert.equal(watchdog.paused, false);
    at(TURN_LIVENESS_WINDOWS.activeToolMs * 3 + TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 1, "the deadline restarts once the user answers");
  });

  it("re-checks the pause immediately before cancelling", () => {
    const { watchdog, clock, timers, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    // A request opens after the timer was armed but before it fires.
    clock.set(TURN_LIVENESS_WINDOWS.idleMs - 1);
    watchdog.observe(event("user-input.requested", { turnId: "turn-1", requestId: "q1" }));
    clock.set(TURN_LIVENESS_WINDOWS.idleMs);
    timers.runDue(TURN_LIVENESS_WINDOWS.idleMs);
    assert.deepEqual(stalled, []);
  });

  it("never stalls a turn while the thread holds a card waiting on the user — even one an earlier turn raised", () => {
    // A question that outlives the turn that asked it (a subagent's own, a
    // waiting wake's: they ride no turn) is gone from the per-turn pause when
    // that turn ends. A turn the provider starts later must not be cancelled
    // for sitting quiet while the user still holds that card.
    let waiting = true;
    const { watchdog, at, stalled } = harness({ waitingOnUser: () => waiting });
    watchdog.observe(event("turn.started", { turnId: "turn-w" }));
    watchdog.observe(event("content.delta", { turnId: "turn-w" }));
    assert.equal(watchdog.paused, false, "the turn's own pause holds nothing");
    at(TURN_LIVENESS_WINDOWS.idleMs);
    at(TURN_LIVENESS_WINDOWS.idleMs * 2);
    assert.equal(stalled.length, 0, "a card waiting on the user is never a stall");

    // The card closes and the turn stays quiet: the next look cancels it.
    waiting = false;
    at(TURN_LIVENESS_WINDOWS.idleMs * 3);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.turnId, "turn-w");
  });

  it("with no card waiting on the user, a quiet turn stalls on its first window", () => {
    const { watchdog, at, stalled } = harness({ waitingOnUser: () => false });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 1);
  });

  it("stops on turn completion and on session exit", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("turn.completed", { turnId: "turn-1" }));
    at(TURN_LIVENESS_WINDOWS.activeToolMs * 2);
    assert.deepEqual(stalled, []);
    assert.equal(watchdog.turnId, null);
  });
});
