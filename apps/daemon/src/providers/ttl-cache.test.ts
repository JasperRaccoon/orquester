import assert from "node:assert/strict";
import test from "node:test";

import { TtlCache } from "./ttl-cache";

test("returns the cached value within the TTL and refetches after it expires", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let fetches = 0;
  const cache = new TtlCache<string>(1000);
  const fetcher = async () => `v${(fetches += 1)}`;

  assert.equal(await cache.get("k", fetcher), "v1");
  t.mock.timers.tick(999);
  assert.equal(await cache.get("k", fetcher), "v1"); // still fresh
  t.mock.timers.tick(2);
  assert.equal(await cache.get("k", fetcher), "v2"); // expired → refetched
  assert.equal(fetches, 2);
});

test("keys are independent and invalidate() drops a single key", async () => {
  const cache = new TtlCache<number>(60_000);
  assert.equal(await cache.get("a", async () => 1), 1);
  assert.equal(await cache.get("b", async () => 2), 2);
  cache.invalidate("a");
  assert.equal(await cache.get("a", async () => 3), 3); // a refetched
  assert.equal(await cache.get("b", async () => 4), 2); // b still cached
});

test("a failed fetch is not cached", async () => {
  const cache = new TtlCache<string>(60_000);
  await assert.rejects(
    cache.get("k", async () => {
      throw new Error("boom");
    })
  );
  assert.equal(await cache.get("k", async () => "ok"), "ok");
});
