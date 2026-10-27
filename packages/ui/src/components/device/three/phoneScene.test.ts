// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/phoneScene.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Mesh, PerspectiveCamera, Texture, Vector3 } from "three";
import { createPhoneScene, phoneDisplayLayout } from "./phoneScene.ts";
import { IOS_TABLET_SHAPE, IOS_PHONE_SHAPE } from "./shapeProfile.ts";

const orientations = [
  "portrait",
  "landscape_left",
  "landscape_right",
  "portrait_upside_down",
] as const;

const closeTo = (actual: number | undefined, expected: number, digits = 2) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 10 ** -digits / 2,
    `expected ${actual} to be close to ${expected}`,
  );

describe("3D phone input", () => {
  for (const profile of [IOS_TABLET_SHAPE, IOS_PHONE_SHAPE])
    it(`preserves input projection for the ${profile.id} silhouette in every orientation`, () => {
      for (const orientation of orientations) {
        const texture = new Texture();
        const aspect = profile.id === "ios-tablet" ? 0.75 : 0.45;
        const layout = phoneDisplayLayout(
          { width: 1200 * aspect, height: 1200, orientation },
          1200 * aspect,
          1200,
        );
        const phone = createPhoneScene(texture, layout, profile);
        const camera = new PerspectiveCamera(32, 0.65, 0.1, 30);
        camera.position.z = 6 / (orientation === "portrait" ? 0.6 : 2.2);
        camera.updateMatrixWorld(true);
        phone.root.rotation.set(0.2, -0.3, 0, "YXZ");
        phone.orientation.rotation.z = layout.rotation;
        phone.root.updateMatrixWorld(true);
        // Read a fixed noncentral location on the rendered framebuffer surface. The camera's
        // projection is independent of both input mapping and overlay projection.
        let display: Mesh | undefined;
        phone.root.traverse((object) => {
          if (object instanceof Mesh && !Array.isArray(object.material) &&
              "map" in object.material && object.material.map === texture) display = object;
        });
        assert.ok(display);
        display.geometry.computeBoundingBox();
        const bounds = display.geometry.boundingBox!;
        const point = new Vector3().lerpVectors(bounds.min, bounds.max, 0.25);
        display.localToWorld(point).project(camera);
        const hit = phone.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
        const expected =
          orientation === "landscape_left"
            ? { x: 0.25, y: 0.25 }
            : orientation === "landscape_right"
              ? { x: 0.75, y: 0.75 }
              : orientation === "portrait_upside_down"
                ? { x: 0.75, y: 0.25 }
                : { x: 0.25, y: 0.75 };
        closeTo(hit?.x, expected.x);
        closeTo(hit?.y, expected.y);
        if (profile.id === "ios-phone") {
          const overlay = phone.viewPoint(expected.x, expected.y, camera);
          closeTo(overlay?.x, (point.x + 1) / 2);
          closeTo(overlay?.y, (1 - point.y) / 2);
          assert.equal(phone.viewPoint(Number.NaN, 0.5, camera), null);
        }
        phone.dispose();
        texture.dispose();
      }
    });
  it("rejects new gestures outside the display, but clamps captured drags at its edge", () => {
    const texture = new Texture();
    const phone = createPhoneScene(texture, phoneDisplayLayout(null, 900, 1950));
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 5;
    assert.equal(phone.screenPoint(1, 0.5, camera), null);
    assert.deepEqual(phone.screenPoint(1, 0.5, camera, true), { x: 1, y: 0.5 });
    phone.root.rotation.y = Math.PI;
    assert.equal(phone.screenPoint(0.5, 0.5, camera), null);
    phone.dispose();
    texture.dispose();
  });
});
