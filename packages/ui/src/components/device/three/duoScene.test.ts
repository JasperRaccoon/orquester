// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/duoScene.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
  Vector3,
} from "three";
import { createDuoScene, duoDisplayKey } from "./duoScene.ts";

const closeTo = (actual: number | undefined, expected: number, digits = 2) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 10 ** -digits / 2,
    `expected ${actual} to be close to ${expected}`,
  );

function fixture() {
  const asset = new Group();
  const left = new Group();
  left.name = "left-half";
  const right = new Group();
  right.name = "right-half";
  const screen = (name: string, x: number, z: number, rear = false) => {
    const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
    if (rear) mesh.geometry.rotateY(Math.PI);
    mesh.geometry.translate(x, 0, z);
    mesh.name = name;
    return mesh;
  };
  const innerLeft = screen("inner-display-left", -0.5, 0.06);
  const innerRight = screen("inner-display-right", 0.5, 0.06);
  const cover = screen("cover-display", -0.5, -0.06, true);
  left.add(innerLeft, cover);
  right.add(innerRight);
  for (const [group, x] of [
    [left, -0.5],
    [right, 0.5],
  ] as const) {
    const body = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshBasicMaterial());
    body.geometry.translate(x, 0, 0);
    group.add(body);
  }
  asset.add(left, right);
  const scene = createDuoScene(asset, { 1: new Texture(), 3: new Texture() });
  const camera = new PerspectiveCamera(36, 1, 0.1, 50);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  return { scene, camera, left, right, innerLeft, innerRight };
}

it("maps active display input through hardware mounting and blocks rear, inactive and stale surfaces", () => {
  const { scene, camera, innerLeft } = fixture();
  scene.setAngle(180);
  const screen = { width: 2007, height: 2853, orientation: "portrait" as const, screenId: 3 };
  const key = duoDisplayKey(screen);
  scene.root.updateMatrixWorld();
  const world = innerLeft.localToWorld(new Vector3(-0.5, -0.5, 0.06)).project(camera);
  const x = (world.x + 1) / 2,
    y = (1 - world.y) / 2;
  const hit = scene.screenPoint(x, y, camera, screen, key);
  closeTo(hit?.x, 0.75);
  closeTo(hit?.y, 0.75);
  assert.equal(
    scene.screenPoint(
      x,
      y,
      camera,
      { ...screen, screenId: 1 },
      duoDisplayKey({ ...screen, screenId: 1 }),
    ),
    null,
  );
  assert.equal(scene.screenPoint(x, y, camera, screen, "old"), null);
  assert.notEqual(scene.screenPoint(x, y, camera, screen, key), null);
  assert.ok((scene.screenPoint(x, 1.1, camera, screen, key, true)?.x ?? -Infinity) > 1);
  scene.dispose();
});
