/**
 * Agent host — the small deterministic seams the orchestration is built on
 * (spec §9: "Anything that reads a clock or a git repository is pinned").
 *
 * `Clock` and `IdGen` are declared by `adapter.ts`; this module carries the
 * production implementations plus the two tiny primitives every serial path
 * uses. Keeping them here means a test can drive the whole orchestration
 * without a timer.
 */

import { randomUUID } from "node:crypto";

import type { Clock, IdGen } from "../adapter.ts";

export type { Clock, IdGen };

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString()
};

export const systemIdGen: IdGen = {
  eventId: () => `evt-${randomUUID()}`,
  messageId: (prefix: string) => `${prefix}${randomUUID()}`,
  uuid: () => randomUUID()
};

/** A promise plus its settlers — the readiness gate and every hand-off use it. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody has awaited yet must not crash the host.
  promise.catch(() => undefined);
  return {
    promise,
    resolve: (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    },
    reject: (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    },
    get settled() {
      return settled;
    }
  };
}

/**
 * One task at a time, in arrival order. This is the §3.1 per-thread lock: a
 * `/turn` that arrives during a restart or an interrupt **waits** rather than
 * racing, and it is never rejected for it.
 *
 * Deliberately per thread rather than global (differs from T3's single
 * `OrchestrationEngine` worker fiber): one slow provider must not stall every
 * other tab.
 */
export interface SerialQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves when the queue is empty and the running task has finished (§9). */
  drain(): Promise<void>;
  readonly size: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let size = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      size += 1;
      const result = tail.then(task, task);
      tail = result.then(
        () => {
          size -= 1;
        },
        () => {
          size -= 1;
        }
      );
      return result;
    },
    async drain(): Promise<void> {
      // Tasks queued by tasks: keep draining until the tail stops moving.
      let previous: Promise<unknown> | null = null;
      while (previous !== tail) {
        previous = tail;
        await tail.catch(() => undefined);
      }
    },
    get size() {
      return size;
    }
  };
}
