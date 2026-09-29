import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { createTurnWatchdog } from "./turn-watchdog.ts";
import { createTestClock } from "./testing/fakes.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

function harness(
  options: { waitingOnUser?: () => boolean; isGoalActive?: () => boolean } = {}
) {
  const clock = createTestClock(0);
  const stalled: Array<{ turnId: string; elapsedMs: number; windowMs: number }> = [];
  const watchdog = createTurnWatchdog({
    threadId: "t1",
    clock,
    ...(options.waitingOnUser !== undefined ? { waitingOnUser: options.waitingOnUser } : {}),
    ...(options.isGoalActive !== undefined ? { isGoalActive: options.isGoalActive } : {}),
    onStalled: ({ turnId, elapsedMs, windowMs }) => stalled.push({ turnId, elapsedMs, windowMs })
  });
  let elapsed = 0;
  const at = (ms: number): void => {
    clock.set(ms);
    mock.timers.tick(ms - elapsed);
    elapsed = ms;
  };
  return { clock, watchdog, stalled, at };
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
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));

    at(10 * 60_000 * 2);
    assert.deepEqual(stalled, []);
  });

  it("cancels a turn that goes silent for the idle window", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(10 * 60_000);
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
    at(10 * 60_000 + 1_000);
    assert.deepEqual(stalled, [], "the idle window does not apply while a tool runs");
    at(30 * 60_000);
    assert.equal(stalled.length, 1);
  });

  it("is paused entirely while an approval is open", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("request.opened", { turnId: "turn-1", requestId: "r1" }));

    at(30 * 60_000 * 3);
    assert.deepEqual(stalled, [], "a turn waiting on a human is not a stalled turn");

    watchdog.observe(event("request.resolved", { turnId: "turn-1", requestId: "r1" }));

    at(30 * 60_000 * 3 + 10 * 60_000);
    assert.equal(stalled.length, 1, "the deadline restarts once the user answers");
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

    at(10 * 60_000);
    at(10 * 60_000 * 2);
    assert.equal(stalled.length, 0, "a card waiting on the user is never a stall");

    // The card closes and the turn stays quiet: the next look cancels it.
    waiting = false;
    at(10 * 60_000 * 3);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.turnId, "turn-w");
  });

  it("stops on turn completion", () => {
    const { watchdog, at, stalled } = harness();
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("turn.completed", { turnId: "turn-1" }));
    at(30 * 60_000 * 2);
    assert.deepEqual(stalled, []);

  });
});

describe("turn liveness watchdog — the goal window (goals §5.2)", () => {
  it("a card the user holds under an active goal: looked at again a normal window later, and the goal's window names the stall", () => {
    let waiting = true;
    const { watchdog, at, stalled } = harness({
      waitingOnUser: () => waiting,
      isGoalActive: () => true
    });
    watchdog.observe(event("turn.started", { turnId: "turn-g" }));
    watchdog.observe(event("content.delta", { turnId: "turn-g" }));
    at(60 * 60_000);
    assert.equal(stalled.length, 0, "a card waiting on the user is never a stall, goal or not");

    waiting = false;
    at(60 * 60_000 + 10 * 60_000);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.windowMs, 60 * 60_000);
  });

  it("while a goal is active a silent turn is not cancelled at the idle window", () => {
    const { watchdog, at, stalled } = harness({ isGoalActive: () => true });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    at(10 * 60_000);
    assert.equal(stalled.length, 0, "10 silent minutes is one verifier round, not a stall");
    at(30 * 60_000);
    assert.equal(stalled.length, 0);
    at(60 * 60_000);
    assert.equal(stalled.length, 1, "an hour of silence still is");
    assert.equal(stalled[0]?.windowMs, 60 * 60_000);
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
    at(10 * 60_000);
    assert.deepEqual(stalled, []);
    at(60 * 60_000);
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
    at(10 * 60_000);
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0]?.windowMs, 10 * 60_000);
  });

  it("is still paused entirely while an approval is open", () => {
    const { watchdog, at, stalled } = harness({ isGoalActive: () => true });
    watchdog.observe(event("turn.started", { turnId: "turn-1" }));
    watchdog.observe(event("content.delta", { turnId: "turn-1" }));
    watchdog.observe(event("request.opened", { turnId: "turn-1", requestId: "r1" }));

    at(60 * 60_000 * 3);
    assert.deepEqual(stalled, []);
  });
});
