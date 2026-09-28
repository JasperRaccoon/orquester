// Automated workflows — the engine's global concurrency caps (spec §3.4, §5.9): a FIFO slot pool
// per resource (agent blocks, sandbox processes). Pure and synchronous apart from the promise a
// waiter gets; no timers.

export class SlotAbortedError extends Error {
  constructor() {
    super("Aborted while waiting for a free slot.");
    this.name = "SlotAbortedError";
  }
}

export interface SlotPool {
  readonly size: number;
  /** Slots held now (may exceed `size` after a forced acquire). */
  inUse(): number;
  /** Waiters queued behind the cap. */
  waiting(): number;
  /**
   * A slot, FIFO behind earlier waiters. Resolves with an idempotent `release`. Rejects with
   * `SlotAbortedError` when `signal` aborts first. `force` takes a slot at once even past the cap —
   * for work that is already running (a resumed process) and cannot wait.
   */
  acquire(signal: AbortSignal, opts?: { force?: boolean }): Promise<() => void>;
}

export function createSlotPool(size: number): SlotPool {
  const cap = Math.max(1, Math.floor(size));
  let held = 0;
  const queue: { resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void }[] = [];

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held -= 1;
      drain();
    };
  };

  const drain = (): void => {
    while (held < cap && queue.length > 0) {
      const next = queue.shift()!;
      next.signal.removeEventListener("abort", next.onAbort);
      held += 1;
      next.resolve(makeRelease());
    }
  };

  return {
    size: cap,
    inUse: () => held,
    waiting: () => queue.length,
    acquire(signal, opts = {}) {
      if (signal.aborted) return Promise.reject(new SlotAbortedError());
      if (opts.force || (held < cap && queue.length === 0)) {
        held += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = queue.indexOf(entry);
            if (index >= 0) queue.splice(index, 1);
            reject(new SlotAbortedError());
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
      });
    }
  };
}
