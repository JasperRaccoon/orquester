import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import { actualSizeBox, containBox, cursorScale, fitRequestSize, voxlRequestSize } from "./layout.ts";

test("Fit asks for the container's device pixels on voxl's grid (width ×8, height even)", () => {
  assert.deepEqual(fitRequestSize({ width: 1000, height: 700 }, 2), { width: 2000, height: 1400 });
  assert.deepEqual(fitRequestSize({ width: 1013, height: 701.5 }, 1.5), { width: 1520, height: 1052 });
  assert.equal(fitRequestSize({ width: 0, height: 700 }, 2), null);
});

test("size requests are clamped to the desktop size limits", () => {
  assert.deepEqual(fitRequestSize({ width: 100, height: 50 }, 1), { width: DESKTOP_MIN_WIDTH, height: DESKTOP_MIN_HEIGHT });
  assert.deepEqual(voxlRequestSize({ width: 20_000, height: 9_999 }), { width: DESKTOP_MAX_WIDTH, height: DESKTOP_MAX_HEIGHT });
  // An exact size on the grid is unchanged, so its hello matches the request.
  assert.deepEqual(voxlRequestSize({ width: 1280, height: 800 }), { width: 1280, height: 800 });
});

test("the display is contained and centered, or 1:1 and centered only where it fits", () => {
  assert.deepEqual(containBox({ width: 1000, height: 1000 }, { width: 2000, height: 1000 }), {
    left: 0,
    top: 250,
    width: 1000,
    height: 500,
    scale: 0.5
  });
  assert.deepEqual(actualSizeBox({ width: 1000, height: 1000 }, { width: 2000, height: 800 }), {
    left: 0,
    top: 100,
    width: 2000,
    height: 800,
    scale: 1
  });
});

test("the cursor follows the display's scale but stays a usable size", () => {
  assert.equal(cursorScale(1, 32, 32), 1);
  assert.equal(cursorScale(0.25, 32, 32), 24 / 32);
  assert.equal(cursorScale(8, 32, 32), 128 / 32);
});
