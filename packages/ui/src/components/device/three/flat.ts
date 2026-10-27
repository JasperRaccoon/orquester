// The flat (2D) device view: the stream canvas inside a bezel drawn from the same shape profile
// the procedural 3D body uses, with touch points normalized the way the 3D viewer reports them.
import type { DeviceShapeProfile } from "./shapeProfile.ts";
import type { DeviceOrientation, DevicePlatform } from "./types.ts";

/** The 3D scenes size every screen to this height; profile measurements are in the same units. */
const SCREEN_HEIGHT = 2.2;
/** How far a side button stands off the body, matching `phoneScene`'s button placement. */
const BUTTON_OFFSET = 0.015;
const BUTTON_THICKNESS = 0.026;

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

const isLandscape = (orientation: DeviceOrientation) =>
  orientation === "landscape_left" || orientation === "landscape_right";

const usable = (size: Size | null | undefined): size is Size =>
  !!size &&
  Number.isFinite(size.width) &&
  Number.isFinite(size.height) &&
  size.width > 0 &&
  size.height > 0;

/** Width over height of the screen as the user sees it, in its current orientation. */
export function deviceScreenAspect(
  platform: DevicePlatform,
  frame: Size | null,
  orientation: DeviceOrientation,
): number {
  const portrait = usable(frame)
    ? Math.min(frame.width, frame.height) / Math.max(frame.width, frame.height)
    : platform === "ios"
      ? 9 / 19.5
      : 9 / 20;
  return isLandscape(orientation) ? 1 / portrait : portrait;
}

/**
 * Clockwise CSS rotation of the raw frame inside the visible screen. serve-sim sends portrait
 * framebuffers even while iOS reports a landscape or upside-down interface; Android emulators
 * rotate their own framebuffer.
 */
export function flatMediaRotation(
  platform: DevicePlatform,
  frame: Size | null,
  orientation: DeviceOrientation,
): 0 | 90 | -90 | 180 {
  if (platform !== "ios" || !usable(frame) || frame.width > frame.height) return 0;
  switch (orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

/** Places the raw frame so that, after `rotation`, it fills a screen of `screen` CSS pixels. */
export function flatMediaStyle(screen: Size, rotation: 0 | 90 | -90 | 180) {
  const sideways = rotation === 90 || rotation === -90;
  return sideways
    ? {
        width: screen.height,
        height: screen.width,
        left: (screen.width - screen.height) / 2,
        top: (screen.height - screen.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: screen.width,
        height: screen.height,
        left: 0,
        top: 0,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };
}

/** The body's clockwise turn as seen from the front, matching `phoneDisplayLayout`'s rotation. */
function bodyTurn(orientation: DeviceOrientation): 0 | 90 | -90 | 180 {
  if (orientation === "landscape_left") return 90;
  if (orientation === "landscape_right") return -90;
  if (orientation === "portrait_upside_down") return 180;
  return 0;
}

function turnRect(rect: Rect, box: Size, turn: 0 | 90 | -90 | 180): Rect {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) =>
    turn === 90
      ? [box.height - y!, x!]
      : turn === -90
        ? [y!, box.width - x!]
        : turn === 180
          ? [box.width - x!, box.height - y!]
          : [x!, y!],
  );
  const [a, b] = corners as [[number, number], [number, number]];
  return {
    x: Math.min(a[0], b[0]),
    y: Math.min(a[1], b[1]),
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
  };
}

/**
 * The front outline of a procedural device in scene units (screen height 2.2), as seen in the
 * given orientation: body size, screen rectangle and side buttons relative to the body's top-left
 * corner (buttons stand outside it), and corner radii.
 */
export function flatDeviceGeometry(
  profile: DeviceShapeProfile,
  portraitAspect: number,
  orientation: DeviceOrientation,
) {
  const aspect = Math.min(portraitAspect, 1 / portraitAspect);
  const screenWidth = SCREEN_HEIGHT * aspect;
  const width = screenWidth + profile.bezel * 2;
  const height = SCREEN_HEIGHT + profile.bezel * 2;
  const portrait: Size = { width, height };
  const turn = bodyTurn(orientation);
  const buttons = profile.buttons.map(({ edge, offset, length }) => {
    // phoneScene centers the body on the origin with +y up; this layout's origin is top-left, +y down.
    const centerX =
      edge === "top" ? offset : (edge === "left" ? -1 : 1) * (width / 2 + BUTTON_OFFSET);
    const centerY = edge === "top" ? height / 2 + BUTTON_OFFSET : offset;
    const w = edge === "top" ? length : BUTTON_THICKNESS;
    const h = edge === "top" ? BUTTON_THICKNESS : length;
    return turnRect(
      { x: centerX + width / 2 - w / 2, y: height / 2 - centerY - h / 2, width: w, height: h },
      portrait,
      turn,
    );
  });
  const screen = turnRect(
    { x: profile.bezel, y: profile.bezel, width: screenWidth, height: SCREEN_HEIGHT },
    portrait,
    turn,
  );
  const sideways = turn === 90 || turn === -90;
  return {
    width: sideways ? height : width,
    height: sideways ? width : height,
    screen,
    buttons,
    bodyRadius: profile.bodyRadius,
    screenRadius: profile.screenRadius,
  };
}

export type FlatDeviceGeometry = ReturnType<typeof flatDeviceGeometry>;

/**
 * The CSS-pixel scale that fits the device (and its buttons) inside the host with no distortion.
 */
export function flatDeviceScale(geometry: FlatDeviceGeometry, host: Size): number {
  if (!usable(host)) return 0;
  const margin = (BUTTON_OFFSET + BUTTON_THICKNESS) * 2;
  return Math.min(host.width / (geometry.width + margin), host.height / (geometry.height + margin));
}

/**
 * A pointer position over the visible screen, normalized to 0..1 in the device's current
 * orientation (as the 3D viewer's `screenPoint` reports it). A press must start on the screen;
 * while a touch is captured, positions past the edges clamp to them.
 */
export function flatScreenPoint(
  screen: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
  captured: boolean,
): { x: number; y: number } | null {
  if (!(screen.width > 0 && screen.height > 0) || !Number.isFinite(clientX + clientY)) return null;
  const x = (clientX - screen.left) / screen.width;
  const y = (clientY - screen.top) / screen.height;
  if (!captured && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/**
 * Where a point on the flat screen as seen (0..1, top-left 0,0) shows, in CSS pixels from the
 * top-left of `root` (the viewport's own box): the inverse of {@link flatScreenPoint}, for drawing
 * over the device. Null when the screen has no size yet.
 */
export function flatViewPoint(
  screen: Pick<DOMRect, "left" | "top" | "width" | "height">,
  root: Pick<DOMRect, "left" | "top">,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (screen.width <= 0 || screen.height <= 0 || ![x, y].every(Number.isFinite)) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: screen.left - root.left + clamp(x) * screen.width,
    y: screen.top - root.top + clamp(y) * screen.height,
  };
}
