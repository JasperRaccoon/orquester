import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ThreadRetentionCache } from "./retention";

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
}

function fakeTimers(): {
  options: { setTimer: (fn: () => void, ms: number) => never; clearTimer: (h: never) => void };
  run(after: number): void;
  pending(): number;
} {
  let next = 1;
  const timers = new Map<number, FakeTimer>();
  return {
    options: {
      setTimer: (fn, ms) => {
        const id = next++;
        timers.set(id, { id, fn, ms });
        return id as never;
      },
      clearTimer: (handle) => {
        timers.delete(handle as unknown as number);
      }
    },
    run(after) {
      for (const timer of [...timers.values()]) {
        if (timer.ms <= after) {
          timers.delete(timer.id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size
  };
}

const cache = (
  overrides: Partial<{ ttlMs: number; maxEntries: number }> = {}
): {
  cache: ThreadRetentionCache<string>;
  timers: ReturnType<typeof fakeTimers>;
} => {
  const timers = fakeTimers();
  return {
    cache: new ThreadRetentionCache<string>({ ttlMs: 1_000, ...overrides, ...timers.options }),
    timers
  };
};

describe("the retained-thread cache", () => {
  it("hands a retained value back to the next generation and removes it", () => {
    const { cache: store } = cache();
    const owner = store.claim("a");
    assert.equal(store.retain("a", owner, { state: "folded", sequence: 7 }), true);
    assert.equal(store.size, 1);

    const taken = store.take("a");
    assert.deepEqual(taken, { state: "folded", sequence: 7 });
    assert.equal(store.size, 0);
    assert.equal(store.take("a"), null, "a taken value is not handed out twice");
  });

  it("drops a retained value once its idle TTL elapses", () => {
    const { cache: store, timers } = cache({ ttlMs: 1_000 });
    const owner = store.claim("a");
    store.retain("a", owner, { state: "folded", sequence: 7 });
    assert.equal(store.size, 1);

    timers.run(1_000);
    assert.equal(store.size, 0);
    assert.equal(store.take("a"), null);
  });

  it("disarms the TTL when the value is taken — a mounted consumer is not idle", () => {
    const { cache: store, timers } = cache();
    const owner = store.claim("a");
    store.retain("a", owner, { state: "folded", sequence: 7 });
    store.take("a");
    assert.equal(timers.pending(), 0);
  });

  it("refuses a write from a generation that no longer owns the key", () => {
    const { cache: store } = cache();
    const stale = store.claim("a");
    const fresh = store.claim("a");

    assert.equal(store.isOwner("a", stale), false);
    assert.equal(store.retain("a", stale, { state: "stale", sequence: 1 }), false);
    assert.equal(store.size, 0, "nothing was written");

    assert.equal(store.retain("a", fresh, { state: "fresh", sequence: 9 }), true);
    assert.deepEqual(store.peek("a"), { state: "fresh", sequence: 9 });
  });

  it("does not let a stale generation overwrite the current retained value", () => {
    const { cache: store } = cache();
    const stale = store.claim("a");
    const fresh = store.claim("a");
    store.retain("a", fresh, { state: "fresh", sequence: 9 });

    assert.equal(store.retain("a", stale, { state: "stale", sequence: 1 }), false);
    assert.deepEqual(store.peek("a"), { state: "fresh", sequence: 9 });
  });

  it("frees the key after a retention, so the next generation may claim it", () => {
    const { cache: store } = cache();
    const first = store.claim("a");
    store.retain("a", first, { state: "one", sequence: 1 });
    assert.equal(store.retain("a", first, { state: "again", sequence: 2 }), false);

    assert.deepEqual(store.take("a"), { state: "one", sequence: 1 });
    const second = store.claim("a");
    assert.equal(store.retain("a", second, { state: "two", sequence: 2 }), true);
  });

  it("evicts the oldest retention past the cap", () => {
    const { cache: store } = cache({ maxEntries: 2 });
    for (const key of ["a", "b", "c"]) {
      store.retain(key, store.claim(key), { state: key, sequence: 1 });
    }
    assert.equal(store.size, 2);
    assert.equal(store.peek("a"), null, "the oldest retention went first");
    assert.deepEqual(store.peek("b"), { state: "b", sequence: 1 });
    assert.deepEqual(store.peek("c"), { state: "c", sequence: 1 });
  });

  it("clears everything, timers included", () => {
    const { cache: store, timers } = cache();
    store.retain("a", store.claim("a"), { state: "a", sequence: 1 });
    store.clear();
    assert.equal(store.size, 0);
    assert.equal(timers.pending(), 0);
  });
});
