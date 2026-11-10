import test from "node:test";
import assert from "node:assert/strict";

import { WheelAccumulator } from "./wheel-steps.ts";

test("small scroll deltas add up to whole wheel steps; the remainder carries over", () => {
  const wheel = new WheelAccumulator();
  assert.deepEqual(wheel.add(0, 20), { x: 0, y: 0 });
  assert.deepEqual(wheel.add(0, 20), { x: 0, y: 0 });
  assert.deepEqual(wheel.add(0, 70), { x: 0, y: 2 });
  assert.deepEqual(wheel.add(-30, -65), { x: 0, y: -1 }, "the 10 px left over count against an upward scroll");
  assert.deepEqual(wheel.add(-30, 0), { x: -1, y: 0 });
  wheel.reset();
  assert.deepEqual(wheel.add(0, 49), { x: 0, y: 0 });
});
