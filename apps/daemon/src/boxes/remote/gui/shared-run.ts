/**
 * One install run that several callers wait on (two tabs opening at once). Each caller joins with
 * its own abort signal and progress listener: aborting leaves only that caller's wait, except that
 * the last waiter leaving aborts the run itself (nobody wants it any more). A joiner first gets the
 * lines the run printed before it joined, so a second tab shows the log from the start.
 */

import type { BoxGuiProgress } from "./types.ts";

const BACKLOG_LINES = 400;

export class SharedRun<T> {
  readonly promise: Promise<T>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<BoxGuiProgress>();
  private readonly backlog: string[] = [];
  private waiters = 0;
  private settled = false;

  constructor(
    work: (signal: AbortSignal, progress: BoxGuiProgress) => Promise<T>,
    private readonly onAbandoned: () => void = () => undefined
  ) {
    this.promise = work(this.controller.signal, (line) => this.emit(line));
    this.promise.then(
      () => {
        this.settled = true;
      },
      () => {
        this.settled = true;
      }
    );
  }

  /** True once nobody waits any more and the run was told to stop. */
  get abandoned(): boolean {
    return this.controller.signal.aborted;
  }

  join(options: { signal?: AbortSignal; onProgress?: BoxGuiProgress } = {}): Promise<T> {
    const { signal, onProgress } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.waiters += 1;
    if (onProgress) {
      for (const line of this.backlog) onProgress(line);
      this.listeners.add(onProgress);
    }
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return false;
        left = true;
        this.waiters -= 1;
        if (onProgress) this.listeners.delete(onProgress);
        signal?.removeEventListener("abort", onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (this.waiters === 0 && !this.settled) {
          this.controller.abort(signal!.reason);
          this.onAbandoned();
        }
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.promise.then(
        (value) => {
          if (leave()) resolve(value);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        }
      );
    });
  }

  /** Stop the run whoever waits (the box is gone). */
  abort(reason: unknown): void {
    if (!this.settled) this.controller.abort(reason);
  }

  private emit(line: string): void {
    this.backlog.push(line);
    if (this.backlog.length > BACKLOG_LINES) this.backlog.splice(0, this.backlog.length - BACKLOG_LINES);
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // A caller's progress sink never breaks the run or the other callers.
      }
    }
  }
}
