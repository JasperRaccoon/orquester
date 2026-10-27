// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/duoControl.test.ts
import assert from "node:assert/strict";
import { it, mock, type Mock } from "node:test";
import { createDuoPinch } from "./duoControl.ts";

const lastArgs = (fn: Mock<(...args: any[]) => unknown>) => fn.mock.calls.at(-1)?.arguments;

it("pinches only a hit device, accumulates independently of native readback, clamps and cancels", () => {
  let confirmed = 90;
  const change = mock.fn((_angle: number | null) => {});
  const pinch = createDuoPinch({
    angle: () => confirmed,
    contains: (x, y) => x > 0.2 && y > 0.2,
    change,
  });
  assert.equal(pinch.begin(0.1, 0.5), false);
  pinch.move(1);
  assert.equal(change.mock.callCount(), 0);
  assert.equal(pinch.begin(0.5, 0.5), true);
  pinch.move(0.25);
  const first = lastArgs(change)![0] as number;
  assert.ok(first > 90 && first < 180);
  confirmed = 0;
  pinch.move(0.25);
  assert.ok((lastArgs(change)![0] as number) > first, "native readback cannot rewind an ongoing pinch");
  pinch.move(2);
  assert.deepEqual(lastArgs(change), [180]);
  pinch.move(-3);
  assert.deepEqual(lastArgs(change), [0]);
  pinch.move(NaN);
  assert.ok(change.mock.calls.every(({ arguments: [angle] }) => angle === null || Number.isFinite(angle)), "non-finite pinch input must not reach native angle control");
  pinch.end();
  assert.deepEqual(lastArgs(change), [null]);
  const count = change.mock.callCount();
  pinch.move(1);
  pinch.end();
  assert.equal(change.mock.callCount(), count);
  assert.equal(pinch.active, false);
});
