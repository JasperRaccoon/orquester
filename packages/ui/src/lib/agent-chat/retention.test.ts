import assert from "node:assert/strict";
import { it } from "node:test";

import { ThreadRetentionCache } from "./retention";

it("evicts the oldest retention past the cap", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const cache = new ThreadRetentionCache<string>();
  for (let index = 0; index < 25; index += 1) {
    const key = `thread-${index}`;
    cache.retain(key, cache.claim(key), { state: key, sequence: index });
  }
  assert.equal(cache.take("thread-0"), null);
  assert.deepEqual(cache.take("thread-1"), { state: "thread-1", sequence: 1 });
  assert.deepEqual(cache.take("thread-24"), { state: "thread-24", sequence: 24 });
});
