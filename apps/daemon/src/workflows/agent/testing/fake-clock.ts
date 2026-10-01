// A manual `Clock` for the agent block's tests (and the engine's / e2e builders'): time moves only
// when a test says so, so no test sleeps. `drive(promise)` runs a scenario to its end by flushing
// pending promise work and, whenever everything is waiting on a timer, jumping to the next one.

import type { Clock } from "../../contracts.ts";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** Let every queued promise continuation run (a few macrotask turns; no time passes). */
export async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeClock implements Clock {
  private ms: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start: Date | string = "2026-09-28T12:00:00.000Z") {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer: Timer = { id: ++this.seq, at: this.ms + Math.max(0, ms), fn };
    this.timers.push(timer);
    return { cancel: () => { this.timers = this.timers.filter((t) => t !== timer); } };
  }

  /** A promise that resolves after `ms` of fake time. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  /** Move time forward by `ms`, firing every timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.ms + ms;
    for (;;) {
      await flushAsync();
      const next = this.nextTimer();
      if (!next || next.at > target) break;
      this.ms = Math.max(this.ms, next.at);
      this.timers = this.timers.filter((t) => t !== next);
      next.fn();
    }
    this.ms = Math.max(this.ms, target);
    await flushAsync();
  }

  /**
   * Run until `promise` settles: flush, and when nothing is left but timers, jump to the next one.
   * Throws when the promise can never settle (no timer left) or after `maxSteps` jumps.
   */
  async drive<T>(promise: Promise<T>, opts: { maxSteps?: number; maxMs?: number } = {}): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let failed = false;
    promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; failed = true; error = e; });
    const start = this.ms;
    const maxSteps = opts.maxSteps ?? 100_000;
    const maxMs = opts.maxMs ?? 30 * 24 * 60 * 60_000;
    for (let step = 0; ; step += 1) {
      await flushAsync();
      if (settled) break;
      const next = this.nextTimer();
      if (!next) throw new Error("FakeClock.drive: the scenario is stuck — nothing pending and no timer left");
      if (step >= maxSteps || next.at - start > maxMs) throw new Error("FakeClock.drive: gave up (too many steps or too much fake time)");
      this.ms = Math.max(this.ms, next.at);
      this.timers = this.timers.filter((t) => t !== next);
      next.fn();
    }
    if (failed) throw error;
    return value as T;
  }

  private nextTimer(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers) if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    return best;
  }
}
