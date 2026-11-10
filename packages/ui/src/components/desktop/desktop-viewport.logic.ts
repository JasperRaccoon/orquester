/**
 * Local zoom, sharp fit and follow-cursor maths for the desktop view on touch
 * devices (spec 2026-11-10 R3.1, R3.2, R3.6). Pure: the gesture layer feeds it
 * the view's geometry and applies the resulting transform to the stage (the
 * element around the stream client's container).
 *
 * Coordinates are CSS px relative to the view's top-left ("viewport" px)
 * unless they say display px. The stream client shows the display scaled to fit
 * its container and centered (`DesktopViewMode` fit / fixed-scale); the stage
 * transform is `translate(x, y) scale(scale)` with origin 0 0 on top of that.
 */

import type { DesktopSize } from "@orquester/api";
import type { DesktopTextSize } from "../../lib/desktop-prefs";

export const ZOOM_MAX = 5;
/** A pinch that ends below this zoom snaps back to 1×. */
export const ZOOM_SNAP_BELOW = 1.05;
/** Sharp fit: a display that would be stretched by at most this much is shown 1:1 instead. */
export const SHARP_MAX_STRETCH = 1.25;
/** Follow-cursor margin inside the visible edges. */
export const FOLLOW_MARGIN_PX = 40;

export interface DesktopViewportGeometry {
  /** The view's (untransformed) size. */
  width: number;
  height: number;
  /** Its top-left in client coordinates, to snap the display's corner to device pixels. */
  left: number;
  top: number;
  /** How much of `height` is above the soft keyboard. */
  visibleHeight: number;
  display: DesktopSize;
  devicePixelRatio: number;
  /** Sharp 1:1 rendering of a slightly-too-small display is allowed (touch rendering, size not fit-driven). */
  sharp: boolean;
}

/** The pinch zoom (1…ZOOM_MAX) and the stage translation it was panned to. */
export interface LocalZoom {
  zoom: number;
  x: number;
  y: number;
}

