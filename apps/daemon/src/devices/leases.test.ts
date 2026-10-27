import assert from "node:assert/strict";
import test from "node:test";

import type { StoredDeviceLease } from "@orquester/config";

import {
  checkAcquire,
  checkAgentAction,
  hostLeasesChanged,
  idleLeases,
  isLiveLease,
  leaseBooted,
  newLease,
  resolveLeaseHandle,
  toLeaseSummary,
  userInput,
  withController
} from "./leases.ts";
import { DeviceError } from "./errors.ts";

const T0 = "2026-10-27T10:00:00.000Z";

function lease(id: string, extra: Partial<StoredDeviceLease> = {}): StoredDeviceLease {
  return {
    ...newLease({ id, threadId: "t1", hostId: "local", platform: "android", profile: "pixel-9", name: "Pixel 9", osVersion: "Android 15", openedBy: "agent", now: T0 }),
    state: "ready",
    deviceId: `emulator-${id}`,
    ...extra
  };
}

const code = (value: unknown) => (value instanceof DeviceError ? value.code : null);

test("a new lease starts with no device, controlled by whoever opened it; booting makes it ready", () => {
  const fresh = newLease({ id: "a", threadId: "t", hostId: "local", platform: "ios", profile: "iphone-17-pro", name: "iPhone 17 Pro", osVersion: "iOS 26", openedBy: "user", now: T0 });
  assert.equal(fresh.state, "starting");
  assert.equal(fresh.deviceId, null);
  assert.equal(fresh.controller, "user");
  assert.equal(toLeaseSummary(fresh)?.key, null);
  const ready = leaseBooted({ ...fresh, error: "old" }, { deviceId: "UDID", name: "", osVersion: "iOS 26.1", stream: { kind: "serve-sim", deviceParam: "UDID" } }, "2026-10-27T10:01:00.000Z");
  assert.equal(ready.state, "ready");
  assert.equal(ready.name, "iPhone 17 Pro");
  assert.equal(ready.osVersion, "iOS 26.1");
  assert.equal(ready.error, undefined);
  assert.equal(toLeaseSummary(ready)?.key, "local/UDID");
  assert.deepEqual(toLeaseSummary(ready)?.stream, { kind: "serve-sim", deviceParam: "UDID" });
});

test("acquire: one device ↔ one live lease; a chat holds at most the limit", () => {
  const leases = [lease("1"), lease("2"), lease("3", { threadId: "t2" })];
  assert.equal(checkAcquire(leases, { threadId: "t1" }, { maxPerThread: 3 }), null);
  assert.equal(code(checkAcquire(leases, { threadId: "t1" }, { maxPerThread: 2 })), "DEVICE_LEASE_LIMIT");
  assert.match(checkAcquire(leases, { threadId: "t1" }, { maxPerThread: 2 })!.message, /close_device/);
  assert.equal(code(checkAcquire(leases, { threadId: "t1", hostId: "local", deviceId: "emulator-3" }, { maxPerThread: 3 })), "DEVICE_BUSY");
  // Already this chat's: fine whatever the limit.
  assert.equal(checkAcquire(leases, { threadId: "t1", hostId: "local", deviceId: "emulator-1" }, { maxPerThread: 1 }), null);
  // Lost and released leases hold nothing.
  assert.equal(checkAcquire([lease("1", { state: "lost" }), lease("2", { state: "released" })], { threadId: "t1" }, { maxPerThread: 1 }), null);
  // A newer build's state holds its device (fail closed).
  assert.ok(isLiveLease(lease("x", { state: "parked-v9" })));
});

test("controller handoff: the user's input takes control; agent input is refused, reads are not", () => {
  const agent = lease("1");
  const user = userInput(agent, "2026-10-27T10:05:00.000Z");
  assert.equal(user.controller, "user");
  assert.equal(user.lastUsedAt, "2026-10-27T10:05:00.000Z");
  assert.equal(code(checkAgentAction(user, "tap")), "DEVICE_CONTROLLED_BY_USER");
  assert.equal(checkAgentAction(user, "snapshot"), null);
  assert.equal(checkAgentAction(user, "screenshot"), null);
  const back = withController(user, "agent", "2026-10-27T10:06:00.000Z");
  assert.equal(checkAgentAction(back, "tap"), null);
  assert.equal(withController(back, "agent", back.lastUsedAt), back);
});

test("agent actions on lost, starting and suspended leases name what to do", () => {
  assert.equal(code(checkAgentAction(lease("1", { state: "lost", error: "box destroyed" }), "snapshot")), "DEVICE_LOST");
  assert.match(checkAgentAction(lease("1", { state: "lost" }), "snapshot")!.message, /open_device/);
  assert.match(checkAgentAction(lease("1", { state: "starting", deviceId: null }), "tap")!.message, /list_devices/);
  assert.equal(code(checkAgentAction(lease("1", { state: "suspended" }), "tap")), "UNAVAILABLE");
});

test("a tool's device handle: key or lease id among the chat's own; none = its only one", () => {
  const leases = [lease("1"), lease("2", { threadId: "t2" }), lease("3", { state: "lost" })];
  assert.equal((resolveLeaseHandle(leases, "t1", "local/emulator-1") as StoredDeviceLease).id, "1");
  assert.equal((resolveLeaseHandle(leases, "t1", "1") as StoredDeviceLease).id, "1");
  assert.equal((resolveLeaseHandle(leases, "t1", undefined) as StoredDeviceLease).id, "1");
  assert.equal((resolveLeaseHandle(leases, "t1", "3") as StoredDeviceLease).state, "lost");
  // Another chat's device is never confirmed.
  assert.equal(code(resolveLeaseHandle(leases, "t1", "local/emulator-2")), "DEVICE_NOT_LEASED");
  assert.equal(code(resolveLeaseHandle([], "t1", undefined)), "DEVICE_NOT_LEASED");
  assert.equal(code(resolveLeaseHandle([lease("1"), lease("4")], "t1", undefined)), "INVALID_ARGUMENT");
});

test("idle: live and lost leases past the idle time; host changes mark leases lost, suspended or back", () => {
  const now = Date.parse("2026-10-27T11:30:00.000Z");
  const leases = [
    lease("old"),
    lease("lost", { state: "lost" }),
    lease("recent", { lastUsedAt: "2026-10-27T11:00:00.000Z" }),
    lease("other-host", { hostId: "box:b1" })
  ];
  assert.deepEqual(idleLeases(leases, now, 60).map((entry) => entry.id), ["old", "lost", "other-host"]);
  assert.deepEqual(hostLeasesChanged(leases, "box:b1", "lost", T0, "gone").map((entry) => [entry.id, entry.state, entry.error]), [["other-host", "lost", "gone"]]);
  const suspended = hostLeasesChanged(leases, "local", "suspended", T0);
  assert.deepEqual(suspended.map((entry) => entry.id), ["old", "recent"]);
  assert.deepEqual(hostLeasesChanged(suspended, "local", "ready", T0).map((entry) => entry.state), ["ready", "ready"]);
});
