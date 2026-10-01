/** Promise utilities for the OpenCode runtime. */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** One-permit semaphore, FIFO. The prompt path takes it; so do compact and rollback. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  /** Callers holding or queued for the permit. */
  private pending = 0;

  /** True from the moment `run` is called until its work (and every queued one) settles. */
  get busy(): boolean {
    return this.pending > 0;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const previous = this.tail;
    const gate = deferred<void>();
    this.tail = gate.promise;
    try {
      await previous;
      return await work();
    } finally {
      this.pending -= 1;
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
