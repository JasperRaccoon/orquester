import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PerspectiveCamera, Texture, Vector3 } from "three";
import {
  deviceScreenAspect,
  flatDeviceGeometry,
  flatDeviceScale,
  flatMediaRotation,
  flatMediaStyle,
  flatScreenPoint,
  flatViewPoint,
} from "./flat.ts";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import { ANDROID_PHONE_SHAPE, IOS_PHONE_SHAPE } from "./shapeProfile.ts";
import type { DeviceOrientation } from "./types.ts";

const orientations: DeviceOrientation[] = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
];
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

  // The 3D viewer reports touches in the screen's visible orientation; flat must agree, so the
  // same device coordinates reach the stream whichever view the user picked.
  for (const orientation of orientations)
    it(`agrees with the 3D projection on every visible corner in ${orientation}`, () => {
      const layout = phoneDisplayLayout({ width: 1206, height: 2622, orientation }, 1206, 2622);
      const phone = createPhoneScene(new Texture(), layout, IOS_PHONE_SHAPE);
      phone.orientation.rotation.z = layout.rotation;
      phone.root.updateMatrixWorld(true);
      const camera = new PerspectiveCamera(32, 1, 0.1, 30);
      camera.position.z = 6;
      camera.updateMatrixWorld(true);
      const halfWidth = (2.2 * layout.aspect * 0.96) / 2;
      const halfHeight = (2.2 * 0.96) / 2;
      for (const [sx, sy] of [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ] as const) {
        const world = phone.orientation.localToWorld(
          new Vector3(sx * halfWidth, sy * halfHeight, 0.043),
        );
        const ndc = world.clone().project(camera);
        const hit = phone.screenPoint((ndc.x + 1) / 2, (1 - ndc.y) / 2, camera);
        assert.ok(hit);
        // Where that corner shows on screen, as the flat view lays it out.
        const visible = { x: world.x > 0 ? 1 : 0, y: world.y > 0 ? 0 : 1 };
        near(hit.x, visible.x, 0.03);
        near(hit.y, visible.y, 0.03);
        const rect = { left: 0, top: 0, width: 10, height: 20 };
        assert.deepEqual(
          flatScreenPoint(rect, visible.x * 10, visible.y * 20, false),
          visible,
        );
      }
      phone.dispose();
    });
});

describe("flat layout", () => {
  it("reports the visible aspect, defaulting by platform before a frame", () => {
    near(deviceScreenAspect("ios", { width: 1206, height: 2622 }, "portrait"), 1206 / 2622);
    near(deviceScreenAspect("ios", { width: 1206, height: 2622 }, "landscape_left"), 2622 / 1206);
    near(deviceScreenAspect("android", { width: 2400, height: 1080 }, "landscape_right"), 2400 / 1080);
    near(deviceScreenAspect("ios", null, "portrait"), 9 / 19.5);
    near(deviceScreenAspect("android", { width: 0, height: 0 }, "portrait"), 9 / 20);
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

  it("sizes a sideways frame so that, once rotated, it covers the screen exactly", () => {
    const style = flatMediaStyle({ width: 400, height: 200 }, 90);
    assert.deepEqual(
      { width: style.width, height: style.height, left: style.left, top: style.top },
      { width: 200, height: 400, left: 100, top: -100 },
    );
    assert.equal(style.transform, "rotate(90deg)");
    assert.deepEqual(flatMediaStyle({ width: 200, height: 400 }, 0), {
      width: 200,
      height: 400,
      left: 0,
      top: 0,
    });
  });

  it("draws the bezel from the shape profile and turns it with the device", () => {
    const aspect = 1206 / 2622;
    const portrait = flatDeviceGeometry(IOS_PHONE_SHAPE, aspect, "portrait");
    near(portrait.width, 2.2 * aspect + 2 * IOS_PHONE_SHAPE.bezel);
    near(portrait.height, 2.2 + 2 * IOS_PHONE_SHAPE.bezel);
    assert.deepEqual(
      [portrait.screen.x, portrait.screen.y],
      [IOS_PHONE_SHAPE.bezel, IOS_PHONE_SHAPE.bezel],
    );
    // The power button sits on the right edge, above the middle.
    const power = portrait.buttons[0]!;
    assert.ok(power.x > portrait.width && power.y + power.height / 2 < portrait.height / 2);

    // Turned a quarter clockwise (landscape_left), the right edge becomes the bottom and its
    // upper half the bottom's right half.
    const left = flatDeviceGeometry(IOS_PHONE_SHAPE, aspect, "landscape_left");
    near(left.width, portrait.height);
    near(left.height, portrait.width);
    near(left.screen.width, 2.2);
    const turned = left.buttons[0]!;
    assert.ok(turned.y > left.height && turned.x + turned.width / 2 > left.width / 2);
    near(turned.width, power.height);

    const right = flatDeviceGeometry(IOS_PHONE_SHAPE, aspect, "landscape_right");
    assert.ok(right.buttons[0]!.y + right.buttons[0]!.height < 0);
    const upside = flatDeviceGeometry(ANDROID_PHONE_SHAPE, 9 / 20, "portrait_upside_down");
    assert.ok(upside.buttons.every((button) => button.x + button.width < 0));
  });

  it("fits the device and its buttons inside the host", () => {
    const geometry = flatDeviceGeometry(IOS_PHONE_SHAPE, 1206 / 2622, "portrait");
    const scale = flatDeviceScale(geometry, { width: 400, height: 400 });
    assert.ok(scale > 0 && geometry.height * scale < 400 && geometry.width * scale < 400);
    assert.equal(flatDeviceScale(geometry, { width: 0, height: 400 }), 0);
  });
});

describe("flatViewPoint", () => {
  it("maps a screen point to pixels from the viewport's top-left and inverts flatScreenPoint", () => {
    const screen = { left: 120, top: 60, width: 200, height: 400 };
    const root = { left: 100, top: 50 };
    assert.deepEqual(flatViewPoint(screen, root, 0, 0), { x: 20, y: 10 });
    assert.deepEqual(flatViewPoint(screen, root, 0.5, 0.25), { x: 120, y: 110 });
    const seen = flatViewPoint(screen, root, 0.3, 0.7)!;
    const back = flatScreenPoint(screen, seen.x + root.left, seen.y + root.top, false)!;
    assert.ok(Math.abs(back.x - 0.3) < 1e-9 && Math.abs(back.y - 0.7) < 1e-9);
  });
  it("clamps to the screen and refuses an unsized screen", () => {
    assert.deepEqual(flatViewPoint({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0 }, 2, -1), { x: 10, y: 0 });
    assert.equal(flatViewPoint({ left: 0, top: 0, width: 0, height: 10 }, { left: 0, top: 0 }, 0.5, 0.5), null);
  });
});
