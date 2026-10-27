// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/DeviceDuoViewport.tsx
import { useEffect, useRef } from "react";
import type { DuoViewer } from "./duoViewer.ts";
import type { createPhoneInteraction } from "./phoneInteraction.ts";
import { createCanvasFrameSink } from "./frame.ts";
import { createDuoPinch, type DuoCommand } from "./duoControl.ts";
import type { DeviceScreenSize, DuoPanelSinks } from "./types.ts";
import { mountDeviceViewer, type DeviceViewerFailure } from "./mountDeviceViewer.ts";
import { DeviceCanvas, type DeviceViewerBindings } from "./DeviceCanvas.tsx";

const loadDuoViewer = () =>
  Promise.all([import("./duoViewer.ts"), import("../models/registry.ts")]);

/** What the stream offers an iPhone Duo view: hinge state, per-panel video and hinge commands. */
export interface DeviceDuoBinding {
  /** The device's screen report including `screenId`, `hingeAngle`, `hingePose` and support flags. */
  readonly screen: DeviceScreenSize | null;
  /** The angle a pending hinge command is moving to, shown before the device confirms it. */
  readonly hingePreview: number | null;
  /** Touch in the active panel's raw framebuffer coordinates (0..1). */
  readonly onRawTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly onCommand: (command: DuoCommand) => void;
  /** Attach (or with null, detach) per-panel frame sinks to the stream. */
  readonly setPanels: (panels: DuoPanelSinks | null) => void;
  /** Register (or clear) the listener the stream calls when the device rejects a control. */
  readonly onControlRejectedListener?: (listener: (() => void) | null) => void;
}

export function DeviceDuoViewport(props: {
  readonly source: HTMLCanvasElement;
  readonly duo: DeviceDuoBinding;
  readonly onUnavailable: (failure: DeviceViewerFailure) => void;
  readonly bindings: DeviceViewerBindings;
  readonly subscribeTrackpadScrollEnd?: (listener: () => void) => () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<
    (DuoViewer & { readonly sources: Record<1 | 3, HTMLCanvasElement> }) | null
  >(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const pinchRef = useRef<ReturnType<typeof createDuoPinch> | null>(null);
  const screenRef = useRef(props.duo.screen);
  const latest = useRef(props);
  latest.current = props;
  const { source } = props;
  const { screen, hingePreview } = props.duo;

  useEffect(() => {
    screenRef.current = screen;
    interactionRef.current?.end();
    viewerRef.current?.setScreen(screen);
  }, [screen]);

  useEffect(() => {
    if (!pinchRef.current?.active) viewerRef.current?.setHingePreview(hingePreview);
  }, [hingePreview]);

  // The 3D viewer lives as long as its canvas and source; later prop changes are pushed above.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const { bindings } = latest.current;
    const duo = () => latest.current.duo;
    return mountDeviceViewer(canvas, host, {
      load: () =>
        loadDuoViewer().then(([{ createDuoViewer }, registry]) => () => {
          const sources = {
            1: document.createElement("canvas"),
            3: document.createElement("canvas"),
          };
          const viewer = createDuoViewer({
            canvas,
            sources,
            onUnavailable: () => latest.current.onUnavailable("render-failed"),
            onPanelRequested: (panel) =>
              duo().onCommand({
                control: "physical",
                value: panel === 1 ? "facedown" : "faceup",
              }),
            onOrientationRequested: (value) => duo().onCommand({ control: "orientation", value }),
            onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
            model: registry.deviceModelSource("iphone-duo"),
          });
          return { ...viewer, sources };
        }),
      touch: (phase, point) => duo().onRawTouch(phase, point.x, point.y),
      viewerRef,
      interactionRef,
      onInputCancel: bindings.onInputCancel,
      onResetReady: bindings.onResetReady,
      onFrameListener: bindings.onFrameListener,
      onUnavailable: (failure) => latest.current.onUnavailable(failure),
      subscribeTrackpadScrollEnd: (listener) =>
        latest.current.subscribeTrackpadScrollEnd?.(listener) ?? (() => {}),
      cancelInput: (viewer) => viewer.cancelInput(),
      ready: ({ viewer, cancelTrackpad }) => {
        duo().onControlRejectedListener?.(() => {
          cancelTrackpad();
          viewer.rejectOrientation();
        });
        viewer.setScreen(screenRef.current);
        viewer.setHingePreview(duo().hingePreview);
        duo().setPanels({
          onScreen(next) {
            screenRef.current = next;
            interactionRef.current?.end();
            viewer.setScreen(next);
          },
          cover: createCanvasFrameSink(viewer.sources[1], () => viewer.frameUpdated(1)),
          inner: createCanvasFrameSink(viewer.sources[3], () => viewer.frameUpdated(3)),
        });
        const pinch = createDuoPinch({
          angle: () =>
            duo().hingePreview ??
            screenRef.current?.hingeAngle ??
            (screenRef.current?.screenId === 1 ? 0 : 180),
          contains: (x, y) => !!screenRef.current && viewer.beginHinge(x, y),
          change: (angle) => {
            viewer.setHingePreview(angle ?? duo().hingePreview, true);
            if (angle !== null) duo().onCommand({ control: "angle", value: angle });
          },
        });
        pinchRef.current = pinch;
        return {
          frame: () => {
            const panel = screenRef.current?.screenId;
            if (panel === 1 || panel === 3) viewer.frameUpdated(panel, source);
          },
          pinch: {
            begin(x, y) {
              interactionRef.current?.end();
              return pinch.begin(x, y);
            },
            move: pinch.move,
            end: pinch.end,
          },
          dispose: () => {
            pinchRef.current = null;
            duo().onControlRejectedListener?.(null);
            duo().setPanels(null);
          },
        };
      },
    });
  }, [source]);

  return (
    <DeviceCanvas
      canvasRef={canvasRef}
      interactionRef={interactionRef}
      label="Interactive 3D iPhone Duo. Drag the screen to interact. Drag outside it or swipe with two fingers to turn. Pinch over the device to open or close its hinge."
    />
  );
}
