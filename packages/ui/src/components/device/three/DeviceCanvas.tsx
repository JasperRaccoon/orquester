// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): the canvas and pointer routing shared by
// apps/web/src/components/device/DevicePhoneViewport.tsx and DeviceDuoViewport.tsx.
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { createPhoneInteraction } from "./phoneInteraction.ts";

/** How a mounted 3D viewer hands its controls back to `DeviceViewport`. */
export interface DeviceViewerBindings {
  readonly onFrameListener: (listener: (() => void) | null) => void;
  readonly onResetReady: (reset: (() => void) | null) => void;
  readonly onInputCancel: (cancel: (() => void) | null) => void;
  /** The 3D viewer's screen-to-canvas projection while one is mounted (`DeviceViewportHandle.projectPoint`). */
  readonly onProjectReady?: (
    project: ((x: number, y: number) => { x: number; y: number } | null) | null,
  ) => void;
}

const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
};

export function DeviceCanvas(props: {
  readonly canvasRef: RefObject<HTMLCanvasElement>;
  readonly interactionRef: RefObject<ReturnType<typeof createPhoneInteraction> | null>;
  readonly label: string;
}) {
  const { interactionRef } = props;
  return (
    <div className="absolute inset-0">
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[6%] left-1/2 h-5 w-2/5 -translate-x-1/2 rounded-full bg-white/10 blur-xl"
      />
      <canvas
        ref={props.canvasRef}
        aria-label={props.label}
        className="block h-full w-full touch-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if (!interactionRef.current?.begin(event.pointerId, point(event), event.altKey)) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          (event.currentTarget.closest("[data-device-view]") as HTMLElement | null)?.focus();
        }}
        onPointerMove={(event) => interactionRef.current?.move(event.pointerId, point(event))}
        onPointerUp={(event) => {
          interactionRef.current?.move(event.pointerId, point(event));
          interactionRef.current?.end(event.pointerId);
        }}
        onPointerCancel={(event) => interactionRef.current?.end(event.pointerId)}
        onLostPointerCapture={(event) => interactionRef.current?.end(event.pointerId)}
      />
    </div>
  );
}
