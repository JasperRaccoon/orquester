// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/duoViewer.test.ts
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Texture,
  type PerspectiveCamera,
  type Quaternion,
  type Scene,
} from "three";
import { createDuoViewer } from "./duoViewer.ts";
import type { DeviceRenderer } from "./types.ts";

type GpuState = {
  blank: boolean;
  allocations: number;
  frames: Scene[];
  views: { camera: PerspectiveCamera; bounds: Box3; quaternion: Quaternion }[];
  dispose: ReturnType<typeof mock.fn>;
  forceContextLoss: ReturnType<typeof mock.fn>;
};
const gpu = { instances: [] as GpuState[], environmentDispose: mock.fn() };

/** Records what the viewer would draw; a stand-in for three's WebGLRenderer. */
class FakeRenderer {
  outputColorSpace = "";
  state: GpuState = {
    blank: true,
    allocations: 0,
    frames: [],
    views: [],
    dispose: mock.fn(),
    forceContextLoss: mock.fn(),
  };
  constructor() {
    gpu.instances.push(this.state);
  }
  setDrawingBufferSize() {
    this.state.blank = true;
    this.state.allocations++;
  }
  render(scene: Scene, camera: PerspectiveCamera) {
    this.state.blank = false;
    this.state.frames.push(scene);
    const root = scene.children.find((child) => child instanceof Group)!;
    root.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    this.state.views.push({
      camera: camera.clone(),
      bounds: new Box3().setFromObject(root),
      quaternion: root.quaternion.clone(),
    });
  }
  dispose() {
    this.state.dispose();
  }
  forceContextLoss() {
    this.state.forceContextLoss();
  }
}

type LoadedModel = { asset: Group; dispose: () => void };
const models = {
  resolve: (_model: LoadedModel) => {},
  signal: null as AbortSignal | null,
};
const loadModel = (_source: unknown, signal: AbortSignal) => {
  models.signal = signal;
  return new Promise<LoadedModel>((resolve) => {
    models.resolve = resolve;
  });
};

const stubbedGlobals = [
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "document",
] as const;
afterEach(() => {
  mock.timers.reset();
  for (const name of stubbedGlobals) delete (globalThis as Record<string, unknown>)[name];
  gpu.instances.length = 0;
  gpu.environmentDispose.mock.resetCalls();
});

function fixture(
  reduced = true,
  onOrientationRequested = mock.fn(),
  onPanelRequested?: (panel: 1 | 3) => void,
) {
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  const drawImage = mock.fn((_source: unknown, ..._rest: unknown[]) => {});
  Object.assign(globalThis, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      pending.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => pending.delete(id),
    matchMedia: () => ({ matches: reduced }),
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          save() {},
          restore() {},
          translate() {},
          rotate() {},
          drawImage,
          getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(255) }),
        }),
      }),
    },
  });
  const canvas = new EventTarget() as HTMLCanvasElement;
  const viewer = createDuoViewer({
    canvas,
    sources: {
      1: { width: 1398, height: 2034 } as HTMLCanvasElement,
      3: { width: 2007, height: 2853 } as HTMLCanvasElement,
    },
    model: { id: "iphone-duo", url: "/duo.glb" },
    onUnavailable: mock.fn(),
    onOrientationRequested,
    createRenderer: () => new FakeRenderer() as unknown as DeviceRenderer,
    createEnvironment: () => ({ texture: new Texture(), dispose: gpu.environmentDispose }),
    loadModel,
    ...(onPanelRequested ? { onPanelRequested } : {}),
  });
  const draw = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { viewer, draw, pending, state: gpu.instances[0]!, onOrientationRequested, drawImage };
}

function asset() {
  const group = new Group();
  for (const [name, names] of [
    ["left-half", ["cover-display", "inner-display-left"]],
    ["right-half", ["inner-display-right"]],
  ] as const) {
    const leaf = new Group();
    leaf.name = name;
    for (const name of names) {
      const mesh = new Mesh(new PlaneGeometry(1, 2), new MeshBasicMaterial());
      if (name === "cover-display") mesh.geometry.rotateY(Math.PI);
      mesh.geometry.translate(
        name === "inner-display-right" ? 0.5 : -0.5,
        0,
        name === "cover-display" ? -0.05 : 0.05,
      );
      mesh.name = name;
      leaf.add(mesh);
    }
    group.add(leaf);
  }
  return group;
}

it("cancels loading and disposes a late model after unmount without installing or rendering it", async () => {
  const { viewer, draw, state } = fixture();
  viewer.resize(400, 700, 2);
  viewer.dispose();
  assert.equal(models.signal?.aborted, true);
  const dispose = mock.fn();
  models.resolve({ asset: asset(), dispose });
  await Promise.resolve();
  draw();
  assert.equal(dispose.mock.callCount(), 1);
  assert.equal(state.frames.length, 0);
});

it("uses the elected primary frame during handoff and never lets a stale fixed-panel feed overwrite it", async () => {
  const { viewer, drawImage } = fixture();
  const cover = {
    width: 1398,
    height: 2034,
    orientation: "portrait" as const,
    screenId: 1,
    hingeAngle: 90,
  };
  viewer.setScreen(cover);
  const primary = { width: 1398, height: 2034 } as HTMLCanvasElement;
  viewer.frameUpdated(1, primary);
  assert.equal(drawImage.mock.calls.at(-1)?.arguments[0], primary);
  const uploads = drawImage.mock.callCount();
  viewer.frameUpdated(1);
  assert.equal(drawImage.mock.callCount(), uploads);
  viewer.frameUpdated(3, primary);
  assert.equal(drawImage.mock.callCount(), uploads);
  viewer.setScreen({ ...cover, width: 2007, height: 2853, screenId: 3 });
  const inner = { width: 2007, height: 2853 } as HTMLCanvasElement;
  viewer.frameUpdated(3, inner);
  assert.equal(drawImage.mock.calls.at(-1)?.arguments[0], inner);
  viewer.setScreen(cover);
  viewer.frameUpdated(1);
  assert.ok(drawImage.mock.callCount() > uploads + 1);
  viewer.dispose();
});
