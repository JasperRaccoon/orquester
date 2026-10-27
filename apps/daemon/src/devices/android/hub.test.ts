import assert from "node:assert/strict";
import test from "node:test";

import { HUB_BACKOFF_MAX_MS, hubArgs, hubBackoffMs, RECYCLE_AFTER_LAST_VIEWER_MS, RECYCLE_IDLE_MS, shouldRecycle } from "./hub.ts";

test("hub: loopback, token required, streaming only, no token in argv", () => {
  const args = hubArgs(41234);
  assert.deepEqual(args, ["--platform", "android", "--host", "127.0.0.1", "--port", "41234", "--require-token", "--hide-sidebar", "--hide-boot-device"]);
  assert.ok(!args.some((arg) => /token=/.test(arg)));
});

test("hub: exponential restart backoff, capped", () => {
  assert.deepEqual([1, 2, 3, 4].map(hubBackoffMs), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(hubBackoffMs(30), HUB_BACKOFF_MAX_MS);
});

test("hub: with the proxy's counts, recycle shortly after the last stream closed, never while one is open", () => {
  const now = 1_000_000;
  const base = { captureChildren: 2, connections: 3, openViewers: 0, lastViewerLeftAt: now - RECYCLE_AFTER_LAST_VIEWER_MS, lastViewerAt: now - 20_000, idleSince: null, now };
  assert.equal(shouldRecycle(base), true, "pooled HTTP connections do not count once the proxy reports");
  assert.equal(shouldRecycle({ ...base, openViewers: 1 }), false);
  assert.equal(shouldRecycle({ ...base, lastViewerLeftAt: now - 1_000 }), false, "grace for a reconnect");
  assert.equal(shouldRecycle({ ...base, lastViewerLeftAt: null }), false, "never watched since the hub started");
  assert.equal(shouldRecycle({ ...base, captureChildren: 0 }), false);
});

test("hub: without counts, recycle capture sessions only after a full idle minute with no viewer", () => {
  const now = 1_000_000;
  const base = { captureChildren: 2, connections: 0, openViewers: null, lastViewerLeftAt: null, lastViewerAt: null, idleSince: now - RECYCLE_IDLE_MS, now };
  assert.equal(shouldRecycle(base), true);
  assert.equal(shouldRecycle({ ...base, captureChildren: 0 }), false, "nothing to recycle");
  assert.equal(shouldRecycle({ ...base, connections: 1 }), false, "a viewer is connected");
  assert.equal(shouldRecycle({ ...base, idleSince: now - 1_000 }), false, "not idle long enough");
  assert.equal(shouldRecycle({ ...base, idleSince: null }), false);
  assert.equal(shouldRecycle({ ...base, lastViewerAt: now - 5_000 }), false, "the service saw a viewer");
});
