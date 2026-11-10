import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LOOP_CLEARANCE, LOOP_LEVEL_STEP, LOOP_STUB, loopEdgePath, loopLane, loopLevels, roundedPolyline } from "./loop-path.ts";

describe("loop edge geometry", () => {
  it("the lane runs above every card between the two ends, and above both ends", () => {
    const source = { x: 800, y: 130 };
    const target = { x: 100, y: 130 };
    const boxes = [
      { x: 100, y: 100, width: 240, height: 80 },
      { x: 420, y: 20, width: 240, height: 80 }, // a higher card in the span
      { x: 2000, y: -500, width: 240, height: 80 } // far right: not under the loop
    ];
    assert.equal(loopLane(source, target, boxes), 20 - LOOP_CLEARANCE);
    assert.equal(loopLane(source, target, []), 130 - LOOP_CLEARANCE);
    assert.equal(loopLane(source, target, [], 2), 130 - LOOP_CLEARANCE - 2 * LOOP_LEVEL_STEP);
  });

  it("the path goes out right, up to the lane, back left and into the input", () => {
    const { path, labelX, labelY } = loopEdgePath({ x: 500, y: 100 }, { x: 100, y: 100 }, 0, { radius: 0 });
    assert.equal(path, `M 500 100 L ${500 + LOOP_STUB} 100 L ${500 + LOOP_STUB} 0 L ${100 - LOOP_STUB} 0 L ${100 - LOOP_STUB} 100 L 100 100`);
    assert.equal(labelY, 0);
    assert.equal(labelX, 300);
  });

  it("rounds corners, never past half a segment", () => {
    const path = roundedPolyline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 100 }
      ],
      14
    );
    assert.equal(path, "M 0 0 L 5 0 Q 10 0 10 5 L 10 100");
  });

  it("outer loops get higher lanes than the loops they wrap", () => {
    const levels = loopLevels([
      { id: "outer", from: 1000, to: 0 },
      { id: "inner", from: 600, to: 300 },
      { id: "apart", from: 2000, to: 1500 },
      { id: "twin", from: 600, to: 300 }
    ]);
    assert.equal(levels.inner, 0);
    assert.equal(levels.twin, 1, "an equal span stacks above the earlier one");
    assert.equal(levels.outer, 2);
    assert.equal(levels.apart, 0);
  });
});
