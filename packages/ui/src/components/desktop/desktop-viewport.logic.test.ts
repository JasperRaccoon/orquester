import test from "node:test";
import assert from "node:assert/strict";

import {
  baseScale,
  displayToViewport,
  followCursor,
  sharpFitAllowed,
  viewTransform,
  type DesktopViewportGeometry
} from "./desktop-viewport.logic.ts";

const VIEW: DesktopViewportGeometry = {
  width: 1000,
  height: 500,
  left: 0,
  top: 0,
  visibleHeight: 500,
  display: { width: 2000, height: 1000 },
  devicePixelRatio: 1,
  sharp: false
};

test("while zoomed the view follows the cursor 40 px inside the edges, above the soft keyboard", () => {
  // 2×, panned to the top-left corner; the soft keyboard covers the bottom 200 px.
  const geo = { ...VIEW, visibleHeight: 300 };
  const zoom = { zoom: 2, x: 0, y: 0 };
  const cursor = { x: 1950, y: 900 };
  const followed = followCursor(geo, zoom, cursor);
  const at = displayToViewport(geo, viewTransform(geo, followed), cursor);
  assert.deepEqual(at, { x: 960, y: 260 });
  // Already well inside: nothing moves.
  assert.deepEqual(followCursor(geo, zoom, { x: 400, y: 200 }), zoom);
});

test("following stops at the display's edges", () => {
  const followed = followCursor(VIEW, { zoom: 2, x: -500, y: -200 }, { x: 1999, y: 999 });
  // The display's bottom-right corner reaches the view's: no panning past it.
  assert.deepEqual(followed, { zoom: 2, x: -1000, y: -500 });
});

test("unzoomed, the cursor never moves the view", () => {
  assert.deepEqual(followCursor(VIEW, { zoom: 1, x: 0, y: 0 }, { x: 1999, y: 999 }), { zoom: 1, x: 0, y: 0 });
});

test("sharp fit shows a display that would stretch by ≤ 1.25× at one device pixel per display pixel", () => {
  // dpr 2: a 1800×900 display fits a 1000×500 view at 1.11 device px per display px.
  const geo = { ...VIEW, left: 0.3, top: 10.2, display: { width: 1800, height: 900 }, devicePixelRatio: 2, sharp: true };
  const t = viewTransform(geo, { zoom: 1, x: 0, y: 0 });
  const topLeft = displayToViewport(geo, t, { x: 0, y: 0 });
  const bottomRight = displayToViewport(geo, t, { x: 1800, y: 900 });
  assert.ok(Math.abs((bottomRight.x - topLeft.x) * 2 - 1800) < 1e-9, "1800 device px wide");
  assert.ok(Math.abs((bottomRight.y - topLeft.y) * 2 - 900) < 1e-9);
  // The corner sits on the device-pixel grid of the page.
  const corner = (geo.left + topLeft.x) * 2;
  assert.ok(Math.abs(corner - Math.round(corner)) < 1e-9);
  assert.ok(Math.abs((geo.top + topLeft.y) * 2 - Math.round((geo.top + topLeft.y) * 2)) < 1e-9);
  // Stretched more than 1.25×, scaled down, or not allowed: the ordinary fit.
  assert.equal(baseScale({ ...geo, display: { width: 1400, height: 700 } }), 1);
  assert.equal(baseScale({ ...geo, display: { width: 2400, height: 1200 } }), 1);
  assert.equal(baseScale({ ...geo, sharp: false }), 1);
});

test("sharp fit never shrinks a display this viewer sizes to the view", () => {
  const touch = { touchRendering: true, fitDrivesSize: false };
  assert.equal(sharpFitAllowed({ ...touch, textSize: "fit" }), true, "a fixed or another viewer's size");
  assert.equal(sharpFitAllowed({ ...touch, textSize: "more" }), true, "More space is device pixels already");
  assert.equal(sharpFitAllowed({ ...touch, fitDrivesSize: true, textSize: "fit" }), false, "Fit mode following this view");
  assert.equal(sharpFitAllowed({ ...touch, textSize: "large" }), false);
  assert.equal(sharpFitAllowed({ ...touch, textSize: "medium" }), false);
  assert.equal(sharpFitAllowed({ touchRendering: false, fitDrivesSize: false, textSize: "fit" }), false, "mouse rendering");
});