/** The CSS transform on the stage: `translate(x px, y px) scale(scale)`, origin 0 0. */
export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export const UNZOOMED: LocalZoom = { zoom: 1, x: 0, y: 0 };
export const IDENTITY: ViewTransform = { scale: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** CSS px per display px when the client scales the display to fit (0 while either is empty). */
export function fitScale(g: DesktopViewportGeometry): number {
  if (g.width <= 0 || g.height <= 0 || g.display.width <= 0 || g.display.height <= 0) return 0;
  return Math.min(g.width / g.display.width, g.height / g.display.height);
}

/** Where the fitted display sits in the untransformed stage. */
function fittedOrigin(g: DesktopViewportGeometry, s: number): Point {
  return { x: (g.width - g.display.width * s) / 2, y: (g.height - g.display.height * s) / 2 };
}

/**
 * The stage scale at 1× zoom: 1, or (sharp fit) the factor that shows the
 * display at one device pixel per display pixel when fitting it would stretch
 * it by 1…1.25×.
 */
export function baseScale(g: DesktopViewportGeometry): number {
  if (!g.sharp) return 1;
  const stretch = fitScale(g) * g.devicePixelRatio;
  return stretch >= 1 && stretch <= SHARP_MAX_STRETCH ? 1 / stretch : 1;
}

/**
 * Whether sharp fit may apply: on touch rendering only, and only to a display
 * this viewer does not size to the view itself. A Fit-mode display that follows
 * the view, or a Large / Medium preset, is already the size the user chose;
 * shrinking it to device pixels would undo that (More space is device pixels).
 */
export function sharpFitAllowed(state: { touchRendering: boolean; fitDrivesSize: boolean; textSize: DesktopTextSize }): boolean {
  if (!state.touchRendering || state.fitDrivesSize) return false;
  return state.textSize === "fit" || state.textSize === "more";
}

/** The 1× transform: identity, or the sharp-fit scale with the display centered and its corner on a device pixel. */
function restingTransform(g: DesktopViewportGeometry): ViewTransform {
  const scale = baseScale(g);
  if (scale === 1) return IDENTITY;
  const s = fitScale(g);
  const o = fittedOrigin(g, s);
  const dpr = g.devicePixelRatio;
  // Scaled about the view's center, then the corner moved onto the device-pixel grid.
  let x = (g.width / 2) * (1 - scale);
  let y = (g.height / 2) * (1 - scale);
  const left = g.left + x + scale * o.x;
  const top = g.top + y + scale * o.y;
  x += Math.round(left * dpr) / dpr - left;
  y += Math.round(top * dpr) / dpr - top;
  return { scale, x, y };
}

/** Keep the zoomed display covering the visible area (or centered in it when smaller). */
function clampAxis(t: number, contentStart: number, contentSize: number, visible: number): number {
  // `+ 0` turns a -0 into 0.
  if (contentSize <= visible) return (visible - contentSize) / 2 - contentStart + 0;
  return clamp(t, visible - contentSize - contentStart, -contentStart) + 0;
}

/** The stage transform for `zoom` in `g`: the resting transform at 1×, else scaled and clamped. */
export function viewTransform(g: DesktopViewportGeometry, zoom: LocalZoom): ViewTransform {
  if (zoom.zoom <= 1) return restingTransform(g);
  const s = fitScale(g);
  const o = fittedOrigin(g, s);
  const scale = baseScale(g) * zoom.zoom;
  return {
    scale,
    x: clampAxis(zoom.x, scale * o.x, scale * g.display.width * s, g.width),
    y: clampAxis(zoom.y, scale * o.y, scale * g.display.height * s, Math.min(g.visibleHeight, g.height))
  };
}

/** `zoom` with its translation clamped as {@link viewTransform} shows it (1× normalises to {@link UNZOOMED}). */
export function clampZoom(g: DesktopViewportGeometry, zoom: LocalZoom): LocalZoom {
  if (zoom.zoom <= 1) return UNZOOMED;
  const t = viewTransform(g, zoom);
  return { zoom: zoom.zoom, x: t.x, y: t.y };
}

/** A display point (display px) in viewport px under `t`. */
export function displayToViewport(g: DesktopViewportGeometry, t: ViewTransform, p: Point): Point {
  const s = fitScale(g);
  const o = fittedOrigin(g, s);
  return { x: t.x + t.scale * (o.x + p.x * s), y: t.y + t.scale * (o.y + p.y * s) };
}

/** A viewport point in display px under `t` (not clamped to the display). */
export function viewportToDisplay(g: DesktopViewportGeometry, t: ViewTransform, p: Point): Point {
  const s = fitScale(g);
  if (s === 0) return { x: 0, y: 0 };
  const o = fittedOrigin(g, s);
  return { x: ((p.x - t.x) / t.scale - o.x) / s, y: ((p.y - t.y) / t.scale - o.y) / s };
}

/** Display px per CSS px as shown under `t`. */
export function displayPxPerCssPx(g: DesktopViewportGeometry, t: ViewTransform): number {
  const s = fitScale(g);
  return s === 0 ? 1 : 1 / (s * t.scale);
}

/** A display point clamped onto the display's pixels. */
export function clampToDisplay(g: DesktopViewportGeometry, p: Point): Point {
  return {
    x: clamp(p.x, 0, Math.max(0, g.display.width - 1)),
    y: clamp(p.y, 0, Math.max(0, g.display.height - 1))
  };
}

/**
 * Pinch: the zoom `start` scaled by `ratio` (finger distance now / at the
 * start), with the display point that was under `from` (the fingers' midpoint
 * then) kept under `to` (their midpoint now), so the pinch also pans.
 */
export function pinchZoom(g: DesktopViewportGeometry, start: LocalZoom, ratio: number, from: Point, to: Point): LocalZoom {
  const zoom = clamp(start.zoom * ratio, 1, ZOOM_MAX);
  const before = viewTransform(g, start);
  const scale = baseScale(g) * zoom;
  // The stage point under `from`, placed under `to` at the new scale.
  const sx = (from.x - before.x) / before.scale;
  const sy = (from.y - before.y) / before.scale;
  if (zoom <= 1) return UNZOOMED;
  return clampZoom(g, { zoom, x: to.x - scale * sx, y: to.y - scale * sy });
}

/** End of a pinch: below {@link ZOOM_SNAP_BELOW} it snaps back to 1×. */
export function settleZoom(g: DesktopViewportGeometry, zoom: LocalZoom): LocalZoom {
  return zoom.zoom < ZOOM_SNAP_BELOW ? UNZOOMED : clampZoom(g, zoom);
}

export function panZoom(g: DesktopViewportGeometry, zoom: LocalZoom, dx: number, dy: number): LocalZoom {
  if (zoom.zoom <= 1) return zoom;
  return clampZoom(g, { zoom: zoom.zoom, x: zoom.x + dx, y: zoom.y + dy });
}

/**
 * While zoomed, pan so `cursor` (display px) stays {@link FOLLOW_MARGIN_PX}
 * inside the visible edges, the bottom one being the top of the soft keyboard.
 */
export function followCursor(g: DesktopViewportGeometry, zoom: LocalZoom, cursor: Point): LocalZoom {
  if (zoom.zoom <= 1) return zoom;
  const t = viewTransform(g, zoom);
  const p = displayToViewport(g, t, cursor);
  const bottom = Math.min(g.visibleHeight, g.height);
  const shift = (v: number, end: number) => {
    // A view narrower than two margins keeps the cursor centered instead.
    if (end <= 2 * FOLLOW_MARGIN_PX) return end / 2 - v;
    if (v < FOLLOW_MARGIN_PX) return FOLLOW_MARGIN_PX - v;
    if (v > end - FOLLOW_MARGIN_PX) return end - FOLLOW_MARGIN_PX - v;
    return 0;
  };
  const dx = shift(p.x, g.width);
  const dy = shift(p.y, bottom);
  if (dx === 0 && dy === 0) return { zoom: zoom.zoom, x: t.x, y: t.y };
  return clampZoom(g, { zoom: zoom.zoom, x: t.x + dx, y: t.y + dy });
}

/** The CSS for `t` (`none` for the identity, so the stage composites as usual). */
export function transformCss(t: ViewTransform): string {
  if (t.scale === 1 && t.x === 0 && t.y === 0) return "none";
  return `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
}
