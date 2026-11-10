/**
 * The desktop agent overlay's geometry and marks, pure (spec 2026-11-10 R2.4): which action entries
 * draw a mark over the desktop (a click ripple, a drag trail, scroll chevrons, a typed-text bubble,
 * a key chip), and where in the view a display point lands.
 *
 * Entry points are display pixels. The view shows the display scaled into its surface element
 * (noVNC's canvas, a video) — letterboxed when the aspect ratios differ — possibly zoomed or panned
 * by a transform, so a point maps through the surface's on-screen rectangle, never through CSS
 * sizes, and lands relative to the overlay's own box.
 */

import type { DesktopActionEntry, DesktopMouseButton, DesktopScrollDirection, DesktopSize } from "@orquester/api";

import { DESKTOP_TYPED_TEXT_MAX, formatDesktopKeys } from "../../../lib/desktops/handoff.logic";

/** How long a mark stays (R2.4: each fades in ~1.2 s). */
export const DESKTOP_MARK_MS = 1200;

export interface ViewPoint {
  x: number;
  y: number;
}

/** A display point → overlay pixels, or null where it cannot be placed (not on screen, unknown geometry). */
export type MapDisplayPoint = (x: number, y: number) => ViewPoint | null;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where display point `point` shows, in pixels from the top-left of `container` (the overlay box),
 * when `surface` (screen rectangle) shows the whole `display` scaled to fit (letterboxed, centred).
 * Null for an unknown size or a point outside the container (scrolled or zoomed out of view).
 */
export function mapDisplayPoint(point: ViewPoint, display: DesktopSize, surface: Rect, container: Rect): ViewPoint | null {
  if (!(display.width > 0 && display.height > 0 && surface.width > 0 && surface.height > 0)) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const scale = Math.min(surface.width / display.width, surface.height / display.height);
  const left = surface.left + (surface.width - display.width * scale) / 2;
  const top = surface.top + (surface.height - display.height * scale) / 2;
  const x = left + point.x * scale - container.left;
  const y = top + point.y * scale - container.top;
  const slack = 1;
  if (x < -slack || y < -slack || x > container.width + slack || y > container.height + slack) return null;
  return { x, y };
}

/** The smallest rectangle around `rects` (a striped video), or null with none of any size. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  const sized = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (sized.length === 0) return null;
  const left = Math.min(...sized.map((rect) => rect.left));
  const top = Math.min(...sized.map((rect) => rect.top));
  const right = Math.max(...sized.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...sized.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Whether a canvas of `pixels` (its drawing-buffer size) draws the whole display. noVNC's canvas is
 * the framebuffer's size when it scales, and the visible part's when it clips (actual size, drag to
 * pan) — whose offset it does not publish, so points cannot be placed then.
 */
export function canvasShowsWholeDisplay(pixels: DesktopSize, display: DesktopSize): boolean {
  if (!(pixels.width > 0 && pixels.height > 0)) return true;
  return pixels.width >= display.width - 1 && pixels.height >= display.height - 1;
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export type DesktopOverlayMark =
  | { kind: "click"; id: string; at: ViewPoint; button: DesktopMouseButton; count: number; label: string; failed: boolean }
  | { kind: "press"; id: string; at: ViewPoint; down: boolean; label: string; failed: boolean }
  | { kind: "move"; id: string; at: ViewPoint; failed: boolean }
  | { kind: "drag"; id: string; from: ViewPoint; to: ViewPoint; failed: boolean }
  | { kind: "scroll"; id: string; at: ViewPoint | null; direction: DesktopScrollDirection; failed: boolean }
  | { kind: "text"; id: string; at: ViewPoint | null; text: string; failed: boolean }
  | { kind: "key"; id: string; label: string; failed: boolean }
  /** A pointer action whose point cannot be placed: its summary alone, at the top. */
  | { kind: "label"; id: string; label: string; failed: boolean };

const BUTTON_WORDS: Record<DesktopMouseButton, string> = { left: "Click", middle: "Middle click", right: "Right click" };

function clickLabel(button: DesktopMouseButton, count: number): string {
  const word = BUTTON_WORDS[button];
  if (count === 2) return button === "left" ? "Double click" : `${word} ×2`;
  if (count === 3) return button === "left" ? "Triple click" : `${word} ×3`;
  return word;
}

/** Typed text as its bubble shows it: one line, at most 60 characters. */
export function typedBubbleText(text: string): string {
  const line = text.replace(/\r?\n/g, " ⏎ ").replace(/\t/g, " ");
  return line.length > DESKTOP_TYPED_TEXT_MAX ? `${line.slice(0, DESKTOP_TYPED_TEXT_MAX - 1)}…` : line;
}

/**
 * The mark an entry draws, with its points mapped into the view; null for reads (screenshots,
 * waits, the clipboard) and anything with nothing to show.
 */
export function desktopOverlayMark(entry: DesktopActionEntry, map: MapDisplayPoint): DesktopOverlayMark | null {
  const failed = !entry.ok;
  const at = entry.point ? map(entry.point.x, entry.point.y) : null;
  const unplaced = (): DesktopOverlayMark => ({ kind: "label", id: entry.id, label: entry.summary, failed });
  switch (entry.kind) {
    case "click": {
      if (!at) return unplaced();
      const button = entry.button ?? "left";
      const count = Math.min(3, Math.max(1, entry.count ?? 1));
      return { kind: "click", id: entry.id, at, button, count, label: clickLabel(button, count), failed };
    }
    case "mouse_down":
    case "mouse_up": {
      if (!at) return unplaced();
      const down = entry.kind === "mouse_down";
      return { kind: "press", id: entry.id, at, down, label: down ? "Button down" : "Button up", failed };
    }
    case "move":
      return at ? { kind: "move", id: entry.id, at, failed } : null;
    case "drag": {
      const to = entry.to ? map(entry.to.x, entry.to.y) : null;
      return at && to ? { kind: "drag", id: entry.id, from: at, to, failed } : unplaced();
    }
    case "scroll":
      return entry.direction ? { kind: "scroll", id: entry.id, at, direction: entry.direction, failed } : unplaced();
    case "type":
      return entry.text ? { kind: "text", id: entry.id, at, text: typedBubbleText(entry.text), failed } : null;
    case "key":
      return { kind: "key", id: entry.id, label: entry.keys ? formatDesktopKeys(entry.keys) : entry.summary, failed };
    default:
      return null;
  }
}

/** The entries that arrived since the overlay last looked (`seen` ids), oldest first. */
export function newDesktopEntries(entries: readonly DesktopActionEntry[], seen: ReadonlySet<string>): DesktopActionEntry[] {
  return entries.filter((entry) => !seen.has(entry.id));
}
