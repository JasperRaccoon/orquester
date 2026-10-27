// A small synthetic foldable in the shape `scripts/convert-device-model.py` emits: two halves
// whose origins sit on the hinge axis just in front of the inner display, a cover display on the
// back of the folding half, and a spine behind the axis.
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from "three";
import type { FoldHinge } from "./foldModelScene.ts";

export const FOLD_RIG = {
  /** Each half's extent across the hinge and along it, and the body depth. */
  across: 1,
  along: 2.2,
  depth: 0.1,
  /** The hinge axis lies this far in front of the inner display (at z = 0). */
  pivotZ: 0.01,
  /** The spine's front face, behind the axis. */
  spineFront: -0.02,
} as const;

/**
 * Vertical: `left-half` folds (cover on its back) onto `right-half`. Horizontal: `top-half` folds
 * onto `bottom-half`. One inner display carries a node scale, as meshopt quantization leaves.
 */
export function createFoldRig(hinge: FoldHinge) {
  const { across, along, depth, pivotZ, spineFront } = FOLD_RIG;
  const vertical = hinge === "vertical";
  // Asset-space position for a point `a` across the hinge and `b` along it.
  const at = (a: number, b: number, z: number) =>
    vertical ? new Vector3(a, b, z) : new Vector3(b, a, z);
  const size = (a: number, b: number) => (vertical ? [a, b] : [b, a]) as [number, number];
  const pivot = new Vector3(0, 0, pivotZ);
  const black = new MeshBasicMaterial({ color: 0x000000 });
  const body = new MeshBasicMaterial({ color: 0x808080 });
  const asset = new Group();
  const [low, high] = vertical ? (["left", "right"] as const) : (["bottom", "top"] as const);
  const moving = vertical ? low : high;
  const place = (group: Group, mesh: Mesh, position: Vector3) => {
    mesh.position.copy(position).sub(pivot);
    group.add(mesh);
    return mesh;
  };
  for (const [side, sign] of [
    [low, -1],
    [high, 1],
  ] as const) {
    const half = new Group();
    half.name = `${side}-half`;
    half.position.copy(pivot);
    asset.add(half);
    const center = (sign * across) / 2;
    const shell = new Mesh(new BoxGeometry(...size(across, along), depth), body);
    place(half, shell, at(center, 0, -depth / 2 + 0.005));
    const inner = new Mesh(new PlaneGeometry(...size(across * 0.95, along * 0.95)), black);
    inner.name = `inner-display-${side}`;
    place(half, inner, at(center, 0, 0));
    if (side === high) {
      // Quantized geometry: a scaled node holding shrunken vertices.
      inner.geometry.scale(0.8, 0.8, 0.8);
      inner.scale.setScalar(1.25);
    }
    if (side === moving) {
      const cover = new Mesh(new PlaneGeometry(...size(across * 0.9, along * 0.9)), black);
      cover.name = "cover-display";
      cover.rotation.y = Math.PI;
      place(half, cover, at(center, 0, -depth - 0.001));
    }
  }
  const spine = new Group();
  spine.name = "hinge";
  spine.position.copy(pivot);
  asset.add(spine);
  const spineCover = new Mesh(new BoxGeometry(...size(0.06, along), 0.08), body);
  place(spine, spineCover, at(0, 0, spineFront - 0.04));
  return asset;
}
