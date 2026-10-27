// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/mountDeviceViewer.ts
import { createPhoneInteraction } from "./phoneInteraction.ts";
import { bindPhoneTrackpad } from "./phoneTrackpad.ts";

type PhoneInteraction = ReturnType<typeof createPhoneInteraction>;
type TrackpadPinch = NonNullable<Parameters<typeof bindPhoneTrackpad>[2]>;

interface MountableViewer {
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly screenPoint: (
    x: number,
    y: number,
    captured?: boolean,
  ) => { x: number; y: number } | null;
  readonly projectPoint?: (x: number, y: number) => { x: number; y: number } | null;
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly setInteractionActive: (active: boolean, mode: "touch" | "orbit") => void;
  readonly resetPose: () => void;
  readonly dispose: () => void;
}

export interface DeviceViewerReady {
  /** Draws the latest decoded frame; called for every frame the stream reports. */
  readonly frame: () => void;
  readonly pinch?: TrackpadPinch;
  readonly dispose?: () => void;
}

/** Why a 3D viewer could not be shown. */
export type DeviceViewerFailure = "load-failed" | "webgl-unavailable" | "render-failed";

/**
 * Mounts a lazily loaded 3D device viewer on a canvas and returns its teardown. Owns host
 * resizing, input cancellation, trackpad gestures, and disposal shared by every viewport.
 */
export function mountDeviceViewer<V extends MountableViewer>(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  options: {
    /** Resolves to the constructor, so a canvas unmounted while loading never builds a viewer. */
    readonly load: () => Promise<() => V>;
    readonly touch: (phase: "begin" | "move" | "end", point: { x: number; y: number }) => void;
    readonly viewerRef: { current: V | null };
    readonly interactionRef: { current: PhoneInteraction | null };
    readonly onInputCancel: (cancel: (() => void) | null) => void;
    readonly onResetReady: (reset: (() => void) | null) => void;
    /** The viewer's screen-to-canvas projection (the Device panel's overlay), while it is mounted. */
    readonly onProjectReady?: (
      project: ((x: number, y: number) => { x: number; y: number } | null) | null,
    ) => void;
    readonly onFrameListener: (listener: (() => void) | null) => void;
    readonly onUnavailable: (failure: DeviceViewerFailure) => void;
    readonly cancelInput?: (viewer: V) => void;
    /** Desktop shells that see the end of a trackpad scroll (momentum included) report it here. */
    readonly subscribeTrackpadScrollEnd?: (listener: () => void) => () => void;
    readonly ready: (context: {
      readonly viewer: V;
      readonly cancelTrackpad: () => void;
    }) => DeviceViewerReady;
  },
) {
  const { viewerRef, interactionRef } = options;
  let disposed = false;
  let trackpad: ReturnType<typeof bindPhoneTrackpad> | null = null;
  let stopTrackpadEnd: (() => void) | undefined;
  let mounted: DeviceViewerReady | null = null;
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    viewerRef.current?.resize(width, height, window.devicePixelRatio);
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(host);
  const blur = () => {
    interactionRef.current?.end();
    trackpad?.cancel();
    if (viewerRef.current) options.cancelInput?.(viewerRef.current);
  };
  options.onInputCancel(blur);
  window.addEventListener("blur", blur);
  void options.load().then(
    (create) => {
      if (disposed) return;
      let viewer: V;
      try {
        viewer = create();
      } catch {
        options.onUnavailable("webgl-unavailable");
        return;
      }
      viewerRef.current = viewer;
      options.onResetReady(viewer.resetPose);
      if (viewer.projectPoint) options.onProjectReady?.(viewer.projectPoint);
      const interaction = createPhoneInteraction({
        screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
        touch: options.touch,
        orbit: viewer.orbit,
        onInteractionActive: viewer.setInteractionActive,
      });
      interactionRef.current = interaction;
      resize();
      mounted = options.ready({ viewer, cancelTrackpad: () => trackpad?.cancel() });
      options.onFrameListener(mounted.frame);
      mounted.frame();
      trackpad = bindPhoneTrackpad(canvas, interaction, mounted.pinch);
      stopTrackpadEnd = options.subscribeTrackpadScrollEnd?.(() => trackpad?.endOrbit());
    },
    () => {
      if (!disposed) options.onUnavailable("load-failed");
    },
  );
  return () => {
    disposed = true;
    stopTrackpadEnd?.();
    trackpad?.dispose();
    mounted?.dispose?.();
    interactionRef.current?.end();
    interactionRef.current = null;
    options.onInputCancel(null);
    options.onResetReady(null);
    options.onProjectReady?.(null);
    options.onFrameListener(null);
    observer?.disconnect();
    window.removeEventListener("blur", blur);
    viewerRef.current?.dispose();
    viewerRef.current = null;
  };
}
