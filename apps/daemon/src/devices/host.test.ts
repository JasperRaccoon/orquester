import assert from "node:assert/strict";
import test from "node:test";

import { deviceHostSummary } from "./host.ts";
import { FakeDeviceHost } from "./testing.ts";

test("a host summary carries its stream capabilities when the host states them", () => {
  const android = new FakeDeviceHost();
  assert.equal(deviceHostSummary(android).stream, undefined, "a host that says nothing: no field (the panel assumes MJPEG for iOS)");

  const vm = Object.assign(new FakeDeviceHost("box:vm", "box", ["ios"], "Mac host"), { streamCapabilities: () => ({ iosH264: false }) });
  assert.deepEqual(deviceHostSummary(vm).stream, { iosH264: false });

  const mac = Object.assign(new FakeDeviceHost("box:mac", "byo", ["ios"], "Studio Mac"), { streamCapabilities: () => ({ iosH264: true }) });
  assert.deepEqual(deviceHostSummary(mac).stream, { iosH264: true });
});
