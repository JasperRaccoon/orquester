import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import {
  RECONNECT_BACKOFF,
  backoffCeilingMs,
  backoffDelayMs,
  scheduleRetry,
  wakeReconnects
} from "./backoff.ts";

afterEach(() => mock.timers.reset());

describe("backoffCeilingMs", () => {
  it("doubles from the base up to the cap", () => {
    const policy = { baseMs: 500, maxMs: 4_000 };
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((attempt) => backoffCeilingMs(attempt, policy)),
      [500, 1_000, 2_000, 4_000, 4_000, 4_000]
    );
  });

  it("never overflows on a long outage and treats a bad attempt as the first", () => {
    assert.equal(backoffCeilingMs(5_000), RECONNECT_BACKOFF.maxMs);
    assert.equal(backoffCeilingMs(Number.POSITIVE_INFINITY), RECONNECT_BACKOFF.baseMs);
    assert.equal(backoffCeilingMs(Number.NaN), RECONNECT_BACKOFF.baseMs);
    assert.equal(backoffCeilingMs(-3), RECONNECT_BACKOFF.baseMs);
  });
});

describe("backoffDelayMs", () => {
  it("spreads the delay over the whole window (full jitter)", () => {
    const policy = { baseMs: 1_000, maxMs: 30_000 };
    assert.equal(backoffDelayMs(3, policy, () => 0), 0);
    assert.equal(backoffDelayMs(3, policy, () => 0.5), 4_000);
    assert.equal(backoffDelayMs(3, policy, () => 1), 8_000);
    assert.equal(backoffDelayMs(20, policy, () => 1), 30_000);
  });

  it("stays inside [0, ceiling] for any random source", () => {
    assert.equal(backoffDelayMs(0, RECONNECT_BACKOFF, () => 7), RECONNECT_BACKOFF.baseMs);
    assert.equal(backoffDelayMs(0, RECONNECT_BACKOFF, () => -1), 0);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const delay = backoffDelayMs(attempt);
      assert.ok(delay >= 0 && delay <= backoffCeilingMs(attempt), `attempt ${attempt}: ${delay}`);
    }
  });

  it("does not redial a fleet of clients in lockstep", () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelayMs(6)));
    assert.ok(delays.size > 25, `only ${delays.size} distinct delays`);
  });
});

describe("scheduleRetry", () => {
  it("runs after the delay, once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const runs: boolean[] = [];
    scheduleRetry(1_000, (woken) => runs.push(woken));
    mock.timers.tick(999);
    assert.deepEqual(runs, []);
    mock.timers.tick(1);
    assert.deepEqual(runs, [false]);
    wakeReconnects();
    mock.timers.tick(5_000);
    assert.deepEqual(runs, [false]);
  });

  it("a wake fires every pending retry at once and says so", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const runs: string[] = [];
    scheduleRetry(20_000, (woken) => runs.push(`a:${woken}`));
    scheduleRetry(5_000, (woken) => runs.push(`b:${woken}`));
    wakeReconnects();
    assert.deepEqual(runs, ["a:true", "b:true"]);
    mock.timers.tick(30_000);
    assert.equal(runs.length, 2, "the timers were cleared");
  });

  it("a cancelled retry never runs", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    let ran = false;
    const retry = scheduleRetry(1_000, () => {
      ran = true;
    });
    retry.cancel();
    wakeReconnects();
    mock.timers.tick(2_000);
    assert.equal(ran, false);
  });

  it("a retry scheduled during a wake waits for the next one", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const runs: boolean[] = [];
    scheduleRetry(1_000, () => {
      scheduleRetry(60_000, (woken) => runs.push(woken));
    });
    wakeReconnects();
    assert.deepEqual(runs, [], "no tight loop inside one wake");
    wakeReconnects();
    assert.deepEqual(runs, [true]);
  });
});
