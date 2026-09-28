import { useCallback, useRef } from "react";

/** How long a finger rests before it is a long press (Android's default). */
export const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling or panning, not pressing. */
const SLOP_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  /** Swallows the click that follows a long press. */
  onClickCapture: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * Long-press handlers for an element (touch and pen only — a mouse has a
 * right click, which `onContextMenu` maps to the same action). The press
 * fires after {@link LONG_PRESS_MS} without moving; the click that follows it
 * is swallowed. Never the only way in: every long-press menu also has a
 * visible button.
 */
export function useLongPress(onLongPress: (point: { x: number; y: number }, target: EventTarget | null) => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);

  return {
    onPointerDown: (event) => {
      fired.current = false;
      if (event.pointerType === "mouse" || event.button !== 0) return;
      clear();
      const point = { x: event.clientX, y: event.clientY };
      const target = event.target;
      start.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(12);
          } catch {
            // not allowed: no buzz
          }
        }
        callback.current(point, target);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const origin = start.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > SLOP_PX) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClickCapture: (event) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event) => {
      event.preventDefault();
      if (fired.current) return;
      callback.current({ x: event.clientX, y: event.clientY }, event.target);
    }
  };
}
