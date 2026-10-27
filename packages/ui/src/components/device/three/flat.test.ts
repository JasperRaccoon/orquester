import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deviceScreenAspect,
  flatMediaRotation,
  flatScreenPoint,
  flatViewPoint,
} from "./flat.ts";
const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not near ${expected}`);

describe("flat pointer mapping", () => {
  const screen = { left: 100, top: 40, width: 200, height: 400 };

  it("normalizes over the letterboxed screen, not the host", () => {
    assert.deepEqual(flatScreenPoint(screen, 100, 40, false), { x: 0, y: 0 });
    assert.deepEqual(flatScreenPoint(screen, 300, 440, false), { x: 1, y: 1 });
    assert.deepEqual(flatScreenPoint(screen, 150, 340, false), { x: 0.25, y: 0.75 });
  });

  it("starts a touch only on the screen and clamps a captured one at its edges", () => {
    assert.equal(flatScreenPoint(screen, 99, 200, false), null);
    assert.equal(flatScreenPoint(screen, 200, 441, false), null);
    assert.deepEqual(flatScreenPoint(screen, 20, 900, true), { x: 0, y: 1 });
    assert.deepEqual(flatScreenPoint(screen, 999, -5, true), { x: 1, y: 0 });
  });

  it("rejects an unmeasured screen and non-finite positions", () => {
    assert.equal(flatScreenPoint({ ...screen, width: 0 }, 150, 100, true), null);
    assert.equal(flatScreenPoint(screen, Number.NaN, 100, true), null);
  });

});

describe("flat layout", () => {
  it("reports the native framebuffer aspect in its visible orientation", () => {
    near(deviceScreenAspect("ios", { width: 1206, height: 2622 }, "portrait"), 1206 / 2622);
    near(deviceScreenAspect("ios", { width: 1206, height: 2622 }, "landscape_left"), 2622 / 1206);
    near(deviceScreenAspect("android", { width: 2400, height: 1080 }, "landscape_right"), 2400 / 1080);
  });

  it("turns an iOS portrait framebuffer to the reported interface orientation only", () => {
    const portrait = { width: 1206, height: 2622 };
    assert.equal(flatMediaRotation("ios", portrait, "portrait"), 0);
    assert.equal(flatMediaRotation("ios", portrait, "landscape_left"), 90);
    assert.equal(flatMediaRotation("ios", portrait, "landscape_right"), -90);
    assert.equal(flatMediaRotation("ios", portrait, "portrait_upside_down"), 180);
    assert.equal(flatMediaRotation("ios", { width: 2622, height: 1206 }, "landscape_left"), 0);
    assert.equal(flatMediaRotation("android", portrait, "landscape_left"), 0);
  });
});

describe("flatViewPoint", () => {
  it("maps screen coordinates to pixels from the viewport's top-left", () => {
    const screen = { left: 120, top: 60, width: 200, height: 400 };
    const root = { left: 100, top: 50 };
    assert.deepEqual(flatViewPoint(screen, root, 0, 0), { x: 20, y: 10 });
    assert.deepEqual(flatViewPoint(screen, root, 0.5, 0.25), { x: 120, y: 110 });

  });
  it("clamps to the screen and refuses an unsized screen", () => {
    assert.deepEqual(flatViewPoint({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0 }, 2, -1), { x: 10, y: 0 });
    assert.equal(flatViewPoint({ left: 0, top: 0, width: 0, height: 10 }, { left: 0, top: 0 }, 0.5, 0.5), null);
  });
});
