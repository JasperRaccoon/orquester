// Load the shipped bytes through the production loader, including its meshopt configuration.
// Only network transport and browser image decoding are substituted in Node.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, it } from "node:test";
import { Box3, Texture, TextureLoader, Vector3 } from "three";
import { createImportedPhoneScene, loadDeviceModel } from "./modelScene.ts";
import { createDuoScene } from "./duoScene.ts";
import { createImportedFoldScene } from "./foldModelScene.ts";
import type { DeviceAssetSource } from "./model.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

const models = new URL("../models/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("sources.json", models), "utf8")) as {
  models: { id: string; file: string; accessoryNode?: string; fold?: { hinge: string } }[];
};
const globals = globalThis as Record<string, unknown>;
const descriptors = new Map(["self", "location"].map((key) =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
before(() => {
  if (!("self" in globals)) globals.self = globalThis;
  Object.defineProperty(globalThis, "location", {
    value: { href: "http://localhost/" }, configurable: true,
  });
});
after(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globals[key];
  }
});

for (const model of manifest.models)
  it(`loads ${model.file} into its viewer scene`, async (t) => {
    const url = `http://localhost/models/${model.file}`;
    t.mock.method(globalThis, "fetch", async (requested: Parameters<typeof fetch>[0]) => {
      assert.equal(requested, url, "the loader requests the selected asset");
      return new Response(new Uint8Array(readFileSync(new URL(model.file, models))));
    });
    t.mock.method(TextureLoader.prototype, "load", (_url: string, onLoad?: (texture: Texture) => void) => {
      const texture = new Texture();
      onLoad?.(texture);
      return texture;
    });
    const loaded = await loadDeviceModel(
      { id: model.id, url } as DeviceAssetSource, new AbortController().signal,
    );
    const texture = new Texture();
    try {
      const { asset } = loaded;
      const bounds = new Box3().setFromObject(asset);
      // Empty/corrupt content cannot be installed by the viewer, including an accessory.
      assert.ok(!bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
      if (model.id === "iphone-duo") {
        createDuoScene(asset, { 1: texture, 3: texture }).dispose();
      } else if (model.fold) {
        const inner = new Box3();
        for (const name of ["left", "right", "bottom", "top"]) {
          const display = asset.getObjectByName(`inner-display-${name}`);
          if (display) inner.expandByObject(display);
        }
        // Converter format: inner display centred at the origin, 2.2 units tall.
        assert.ok(Math.abs(inner.getSize(new Vector3()).y - 2.2) < 0.002);
        const center = inner.getCenter(new Vector3());
        assert.ok(Math.abs(center.x) < 0.002 && Math.abs(center.y) < 0.002);
        createImportedFoldScene(asset, texture, phoneDisplayLayout(null, 2208, 1840), 180).dispose();
      } else if (!model.accessoryNode) {
        createImportedPhoneScene(asset, texture, phoneDisplayLayout(null, 1206, 2622)).dispose();
      }
    } finally {
      texture.dispose();
      loaded.dispose();
    }
  });
