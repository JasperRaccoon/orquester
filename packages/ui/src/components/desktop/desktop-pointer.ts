/**
 * Where the remote pointer goes when the local mouse leaves the display.
 *
 * noVNC only forwards pointer events from inside its canvas, so the desktop's
 * pointer otherwise stays where the mouse last was: on the button the user
 * hovered before reaching for the Orquester toolbar. The app keeps that button
 * hovered and its tooltip up — and a tooltip is an override-redirect window,
 * so it then floats above whichever window the user raises next. Parking the
 * pointer at the point where the mouse crossed the display's edge is what a
 * real screen edge does.
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The exit point `(x, y)` (client px) clamped onto the last pixel row/column inside `rect`. */
export function exitPoint(rect: Rect, x: number, y: number): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return { x: clamp(x, rect.left, rect.right - 1), y: clamp(y, rect.top, rect.bottom - 1) };
}
