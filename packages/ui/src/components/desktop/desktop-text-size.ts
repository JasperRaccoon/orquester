import {
  DESKTOP_MAX_HEIGHT,
  DESKTOP_MAX_WIDTH,
  DESKTOP_MIN_HEIGHT,
  DESKTOP_MIN_WIDTH
} from "@orquester/config";
import type { DesktopSize } from "@orquester/api";
import type { DesktopTextSize } from "../../lib/desktop-prefs";

/**
 * Text-size presets on touch devices (spec 2026-11-10 R3.5): the display size
 * is the view's CSS size times a factor, so the desktop's own text renders at
 * the chosen size instead of being scaled.
 *
 * - Large: × 1 (one display pixel per CSS pixel).
 * - Medium: × (1 + dpr) / 2.
 * - More space: × dpr (one display pixel per device pixel).
 *
 * Each side is rounded down to an even number (so the display never outgrows
 * the view's device pixels and a sharp 1:1 fit applies) and clamped to the
 * desktop size limits. `fit` is no preset: the View menu's display size applies.
 */
export function textSizeFactor(preset: Exclude<DesktopTextSize, "fit">, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  switch (preset) {
    case "large":
      return 1;
    case "medium":
      return (1 + dpr) / 2;
    case "more":
      return dpr;
  }
}

function evenWithin(value: number, min: number, max: number): number {
  const even = Math.floor(value / 2) * 2;
  return Math.min(max, Math.max(min, even));
}

/** The display size `preset` asks for in a view of `cssSize`, or null for `fit` or an empty view. */
export function textSizeDisplaySize(preset: DesktopTextSize, cssSize: DesktopSize, devicePixelRatio: number): DesktopSize | null {
  if (preset === "fit" || cssSize.width <= 0 || cssSize.height <= 0) return null;
  const factor = textSizeFactor(preset, devicePixelRatio);
  return {
    width: evenWithin(cssSize.width * factor, DESKTOP_MIN_WIDTH, DESKTOP_MAX_WIDTH),
    height: evenWithin(cssSize.height * factor, DESKTOP_MIN_HEIGHT, DESKTOP_MAX_HEIGHT)
  };
}

/** Debounce for preset requests while the view's size settles (rotation, soft keyboard). */
export const TEXT_SIZE_DEBOUNCE_MS = 250;
