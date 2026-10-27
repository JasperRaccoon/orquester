import type { BrowserWindowConstructorOptions, Rectangle } from "electron";

// --- Main window geometry and frame ---
//
// Pure decisions behind `createWindow` (main.ts): where the window opens,
// whether it opens maximized, and which native frame it gets. The persisted
// geometry (`<appdir>/app/window-state.json`) is device-local window chrome
// owned by the main process, like window-theme.json: validated field by field,
// so a file from another version or another monitor setup degrades to the
// defaults instead of opening the window off-screen.

export const MIN_WINDOW_SIZE = { width: 1040, height: 680 } as const;
const DEFAULT_WINDOW_SIZE = { width: 1320, height: 860 } as const;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** The window's normal (unmaximized) bounds; null when none were saved. */
  bounds: WindowBounds | null;
  maximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = { bounds: null, maximized: false };

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** A saved window-state.json, field by field. Sizes below the window's minimum grow to it. */
export function parseWindowState(raw: unknown): WindowState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_WINDOW_STATE;
  const record = raw as Record<string, unknown>;
  const maximized = record.maximized === true;
  const bounds = record.bounds as Record<string, unknown> | null | undefined;
  if (
    typeof bounds !== "object" ||
    bounds === null ||
    !isInteger(bounds.x) ||
    !isInteger(bounds.y) ||
    !isInteger(bounds.width) ||
    !isInteger(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return { bounds: null, maximized };
  }
  return {
    bounds: {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, MIN_WINDOW_SIZE.width),
      height: Math.max(bounds.height, MIN_WINDOW_SIZE.height)
    },
    maximized
  };
}

type DisplayArea = Pick<Rectangle, "x" | "y" | "width" | "height">;

function fitsWithin(bounds: WindowBounds, area: DisplayArea): boolean {
  return (
    bounds.x >= area.x &&
    bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  );
}

/**
 * Where the window opens: the saved bounds when they fit on a connected
 * display; else, when the saved size still fits the first display, that size
 * centred (a monitor was unplugged or rearranged); else the default size,
 * centred. Omitting x/y is what makes Electron centre the window.
 */
// Adapted from T3 Code (MIT): apps/desktop/src/window/DesktopWindow.ts
export function resolveInitialWindowBounds(
  saved: WindowBounds | null,
  displays: readonly DisplayArea[]
): WindowBounds | { width: number; height: number } {
  if (saved !== null) {
    if (displays.some((display) => fitsWithin(saved, display))) return saved;
    const primary = displays[0];
    if (primary && saved.width <= primary.width && saved.height <= primary.height) {
      return { width: saved.width, height: saved.height };
    }
  }
  return { ...DEFAULT_WINDOW_SIZE };
}

/** True when two saved states would write the same file (skips needless writes). */
export function sameWindowState(a: WindowState, b: WindowState): boolean {
  if (a.maximized !== b.maximized) return false;
  if (a.bounds === null || b.bounds === null) return a.bounds === b.bounds;
  return (
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
}

type WindowFrameOptions = Pick<BrowserWindowConstructorOptions, "frame" | "titleBarStyle" | "trafficLightPosition">;

/**
 * The window's native frame for the "Custom titlebar" setting. macOS always
 * keeps the hidden titlebar with its traffic lights (the setting only toggles
 * the in-app buttons there); Windows and Linux are frameless with the in-app
 * controls, or get the OS frame and its caption buttons.
 */
export function windowFrameOptions(platform: NodeJS.Platform, useTitlebar: boolean): WindowFrameOptions {
  if (platform === "darwin") {
    return { frame: false, titleBarStyle: "hidden", trafficLightPosition: { x: 12, y: 12 } };
  }
  return useTitlebar ? { frame: false, titleBarStyle: "hidden" } : { frame: true };
}

/** Whether the OS draws the window's own minimise/maximise/close buttons. */
export function hasNativeWindowControls(platform: NodeJS.Platform, useTitlebar: boolean): boolean {
  return platform === "darwin" || !useTitlebar;
}

/** Comparable identity of a frame: a window is rebuilt only when this changes. */
export function frameKey(options: WindowFrameOptions): string {
  return JSON.stringify([options.frame, options.titleBarStyle ?? null, options.trafficLightPosition ?? null]);
}

/**
 * The renderer argument marking a window without native caption buttons;
 * `preload.cjs` reads it from `process.argv` (keep the two in step).
 */
export const NO_NATIVE_CONTROLS_ARGUMENT = "--orquester-no-native-window-controls";
