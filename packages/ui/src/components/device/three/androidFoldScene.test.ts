// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/androidFoldScene.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PerspectiveCamera, Texture, Vector3 } from "three";
import { createAndroidFoldScene } from "./androidFoldScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

const closeTo = (actual: number | undefined, expected: number, digits = 2) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 10 ** -digits / 2,
    `expected ${actual} to be close to ${expected}`,
  );

describe("Android fold scene", () => {
  it("maps touches on each open half and the closed cover to the live frame", () => {
    const texture = new Texture();
    const scene = createAndroidFoldScene(texture, phoneDisplayLayout(null, 2200, 1840), 180);
    const camera = new PerspectiveCamera(32, 1, 0.1, 30);
    camera.position.z = 6;
    camera.updateMatrixWorld(true);
    const project = (x: number) => {
      const point = new Vector3(x, 0, 0.041).project(camera);
      return scene.screenPoint((point.x + 1) / 2, (1 - point.y) / 2, camera);
    };
    closeTo(project(-0.52)?.x, 0.25, 1);
    closeTo(project(0.52)?.x, 0.75, 1);
    assert.equal(scene.screenPoint(0.99, 0.5, camera, true)?.x, 1);
    scene.setAngle(0);
    closeTo(project(0.52)?.x, 0.5, 1);
    scene.dispose();
    texture.dispose();
  });
});
