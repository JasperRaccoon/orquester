import assert from "node:assert/strict";
import test from "node:test";

import { hubArgs, shouldRecycle } from "./hub.ts";

test("hub: Android streaming uses loopback and requires authentication", () => {
  const args = hubArgs(41234);
  for (const [flag, value] of [["--platform", "android"], ["--host", "127.0.0.1"], ["--port", "41234"]]) assert.equal(args[args.indexOf(flag!) + 1], value);
  for (const flag of ["--require-token", "--hide-sidebar", "--hide-boot-device"]) assert.ok(args.includes(flag), flag);
});

test("hub: with the proxy's counts, recycle shortly after the last stream closed, never while one is open", () => {
  const now = 1_000_000;
  const base = { captureChildren: 2, connections: 3, openViewers: 0, lastViewerLeftAt: now - 15_000, lastViewerAt: now - 20_000, idleSince: null, now };
  assert.equal(shouldRecycle(base), true, "pooled HTTP connections do not count once the proxy reports");
  assert.equal(shouldRecycle({ ...base, openViewers: 1 }), false);
  assert.equal(shouldRecycle({ ...base, lastViewerLeftAt: now - 1_000 }), false, "grace for a reconnect");
  assert.equal(shouldRecycle({ ...base, lastViewerLeftAt: null }), false, "never watched since the hub started");
  assert.equal(shouldRecycle({ ...base, captureChildren: 0 }), false);
});

test("hub: without counts, recycle capture sessions only after a full idle minute with no viewer", () => {
  const now = 1_000_000;
  const base = { captureChildren: 2, connections: 0, openViewers: null, lastViewerLeftAt: null, lastViewerAt: null, idleSince: now - 60_000, now };
  assert.equal(shouldRecycle(base), true);
  assert.equal(shouldRecycle({ ...base, captureChildren: 0 }), false, "nothing to recycle");
  assert.equal(shouldRecycle({ ...base, connections: 1 }), false, "a viewer is connected");
  assert.equal(shouldRecycle({ ...base, idleSince: now - 1_000 }), false, "not idle long enough");
  assert.equal(shouldRecycle({ ...base, idleSince: null }), false);
  assert.equal(shouldRecycle({ ...base, lastViewerAt: now - 5_000 }), false, "the service saw a viewer");
});
