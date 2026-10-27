import assert from "node:assert/strict";
import { it } from "node:test";
import { clampUnit, createPointerThrottle } from "./pointer.ts";
import type { TouchPhase } from "./types.ts";

function harness() {
  const sent: Array<[TouchPhase, number, number]> = [];
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const throttle = createPointerThrottle(
    (phase, x, y) => sent.push([phase, x, y]),
    (callback) => {
      frames.set(++next, callback);
      return next;
    },
    (handle) => frames.delete(handle)
  );
  const runFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return { sent, frames, throttle, runFrame };
}

it("sends begin at once and coalesces moves to the latest per animation frame", () => {
  const { sent, frames, throttle, runFrame } = harness();
  throttle.push("begin", 0.1, 0.1);
  throttle.push("move", 0.2, 0.2);
  throttle.push("move", 0.3, 0.3);
  throttle.push("move", 0.4, 0.4);
  assert.equal(frames.size, 1);
  assert.deepEqual(sent, [["begin", 0.1, 0.1]]);
  runFrame();
  assert.deepEqual(sent, [["begin", 0.1, 0.1], ["move", 0.4, 0.4]]);
  runFrame();
  assert.equal(sent.length, 2);
});

it("flushes a pending move before end and cancels its frame", () => {
  const { sent, frames, throttle } = harness();
  throttle.push("begin", 0, 0);
  throttle.push("move", 0.5, 0.5);
  throttle.push("end", 0.6, 0.6);
  assert.deepEqual(sent, [["begin", 0, 0], ["move", 0.5, 0.5], ["end", 0.6, 0.6]]);
  assert.equal(frames.size, 0);
});

it("drops a stale move when a new gesture begins, and everything after dispose", () => {
  const { sent, frames, throttle, runFrame } = harness();
  throttle.push("move", 0.9, 0.9);
  throttle.push("begin", 0.1, 0.1);
  assert.equal(frames.size, 0);
  throttle.push("move", 0.2, 0.2);
  throttle.dispose();
  runFrame();
  throttle.push("end", 0.3, 0.3);
  assert.deepEqual(sent, [["begin", 0.1, 0.1]]);
});

it("clamps coordinates into 0..1", () => {
  assert.deepEqual([clampUnit(-0.2), clampUnit(0.5), clampUnit(1.4), clampUnit(Number.NaN)], [0, 0.5, 1, 0]);
});
