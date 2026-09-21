/**
 * Codex adapter — the adapter's single event stream (spec §4.1 `events`).
 *
 * `AgentAdapter.events` has exactly **one** consumer, the host's ingestion, so
 * this is a plain unbounded-but-capped FIFO rather than a broadcast. The cap
 * matters: ingestion batches (§5.6) and a wedged consumer must cost a bounded
 * amount of memory, not the host.
 *
 * Dropping from the FRONT rather than refusing at the back is deliberate — the
 * newest events are the ones the UI needs, and a drop is reported so the
 * adapter can emit a `runtime.warning` about it.
 */

export interface EventQueueOptions {
  /** Past this many buffered events the OLDEST are dropped. */
  maxBuffered?: number;
  onDrop?: (dropped: number) => void;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  private readonly maxBuffered: number;
  private readonly onDrop: ((dropped: number) => void) | undefined;
  private closed = false;

  constructor(options: EventQueueOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? 10_000;
    this.onDrop = options.onDrop;
  }

  get size(): number {
    return this.buffer.length;
  }

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    this.buffer.push(value);
    if (this.buffer.length > this.maxBuffered) {
      const dropped = this.buffer.length - this.maxBuffered;
      this.buffer.splice(0, dropped);
      this.onDrop?.(dropped);
    }
  }

  /** Stop accepting values and release every waiter. Idempotent. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}
