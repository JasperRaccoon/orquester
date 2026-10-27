// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/deviceMotion.test.ts
import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { Quaternion, Vector3 } from "three";
import { createDeviceMotion } from "./deviceMotion.ts";
import { nearestDeviceView } from "./deviceViewSnap.ts";

const snaps = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"].map(
  (orientation, index) => ({
    orientation,
    rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (-index * Math.PI) / 2),
    yawLimit: Math.PI / 3,
  }),
);
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

it("selects the nearest quarter turn, retains a nearby yaw, and treats quaternion signs identically", () => {
  const side = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
  const released = side.clone().premultiply(rotation(0, 0.4));
  const nearest = nearestDeviceView(released, snaps)!;
  assert.equal(nearest.orientation, "landscape_left");
  assert.ok(nearest.rotation.angleTo(released) < 1e-6);
  const negative = released.clone().set(-released.x, -released.y, -released.z, -released.w);
  assert.ok(nearestDeviceView(negative, snaps)!.rotation.angleTo(nearest.rotation) < 1e-6);
  assert.ok(
    nearestDeviceView(rotation(0, 3), snaps)!.rotation.angleTo(new Quaternion()) <=
      Math.PI / 3 + 1e-6,
  );
});

it("a click without dragging resumes the interrupted resting view instead of stranding the device", () => {
  const choose = mock.fn((_rotation: Quaternion) => new Quaternion());
  const motion = createDeviceMotion({ choose });
  const rest = rotation(0, 0.8);
  motion.setPose(rest, 0);
  motion.advance(50);
  motion.dragActive(true, 50);
  motion.advance(60);
  motion.dragActive(false, 60);
  motion.advance(2100);
  assert.ok(motion.rotation.angleTo(rest) < 1e-6);
  assert.equal(choose.mock.callCount(), 0);
  assert.equal(motion.needsFrame(), false);
});
