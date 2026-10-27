import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { wakeReconnects } from "../../../lib/connection/backoff.ts";
import { RateMeter, StreamLifecycle, type StreamAttempt, type StreamLifecycleOptions } from "./lifecycle.ts";
import { DeviceStreamError, type DeviceStreamState } from "./types.ts";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => mock.timers.reset());

function harness(overrides: Partial<StreamLifecycleOptions> = {}) {
  const attempts: StreamAttempt[] = [];
  const states: Array<[DeviceStreamState, string | null]> = [];
  const events: string[] = [];
  const lifecycle = new StreamLifecycle({
    transport: "serve-emu",
    now: () => Date.now(),
    random: () => 1,
    connect: (attempt) => attempts.push(attempt),
    callbacks: {
      onState: (state, error) => states.push([state, error?.code ?? null]),
      onFrame: () => events.push("frame"),
      onVideoSize: (w, h) => events.push(`size ${w}x${h}`)
    },
    ...overrides
  });
  return { lifecycle, attempts, states, events };
}

const retryable = () => new DeviceStreamError("network", "dropped");

describe("StreamLifecycle", () => {
  it("goes live on a frame, stalls after 2 s of silence, and recovers on the next frame", () => {
    const stalls: number[] = [];
    const { lifecycle, attempts, states, events } = harness({ onStall: () => stalls.push(Date.now()) });
    lifecycle.start();
    assert.equal(attempts.length, 1);
    assert.equal(lifecycle.state, "connecting");
    mock.timers.tick(300);
    lifecycle.frame(720, 1280);
    assert.equal(lifecycle.state, "live");
    assert.deepEqual(events, ["size 720x1280", "frame"]);
    mock.timers.tick(1_999);
    assert.equal(lifecycle.state, "live");
    mock.timers.tick(1);
    assert.equal(lifecycle.state, "stalled");
    assert.deepEqual(stalls, [2_300]);
    lifecycle.frame(720, 1280);
    assert.equal(lifecycle.state, "live");
    assert.deepEqual(states, [["live", null], ["stalled", null], ["live", null]]);
    assert.equal(attempts.length, 1);
  });

  it("reconnects after long silence, keeping the attempt count for stats", () => {
    const { lifecycle, attempts } = harness({ reconnectAfterMs: 10_000, backoff: { baseMs: 500, maxMs: 30_000 } });
    lifecycle.start();
    lifecycle.frame(10, 10);
    mock.timers.tick(2_000);
    assert.equal(lifecycle.state, "stalled");
    mock.timers.tick(8_000);
    assert.equal(lifecycle.state, "connecting");
    assert.equal(lifecycle.error?.code, "no-video");
    assert.equal(attempts[0]!.current(), false);
    assert.equal(attempts[0]!.signal.aborted, true);
    mock.timers.tick(500);
    assert.equal(attempts.length, 2);
    assert.equal(lifecycle.stats().reconnects, 1);
  });

  it("times out a connection that never paints", () => {
    const { lifecycle, attempts } = harness({ reconnectAfterMs: 5_000 });
    lifecycle.start();
    mock.timers.tick(4_999);
    assert.equal(attempts.length, 1);
    mock.timers.tick(1);
    assert.equal(lifecycle.error?.code, "no-video");
    mock.timers.tick(500);
    assert.equal(attempts.length, 2);
  });

  it("backs off exponentially with jitter, reads error after three failures, and resets on a frame", () => {
    const { lifecycle, attempts, states } = harness();
    lifecycle.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = Date.now();
      lifecycle.fail(retryable());
      const count = attempts.length;
      while (attempts.length === count) mock.timers.tick(50);
      delays.push(Date.now() - before);
    }
    assert.deepEqual(delays, [500, 1_000, 2_000, 4_000]);
    assert.deepEqual(
      states.map(([state]) => state),
      ["connecting", "connecting", "error", "error"]
    );
    lifecycle.frame(1, 1);
    assert.equal(lifecycle.state, "live");
    lifecycle.fail(retryable());
    assert.equal(lifecycle.state, "connecting");
    mock.timers.tick(500);
    assert.equal(attempts.length, 6);
  });

  it("retries at once when the page wakes", () => {
    const { lifecycle, attempts } = harness();
    lifecycle.start();
    lifecycle.fail(retryable());
    assert.equal(attempts.length, 1);
    wakeReconnects();
    assert.equal(attempts.length, 2);
  });

  it("stops on a fatal error and ignores late failures from the old attempt", () => {
    const { lifecycle, attempts, states } = harness();
    lifecycle.start();
    lifecycle.fail(new DeviceStreamError("unauthorized", "no", true));
    assert.equal(lifecycle.state, "error");
    lifecycle.fail(retryable());
    mock.timers.tick(60_000);
    assert.equal(attempts.length, 1);
    assert.deepEqual(states, [["error", "unauthorized"]]);
  });

  it("close aborts the attempt, cancels retries and silences callbacks", () => {
    const { lifecycle, attempts, states, events } = harness();
    lifecycle.start();
    lifecycle.fail(retryable());
    lifecycle.close();
    assert.equal(lifecycle.state, "closed");
    mock.timers.tick(60_000);
    assert.equal(attempts.length, 1);
    lifecycle.frame(1, 1);
    lifecycle.close();
    assert.deepEqual(events, []);
    assert.deepEqual(states.at(-1), ["closed", null]);
  });

  it("marks an input-only attempt ready without a stall watchdog", () => {
    const { lifecycle, attempts } = harness({ stallMs: null });
    lifecycle.start();
    lifecycle.ready();
    mock.timers.tick(120_000);
    assert.equal(lifecycle.state, "live");
    assert.equal(attempts.length, 1);
  });
});

describe("RateMeter", () => {
  it("reports fps and kbps over a sliding two-second window", () => {
    const meter = new RateMeter(() => Date.now());
    for (let i = 0; i < 20; i++) {
      meter.add(1, 25_000);
      mock.timers.tick(100);
    }
    // 19 samples (t = 100…1900 ms) fall inside (0, 2000].
    assert.deepEqual(meter.rates(), { fps: 9.5, kbps: 1_900 });
    mock.timers.tick(1_000);
    assert.deepEqual(meter.rates(), { fps: 4.5, kbps: 900 });
    mock.timers.tick(1_000);
    assert.deepEqual(meter.rates(), { fps: 0, kbps: 0 });
  });
});
