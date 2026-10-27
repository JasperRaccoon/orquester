import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceActionEntry } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { DeviceError } from "./errors.ts";
import { FakeActionExecutor, FakeDeviceHost } from "./testing.ts";
import { runUserAction, type UserActionContext } from "./user-actions.ts";

const signal = new AbortController().signal;

function lease(overrides: Partial<StoredDeviceLease> = {}): StoredDeviceLease {
  return {
    id: "l1",
    threadId: "t1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "user",
    openedBy: "agent",
    createdAt: "2026-10-27T00:00:00.000Z",
    lastUsedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}

function context(over: Partial<UserActionContext> = {}): { ctx: UserActionContext; rows: Partial<DeviceActionEntry>[]; actions: FakeActionExecutor } {
  const rows: Partial<DeviceActionEntry>[] = [];
  const actions = new FakeActionExecutor();
  const ctx: UserActionContext = {
    lease: lease(),
    host: new FakeDeviceHost(),
    actions,
    record: (draft) => {
      rows.push(draft);
      return { id: String(rows.length), leaseId: "l1", at: "now", actor: "user", ...draft };
    },
    powerOff: async () => null,
    summary: () => null,
    logger: { error: () => undefined },
    ...over
  };
  return { ctx, rows, actions };
}

test("a user action needs a ready device on a host that is still there; nothing runs or is logged otherwise", async () => {
  for (const [over, code] of [
    [{ host: null }, "DEVICE_LOST"],
    [{ lease: lease({ state: "lost" }) }, "DEVICE_LOST"],
    [{ lease: lease({ state: "starting", deviceId: null }) }, "UNAVAILABLE"]
  ] as const) {
    const { ctx, rows, actions } = context(over);
    await assert.rejects(runUserAction(ctx, { kind: "rotate", orientation: "portrait" }, signal), (error: unknown) => (error as DeviceError).code === code);
    assert.deepEqual(rows, []);
    assert.deepEqual(actions.calls, []);
  }
});

test("an unexpected failure is logged as the user's failed row and answered UNAVAILABLE", async () => {
  const { ctx, rows, actions } = context();
  actions.result = () => {
    throw new Error("socket hang up");
  };
  await assert.rejects(runUserAction(ctx, { kind: "appearance", appearance: "light" }, signal), (error: unknown) => (error as DeviceError).code === "UNAVAILABLE");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "appearance");
  assert.equal(rows[0]!.ok, false);
  assert.ok(rows[0]!.error && !rows[0]!.error.includes("socket hang up"));
});
