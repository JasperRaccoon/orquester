/**
 * The Device panel's controls (spec §10.1): a compact vertical rail beside the device with its
 * tooltips on the left (t3code's `DeviceControlsRail`), or a bottom bar on a phone. Every disabled
 * control says why in its tooltip. Fold controls appear for Android foldables. More holds Restart
 * app (the daemon's user action), Copy device key, Release and Power off.
 */

import React from "react";
import {
  Box,
  Camera,
  ChevronLeft,
  Copy,
  Home,
  Keyboard,
  Loader2,
  LogOut,
  MoreHorizontal,
  Power,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Smartphone,
  Square
} from "lucide-react";

import { cn } from "../../lib/cn";
import { AdaptiveMenu } from "../ui/adaptive-menu";
import { DropdownItem, DropdownSeparator } from "../ui/dropdown";
import { DeviceDuoGlyph } from "./three/DeviceDuoGlyph";
import type { AndroidFoldPosture } from "./three/DeviceAndroidFoldControls";
import type { DeviceButton } from "./stream";

export type ToolbarLayout = "rail" | "bar";

/** A control the panel may offer, with why it is off when it is. */
export interface ToolbarControl {
  enabled: boolean;
  /** Shown instead of the label while disabled. */
  reason?: string | null;
}

export interface DeviceToolbarProps {
  layout: ToolbarLayout;
  platform: "ios" | "android";
  /** Input buttons (Home, Back, Recents): live input, else why not. */
  input: ToolbarControl;
  onButton: (button: DeviceButton) => void;
  rotate: ToolbarControl & { onRotate: () => void };
  screenshot: ToolbarControl & { pending: boolean; onShot: (download: boolean) => void };
  keyboard: ToolbarControl & { active: boolean; onToggle: () => void };
  view: { mode: "3d" | "flat"; unavailable: string | null; enabled: boolean; onMode: (mode: "3d" | "flat") => void; onReset?: () => void };
  fold?: { posture: AndroidFoldPosture | null; pending: boolean; enabled: boolean; error: string | null; onChange: (posture: "closed" | "opened") => void };
  more: { onRelease: () => void; onPowerOff: () => void; onCopyKey: () => void; releasing: boolean; onRestartApp: () => void; restarting: boolean };
}

function Tip({ layout, text }: { layout: ToolbarLayout; text: string }) {
  return (
    <span
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-30 w-max max-w-[15rem] rounded-md border border-neutral-700/70 bg-neutral-900 px-2 py-1 text-[11px] leading-snug text-neutral-100 shadow-lg",
        "opacity-0 transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 motion-reduce:transition-none",
        layout === "rail" ? "right-full top-1/2 mr-2 -translate-y-1/2" : "bottom-full left-1/2 mb-2 -translate-x-1/2"
      )}
    >
      {text}
    </span>
  );
}

export function ToolbarButton(props: {
  layout: ToolbarLayout;
  label: string;
  control?: ToolbarControl;
  pressed?: boolean;
  danger?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  const enabled = props.control?.enabled ?? true;
  const tip = !enabled && props.control?.reason ? `${props.label} — ${props.control.reason}` : props.label;
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.pressed}
        aria-disabled={!enabled || undefined}
        // Disabled buttons drop hover in some browsers: keep it focusable and refuse the click instead.
        onClick={(event) => {
          if (enabled) props.onClick(event);
        }}
        // A press keeps the keyboard on the device view.
        onPointerDown={(event) => event.preventDefault()}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-full text-neutral-300 transition-colors",
          "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
          enabled ? "hover:bg-neutral-800 hover:text-neutral-50" : "cursor-default opacity-35",
          props.pressed && "bg-neutral-700/80 text-neutral-50",
          props.danger && enabled && "hover:text-danger"
        )}
      >
        {props.children}
      </button>
      <Tip layout={props.layout} text={tip} />
    </span>
  );
}

function Divider({ layout }: { layout: ToolbarLayout }) {
  return <span aria-hidden className={cn("shrink-0 bg-neutral-700/60", layout === "rail" ? "my-0.5 h-px w-5" : "mx-0.5 h-5 w-px")} />;
}

const ICON = { size: 16, strokeWidth: 1.8, "aria-hidden": true } as const;

