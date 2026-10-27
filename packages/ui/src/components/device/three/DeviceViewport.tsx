import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "../../../lib/cn";
import { resolveDeviceModelId } from "./model.ts";
import { resolveDeviceShape } from "./shapeProfile.ts";
import { deviceScreenAspect, flatViewPoint, type Size } from "./flat.ts";
import type { DeviceOrientation, DevicePlatform, DeviceScreenSize } from "./types.ts";
import type { DeviceViewerFailure } from "./mountDeviceViewer.ts";
import type { DeviceViewerBindings } from "./DeviceCanvas.tsx";
import { DeviceFlatViewport } from "./DeviceFlatViewport.tsx";
import { DevicePhoneViewport } from "./DevicePhoneViewport.tsx";
import { DeviceDuoViewport, type DeviceDuoBinding } from "./DeviceDuoViewport.tsx";

export type DeviceViewMode = "3d" | "flat";

export interface DeviceViewUnavailable {
  readonly code: DeviceViewerFailure | "duo-unsupported";
  readonly message: string;
}

const MESSAGES: Record<DeviceViewUnavailable["code"], string> = {
  "webgl-unavailable": "3D is unavailable on this browser",
  "load-failed": "The 3D viewer could not load",
  "render-failed": "3D stopped working in this browser",
  "duo-unsupported": "iPhone Duo 3D needs a stream that reports the hinge",
};

export interface DeviceViewportProps {
  /** The canvas the stream decoder draws frames into; null before a stream exists. */
  readonly source: HTMLCanvasElement | null;
  readonly platform: DevicePlatform;
  /** The simulator/emulator device name ("iPhone 17", "Pixel 9"); picks the 3D model and shape. */
  readonly deviceName: string;
  /** The device profile name; a second chance to match a model when the device name does not. */
  readonly profileName?: string;
  /** The raw frame size in device pixels as the stream reports it; null until known. */
  readonly screen: Size | null;
  readonly orientation: DeviceOrientation;
  /** What the user asked for; 3D falls back to flat (see `onModeUnavailable`). */
  readonly mode: DeviceViewMode;
  /** A touch normalized to 0..1 over the screen as seen, in its current orientation. */
  readonly onTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  /** 3D was requested but is showing flat; called once per new reason. */
  readonly onModeUnavailable?: (reason: DeviceViewUnavailable) => void;
  /** Shows the Magic Keyboard on models that have one (iPad Pro 13-inch). */
  readonly keyboardAttached?: boolean;
  /** Android foldables: hinge angle in degrees (0 closed, 180 open); null for a slab phone. */
  readonly foldAngle?: number | null;
  /** iPhone Duo: hinge state, per-panel video and hinge commands. Without it a Duo shows flat. */
  readonly duo?: DeviceDuoBinding;
  /** Desktop shells that see a trackpad scroll's end (momentum included) report it here. */
  readonly subscribeTrackpadScrollEnd?: (listener: () => void) => () => void;
  readonly className?: string;
}

export interface DeviceViewportHandle {
  /** Call after the decoder drew a frame into `source`. */
  readonly notifyFrame: () => void;
  /** Turn the 3D device back to face the viewer. */
  readonly resetView: () => void;
  /** End any touch or gesture in progress (focus loss, control handover). */
  readonly cancelInput: () => void;
  /**
   * Where a point on the screen as seen (0..1, the `onTouch` space) shows now, in CSS pixels from
   * the viewport's top-left; null before a frame, or when the 3D scene cannot project (foldables).
   * For drawing over the device (the Device panel's agent overlay).
   */
  readonly projectPoint: (x: number, y: number) => { x: number; y: number } | null;
}

let webgl2: boolean | null = null;
/** three.js r163+ renders with WebGL 2 only. */
function webgl2Available() {
  if (webgl2 !== null) return webgl2;
  try {
    const context = document.createElement("canvas").getContext("webgl2");
    webgl2 = !!context;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl2 = false;
  }
  return webgl2;
}

const canvasSize = (canvas: HTMLCanvasElement | null): Size | null =>
  canvas && canvas.width > 0 && canvas.height > 0
    ? { width: canvas.width, height: canvas.height }
    : null;

/**
 * A live device screen in a 3D device model (lazily loaded three.js) or a flat bezel. Fills its
 * positioned parent. See ./README.md.
 */
