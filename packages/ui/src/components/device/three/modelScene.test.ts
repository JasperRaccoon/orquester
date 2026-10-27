// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/modelScene.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import {
  BoxGeometry,
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
} from "three";
import {
  bakeDisplayTransform,
  createImportedPhoneScene,
  disposeDeviceModel,
} from "./modelScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

function asset() {
  const root = new Group();
  const body = new Mesh(new BoxGeometry(1.15, 2.3, 0.1), new MeshBasicMaterial());
  body.position.z = -0.02;
  const screen = new Mesh(new PlaneGeometry(1, 2.2), new MeshBasicMaterial());
  screen.geometry.translate(0, 0, 0.043);
  screen.name = "device-screen";
  root.add(body, screen);
  return { root, screen, body };
}

it("rejects touches from the rear and preserves borrowed textures when releasing imported resources", () => {
  const { root, screen, body } = asset();
  const texture = new Texture();
  const borrowed = mock.method(texture, "dispose");
  const ownedTexture = new Texture();
  const owned = mock.method(ownedTexture, "dispose");
  body.material.map = ownedTexture;
  const geometry = mock.method(body.geometry, "dispose");
  const phone = createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622));
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  phone.root.rotation.y = Math.PI;
  assert.equal(phone.screenPoint(0.5, 0.5, camera), null);
  phone.dispose();
  assert.equal(borrowed.mock.callCount(), 0);
  assert.equal(geometry.mock.callCount(), 0);
  assert.equal(screen.material.map, null);
  disposeDeviceModel(root);
  assert.equal(owned.mock.callCount(), 1);
  assert.equal(geometry.mock.callCount(), 1);
  assert.equal(borrowed.mock.callCount(), 0);
  texture.dispose();
});

it("rejects missing and incorrectly normalized displays before changing their materials", () => {
  const { root, screen } = asset();
  const original = screen.material;
  const texture = new Texture();
  screen.geometry.scale(1, 2, 1);
  assert.throws(
    () => createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
    /not normalized/,
  );
  assert.equal(screen.material, original);
  screen.geometry.scale(1, 0.5, 1);
  root.rotation.y = Math.PI;
  assert.throws(
    () => createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
    /not normalized/,
  );
  assert.equal(screen.material, original);
  screen.name = "wrong-screen";
  assert.throws(
    () => createImportedPhoneScene(root, texture, phoneDisplayLayout(null, 1206, 2622)),
    /one device-screen/,
  );
  disposeDeviceModel(root);
  texture.dispose();
});

it("bakes a meshopt-quantized display's node transform back into float geometry", () => {
  const { root, screen } = asset();
  const reference = screen.geometry.getAttribute("position");
  // As gltf-transform quantizes: int16 normalized positions, with scale and offset on the node.
  const scale = 1.2;
  const quantized = new Int16Array(reference.count * 3);
  for (let i = 0; i < reference.count; i++)
    for (let c = 0; c < 3; c++)
      quantized[i * 3 + c] = Math.round((reference.getComponent(i, c) / scale) * 32767);
  screen.geometry.setAttribute("position", new BufferAttribute(quantized, 3, true));
  screen.scale.setScalar(scale);
  screen.position.set(0, 0, 0);
  assert.throws(
    () => createImportedPhoneScene(root, new Texture(), phoneDisplayLayout(null, 1206, 2622)),
    /not normalized/,
  );
  bakeDisplayTransform(root);
  const baked = screen.geometry.getAttribute("position");
  assert.ok(baked.array instanceof Float32Array);
  for (let i = 0; i < reference.count; i++)
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(baked.getComponent(i, c) - reference.getComponent(i, c)) < 1e-4);
  assert.deepEqual(screen.scale.toArray(), [1, 1, 1]);
  const phone = createImportedPhoneScene(root, new Texture(), phoneDisplayLayout(null, 1206, 2622));
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 6;
  const center = phone.screenPoint(0.5, 0.5, camera);
  assert.ok(center && Math.abs(center.x - 0.5) < 1e-6 && Math.abs(center.y - 0.5) < 1e-6);
  phone.dispose();
  disposeDeviceModel(root);
});
