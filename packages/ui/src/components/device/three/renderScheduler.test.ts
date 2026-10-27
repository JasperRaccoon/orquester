// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/renderScheduler.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createRenderScheduler } from "./renderScheduler.ts";

it("coalesces frame and pointer invalidations, then stops scheduling when idle or disposed", (t) => {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    });
  }
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pending.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (handle: number) => pending.delete(handle),
  });
  const render = mock.fn();
  const scheduler = createRenderScheduler(render);
  scheduler.invalidate();
  scheduler.invalidate();
  assert.equal(pending.size, 1);
  const first = [...pending.values()][0]!;
  pending.clear();
  first(0);
  assert.equal(render.mock.callCount(), 1);
  assert.equal(pending.size, 0, "idle render does not request another frame");
  scheduler.invalidate();
  const late = [...pending.values()][0]!;
  scheduler.dispose();
  scheduler.dispose();
  scheduler.invalidate();
  assert.equal(pending.size, 0);
  late(0);
  assert.equal(render.mock.callCount(), 1);
});
