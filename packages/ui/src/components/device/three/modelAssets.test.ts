// Every shipped GLB must load through the viewer's loader path (meshopt included) and satisfy the
// scene it is used in. Textures are stubbed: Node has no image decoder.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, it } from "node:test";
import { Box3, Texture, Vector3, type Group } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { bakeDisplayTransform, createImportedPhoneScene, disposeDeviceModel } from "./modelScene.ts";
import { createDuoScene } from "./duoScene.ts";
import { createImportedFoldScene, foldRigHinge } from "./foldModelScene.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

const models = new URL("../models/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("sources.json", models), "utf8")) as {
  models: { id: string; file: string; accessoryNode?: string; fold?: { hinge: string } }[];
};

const globals = globalThis as { self?: unknown };
const hadSelf = "self" in globals;
before(() => {
  // GLTFLoader reaches `self.URL` for embedded images.
  if (!hadSelf) globals.self = globalThis;
});
after(() => {
  if (!hadSelf) delete globals.self;
});

async function load(file: string): Promise<Group> {
  const bytes = readFileSync(new URL(file, models));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => {
    Object.assign(parser, {
      textureLoader: {
        load: (_url: string, onLoad: (texture: Texture) => void) => onLoad(new Texture()),
        setCrossOrigin() {},
        setRequestHeader() {},
      },
    });
    return { name: "test_stub_textures" };
  });
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return (await loader.parseAsync(data as ArrayBuffer, "")).scene;
}

for (const model of manifest.models)
  it(`loads ${model.file} into its viewer scene`, async () => {
    const asset = await load(model.file);
    const bounds = new Box3().setFromObject(asset);
    assert.ok(!bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
    if (model.id === "iphone-duo") {
      createDuoScene(asset, { 1: new Texture(), 3: new Texture() }).dispose();
    } else if (model.fold) {
      // Foldables carry a hinge rig and no single device-screen.
      bakeDisplayTransform(asset);
      assert.equal(foldRigHinge(asset), model.fold.hinge);
      const across = model.fold.hinge === "vertical" ? "x" : "y";
      const inner = new Box3();
      for (const name of ["left", "right", "bottom", "top"]) {
        const display = asset.getObjectByName(`inner-display-${name}`);
        if (display) inner.expandByObject(display);
      }
      // The open inner display is normalized like a device-screen: centred, 2.2 units tall.
      assert.ok(Math.abs(inner.getSize(new Vector3()).y - 2.2) < 0.002, "inner height");
      const center = inner.getCenter(new Vector3());
      assert.ok(Math.abs(center.x) < 0.002 && Math.abs(center.y) < 0.002, "inner centre");
      const layout = phoneDisplayLayout(null, 2208, 1840);
      const fold = createImportedFoldScene(asset, new Texture(), layout, 180);
      const open = new Box3().setFromObject(asset).getSize(new Vector3());
      fold.setAngle(0);
      const closed = new Box3().setFromObject(asset).getSize(new Vector3());
      // Closed, the device is about half as long across the hinge and thicker (the camera bump
      // already sets the open depth).
      const ratio = closed[across] / open[across];
      assert.ok(ratio > 0.45 && ratio < 0.56, `closed/open ${across} ${ratio}`);
      const thicker = closed.z / open.z;
      assert.ok(thicker > 1.2 && thicker < 2.2, `thickness ${open.z} -> ${closed.z}`);
      fold.dispose();
    } else if (model.accessoryNode) {
      // The keyboard is an accessory: no display, mounted in the tablet's frame.
      let screens = 0;
      asset.traverse((object) => void (object.name === "device-screen" && screens++));
      assert.equal(screens, 0);
    } else {
      bakeDisplayTransform(asset);
      const phone = createImportedPhoneScene(asset, new Texture(), phoneDisplayLayout(null, 1206, 2622));
      // The body surrounds a portrait screen 2.2 units tall.
      const size = new Box3().setFromObject(asset).getSize(new Vector3());
      assert.ok(size.y >= 2.2 && size.y < 2.6, `height ${size.y}`);
      assert.ok(size.x / size.y > 0.4 && size.x / size.y < 0.85, `aspect ${size.x / size.y}`);
      phone.dispose();
    }
    disposeDeviceModel(asset);
  });
