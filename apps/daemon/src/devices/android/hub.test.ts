import assert from "node:assert/strict";
import test from "node:test";

import { HUB_BACKOFF_MAX_MS, hubArgs, hubBackoffMs, RECYCLE_IDLE_MS, shouldRecycle } from "./hub.ts";

test("hub: loopback, token required, streaming only, no token in argv", () => {
  const args = hubArgs(41234);
  assert.deepEqual(args, ["--platform", "android", "--host", "127.0.0.1", "--port", "41234", "--require-token", "--hide-sidebar", "--hide-boot-device"]);
  assert.ok(!args.some((arg) => /token=/.test(arg)));
});

test("hub: exponential restart backoff, capped", () => {
  assert.deepEqual([1, 2, 3, 4].map(hubBackoffMs), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(hubBackoffMs(30), HUB_BACKOFF_MAX_MS);
});

test("hub: recycle capture sessions only after a full idle minute with no viewer", () => {
  const now = 1_000_000;
  const base = { captureChildren: 2, connections: 0, lastViewerAt: null, idleSince: now - RECYCLE_IDLE_MS, now };
  assert.equal(shouldRecycle(base), true);
  assert.equal(shouldRecycle({ ...base, captureChildren: 0 }), false, "nothing to recycle");
  assert.equal(shouldRecycle({ ...base, connections: 1 }), false, "a viewer is connected");
  assert.equal(shouldRecycle({ ...base, idleSince: now - 1_000 }), false, "not idle long enough");
  assert.equal(shouldRecycle({ ...base, idleSince: null }), false);
  assert.equal(shouldRecycle({ ...base, lastViewerAt: now - 5_000 }), false, "the service saw a viewer");
});
