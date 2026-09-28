// Automated workflows — clocks for the triggers: the real one (unref'd timers, so an armed trigger
// never keeps the process alive) and a manual one for tests (a timer queue advanced by hand — no
// sleeps anywhere).

import type { Clock } from "../contracts.ts";

/** Wall clock with unref'd timers. */
export const systemTriggerClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, Math.max(0, ms));
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  }
};

interface ManualTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** A clock whose time only moves when a test says so. */
export class ManualClock implements Clock {
  private current: number;
  private timers: ManualTimer[] = [];
  private seq = 0;

  constructor(start: Date | string | number) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { id: (this.seq += 1), at: this.current + Math.max(0, ms), fn };
    this.timers.push(timer);
    return {
      cancel: () => {
        this.timers = this.timers.filter((candidate) => candidate !== timer);
      }
    };
  }

  /** Delays (ms from now) of every armed timer, soonest first. */
  pending(): number[] {
    return this.timers.map((timer) => timer.at - this.current).sort((a, b) => a - b);
  }

  /** Moves time to `to` WITHOUT running timers (a wall-clock jump while the process slept). */
  jump(to: Date | string | number): void {
    this.current = new Date(to).getTime();
  }

  /**
   * Moves time forward by `ms`, running every timer that comes due on the way, in order (a timer
   * armed by one that ran is run too when it falls inside the window). Returns how many ran.
   */
  advance(ms: number): number {
    const end = this.current + ms;
    let ran = 0;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      ran += 1;
    }
    this.current = end;
    return ran;
  }
}
