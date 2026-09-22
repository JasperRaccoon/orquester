// Ported from T3 Code (MIT):
//   packages/client-runtime/src/state/threadRetention.ts:1-3
//   packages/client-runtime/src/state/threads.ts:186-228, :917-950 (the resume cache + its owner token)

/**
 * Agent chat — the **retained thread snapshot** cache (spec §6.5, §7.2).
 *
 * T3 splits a thread's client state in two, and the split is the whole point:
 *
 *  - a **value-only retained snapshot** — the folded state plus the sequence it
 *    was folded to — with a 5-minute *idle* TTL
 *    (`Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS)` on the resume family), and
 *  - a **live subscription** with TTL 0 (`Atom.setIdleTTL(0)` on the state
 *    family), released as soon as its last consumer leaves.
 *
 * A remount then paints the retained value on its first emission
 * (`Stream.concat(Stream.succeed(cachedThreadState(cached)), live)`) and the
 * live stream resumes with `afterSequence` from the retained sequence, so a
 * warm cache catches up on deltas instead of re-downloading the thread body.
 *
 * Keeping a *stream* open per recently-viewed tab (which is what a long dispose
 * grace does) buys the same instant repaint at the cost of one live connection
 * and one live fold per tab; keeping a *value* costs neither.
 *
 * **The owner token.** Only the generation that currently owns a key may write
 * its snapshot (T3 `threads.ts:188-189, 228, 255, 274, 293, 418` — every write
 * is guarded by `resumeCache.owner === owner`). A store whose teardown lands
 * after a newer store has claimed the key would otherwise clobber the newer
 * generation's cache with state the user has already moved past.
 *
 * In-memory only, and deliberately so: nothing here is persisted, so none of
 * the "a payload from an older bundle outlives a deploy" rules apply.
 *
 * No React, no zustand, no transport — just a map and a timer.
 */

/** How long an unreferenced thread's folded state survives its live stream. */
export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

/**
 * How many retained threads are kept at once.
 *
 * T3 bounds this structurally (its atom registry collects what nothing
 * references); we hold plain objects, so the cap is explicit. A folded thread
 * is not small, and a long session can touch far more tabs than a person ever
 * navigates back to — the oldest retention is evicted first.
 */
export const THREAD_SNAPSHOT_CACHE_MAX = 24;

/** The retained value: whatever the store folds, plus the cursor it folded to. */
export interface RetainedThread<TState> {
  readonly state: TState;
  /** The last applied event sequence — the `after=` a remount resumes from. */
  readonly sequence: number;
}

interface RetentionCell<TState> {
  /** The live generation allowed to write this key, or `null` when none is. */
  owner: object | null;
  snapshot: RetainedThread<TState> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Monotonic write stamp; the eviction order. */
  retainedAt: number;
}

export interface ThreadRetentionOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Injected in tests; production uses `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * The retained-snapshot store.
 *
 * Generic over the retained value so the cache knows nothing about the shape
 * of a thread — `store.ts` owns that, and this file stays testable on its own.
 */
export class ThreadRetentionCache<TState> {
  private readonly cells = new Map<string, RetentionCell<TState>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly setTimer: NonNullable<ThreadRetentionOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ThreadRetentionOptions["clearTimer"]>;
  private clock = 0;

  constructor(options: ThreadRetentionOptions = {}) {
    this.ttlMs = options.ttlMs ?? THREAD_SNAPSHOT_IDLE_TTL_MS;
    this.maxEntries = options.maxEntries ?? THREAD_SNAPSHOT_CACHE_MAX;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Become the key's owner and mint the token that proves it.
   *
   * Called once per live generation (one per `createThreadStore`). It never
   * touches the retained value: a generation reads with {@link take} first and
   * claims second, exactly as T3 reads `get.once(resumeAtom)` and then assigns
   * `resumeCache.owner = owner` inside the state's constructor.
   */
  claim(key: string): object {
    const owner = {};
    const cell = this.cells.get(key);
    if (cell) {
      cell.owner = owner;
    } else {
      this.cells.set(key, { owner, snapshot: null, timer: null, retainedAt: 0 });
    }
    return owner;
  }

  /** Whether `owner` is still the generation allowed to write this key. */
  isOwner(key: string, owner: object): boolean {
    return this.cells.get(key)?.owner === owner;
  }

  /**
   * Read the retained value **and remove it**: the caller becomes the live
   * copy, and re-retains on its own teardown. The TTL timer is disarmed with
   * it — a mounted consumer is not idle.
   */
  take(key: string): RetainedThread<TState> | null {
    const cell = this.cells.get(key);
    if (!cell) {
      return null;
    }
    const snapshot = cell.snapshot;
    this.disarm(cell);
    cell.snapshot = null;
    if (cell.owner === null) {
      this.cells.delete(key);
    }
    return snapshot;
  }

  /** Read without taking. For assertions and for surfaces that must not own one. */
  peek(key: string): RetainedThread<TState> | null {
    return this.cells.get(key)?.snapshot ?? null;
  }

  /**
   * Write the retained value, if `owner` still owns the key.
   *
   * Returns `false` for a stale generation, which is the guard T3 spells as
   * `if (resumeCache?.owner === owner) resumeCache.snapshot = committed`.
   */
  retain(key: string, owner: object, snapshot: RetainedThread<TState>): boolean {
    const cell = this.cells.get(key);
    if (!cell || cell.owner !== owner) {
      return false;
    }
    this.disarm(cell);
    cell.snapshot = snapshot;
    cell.retainedAt = ++this.clock;
    // The generation that wrote this is gone; the key is free for the next one.
    cell.owner = null;
    cell.timer = this.setTimer(() => {
      const current = this.cells.get(key);
      if (current === cell && current.snapshot === snapshot) {
        this.cells.delete(key);
      }
    }, this.ttlMs);
    cell.timer.unref?.();
    this.evictOverflow();
    return true;
  }

  /** How many keys currently hold a retained value. */
  get size(): number {
    let count = 0;
    for (const cell of this.cells.values()) {
      if (cell.snapshot !== null) {
        count += 1;
      }
    }
    return count;
  }

  /** Test seam: drop everything, timers included. */
  clear(): void {
    for (const cell of this.cells.values()) {
      this.disarm(cell);
    }
    this.cells.clear();
  }

  private disarm(cell: RetentionCell<TState>): void {
    if (cell.timer !== null) {
      this.clearTimer(cell.timer);
      cell.timer = null;
    }
  }

  private evictOverflow(): void {
    let held: Array<[string, RetentionCell<TState>]> = [];
    for (const entry of this.cells.entries()) {
      if (entry[1].snapshot !== null) {
        held.push(entry);
      }
    }
    if (held.length <= this.maxEntries) {
      return;
    }
    held = held.sort((left, right) => left[1].retainedAt - right[1].retainedAt);
    for (const [key, cell] of held.slice(0, held.length - this.maxEntries)) {
      this.disarm(cell);
      this.cells.delete(key);
    }
  }
}
