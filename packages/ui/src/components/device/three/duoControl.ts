// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/duoControl.ts
import type { DeviceScreenSize } from "./types.ts";

export type DuoPose = "closed" | "book" | "open" | "laptop" | "tent";
export type DuoCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: DuoPose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" }
  | { control: "orientation"; value: DeviceScreenSize["orientation"] };

/**
 * A fold across the closed position hands off in steps, and the outgoing display first reports
 * the incoming one's orientation, so an unsettled screen's orientation does not say how the
 * phone is held. Stands such as Tent can also rest unsettled on the cover.
 */
export function duoScreenSettled(screen: Pick<DeviceScreenSize, "screenId" | "hingeAngle">) {
  const angle = screen.hingeAngle ?? (screen.screenId === 1 ? 0 : 180);
  return (screen.screenId === 1) === (angle === 0);
}

export function createDuoPinch(options: {
  angle: () => number;
  contains: (x: number, y: number) => boolean;
  change: (angle: number | null) => void;
}) {
  let angle: number | null = null;
  return {
    begin(x: number, y: number) {
      if (!options.contains(x, y)) return false;
      angle = Math.max(0, Math.min(180, options.angle()));
      return true;
    },
    move(logScale: number) {
      if (angle === null || !Number.isFinite(logScale)) return;
      const next = Math.max(0, Math.min(180, angle + logScale * 120));
      if (next === angle) return;
      angle = next;
      options.change(next);
    },
    end() {
      if (angle === null) return;
      angle = null;
      options.change(null);
    },
    get active() {
      return angle !== null;
    },
  };
}
