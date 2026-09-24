import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { TURN_LIVENESS_WINDOWS } from "../support/deadline.ts";
import { createTurnWatchdog } from "./turn-watchdog.ts";
import { createTestClock, createTestTimers } from "./testing/fakes.ts";

function harness(goal: { isGoalActive?: () => boolean; goalMs?: number } = {}) {
  const clock = createTestClock(0);
  const timers = createTestTimers();
  const stalled: Array<{ turnId: string; elapsedMs: number; windowMs: number }> = [];
  const watchdog = createTurnWatchdog({
    threadId: "t1",
    clock,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle),
    ...(goal.isGoalActive !== undefined ? { isGoalActive: goal.isGoalActive } : {}),
    ...(goal.goalMs !== undefined ? { goalMs: goal.goalMs } : {}),
    onStalled: ({ turnId, elapsedMs, windowMs }) => stalled.push({ turnId, elapsedMs, windowMs })
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

describe("turn liveness watchdog — the goal window (goals §5.2)", () => {
  it("is an hour — longer than a Grok goal run's silent verifier rounds", () => {
    assert.equal(TURN_LIVENESS_WINDOWS.goalMs, 60 * 60_000);
    assert.ok(TURN_LIVENESS_WINDOWS.goalMs > TURN_LIVENESS_WINDOWS.activeToolMs);
  });

  it("while a goal is active a silent turn is not cancelled at the idle window", () => {
    const { watchdog, at, stalled } = harness({ isGoalActive: () => true });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 0, "10 silent minutes is one verifier round, not a stall");
    at(TURN_LIVENESS_WINDOWS.activeToolMs);
    assert.equal(stalled.length, 0);
    at(TURN_LIVENESS_WINDOWS.goalMs);
    assert.equal(stalled.length, 1, "an hour of silence still is");
    assert.equal(stalled[0]?.windowMs, TURN_LIVENESS_WINDOWS.goalMs);
  });

  it("without an active goal the normal windows apply", () => {
    const { watchdog, at, stalled } = harness({ isGoalActive: () => false });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.windowMs, TURN_LIVENESS_WINDOWS.idleMs);
  });

  it("is the LONGER of the goal window and the normal one, never a shortcut", () => {
    // A goal window configured below the tool window must not shorten an open
    // tool call's leash: the window is max(goal, normal).
    const { watchdog, at, stalled } = harness({
      isGoalActive: () => true,
      goalMs: TURN_LIVENESS_WINDOWS.idleMs / 2
    });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(
      event("item.started", {
        turnId: "turn-1",
        itemId: "i1",
        payload: { itemType: "command_execution" }
      })
    );
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 0, "the tool window still applies");
    at(TURN_LIVENESS_WINDOWS.activeToolMs);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.windowMs, TURN_LIVENESS_WINDOWS.activeToolMs);
  });

  it("a goal that turns active after the timer was armed is honoured when it fires", () => {
    // The goal row usually lands AFTER the event that armed the timer: the
    // watchdog observes a runtime event before ingestion folds it. The window
    // is re-read when the timer fires, so the idle deadline does not cancel it.
    let active = false;
    const { watchdog, at, stalled } = harness({ isGoalActive: () => active });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    active = true;
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.deepEqual(stalled, []);
    at(TURN_LIVENESS_WINDOWS.goalMs);
    assert.equal(stalled.length, 1);
  });

  it("a goal that ends while the timer is armed cancels at the normal window, not the hour", () => {
    // The goal row lands AFTER the event that armed the timer (the watchdog
    // observes before ingestion folds), so the arming read a goal that was
    // already over. No timer may outlive the normal window on the goal's word.
    let active = true;
    const { watchdog, at, stalled } = harness({ isGoalActive: () => active });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    active = false;
    at(TURN_LIVENESS_WINDOWS.idleMs);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.windowMs, TURN_LIVENESS_WINDOWS.idleMs);
  });

  it("the goal window is re-checked at every normal window, so it holds while the goal does", () => {
    let active = true;
    const { watchdog, at, stalled, timers } = harness({ isGoalActive: () => active });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    for (let minute = 10; minute < 60; minute += 10) {
      at(minute * 60_000);
      assert.equal(stalled.length, 0, `still inside the goal window at ${minute} min`);
      assert.equal(timers.pending, 1, "re-armed for the next normal window");
    }
    // The goal ends at 55 minutes: the next check, at 60, finds no goal — and
    // an hour of silence is past every window.
    active = false;
    at(TURN_LIVENESS_WINDOWS.goalMs);
    assert.equal(stalled.length, 1);
  });

  it("is still paused entirely while an approval is open", () => {
    const { watchdog, at, stalled, timers } = harness({ isGoalActive: () => true });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("request.opened", { turnId: "turn-1", requestId: "r1" }));
    assert.equal(timers.pending, 0);
    at(TURN_LIVENESS_WINDOWS.goalMs * 3);
    assert.deepEqual(stalled, []);
  });
});
