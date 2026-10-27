import {
  Box3,
  BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
  type Texture,
} from "three";
import type { PhoneDisplayLayout } from "./phoneScene.ts";

/** A book-style fold turns about the vertical axis; a clamshell about the horizontal one. */
export type FoldHinge = "vertical" | "horizontal";

const SIDES = { vertical: ["left", "right"], horizontal: ["bottom", "top"] } as const;

/**
 * The hinge of a converted foldable model (see scripts/convert-device-model.py), or null for a
 * single-body model. The rig's half names give the axis: `left-half`/`right-half` or
 * `bottom-half`/`top-half`.
 */
export function foldRigHinge(asset: Object3D): FoldHinge | null {
  for (const hinge of ["vertical", "horizontal"] as const)
    if (SIDES[hinge].every((side) => asset.getObjectByName(`${side}-half`))) return hinge;
  return null;
}

interface FoldDisplay {
  readonly mesh: Mesh;
  /** Mesh-local coordinates into the plane the display is read in (+Z toward the viewer). */
  readonly toFrame: Matrix4;
  readonly min: Vector2;
  readonly size: Vector2;
}

/**
 * A foldable GLB driven by one Android framebuffer, like the procedural fold scene: open past
 * 90 degrees the inner display shows it across both halves, otherwise the cover display does.
 * The half that carries `cover-display` turns about its origin (on the hinge axis); the other
 * stays put. The optional `hinge` spine turns by half as much and slides in until its inner face
 * meets the fold edge when closed. The model slot owns the asset; this scene owns only its
 * live-screen material and restores the rest pose on dispose.
 */