export function DeviceToolbar(props: DeviceToolbarProps): React.ReactElement {
  const { layout } = props;
  const group = cn(
    "pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-full border border-neutral-700/60 bg-neutral-900/85 p-1 shadow-sm backdrop-blur",
    layout === "rail" ? "flex-col" : "flex-row"
  );
  const RotateIcon = props.platform === "ios" ? RotateCcw : RotateCw;
  return (
    <div
      role="toolbar"
      aria-label="Device controls"
      aria-orientation={layout === "rail" ? "vertical" : "horizontal"}
      className={cn("flex items-center gap-2", layout === "rail" ? "flex-col" : "flex-row justify-center")}
      data-device-toolbar={layout}
    >
      <div className={group}>
        <ToolbarButton layout={layout} label="Home" control={props.input} onClick={() => props.onButton("home")}>
          <Home {...ICON} />
        </ToolbarButton>
        {props.platform === "android" ? (
          <ToolbarButton layout={layout} label="Back" control={props.input} onClick={() => props.onButton("back")}>
            <ChevronLeft {...ICON} />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          layout={layout}
          label={props.platform === "android" ? "Recent apps" : "App switcher"}
          control={props.input}
          onClick={() => props.onButton("recents")}
        >
          <Square {...ICON} size={14} />
        </ToolbarButton>
        <ToolbarButton layout={layout} label="Rotate" control={props.rotate} onClick={props.rotate.onRotate}>
          <RotateIcon {...ICON} />
        </ToolbarButton>
        <Divider layout={layout} />
        <ToolbarButton
          layout={layout}
          label={props.screenshot.pending ? "Taking a screenshot…" : "Screenshot to the chat (Shift-click to download)"}
          control={props.screenshot}
          onClick={(event) => props.screenshot.onShot(event.shiftKey)}
        >
          {props.screenshot.pending ? <Loader2 {...ICON} className="animate-spin motion-reduce:animate-none" /> : <Camera {...ICON} />}
        </ToolbarButton>
        <ToolbarButton
          layout={layout}
          label={props.keyboard.active ? "Typing goes to the device (click to stop)" : "Type on the device"}
          control={props.keyboard}
          pressed={props.keyboard.active}
          onClick={props.keyboard.onToggle}
        >
          <Keyboard {...ICON} />
        </ToolbarButton>
        <ToolbarButton
          layout={layout}
          label={props.view.mode === "3d" ? "Show flat" : "Show in 3D"}
          control={{ enabled: props.view.enabled && (props.view.mode === "3d" || props.view.unavailable === null), reason: props.view.unavailable }}
          onClick={() => props.view.onMode(props.view.mode === "3d" ? "flat" : "3d")}
        >
          {props.view.mode === "3d" ? <Smartphone {...ICON} /> : <Box {...ICON} />}
        </ToolbarButton>
        <AdaptiveMenu
          title="Device"
          align="right"
          width="w-52"
          trigger={
            <span className="group/tip relative inline-flex">
              <span
                aria-label="More device actions"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50"
              >
                <MoreHorizontal {...ICON} />
              </span>
              <Tip layout={layout} text="More" />
            </span>
          }
        >
          {props.view.onReset && props.view.mode === "3d" ? (
            <DropdownItem icon={<Box size={14} />} onClick={props.view.onReset}>
              Face the device forward
            </DropdownItem>
          ) : null}
          <DropdownItem icon={<RefreshCw size={14} />} disabled={props.more.restarting || props.more.releasing} onClick={props.more.onRestartApp}>
            {props.more.restarting ? "Restarting the app…" : "Restart app"}
          </DropdownItem>
          <DropdownItem icon={<Copy size={14} />} onClick={props.more.onCopyKey}>
            Copy device key
          </DropdownItem>
          <DropdownSeparator />
          <DropdownItem icon={<LogOut size={14} />} disabled={props.more.releasing} onClick={props.more.onRelease}>
            Release device
          </DropdownItem>
          <DropdownItem icon={<Power size={14} />} disabled={props.more.releasing} onClick={props.more.onPowerOff} className="hover:text-danger">
            Power off and release
          </DropdownItem>
        </AdaptiveMenu>
      </div>
      {props.fold ? (
        <div className={group} aria-label="Fold controls">
          <ToolbarButton
            layout={layout}
            label="Fold"
            control={{ enabled: props.fold.enabled && !props.fold.pending, reason: props.fold.pending ? "Folding…" : props.fold.error }}
            pressed={props.fold.posture === "closed"}
            onClick={() => props.fold?.onChange("closed")}
          >
            <DeviceDuoGlyph pose="closed" />
          </ToolbarButton>
          <ToolbarButton
            layout={layout}
            label="Unfold"
            control={{ enabled: props.fold.enabled && !props.fold.pending, reason: props.fold.pending ? "Unfolding…" : props.fold.error }}
            pressed={props.fold.posture === "opened"}
            onClick={() => props.fold?.onChange("opened")}
          >
            <DeviceDuoGlyph pose="open" />
          </ToolbarButton>
        </div>
      ) : null}
      {props.fold?.error ? (
        <span role="alert" className="max-w-[8rem] text-center text-[10px] leading-tight text-danger">
          {props.fold.error}
        </span>
      ) : null}
    </div>
  );
}
