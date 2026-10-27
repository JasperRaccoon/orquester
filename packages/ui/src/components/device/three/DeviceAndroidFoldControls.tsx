// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/DeviceAndroidFoldControls.tsx
// (presentation only; reading and setting the posture is the device panel's request).
export type AndroidFoldPosture = "closed" | "half_opened" | "opened" | "flipped" | "tent";

/** The hinge angle the 3D foldable shows for a reported posture. */
export function androidFoldAngle(posture: AndroidFoldPosture | null, hingeAngle: number | null) {
  if (hingeAngle !== null && Number.isFinite(hingeAngle))
    return Math.max(0, Math.min(180, hingeAngle));
  return posture === "closed" ? 0 : 180;
}
