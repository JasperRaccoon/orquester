import React from "react";
import { Lock } from "lucide-react";
import type { LatchState } from "../../lib/modifier-latch";

/**
 * The touch key-bar look shared by the terminal's `MobileKeyBar` and the
 * desktop key bar. Keys act on pointerdown with preventDefault: the focused
 * field keeps focus, so the soft keyboard stays up.
 */

export const KEY_BAR_KEY_CLASS =
  "flex h-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 px-3 font-mono text-sm text-neutral-200 active:bg-neutral-700";

const LATCH_CLASS: Record<LatchState, string> = {
  off: "bg-neutral-800 text-neutral-200 active:bg-neutral-700",
  armed: "bg-info-soft/40 text-info ring-1 ring-inset ring-info/60",
  locked: "bg-info text-neutral-950"
};

const LATCH_LABEL: Record<LatchState, string> = {
  off: "off",
  armed: "on for the next key",
  locked: "locked on"
};

export const KeyBarButton: React.FC<{
  label: React.ReactNode;
  onPress: () => void;
  wide?: boolean;
  ariaLabel?: string;
  pressed?: boolean;
  className?: string;
}> = ({ label, onPress, wide, ariaLabel, pressed, className }) => (
  <button
    type="button"
    aria-label={ariaLabel}
    aria-pressed={pressed}
    // Don't take focus → the keyboard stays up.
    onPointerDown={(e) => {
      e.preventDefault();
      onPress();
    }}
    className={`${KEY_BAR_KEY_CLASS} ${wide ? "flex-1" : ""} ${className ?? ""}`}
  >
    {label}
  </button>
);

/** A latching modifier: off / armed (next key) / locked, tapped on pointerdown. */
export const LatchKeyButton: React.FC<{
  label: string;
  state: LatchState;
  /** `timeStamp`: the pointerdown's, so a quick second tap locks. */
  onTap: (timeStamp: number) => void;
}> = ({ label, state, onTap }) => (
  <button
    type="button"
    aria-label={`${label} modifier, ${LATCH_LABEL[state]}`}
    aria-pressed={state !== "off"}
    // Tap arms for the next key; a quick second tap locks; tap again releases.
    onPointerDown={(e) => {
      e.preventDefault();
      onTap(e.timeStamp);
    }}
    className={`flex h-9 shrink-0 touch-manipulation items-center justify-center gap-1 rounded-md px-3 font-mono text-sm ${LATCH_CLASS[state]}`}
  >
    {label}
    {state === "locked" && <Lock size={11} aria-hidden />}
  </button>
);
