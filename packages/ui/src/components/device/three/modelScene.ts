// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/modelScene.ts
import {
  Box3,
  BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Texture,
  TextureLoader,
  type Material,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { DeviceAssetSource } from "./model.ts";
import { createDisplayProjection, updateDisplayUv, type PhoneDisplayLayout } from "./phoneScene.ts";

/** GLB resources belong to one viewer; the live framebuffer texture belongs to its stream presentation. */
export function disposeDeviceModel(root: Object3D) {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap)
      images.add(texture.image);
  }
  for (const image of images) image.close();
}

export function createImportedPhoneScene(
  asset: Group,
  texture: Texture,
  initial: PhoneDisplayLayout,
) {
  const screens: Mesh[] = [];
  asset.traverse((object) => {
    if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
  });
  const display = screens[0];
  if (!display || screens.length !== 1)
    throw new Error("Device model must have one device-screen mesh");
  asset.updateMatrixWorld(true);
  const screenBounds = new Box3().setFromObject(display);
  const screenWidth = screenBounds.max.x - screenBounds.min.x;
  const screenHeight = screenBounds.max.y - screenBounds.min.y;
  if (
    display.matrixWorld.elements.some(
      (value, index) =>
        !Number.isFinite(value) || Math.abs(value - (index % 5 === 0 ? 1 : 0)) > 0.001,
    ) ||
    !Number.isFinite(screenWidth) ||
    !Number.isFinite(screenHeight) ||
    !Number.isFinite(screenBounds.min.z) ||
    !Number.isFinite(screenBounds.max.z) ||
    screenWidth <= 0 ||
    Math.abs(screenHeight - 2.2) > 0.001 ||
    Math.abs(screenBounds.min.x + screenBounds.max.x) > 0.001 ||
    Math.abs(screenBounds.min.y + screenBounds.max.y) > 0.001 ||
    screenBounds.max.z - screenBounds.min.z > 0.001
  )
    throw new Error("Device model display is not normalized");
  updateDisplayUv(display.geometry, screenWidth, screenHeight, initial);
  const originalMaterial = display.material;
  const screenMaterial = new MeshBasicMaterial({ map: texture, toneMapped: false });
  display.material = screenMaterial;
  const root = new Group();
  const orientation = new Group();
  orientation.add(asset);
  root.add(orientation);
  const bounds = new Box3().setFromObject(asset);
  let layout = initial;
  const projection = createDisplayProjection(
    display,
    orientation,
    screenWidth,
    screenHeight,
    () => layout,
  );
  return {
    root,
    orientation,
    width: bounds.max.x - bounds.min.x,
    height: bounds.max.y - bounds.min.y,
    setDisplay(nextTexture: Texture, nextLayout: PhoneDisplayLayout) {
      layout = nextLayout;
      screenMaterial.map = nextTexture;
      updateDisplayUv(display.geometry, screenWidth, screenHeight, layout);
    },
    screenPoint: projection,
    dispose() {
      // The model slot owns imported resources. This scene owns only its replacement screen material.
      display.material = originalMaterial;
      screenMaterial.map = null;
      screenMaterial.dispose();
      orientation.remove(asset);
    },
  };
}

/**
 * Meshopt re-encoding quantizes positions and moves their scale and offset onto each node. The
 * viewer projects touches in the display's own coordinates, so bake that node transform back into
 * a float copy of the display geometry. Other meshes render quantized as they are.
 */
export function bakeDisplayTransform(root: Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (!(object instanceof Mesh) || object.name !== "device-screen") return;
    const parentWorld = object.parent?.matrixWorld ?? new Matrix4();
    if (isIdentity(object.matrixWorld)) return;
    const geometry = object.geometry.clone();
    for (const name of ["position", "normal"] as const) {
      const attribute = geometry.getAttribute(name);
      if (!attribute || (attribute instanceof BufferAttribute && attribute.array instanceof Float32Array))
        continue;
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++)
        for (let c = 0; c < attribute.itemSize; c++)
          values[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      geometry.setAttribute(name, new BufferAttribute(values, attribute.itemSize));
    }
    geometry.applyMatrix4(object.matrixWorld);
    object.geometry.dispose();
    object.geometry = geometry;
    parentWorld.clone().invert().decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
  });
}

const isIdentity = (matrix: Matrix4) =>
  matrix.elements.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) <= 1e-6);

export async function loadDeviceModel(source: DeviceAssetSource, signal: AbortSignal) {
  const response = await fetch(source.url, { signal });
  if (!response.ok) throw new Error(`Device model request failed: ${response.status}`);
  const data = await response.arrayBuffer();
  signal.throwIfAborted();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // GLTFLoader decodes embedded images by `fetch`ing a blob: URL, which the web client's CSP
  // (`connect-src 'self' wss:`) refuses; an <img> load is covered by `img-src blob:`.
  loader.register((parser) => {
    parser.textureLoader = new TextureLoader(parser.options.manager);
    return { name: "orquester_image_element_textures" };
  });
  const gltf = await loader.parseAsync(
    data,
    new URL(".", new URL(source.url, globalThis.location.href)).href,
  );
  if (signal.aborted) {
    disposeDeviceModel(gltf.scene);
    signal.throwIfAborted();
  }
  bakeDisplayTransform(gltf.scene);
  return { asset: gltf.scene, dispose: () => disposeDeviceModel(gltf.scene) };
}
