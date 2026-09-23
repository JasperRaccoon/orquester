/**
 * Agent host — the projection seam (spec §5.1, §6.3).
 *
 * There is exactly one definition of "what the thread looks like after these
 * events", and it lives in `@orquester/api/agent-chat` (package W2) so the host
 * and the client apply the same reducer. This module is only the *injection
 * point*: production wires {@link DEFAULT_FOLD_OPS}, and a test may pass a
 * scripted fold so orchestration behaviour can be asserted without the whole
 * projection.
 *
 * It is deliberately not a second fold — nothing here implements any rule.
 */

import {
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  toThreadSnapshot,
  type DomainEvent,
  type ThreadFoldState,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

export interface FoldOps {
  createEmpty(): ThreadFoldState;
  apply(state: ThreadFoldState, event: DomainEvent): ThreadFoldState;
  foldAll(events: Iterable<DomainEvent>): ThreadFoldState;
  snapshot(state: ThreadFoldState): ThreadSnapshotPayload;
}

export const DEFAULT_FOLD_OPS: FoldOps = {
  createEmpty: createEmptyThreadState,
  apply: applyDomainEvent,
  foldAll: foldThread,
  snapshot: toThreadSnapshot
};

/** Events folded between two yields to the event loop (design 2026-09-23, invariant 7). */
export const FOLD_CHUNK_SIZE = 500;

export interface ChunkedFoldOptions {
  /** Events applied between two yields; anything but a positive number means the default. */
  chunkSize?: number;
  /** The reducer — the orchestrator passes its injected {@link FoldOps.apply}. */
  apply?: (state: ThreadFoldState, event: DomainEvent) => ThreadFoldState;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Fold `events` onto `state`, yielding to the event loop (`setImmediate`)
 * between chunks of {@link FOLD_CHUNK_SIZE} events.
 *
 * Exactly `events.reduce(apply, state)` — the same reducer, the same order —
 * only interleaved with the loop. A cold fold of a big thread used to hold the
 * host's loop for seconds, long enough for the daemon's 15 s health probe (5 s
 * timeout) to miss twice and kill a healthy host, and for every other thread's
 * reads to stall behind it (design 2026-09-23, invariant 7). A log that fits in
 * one chunk folds without a single yield.
 */
export async function applyEventsChunked(
  state: ThreadFoldState,
  events: readonly DomainEvent[],
  options: ChunkedFoldOptions = {}
): Promise<ThreadFoldState> {
  const apply = options.apply ?? applyDomainEvent;
  const requested = options.chunkSize;
  const chunkSize =
    typeof requested === "number" && Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : FOLD_CHUNK_SIZE;
  let next = state;
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0 && index % chunkSize === 0) {
      await yieldToEventLoop();
    }
    next = apply(next, events[index]!);
  }
  return next;
}
