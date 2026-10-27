import assert from "node:assert/strict";
import test from "node:test";

import type { StoredDeviceLease } from "@orquester/config";

import {
  checkAcquire,
  hostLeasesChanged,
  idleLeases,
  isLiveLease,
  newLease,
  resolveLeaseHandle
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
  assert.deepEqual(hostLeasesChanged(leases, "box:b1", "lost", "gone").map((entry) => [entry.id, entry.state, entry.error]), [["other-host", "lost", "gone"]]);
  const suspended = hostLeasesChanged(leases, "local", "suspended");
  assert.deepEqual(suspended.map((entry) => entry.id), ["old", "recent"]);
  assert.deepEqual(hostLeasesChanged(suspended, "local", "ready").map((entry) => entry.state), ["ready", "ready"]);
});
