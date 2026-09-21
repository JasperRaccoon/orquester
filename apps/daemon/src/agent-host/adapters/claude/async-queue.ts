/**
 * Claude adapter — two tiny async primitives.
 *
 * `AsyncEventQueue` backs `AgentAdapter.events` (§4.1): one producer (the
 * session), one consumer (the host's ingestion). `PromptQueue` backs the
 * long-lived streaming input the SDK reads (§4.5 "Prompt feeding is a
 * long-lived streaming input") — `sendTurn` only ever offers onto it, and
 * `query()` is never re-made per turn.
 *
 * Neither is unbounded by accident: the event queue is drained by the host on
 * the same tick it is written, and the prompt queue only ever holds turns the
 * user actually sent.
 */

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  pushAll(items: readonly T[]): void {
    for (const item of items) {
      this.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  get size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}

/** A promise with its settle functions exposed. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: () => boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (done) {
        return;
      }
      done = true;
      res(value);
    };
    reject = (error) => {
      if (done) {
        return;
      }
      done = true;
      rej(error);
    };
  });
  return { promise, resolve, reject, settled: () => done };
}
