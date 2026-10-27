// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/DevicePhoneViewport.tsx
import { useEffect, useRef } from "react";
import type { PhoneViewer } from "./phoneViewer.ts";
import type { DeviceModelId } from "./model.ts";
import type { DeviceShapeProfile } from "./shapeProfile.ts";
import type { createPhoneInteraction } from "./phoneInteraction.ts";
import type { DeviceScreenSize } from "./types.ts";
import { mountDeviceViewer, type DeviceViewerFailure } from "./mountDeviceViewer.ts";
import { DeviceCanvas, type DeviceViewerBindings } from "./DeviceCanvas.tsx";

type Registry = typeof import("../models/registry.ts");

// three.js and the model URLs load only when a 3D view first mounts.
const loadPhoneViewer = () =>
  Promise.all([import("./phoneViewer.ts"), import("../models/registry.ts")]);

export function DevicePhoneViewport(props: {
  readonly profile: DeviceShapeProfile;
  readonly modelId: DeviceModelId | null;
  readonly keyboardAttached: boolean;
  readonly source: HTMLCanvasElement;
  readonly screen: DeviceScreenSize | null;
  readonly foldAngle: number | null;
  readonly onTouch: (phase: "begin" | "move" | "end", x: number, y: number) => void;
  readonly onUnavailable: (failure: DeviceViewerFailure) => void;
  readonly bindings: DeviceViewerBindings;
  readonly subscribeTrackpadScrollEnd?: (listener: () => void) => () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<PhoneViewer | null>(null);
  const registryRef = useRef<Registry | null>(null);
  const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const { source, foldAngle, screen, profile, modelId, keyboardAttached } = props;

  useEffect(() => {
    viewerRef.current?.setFoldAngle(foldAngle);
  }, [foldAngle]);

  useEffect(() => {
    const registry = registryRef.current;
    interactionRef.current?.end();
    if (registry) {
      viewerRef.current?.setModel(modelId ? registry.deviceModelSource(modelId) : null);
      viewerRef.current?.setAccessory(
        keyboardAttached ? registry.deviceKeyboardSource(modelId) : null,
      );
    }
    viewerRef.current?.setScreen(screen, profile);
  }, [screen, profile, modelId, keyboardAttached]);

  // The 3D viewer lives as long as its canvas and source; later prop changes are pushed above.
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const { bindings } = latest.current;
    return mountDeviceViewer(canvas, host, {
      load: () =>
        loadPhoneViewer().then(([{ createPhoneViewer }, registry]) => () => {
          registryRef.current = registry;
          const current = latest.current;
          return createPhoneViewer({
            canvas,
            source,
            onUnavailable: () => latest.current.onUnavailable("render-failed"),
            onModelError: (cause) => console.warn("Device 3D asset could not load", cause),
            profile: current.profile,
            model: current.modelId ? registry.deviceModelSource(current.modelId) : null,
            accessory: current.keyboardAttached
              ? registry.deviceKeyboardSource(current.modelId)
              : null,
            foldAngle: current.foldAngle,
          });
        }),
      touch: (phase, point) => latest.current.onTouch(phase, point.x, point.y),
      viewerRef,
      interactionRef,
      onInputCancel: bindings.onInputCancel,
      onResetReady: bindings.onResetReady,
      onFrameListener: bindings.onFrameListener,
      onUnavailable: (failure) => latest.current.onUnavailable(failure),
      subscribeTrackpadScrollEnd: (listener) =>
        latest.current.subscribeTrackpadScrollEnd?.(listener) ?? (() => {}),
      ready: ({ viewer }) => {
        viewer.setScreen(latest.current.screen);
        return { frame: viewer.frameUpdated };
      },
    });
  }, [source]);

  return (
    <DeviceCanvas
      canvasRef={canvasRef}
      interactionRef={interactionRef}
      label="Interactive 3D device. Drag the screen to interact. Drag outside it or swipe with two fingers to turn."
    />
  );
}
