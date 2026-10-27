// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/modelScene.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Texture,
} from "three";
import {
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
