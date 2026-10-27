// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/web/src/components/device/DeviceDuoControls.tsx
import { useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import {
  duoFoldState,
  duoHoldOrientation,
  type DuoCommand,
  type DuoControlState,
} from "./duoControl.ts";
import type { DeviceScreenSize } from "./types.ts";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph.tsx";

const FOLDS = [
  { id: "closed", angle: 0 },
  { id: "half", angle: 90 },
  { id: "open", angle: 180 },
] as const;
const STANDS = [
  { id: "laptop", label: "Laptop stand" },
  { id: "tent", label: "Tent stand" },
] as const;

const GROUP =
  "pointer-events-auto flex shrink-0 flex-col items-center gap-1 rounded-full border border-neutral-700/60 bg-neutral-900/80 p-1 shadow-sm";

export function DeviceControlButton(props: {
  readonly label: string;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full text-neutral-300 transition-colors",
        "hover:bg-neutral-800 hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-40",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
        props.pressed && "bg-neutral-700 text-neutral-100",
      )}
    >
      {props.children}
    </button>
  );
}

export function DeviceControlError({ error }: { readonly error: string | null }) {
  return error ? (
    <span role="alert" title={error} className="pointer-events-auto text-xs text-red-400">
      !
    </span>
  ) : null;
}

/** Fold shape and stand controls for an iPhone Duo; commands go to the stream's Duo control. */
export function DeviceDuoControls(props: {
  readonly screen: DeviceScreenSize;
  readonly state: DuoControlState;
  readonly enabled: boolean;
  readonly onCommand: (command: DuoCommand) => void;
}) {
  const { screen } = props;
  const { fold, stand, phoneVertical: reportedVertical, settled } = duoFoldState(screen);
  const [settledVertical, setSettledVertical] = useState(reportedVertical);
  if (settled && settledVertical !== reportedVertical) setSettledVertical(reportedVertical);
  const [standVertical, setStandVertical] = useState(settledVertical);
  const phoneVertical = stand ? standVertical : settledVertical;
  // Only one command can wait; defer fold controls until stand rotation and queued commands settle
  // in the correct display frame.
  const foldWaits = props.state.pending && (stand || props.state.requested?.control === "pose");
  const foldLabels = { closed: "Closed", half: phoneVertical ? "Book" : "Laptop", open: "Open" };
  return (
    <div aria-label="iPhone Duo stands" className="flex flex-col items-center gap-2">
      <div role="group" aria-label="Fold shape" className={GROUP}>
        {FOLDS.map(({ id, angle }) => (
          <DeviceControlButton
            key={id}
            label={foldLabels[id]}
            pressed={!stand && fold === id}
            disabled={!props.enabled || foldWaits}
            onClick={() => {
              if (stand)
                props.onCommand({
                  control: "orientation",
                  value: duoHoldOrientation(standVertical, screen.screenId),
                });
              props.onCommand({ control: "angle", value: angle });
            }}
          >
            <DeviceDuoGlyph pose={id === "half" ? "book" : id} rotated={!phoneVertical} />
          </DeviceControlButton>
        ))}
      </div>
      <div role="group" aria-label="Device stance" className={GROUP}>
        {STANDS.map(({ id, label }) => (
          <DeviceControlButton
            key={id}
            label={label}
            pressed={screen.hingePose === id}
            disabled={!props.enabled}
            onClick={() => {
              if (!stand) setStandVertical(settledVertical);
              props.onCommand({ control: "pose", value: id });
            }}
          >
            <DeviceDuoGlyph pose={id} />
          </DeviceControlButton>
        ))}
      </div>
      <DeviceControlError error={props.state.error} />
    </div>
  );
}
