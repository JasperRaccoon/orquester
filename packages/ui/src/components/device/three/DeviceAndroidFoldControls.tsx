// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/DeviceAndroidFoldControls.tsx
// (presentation only; reading and setting the posture is the device panel's request).
import { DeviceDuoGlyph } from "./DeviceDuoGlyph.tsx";
import { DeviceControlButton, DeviceControlError } from "./DeviceDuoControls.tsx";

export type AndroidFoldPosture = "closed" | "half_opened" | "opened" | "flipped" | "tent";

/** The hinge angle the 3D foldable shows for a reported posture. */
export function androidFoldAngle(posture: AndroidFoldPosture | null, hingeAngle: number | null) {
  if (hingeAngle !== null && Number.isFinite(hingeAngle))
    return Math.max(0, Math.min(180, hingeAngle));
  return posture === "closed" ? 0 : 180;
}

export function DeviceAndroidFoldControls(props: {
  readonly posture: AndroidFoldPosture | null;
  /** A posture change is in flight; it owns the posture until it settles. */
  readonly pending: boolean;
  readonly enabled: boolean;
  readonly error: string | null;
  readonly onChange: (posture: "closed" | "opened") => void;
}) {
  const disabled = props.pending || !props.enabled;
  return (
    <div aria-label="Android fold controls" className="flex flex-col items-center gap-2">
      <div className="pointer-events-auto flex shrink-0 flex-col items-center gap-1 rounded-full border border-neutral-700/60 bg-neutral-900/80 p-1 shadow-sm">
        <DeviceControlButton
          label="Fold device"
          pressed={props.posture === "closed"}
          disabled={disabled}
          onClick={() => props.onChange("closed")}
        >
          <DeviceDuoGlyph pose="closed" />
        </DeviceControlButton>
        <DeviceControlButton
          label="Unfold device"
          pressed={props.posture === "opened"}
          disabled={disabled}
          onClick={() => props.onChange("opened")}
        >
          <DeviceDuoGlyph pose="open" />
        </DeviceControlButton>
      </div>
      <DeviceControlError error={props.error} />
    </div>
  );
}
