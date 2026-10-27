import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box3, Group, Mesh, PerspectiveCamera, Texture, Vector3, type Object3D } from "three";
import { createImportedFoldScene, foldRigHinge } from "./foldModelScene.ts";
import { createFoldRig, FOLD_RIG } from "./foldRig.testing.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

const closeTo = (actual: number | undefined, expected: number, tolerance = 0.02) =>
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < tolerance,
    `expected ${actual} to be close to ${expected}`,
  );

function view(hinge: "vertical" | "horizontal", angle: number) {
  const asset = createFoldRig(hinge);
  const texture = new Texture();
  const layout = phoneDisplayLayout(null, 2200, 1840);
  const scene = createImportedFoldScene(asset, texture, layout, angle);
  const camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.z = 8;
  camera.updateMatrixWorld(true);
  /** Touch at an asset-local point of a display mesh, as seen through the camera. */
  const touch = (name: string, local = new Vector3()) => {
    scene.root.updateMatrixWorld(true);
    const world = asset.getObjectByName(name)!.localToWorld(local.clone()).project(camera);
    return scene.screenPoint((world.x + 1) / 2, (1 - world.y) / 2, camera);
  };
  return { asset, texture, scene, camera, touch };
}

/** The cover display's plane in its half's frame (origin on the hinge axis). */
const coverZ = -FOLD_RIG.depth - 0.001 - FOLD_RIG.pivotZ;
const node = (asset: Object3D, name: string) => asset.getObjectByName(name)!;
const map = (asset: Object3D, name: string) =>
  ((node(asset, name) as Mesh).material as { map?: Texture | null }).map ?? null;

describe("foldable model scene", () => {
  it("reads the hinge axis from the rig's half names", () => {
    assert.equal(foldRigHinge(createFoldRig("vertical")), "vertical");
    assert.equal(foldRigHinge(createFoldRig("horizontal")), "horizontal");
    assert.equal(foldRigHinge(new Group()), null);
    const layout = phoneDisplayLayout(null, 1, 1);
    assert.throws(() => createImportedFoldScene(new Group(), new Texture(), layout, 180));
  });

  it("maps a book fold's open halves and its closed cover to the one framebuffer", () => {
    const { asset, texture, scene, camera, touch } = view("vertical", 180);
    closeTo(touch("inner-display-left")?.x, 0.25);
    closeTo(touch("inner-display-right")?.x, 0.75);
    closeTo(touch("inner-display-left")?.y, 0.5);
    // Toward the top of the display is toward the top of the frame.
    assert.ok(touch("inner-display-left", new Vector3(0, 0.8, 0))!.y < 0.2);
    assert.equal(map(asset, "inner-display-left"), texture);
    assert.notEqual(map(asset, "cover-display"), texture);
    // A held touch dragged past the edge clamps to it.
    assert.equal(scene.screenPoint(0.99, 0.5, camera, true)?.x, 1);
    assert.equal(scene.screenPoint(0.99, 0.5, camera), null);

    scene.setAngle(0);
    assert.equal(map(asset, "cover-display"), texture);
    assert.notEqual(map(asset, "inner-display-left"), texture);
    closeTo(touch("cover-display")?.x, 0.5);
    // Closed, the cover's outer edge (far from the hinge) lies on the right as seen.
    const outer = node(asset, "cover-display").worldToLocal(
      node(asset, "left-half").localToWorld(new Vector3(-0.9, 0, coverZ)),
    );
    assert.ok(touch("cover-display", outer)!.x > 0.85);
    scene.dispose();
  });

  it("swings the folding half toward the viewer and seats the spine at the fold edge", () => {
    const { asset, scene } = view("vertical", 90);
    const standing = new Box3().setFromObject(node(asset, "left-half"));
    const lying = new Box3().setFromObject(node(asset, "right-half"));
    assert.ok(standing.max.z - lying.max.z > FOLD_RIG.across * 0.9, "left half toward +Z");
    scene.setAngle(0);
    const right = new Box3().setFromObject(node(asset, "right-half"));
    const left = new Box3().setFromObject(node(asset, "left-half"));
    // Closed: stacked over the right half, inner faces together, half the open width.
    closeTo(left.min.x, right.min.x, 0.01);
    assert.ok(left.min.z >= right.max.z - 0.011);
    const spine = node(asset, "hinge");
    closeTo(spine.position.x, -(FOLD_RIG.spineFront - FOLD_RIG.pivotZ), 1e-6);
    closeTo(spine.rotation.y, Math.PI / 2, 1e-6);
    scene.dispose();
    // Disposing restores the authored open pose and the asset's own materials.
    assert.equal(node(asset, "left-half").quaternion.w, 1);
    assert.equal(spine.position.z, FOLD_RIG.pivotZ);
    assert.equal(map(asset, "cover-display"), null);
    assert.equal(asset.parent, null);
  });

  it("folds a clamshell about its horizontal hinge with the cover on the top half", () => {
    const { asset, texture, scene, touch } = view("horizontal", 180);
    closeTo(touch("inner-display-top")?.y, 0.25);
    closeTo(touch("inner-display-bottom")?.y, 0.75);
    closeTo(touch("inner-display-top")?.x, 0.5);
    scene.setAngle(90);
    const standing = new Box3().setFromObject(node(asset, "top-half"));
    const lying = new Box3().setFromObject(node(asset, "bottom-half"));
    assert.ok(standing.max.z - lying.max.z > FOLD_RIG.across * 0.9, "top half toward +Z");
    assert.equal(node(asset, "bottom-half").quaternion.w, 1);
    scene.setAngle(0);
    assert.equal(map(asset, "cover-display"), texture);
    closeTo(touch("cover-display")?.y, 0.5);
    // The cover's far edge (the top when open) is at the bottom when closed.
    const far = node(asset, "cover-display").worldToLocal(
      node(asset, "top-half").localToWorld(new Vector3(0, 0.9, coverZ)),
    );
    assert.ok(touch("cover-display", far)!.y > 0.85);
    scene.dispose();
  });

  it("flips touches for an upside-down frame and refuses a rig authored folded", () => {
    const { scene, touch } = view("vertical", 180);
    const upsideDown = { width: 2200, height: 1840, orientation: "portrait_upside_down" } as const;
    scene.setDisplay(new Texture(), phoneDisplayLayout(upsideDown, 2200, 1840));
    closeTo(touch("inner-display-left")?.x, 0.75);
    scene.dispose();
    const folded = createFoldRig("vertical");
    node(folded, "left-half").rotation.y = 1;
    assert.throws(
      () => createImportedFoldScene(folded, new Texture(), phoneDisplayLayout(null, 1, 1), 180),
      /authored open/,
    );
  });
});