export function createImportedFoldScene(
  asset: Group,
  texture: Texture,
  initial: PhoneDisplayLayout,
  initialAngle: number,
) {
  const hinge = foldRigHinge(asset);
  if (!hinge) throw new Error("Foldable model must have two hinge halves");
  const [lowSide, highSide] = SIDES[hinge];
  const low = asset.getObjectByName(`${lowSide}-half`)!;
  const high = asset.getObjectByName(`${highSide}-half`)!;
  const cover = asset.getObjectByName("cover-display");
  const innerLow = asset.getObjectByName(`inner-display-${lowSide}`);
  const innerHigh = asset.getObjectByName(`inner-display-${highSide}`);
  if (!(cover instanceof Mesh) || !(innerLow instanceof Mesh) || !(innerHigh instanceof Mesh))
    throw new Error("Foldable model must have a cover display and two inner displays");
  const within = (object: Object3D, ancestor: Object3D) => {
    for (let node: Object3D | null = object; node; node = node.parent)
      if (node === ancestor) return true;
    return false;
  };
  const leaf = within(cover, low) ? low : within(cover, high) ? high : null;
  if (!leaf || !within(innerLow, low) || !within(innerHigh, high) || low.parent !== high.parent)
    throw new Error("Foldable model displays are not on their hinge halves");
  const spine = asset.getObjectByName("hinge") ?? null;
  for (const group of [low, high, spine])
    if (group && !group.quaternion.equals(new Quaternion()))
      throw new Error("Foldable model must be authored open");

  asset.updateMatrixWorld(true);
  const toAsset = (object: Object3D) =>
    new Matrix4().copy(asset.matrixWorld).invert().multiply(object.matrixWorld);
  const pivot = new Vector3().setFromMatrixPosition(toAsset(leaf));
  // The leaf swings toward the viewer: about (direction from the hinge to the leaf) x (+Z).
  const leafCenter = new Box3().setFromObject(leaf).getCenter(new Vector3());
  leafCenter.applyMatrix4(new Matrix4().copy(asset.matrixWorld).invert()).sub(pivot);
  const across =
    hinge === "vertical"
      ? new Vector3(Math.sign(leafCenter.x), 0, 0)
      : new Vector3(0, Math.sign(leafCenter.y), 0);
  const axis = across.clone().cross(new Vector3(0, 0, 1));
  if (axis.lengthSq() === 0) throw new Error("Foldable model leaf lies on its hinge");
  const closed = new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeRotationAxis(axis, Math.PI))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));

  // Each display reads the framebuffer as it faces the viewer: the inner pair open, the cover
  // closed.
  const frame = (meshes: Mesh[], pose: Matrix4): FoldDisplay[] => {
    const bounds = new Box3();
    const point = new Vector3();
    const transforms = meshes.map((mesh) => pose.clone().multiply(toAsset(mesh)));
    meshes.forEach((mesh, index) => {
      const position = mesh.geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++)
        bounds.expandByPoint(
          point.fromBufferAttribute(position, i).applyMatrix4(transforms[index]!),
        );
    });
    const size = bounds.getSize(new Vector3());
    if (![size.x, size.y].every((value) => Number.isFinite(value) && value > 0))
      throw new Error("Invalid foldable display bounds");
    return meshes.map((mesh, index) => ({
      mesh,
      toFrame: transforms[index]!,
      min: new Vector2(bounds.min.x, bounds.min.y),
      size: new Vector2(size.x, size.y),
    }));
  };
  const inner = frame([innerLow, innerHigh], new Matrix4());
  const [outer] = frame([cover], closed);
  const displays = [...inner, outer!];
  const uvAt = (display: FoldDisplay, local: Vector3) => {
    const p = local.clone().applyMatrix4(display.toFrame);
    return new Vector2(
      (p.x - display.min.x) / display.size.x,
      (p.y - display.min.y) / display.size.y,
    );
  };
  const point = new Vector3();
  for (const display of displays) {
    const position = display.mesh.geometry.getAttribute("position");
    const uv = new Float32Array(position.count * 2);
    for (let i = 0; i < position.count; i++) {
      const value = uvAt(display, point.fromBufferAttribute(position, i));
      uv[i * 2] = value.x;
      uv[i * 2 + 1] = value.y;
    }
    display.mesh.geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  }

  const restBounds = new Box3();
  asset.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    restBounds.union(object.geometry.boundingBox!.clone().applyMatrix4(toAsset(object)));
  });
  const restSize = restBounds.getSize(new Vector3());
  // Closed, the spine's inner face (its front, behind the hinge axis) meets the fold edge.
  const spineRest = spine?.position.clone() ?? null;
  let spineInset = 0;
  if (spine) {
    const local = new Matrix4().copy(spine.matrixWorld).invert();
    const bounds = new Box3();
    spine.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const relative = local.clone().multiply(object.matrixWorld);
      bounds.union(object.geometry.boundingBox!.clone().applyMatrix4(relative));
    });
    spineInset = Math.max(0, -bounds.max.z);
  }

  const root = new Group();
  const orientation = new Group();
  const content = new Group();
  content.add(asset);
  orientation.add(content);
  root.add(orientation);
  const live = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const originals = new Map(displays.map(({ mesh }) => [mesh, mesh.material] as const));
  const relative = new Matrix4();
  const inverse = new Matrix4();
  const currentBounds = new Box3();
  let layout = initial;
  let angle = Number.NaN;
  let innerActive = false;
  const active = () => (innerActive ? inner : [outer!]);
  const setAngle = (next: number) => {
    const clamped = Math.max(0, Math.min(180, Number.isFinite(next) ? next : 180));
    if (clamped === angle) return;
    angle = clamped;
    const turn = Math.PI * (1 - angle / 180);
    leaf.quaternion.setFromAxisAngle(axis, turn);
    if (spine && spineRest) {
      spine.quaternion.setFromAxisAngle(axis, turn / 2);
      spine.position
        .set(0, 0, (spineInset * (1 - Math.cos(turn))) / 2)
        .applyQuaternion(spine.quaternion)
        .add(spineRest);
    }
    innerActive = angle >= 90;
    for (const display of displays)
      display.mesh.material = active().includes(display) ? live : originals.get(display.mesh)!;
    // Keep the device centred on the orbit pivot as it folds.
    content.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    inverse.copy(content.matrixWorld).invert();
    currentBounds.makeEmpty();
    asset.traverse((object) => {
      if (!(object instanceof Mesh) || !object.geometry.boundingBox) return;
      relative.multiplyMatrices(inverse, object.matrixWorld);
      currentBounds.union(object.geometry.boundingBox.clone().applyMatrix4(relative));
    });
    content.position.copy(currentBounds.getCenter(new Vector3())).negate();
  };
  setAngle(initialAngle);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let captured: FoldDisplay | null = null;
  return {
    root,
    orientation,
    hinge,
    width: restSize.x,
    height: restSize.y,
    setAngle,
    setDisplay(nextTexture: Texture, nextLayout: PhoneDisplayLayout) {
      layout = nextLayout;
      live.map = nextTexture;
    },
    screenPoint(x: number, y: number, camera: Camera, extend = false) {
      root.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      pointer.set(x * 2 - 1, 1 - y * 2);
      raycaster.setFromCamera(pointer, camera);
      const screens = active();
      const hit = raycaster.intersectObjects(
        screens.map((display) => display.mesh),
        false,
      )[0];
      if (!hit && !extend) {
        captured = null;
        return null;
      }
      const display = hit
        ? screens.find((candidate) => candidate.mesh === hit.object)!
        : captured && screens.includes(captured)
          ? captured
          : screens[0]!;
      let local: Vector3;
      if (hit) {
        captured = display;
        local = display.mesh.worldToLocal(hit.point.clone());
      } else {
        // A held touch past the edge: project onto the display's plane and clamp.
        const toLocal = new Matrix4().copy(display.toFrame).invert();
        const normal = new Vector3(0, 0, 1)
          .transformDirection(toLocal)
          .transformDirection(display.mesh.matrixWorld);
        if (!display.mesh.geometry.boundingBox) display.mesh.geometry.computeBoundingBox();
        const origin = display.mesh.geometry
          .boundingBox!.getCenter(new Vector3())
          .applyMatrix4(display.mesh.matrixWorld);
        const target = raycaster.ray.intersectPlane(
          new Plane().setFromNormalAndCoplanarPoint(normal, origin),
          new Vector3(),
        );
        if (!target) return null;
        local = display.mesh.worldToLocal(target);
      }
      const uv = uvAt(display, local);
      const u = Math.max(0, Math.min(1, uv.x));
      const v = Math.max(0, Math.min(1, 1 - uv.y));
      return layout.rotation === Math.PI ? { x: 1 - u, y: 1 - v } : { x: u, y: v };
    },
    dispose() {
      for (const [mesh, material] of originals) mesh.material = material;
      live.map = null;
      live.dispose();
      leaf.quaternion.identity();
      if (spine && spineRest) {
        spine.quaternion.identity();
        spine.position.copy(spineRest);
      }
      content.remove(asset);
      captured = null;
    },
  };
}
