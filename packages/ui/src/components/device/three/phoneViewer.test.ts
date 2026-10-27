// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/phoneViewer.test.ts
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import {
  Group,
  Mesh,
  PlaneGeometry,
  Quaternion,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
} from "three";
import { createPhoneViewer } from "./phoneViewer.ts";
import { createFoldRig } from "./foldRig.testing.ts";
import { type DeviceShapeProfile } from "./shapeProfile.ts";
import type { DeviceRenderer } from "./types.ts";

type GpuState = {
  blank: boolean;
  allocations: number;
  disposed: boolean;
  size: { width: number; height: number; pixelRatio: number };
  frames: {
    scene: Scene;
    phone: Object3D | undefined;
    rotation: Quaternion | undefined;
    displayAngle: number | undefined;
    yaw: number | undefined;
    cameraZ: number;
  }[];
};
const gpu = { instances: [] as GpuState[] };

/** Records what the viewer would draw; a stand-in for three's WebGLRenderer. */
class FakeRenderer {
  outputColorSpace = "";
  state: GpuState = {
    blank: true,
    allocations: 0,
    disposed: false,
    size: { width: 0, height: 0, pixelRatio: 1 },
    frames: [],
  };
  constructor() {
    gpu.instances.push(this.state);
  }
  setDrawingBufferSize(width: number, height: number, pixelRatio: number) {
    this.state.size = { width, height, pixelRatio };
    this.state.allocations++;
    this.state.blank = true;
  }
  render(scene: Scene, camera: PerspectiveCamera) {
    const phone = scene.children.find((child) => child.type === "Group");
    this.state.frames.push({
      scene,
      phone,
      rotation: phone?.quaternion.clone(),
      displayAngle: phone?.children[0]?.rotation.z,
      yaw: phone?.rotation.y,
      cameraZ: camera.position.z,
    });
    this.state.blank = false;
  }
  dispose() {
    this.state.disposed = true;
  }
  forceContextLoss() {}
}

type LoadedModel = { asset: Group; dispose: () => void };
const models = {
  pending: [] as { signal: AbortSignal; resolve: (model: LoadedModel) => void }[],
};
const loadModel = (_source: unknown, signal: AbortSignal) =>
  new Promise<LoadedModel>((resolve) => models.pending.push({ signal, resolve }));

const frameGlobals = ["requestAnimationFrame", "cancelAnimationFrame"] as const;
afterEach(() => {
  mock.restoreAll();
  for (const name of frameGlobals) delete (globalThis as Record<string, unknown>)[name];
  gpu.instances.length = 0;
  models.pending.length = 0;
});

function fixture(profile?: DeviceShapeProfile) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  let now = 0;
  mock.method(performance, "now", () => now);
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pending.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => pending.delete(id),
  });
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0 }) as HTMLCanvasElement;
  const source = { width: 1206, height: 2622 } as HTMLCanvasElement;
  const onUnavailable = mock.fn();
  const onFramingAspect = mock.fn((_aspect: number) => {});
  const viewer = createPhoneViewer({
    canvas,
    source,
    onUnavailable,
    onFramingAspect,
    createRenderer: () => new FakeRenderer() as unknown as DeviceRenderer,
    loadModel,
    ...(profile ? { profile } : {}),
  });
  const draw = (time = now) => {
    now = time;
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(0));
  };
  viewer.resize(400, 700, 2);
  draw();
  return {
    viewer,
    draw,
    pending,
    source,
    onUnavailable,
    onFramingAspect,
    state: gpu.instances[0]!,
  };
}

it("rejects incompatible accessories and releases an accessory that finishes after detaching", async () => {
  const { viewer } = fixture();
  const keyboard = {
    id: "ipad-pro-13-m5-magic-keyboard",
    modelId: "ipad-pro-13-m5",
    url: "/keyboard.glb",
  } as const;
  viewer.setAccessory(keyboard);
  assert.equal(models.pending.length, 0);
  viewer.setModel({ id: "ipad-pro-13-m5", url: "/ipad.glb" });
  viewer.setAccessory(keyboard);
  viewer.setAccessory(null);
  assert.equal(models.pending[1]!.signal.aborted, true);
  const dispose = mock.fn();
  const asset = new Group();
  models.pending[1]!.resolve({ asset, dispose });
  await Promise.resolve();
  assert.equal(asset.parent, null);
  assert.equal(dispose.mock.callCount(), 1);
  viewer.dispose();
});

it("folds a foldable model to the reported hinge angle; a slab model ignores it", async () => {
  const { viewer, draw, state, onUnavailable } = fixture();
  viewer.setModel({ id: "galaxy-z-fold8", url: "/fold.glb" });
  const asset = createFoldRig("vertical");
  models.pending[0]!.resolve({ asset, dispose: () => {} });
  await Promise.resolve();
  draw();
  const leaf = asset.getObjectByName("left-half")!;
  // No angle reported yet: shown open, upright.
  assert.equal(leaf.quaternion.w, 1);
  assert.equal(state.frames.at(-1)!.displayAngle, 0);
  viewer.setFoldAngle(0);
  draw(100);
  const midway = leaf.rotation.y;
  assert.ok(midway > 0 && midway < Math.PI, `animating, at ${midway}`);
  draw(2000);
  draw(2000);
  assert.ok(Math.abs(leaf.quaternion.angleTo(new Quaternion()) - Math.PI) < 1e-6);
  viewer.setFoldAngle(null);
  draw(3000);
  assert.ok(Math.abs(leaf.quaternion.angleTo(new Quaternion()) - Math.PI) < 1e-6);

  viewer.setModel({ id: "galaxy-s26", url: "/s26.glb" });
  // Uninstalling the foldable restores its authored pose before the slot disposes it.
  assert.equal(leaf.quaternion.w, 1);
  const slab = new Group();
  const screen = new Mesh(new PlaneGeometry(1, 2.2));
  screen.name = "device-screen";
  slab.add(screen);
  models.pending[1]!.resolve({ asset: slab, dispose: () => {} });
  await Promise.resolve();
  viewer.setFoldAngle(90);
  draw(4000);
  assert.equal(state.frames.at(-1)!.phone?.children[0]?.children[0], slab);
  assert.equal(onUnavailable.mock.callCount(), 0);
  viewer.dispose();
});
