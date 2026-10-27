import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createPointerThrottle } from "./pointer.ts";
import { browserApis, restoreBrowserApis } from "./testing/fakes.ts";
import type { TouchPhase } from "./types.ts";

afterEach(restoreBrowserApis);

function harness() {
  const sent: Array<[TouchPhase, number, number]> = [];
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  browserApis({
    requestAnimationFrame: (callback) => {
      frames.set(++next, callback);
      return next;
    },
    cancelAnimationFrame: (handle) => { frames.delete(handle); }
  });
  const throttle = createPointerThrottle((phase, x, y) => sent.push([phase, x, y]));
  const runFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  return { sent, frames, throttle, runFrame };
}

it("sends begin at once and coalesces moves to the latest per animation frame", () => {
  const { sent, throttle, runFrame } = harness();
  throttle.push("begin", 0.1, 0.1);
  throttle.push("move", 0.2, 0.2);
  throttle.push("move", 0.3, 0.3);
  throttle.push("move", 0.4, 0.4);
  assert.deepEqual(sent, [["begin", 0.1, 0.1]]);
  runFrame();
  assert.deepEqual(sent, [["begin", 0.1, 0.1], ["move", 0.4, 0.4]]);
  runFrame();
  assert.equal(sent.length, 2);
});

it("flushes a pending move before end and cancels its frame", () => {
  const { sent, throttle } = harness();
  throttle.push("begin", 0, 0);
  throttle.push("move", 0.5, 0.5);
  throttle.push("end", 0.6, 0.6);
  assert.deepEqual(sent, [["begin", 0, 0], ["move", 0.5, 0.5], ["end", 0.6, 0.6]]);
});

it("drops a stale move when a new gesture begins, and everything after dispose", () => {
  const { sent, throttle, runFrame } = harness();
  throttle.push("move", 0.9, 0.9);
  throttle.push("begin", 0.1, 0.1);
  throttle.push("move", 0.2, 0.2);
  throttle.dispose();
  runFrame();
  throttle.push("end", 0.3, 0.3);
  assert.deepEqual(sent, [["begin", 0.1, 0.1]]);
});
