/**
 * Touch throttle: pointer moves arrive faster than a device redraws (a 120 Hz
 * mouse, coalesced events); sending each one floods the input socket and the
 * host's input queue. Moves are coalesced to one per animation frame (latest
 * position wins); begin and end go out at once, and a pending move is flushed
 * before an end so the gesture finishes where the finger left.
 */

import type { TouchPhase } from "./types.ts";

export type TouchSender = (phase: TouchPhase, x: number, y: number) => void;

export interface PointerThrottle {
  push(phase: TouchPhase, x: number, y: number): void;
  /** Drop a pending move and stop scheduling. */
  dispose(): void;
}

export function createPointerThrottle(
  send: TouchSender
): PointerThrottle {
  let pending: { x: number; y: number } | null = null;
  let frame: number | null = null;
  let disposed = false;

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    const move = pending;
    pending = null;
    if (move && !disposed) send("move", move.x, move.y);
  };

  return {
    push(phase, x, y) {
      if (disposed) return;
      if (phase === "move") {
        pending = { x, y };
        frame ??= requestAnimationFrame(() => {
          frame = null;
          flush();
        });
        return;
      }
      if (phase === "end") flush();
      else {
        // A new gesture discards a stale move from the last one.
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        pending = null;
      }
      send(phase, x, y);
    },
    dispose() {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    }
  };
}

/** Clamp a normalized coordinate into 0..1 (hosts reject values outside). */
export function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