export const DeviceViewport = forwardRef<DeviceViewportHandle, DeviceViewportProps>(
  function DeviceViewport(props, ref) {
    const { source, platform, deviceName, profileName, orientation, mode } = props;
    const modelId =
      resolveDeviceModelId(platform, deviceName) ??
      (profileName ? resolveDeviceModelId(platform, profileName) : null);
    const isDuo = modelId === "iphone-duo";

    // Before the stream reports its size, the canvas's own size is the best guess.
    const [canvasFrame, setCanvasFrame] = useState<Size | null>(() => canvasSize(source));
    const frame = props.screen && props.screen.width > 0 && props.screen.height > 0
      ? props.screen
      : canvasFrame;
    const frameWidth = frame?.width ?? 0;
    const frameHeight = frame?.height ?? 0;
    const screen = useMemo<DeviceScreenSize | null>(
      () => (frameWidth && frameHeight ? { width: frameWidth, height: frameHeight, orientation } : null),
      [frameWidth, frameHeight, orientation],
    );
    const aspect = deviceScreenAspect(platform, frame, orientation);
    const portraitAspect = Math.min(aspect, 1 / aspect);
    const profile = useMemo(
      () => resolveDeviceShape({ platform, name: deviceName || profileName || "", portraitAspect }),
      [platform, deviceName, profileName, portraitAspect],
    );

    // A failure holds until 3D is asked for again or the stream canvas changes.
    const [failure, setFailure] = useState<DeviceViewerFailure | null>(null);
    useEffect(() => setFailure(null), [mode, source]);
    const unavailableCode: DeviceViewUnavailable["code"] | null =
      mode !== "3d"
        ? null
        : !webgl2Available()
          ? "webgl-unavailable"
          : (failure ??
            (isDuo && !props.duo?.screen?.supportsHingeAngle ? "duo-unsupported" : null));
    const show3d = mode === "3d" && !unavailableCode && !!source;

    const onModeUnavailable = useRef(props.onModeUnavailable);
    onModeUnavailable.current = props.onModeUnavailable;
    useEffect(() => {
      if (unavailableCode)
        onModeUnavailable.current?.({ code: unavailableCode, message: MESSAGES[unavailableCode] });
    }, [unavailableCode]);

    const frameListener = useRef<(() => void) | null>(null);
    const reset = useRef<(() => void) | null>(null);
    const cancel = useRef<(() => void) | null>(null);
    const project = useRef<((x: number, y: number) => { x: number; y: number } | null) | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const show3dRef = useRef(false);
    const bindings = useMemo<DeviceViewerBindings>(
      () => ({
        onFrameListener: (listener) => (frameListener.current = listener),
        onResetReady: (listener) => (reset.current = listener),
        onInputCancel: (listener) => (cancel.current = listener),
        onProjectReady: (listener) => (project.current = listener),
      }),
      [],
    );
    const sourceRef = useRef(source);
    sourceRef.current = source;
    useImperativeHandle(
      ref,
      () => ({
        notifyFrame() {
          frameListener.current?.();
          const next = canvasSize(sourceRef.current);
          setCanvasFrame((current) =>
            current?.width === next?.width && current?.height === next?.height ? current : next,
          );
        },
        resetView: () => reset.current?.(),
        cancelInput: () => cancel.current?.(),
        projectPoint(x, y) {
          const root = rootRef.current;
          if (!root) return null;
          const box = root.getBoundingClientRect();
          if (show3dRef.current) {
            const seen = project.current?.(x, y);
            return seen ? { x: seen.x * box.width, y: seen.y * box.height } : null;
          }
          const screen = root.querySelector<HTMLElement>("[data-device-flat-screen]");
          return screen ? flatViewPoint(screen.getBoundingClientRect(), box, x, y) : null;
        },
      }),
      [],
    );
    useEffect(() => {
      setCanvasFrame(canvasSize(source));
    }, [source]);

    show3dRef.current = show3d;
    const onUnavailable = (next: DeviceViewerFailure) => setFailure(next);
    return (
      <div ref={rootRef} className={cn("relative h-full w-full min-h-0 min-w-0", props.className)}>
        {show3d && isDuo && props.duo ? (
          <DeviceDuoViewport
            source={source}
            duo={props.duo}
            onUnavailable={onUnavailable}
            bindings={bindings}
            subscribeTrackpadScrollEnd={props.subscribeTrackpadScrollEnd}
          />
        ) : show3d ? (
          <DevicePhoneViewport
            profile={profile}
            modelId={modelId}
            keyboardAttached={props.keyboardAttached ?? false}
            source={source}
            screen={screen}
            foldAngle={props.foldAngle ?? null}
            onTouch={props.onTouch}
            onUnavailable={onUnavailable}
            bindings={bindings}
            subscribeTrackpadScrollEnd={props.subscribeTrackpadScrollEnd}
          />
        ) : (
          <DeviceFlatViewport
            source={source}
            platform={platform}
            frame={frame}
            orientation={orientation}
            profile={profile}
            onTouch={props.onTouch}
          />
        )}
      </div>
    );
  },
);
