/**
 * Agent host — small promise utilities the OpenCode runtime needs.
 *
 * No dependency is added for these (COORDINATION §1.5) and none of them starts
 * a timer that the event loop is free to skip when the host is draining: every
 * `delay` takes the host's abort signal.
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      done = true;
      res(value);
    };
    reject = (error) => {
      done = true;
      rej(error);
    };
  });
  // A deferred nobody awaits must not crash the host.
  promise.catch(() => undefined);
  return { promise, resolve, reject, settled: () => done };
}

/** One-permit semaphore, FIFO. The prompt path takes it; so do compact and rollback. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const gate = deferred<void>();
    this.tail = gate.promise;
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      gate.resolve();
    }
  }
}

/** A sleep that resolves early (not rejects) when the host is shutting down. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Run `work` over `items` with at most `limit` in flight. Never rejects. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners: Promise<void>[] = [];
  const width = Math.max(1, Math.min(limit, queue.length));
  for (let index = 0; index < width; index += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const item = queue.shift();
          if (item === undefined) {
            return;
          }
          await work(item).catch(() => undefined);
        }
      })()
    );
  }
  await Promise.all(runners);
}

/** `min(base · 2^attempt, cap)`. */
export function backoffMs(attempt: number, base: number, cap: number): number {
  return Math.min(base * 2 ** attempt, cap);
}
