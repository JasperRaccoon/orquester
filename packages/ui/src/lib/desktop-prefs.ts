import {
  DESKTOP_MAX_HEIGHT,
  DESKTOP_MAX_WIDTH,
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH
} from "@orquester/config";

/**
 * Per-desktop viewer preferences (spec §10.5), per device: stored in
 * localStorage under `orq.desktop.prefs.<desktopId>` and removed when the
 * desktop is closed.
 *
 * Validated field-wise on read, like `chat-prefs.ts`: a blob written by another
 * bundle keeps the fields that are still valid and every invalid one falls back
 * to its default. (`zod` is not a `packages/ui` dependency; the checks below are
 * the same shape a schema would enforce.)
 */
export interface DesktopPrefs {
  muted: boolean;
  /** 0..1 */
  volume: number;
  /** `fit`: the display follows the tab size. `fixed`: `fixedSize`, scaled or panned. */
  view: "fit" | "fixed";
  fixedSize?: { width: number; height: number };
  fixedMode?: "scale" | "pan";
}

const KEY_PREFIX = "orq.desktop.prefs.";

/** The fixed sizes the View menu offers; the first is the touch default. */
export const DESKTOP_FIXED_SIZES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 }
];

function prefsKey(desktopId: string): string {
  return `${KEY_PREFIX}${desktopId}`;
}

/** Touch-first devices default to a fixed 1280×800 display: editors need room. */
function defaultDesktopPrefs(coarsePointer: boolean): DesktopPrefs {
  return coarsePointer
    ? { muted: false, volume: 1, view: "fixed", fixedSize: { ...DESKTOP_FIXED_SIZES[0] }, fixedMode: "scale" }
    : { muted: false, volume: 1, view: "fit" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSize(value: unknown): { width: number; height: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { width, height } = value;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width < DESKTOP_MIN_WIDTH || width > DESKTOP_MAX_WIDTH) return undefined;
  if (height < DESKTOP_MIN_HEIGHT || height > DESKTOP_MAX_HEIGHT) return undefined;
  return { width, height };
}

/** Field-wise validation with per-field fallback to the device default; never throws. */
function sanitizeDesktopPrefs(raw: unknown, coarsePointer: boolean): DesktopPrefs {
  const defaults = defaultDesktopPrefs(coarsePointer);
  if (!isRecord(raw)) return defaults;
  const muted = typeof raw.muted === "boolean" ? raw.muted : defaults.muted;
  const volume =
    typeof raw.volume === "number" && Number.isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 1
      ? raw.volume
      : defaults.volume;
  const view = raw.view === "fit" || raw.view === "fixed" ? raw.view : defaults.view;
  const out: DesktopPrefs = { muted, volume, view };
  const fixedSize = validSize(raw.fixedSize) ?? defaults.fixedSize;
  const fixedMode = raw.fixedMode === "scale" || raw.fixedMode === "pan" ? raw.fixedMode : defaults.fixedMode;
  if (view === "fixed") {
    // A fixed view always carries a usable size and mode.
    out.fixedSize = fixedSize ?? { ...DESKTOP_FIXED_SIZES[0] };
    out.fixedMode = fixedMode ?? "scale";
  } else {
    // Fit keeps the last fixed choice so switching back restores it.
    if (fixedSize) out.fixedSize = fixedSize;
    if (fixedMode) out.fixedMode = fixedMode;
  }
  return out;
}

function coarsePointer(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDesktopPrefs(desktopId: string): DesktopPrefs {
  let raw: unknown = undefined;
  try {
    const text = storage()?.getItem(prefsKey(desktopId));
    if (text) raw = JSON.parse(text);
  } catch {
    raw = undefined; // unreadable or corrupt JSON → defaults
  }
  return sanitizeDesktopPrefs(raw, coarsePointer());
}

export function writeDesktopPrefs(desktopId: string, prefs: DesktopPrefs): void {
  try {
    storage()?.setItem(prefsKey(desktopId), JSON.stringify(prefs));
  } catch {
    /* storage full or unavailable — prefs just don't persist */
  }
}

/** Remove a closed desktop's prefs. */
export function clearDesktopPrefs(desktopId: string): void {
  try {
    storage()?.removeItem(prefsKey(desktopId));
  } catch {
    /* storage unavailable */
  }
}
