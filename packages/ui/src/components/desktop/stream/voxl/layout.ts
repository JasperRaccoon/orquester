// Layout and sizing maths for the voxl stream client: where the display sits in its container,
// which size a Fit-mode viewer asks for, and how big the remote cursor is drawn.
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/client/{video,cursor,resize}.ts).

import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import type { DesktopSize } from "@orquester/api";

/** The display's box inside its container, in CSS px, and CSS px per display px. */
export interface DisplayBox {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

/** Fit / fixed-scale: scaled to fit the container (contain) and centered. */
export function containBox(container: DesktopSize, display: DesktopSize): DisplayBox | null {
  if (container.width <= 0 || container.height <= 0 || display.width <= 0 || display.height <= 0) return null;
  const scale = Math.min(container.width / display.width, container.height / display.height);
  const width = display.width * scale;
  const height = display.height * scale;
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height, scale };
}

/** Fixed, pan: 1:1, centered on an axis where it is smaller than the container (panned otherwise). */
export function actualSizeBox(container: DesktopSize, display: DesktopSize): DisplayBox | null {
  if (display.width <= 0 || display.height <= 0) return null;
  return {
    left: Math.max(0, (container.width - display.width) / 2),
    top: Math.max(0, (container.height - display.height) / 2),
    width: display.width,
    height: display.height,
    scale: 1
  };
}

/**
 * The size voxl gives the display for a `sz` request: within the desktop size limits, width a
 * multiple of 8 and height even (4:2:0 video), rounding down — voxl's own `screen::fit` grid, so
 * the next `hello` reports exactly this size.
 */
export function voxlRequestSize(size: DesktopSize): DesktopSize {
  const within = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  return {
    width: Math.floor(within(size.width, DESKTOP_MIN_WIDTH, DESKTOP_MAX_WIDTH) / 8) * 8,
    height: Math.floor(within(size.height, DESKTOP_MIN_HEIGHT, DESKTOP_MAX_HEIGHT) / 2) * 2
  };
}

/** Fit mode: the display size for a container of `css` layout px, in device pixels; null for an empty one. */
export function fitRequestSize(css: DesktopSize, devicePixelRatio: number): DesktopSize | null {
  if (css.width <= 0 || css.height <= 0) return null;
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return voxlRequestSize({ width: Math.round(css.width * dpr), height: Math.round(css.height * dpr) });
}

/** On-screen cursor bounds (CSS px, longer side): 24 is the standard pointer size. */
export const CURSOR_MIN_PX = 24;
export const CURSOR_MAX_PX = 128;

/** CSS px per cursor-image px: the display's scale, but never smaller than a normal pointer nor huge. */
export function cursorScale(displayScale: number, width: number, height: number): number {
  const size = Math.max(width, height, 1);
  const scale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  return Math.min(Math.max(scale, CURSOR_MIN_PX / size), CURSOR_MAX_PX / size);
}

/** A rendered box in client coordinates (a `getBoundingClientRect()`). */
export interface ClientBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A client point → display pixels through the surface's rendered (post-transform) rect, so the
 * view's local zoom on an ancestor is accounted for; null outside the rect or `shown` (the part of
 * a panned surface that is visible).
 */
export function clientToDisplayPoint(
  surface: ClientBox,
  display: DesktopSize,
  clientX: number,
  clientY: number,
  shown: ClientBox = surface
): { x: number; y: number } | null {
  if (surface.width <= 0 || surface.height <= 0) return null;
  const inside = (b: ClientBox) => clientX >= b.left && clientX < b.left + b.width && clientY >= b.top && clientY < b.top + b.height;
  if (!inside(surface) || !inside(shown)) return null;
  return {
    x: ((clientX - surface.left) / surface.width) * display.width,
    y: ((clientY - surface.top) / surface.height) * display.height
  };
}

/** Display pixels → a client point on the surface's rendered (post-transform) rect. */
export function displayToClientPoint(surface: ClientBox, display: DesktopSize, x: number, y: number): { x: number; y: number } | null {
  if (display.width <= 0 || display.height <= 0) return null;
  return { x: surface.left + (x / display.width) * surface.width, y: surface.top + (y / display.height) * surface.height };
}
