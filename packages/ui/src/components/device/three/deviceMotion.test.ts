// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/deviceMotion.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import { Quaternion, Vector3 } from "three";
import { createDeviceMotion } from "./deviceMotion.ts";
const rotation = (x: number, y: number, z = 0) =>
  new Quaternion().setFromAxisAngle(new Vector3(x, y, z).normalize(), Math.hypot(x, y, z));

it("a click without dragging resumes the interrupted resting view instead of stranding the device", () => {
  const motion = createDeviceMotion({ choose: () => new Quaternion() });
  const rest = rotation(0, 0.8);
  motion.setPose(rest, 0);
  motion.advance(50);
  motion.dragActive(true, 50);
  motion.advance(60);
  motion.dragActive(false, 60);
  motion.advance(2100);
  assert.ok(motion.rotation.angleTo(rest) < 1e-6);
  assert.equal(motion.needsFrame(), false);
});
