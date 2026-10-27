// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/renderScheduler.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createRenderScheduler } from "./renderScheduler.ts";

it("coalesces frame and pointer invalidations, then stops scheduling when idle or disposed", () => {
  const callbacks: FrameRequestCallback[] = [];
  const request = mock.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const cancel = mock.fn((_id: number) => {});
  const render = mock.fn(() => {});
  const scheduler = createRenderScheduler(render, request, cancel);
  scheduler.invalidate();
  scheduler.invalidate();
  assert.equal(request.mock.callCount(), 1);
  callbacks[0]?.(0);
  assert.equal(render.mock.callCount(), 1);
  assert.equal(request.mock.callCount(), 1);
  scheduler.invalidate();
  scheduler.dispose();
  scheduler.dispose();
  scheduler.invalidate();
  callbacks[1]?.(0);
  assert.equal(cancel.mock.callCount(), 1);
  assert.deepEqual(cancel.mock.calls[0]!.arguments, [2]);
  assert.equal(render.mock.callCount(), 1);
  assert.equal(request.mock.callCount(), 2);
});
