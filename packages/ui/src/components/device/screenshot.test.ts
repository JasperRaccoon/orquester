import assert from "node:assert/strict";
import { it } from "node:test";

import { drawTurned, screenshotTurn, type ScreenshotTurn } from "./screenshot.ts";

/** A 2D context that records where the source's corners land (translate, then rotate, as canvas composes them). */
function recorder() {
  let m = [1, 0, 0, 1, 0, 0]; // a b c d e f
  const corners: [number, number][] = [];
  return {
    corners,
    translate(x: number, y: number) {
      m = [m[0]!, m[1]!, m[2]!, m[3]!, m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
    },
    rotate(angle: number) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      m = [m[0]! * cos + m[2]! * sin, m[1]! * cos + m[3]! * sin, -m[0]! * sin + m[2]! * cos, -m[1]! * sin + m[3]! * cos, m[4]!, m[5]!];
    },
    drawImage(source: { width: number; height: number }) {
      for (const [x, y] of [[0, 0], [source.width, 0], [0, source.height]] as const) {
        corners.push([Math.round(m[0]! * x + m[2]! * y + m[4]!), Math.round(m[1]! * x + m[3]! * y + m[5]!)]);
      }
    }
  };
}

it("iOS frames turn by the stream's screen orientation; Android and already-landscape frames never do", () => {
  const portrait = { width: 1206, height: 2622 };
  assert.equal(screenshotTurn("ios", portrait, "portrait"), 0);
  assert.equal(screenshotTurn("ios", portrait, "landscape_left"), 90);
  assert.equal(screenshotTurn("ios", portrait, "landscape_right"), -90);
  assert.equal(screenshotTurn("ios", portrait, "portrait_upside_down"), 180);
  assert.equal(screenshotTurn("ios", { width: 2622, height: 1206 }, "landscape_left"), 0);
  assert.equal(screenshotTurn("android", portrait, "landscape_left"), 0);
});

it("the turned frame fills its output: corners land where a clockwise turn puts them", () => {
  const source = { width: 4, height: 10 };
  const cases: [ScreenshotTurn, { width: number; height: number }, [number, number][]][] = [
    // top-left, top-right, bottom-left of the source
    [0, { width: 4, height: 10 }, [[0, 0], [4, 0], [0, 10]]],
    [90, { width: 10, height: 4 }, [[10, 0], [10, 4], [0, 0]]],
    [-90, { width: 10, height: 4 }, [[0, 4], [0, 0], [10, 4]]],
    [180, { width: 4, height: 10 }, [[4, 10], [0, 10], [4, 0]]]
  ];
  for (const [turn, size, corners] of cases) {
    const ctx = recorder();
    assert.deepEqual(drawTurned(ctx, source, source.width, source.height, turn), size, `turn ${turn}`);
    assert.deepEqual(ctx.corners.map(([x, y]) => [x + 0, y + 0]), corners, `turn ${turn}`);
  }
});
