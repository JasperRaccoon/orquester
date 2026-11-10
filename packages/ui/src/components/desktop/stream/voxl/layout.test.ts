import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import { actualSizeBox, clientToDisplayPoint, containBox, cursorScale, displayToClientPoint, fitRequestSize, voxlRequestSize } from "./layout.ts";

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

test("points map through the surface's rendered rect, so a zoomed view maps both ways", () => {
  const display = { width: 1920, height: 1080 };
  // A 960×540 surface at (100, 50), zoomed 2× about the view's origin: rendered at (200, 100), 1920×1080.
  const zoomed = { left: 200, top: 100, width: 1920, height: 1080 };
  assert.deepEqual(clientToDisplayPoint(zoomed, display, 200 + 960, 100 + 540), { x: 960, y: 540 });
  assert.deepEqual(displayToClientPoint(zoomed, display, 960, 540), { x: 1160, y: 640 });
  const back = displayToClientPoint(zoomed, display, 123, 456)!;
  const round = clientToDisplayPoint(zoomed, display, back.x, back.y)!;
  assert.deepEqual([Math.round(round.x * 1e6) / 1e6, Math.round(round.y * 1e6) / 1e6], [123, 456]);
  // Outside the surface, or outside the visible part of a panned one: no display point.
  assert.equal(clientToDisplayPoint(zoomed, display, 199, 300), null);
  assert.equal(clientToDisplayPoint(zoomed, display, 1500, 300, { left: 0, top: 0, width: 1000, height: 800 }), null);
});
