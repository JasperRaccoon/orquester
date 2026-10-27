// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
// (the screen description shared by the viewers; the stream itself lives with the device panel).
import type { WebGLRenderer } from "three";
import type { DuoPose } from "./duoControl.ts";
import type { DeviceFrameSink } from "./frame.ts";

/** Local until the Devices contracts land in `@orquester/api`. */
export type DevicePlatform = "ios" | "android";

export type DeviceOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export interface DeviceScreenSize {
  readonly width: number;
  readonly height: number;
  readonly orientation: DeviceOrientation;
  readonly screenId?: number;
  readonly supportsHingeAngle?: boolean;
  readonly supportsPhysicalOrientation?: boolean;
  readonly hingeAngle?: number;
  readonly hingePose?: DuoPose | null;
  readonly tableMode?: boolean;
  readonly tableModeAvailable?: boolean;
}

/** The part of three's `WebGLRenderer` the viewers use; tests substitute a recorder. */
export type DeviceRenderer = Pick<
  WebGLRenderer,
  "outputColorSpace" | "setDrawingBufferSize" | "render" | "dispose" | "forceContextLoss"
>;

/** Per-panel frame sinks the iPhone Duo viewer hands the stream while it is mounted. */
export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
  /** Invalidate captured input synchronously, before React can commit the new layout. */
  readonly onScreen?: (screen: DeviceScreenSize) => void;
}
