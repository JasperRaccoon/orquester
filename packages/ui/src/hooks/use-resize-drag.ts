import { useEffect, useRef, useState } from "react";

/**
 * A divider's line orientation: `"vertical"` divides columns (drag horizontally,
 * `cursor-col-resize`), `"horizontal"` divides rows (drag vertically,
 * `cursor-row-resize`). Doubles as the `aria-orientation` value.
 */
export type ResizeOrientation = "vertical" | "horizontal";

export interface UseResizeDragOptions {
  /** Line orientation; picks the pointer axis (X for vertical, Y for horizontal). */
  orientation: ResizeOrientation;
  /** Reads the size being dragged at pointer-down (px, or grid-boundary px). */
  getCurrent: () => number;
  /** Lower bound (px) when no `clamp` is supplied. */
  min?: number;
  /** Upper bound (px) when no `clamp` is supplied. */
  max?: number;
  /**
   * Custom clamp for the proposed value (takes precedence over `min`/`max`).
   * Grid dividers use this to bound against both adjacent tracks + container.
   */
  clamp?: (next: number) => number;
  /** Per-frame (rAF-coalesced) callback with the clamped size during a drag. */
  onResize: (next: number) => void;
  /** Called once on release (pointerup/pointercancel) with the final size. */
  onCommit: (next: number) => void;
  /** Optional double-click handler (reset to default). */
  onReset?: () => void;
  /** When true, pointer-down and double-click are inert. */
  disabled?: boolean;
}

/** Event handlers to spread onto the interactive hit-area element. */
export interface ResizeDragHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
  /** Swallows the click that a real drag would otherwise synthesize. */
  onClickCapture: (e: React.MouseEvent) => void;
}

export interface UseResizeDragResult {
  /** True between pointer-down and release; drive the active highlight with it. */
  dragging: boolean;
  handlers: ResizeDragHandlers;
}

interface DragState {
  pointerId: number;
  /** The captured hit-area element (for releasing capture from outside a handler). */
  target: HTMLElement;
  /** Pointer coordinate (X or Y) at pointer-down. */
  start: number;
  /** `getCurrent()` captured at pointer-down. */
  base: number;
  /** Last clamped value; flushed to `onResize` at most once per frame. */
  next: number;
  raf: number | null;
}

/**
 * Pointer-events resize drag with `setPointerCapture` (so the drag survives over
 * xterm mouse-reporting regions and sandboxed iframes), rAF-coalesced `onResize`
 * (≤1 per frame — bounds the ResizeObserver→FitAddon flood on terminal grids),
 * commit-on-release, optional double-click reset, and full listener/rAF cleanup
 * on unmount. Handlers attach to the element itself; pointer capture routes moves
 * back to it without window listeners.
 */
export function useResizeDrag(opts: UseResizeDragOptions): UseResizeDragResult {
  const [dragging, setDragging] = useState(false);
  // Latest options in a ref so the handlers/rAF flush always see current props
  // without re-binding (callbacks are recreated on every parent render).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const drag = useRef<DragState | null>(null);
  // True once a real move occurred; both commits the drag and marks the
  // synthesized click for swallowing (the FileBrowser long-press precedent).
  const moved = useRef(false);

  useEffect(
    () => () => {
      // Unmount mid-drag: cancel any pending frame so the flush can't fire late,
      // then commit the previewed value so the persist:false preview already in
      // the store isn't stranded (later silently serialized, or lost on reload).
      // The store setters are safe to call post-unmount; a no-move drag is a no-op.
      const d = drag.current;
      if (d) {
        if (d.raf !== null) {
          cancelAnimationFrame(d.raf);
        }
        if (moved.current) {
          optsRef.current.onCommit(d.next);
        }
      }
      drag.current = null;
    },
    []
  );

  // If `disabled` flips true during an active drag (e.g. the viewport crosses
  // below 768px and the handle is display:none'd while still mounted), terminate
  // the drag: release capture, cancel the pending frame, and commit the last
  // moved value. Commit (not revert) matches the unmount path and keeps the last
  // desktop-computed size — moves stop arriving once the handle is hidden, so
  // `next` is the final valid value from before the layout changed.
  useEffect(() => {
    if (!opts.disabled) {
      return;
    }
    const d = drag.current;
    if (!d) {
      return;
    }
    if (d.raf !== null) {
      cancelAnimationFrame(d.raf);
    }
    try {
      d.target.releasePointerCapture(d.pointerId);
    } catch {
      /* capture may already be gone (display:none implicitly releases it) */
    }
    const didMove = moved.current;
    const final = d.next;
    drag.current = null;
    setDragging(false);
    if (didMove) {
      optsRef.current.onCommit(final);
    }
  }, [opts.disabled]);

  const clampValue = (value: number): number => {
    const { clamp, min, max } = optsRef.current;
    if (clamp) {
      return clamp(value);
    }
    let v = value;
    if (typeof min === "number" && v < min) {
      v = min;
    }
    if (typeof max === "number" && v > max) {
      v = max;
    }
    return v;
  };

  const flush = () => {
    const d = drag.current;
    if (!d) {
      return;
    }
    d.raf = null;
    optsRef.current.onResize(d.next);
  };

  const finish = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) {
      return;
    }
    if (d.raf !== null) {
      cancelAnimationFrame(d.raf);
    }
    try {
      e.currentTarget.releasePointerCapture(d.pointerId);
    } catch {
      /* capture may already be gone (pointercancel) — ignore */
    }
    const final = d.next;
    const didMove = moved.current;
    drag.current = null;
    setDragging(false);
    // A plain click on the handle (no movement) must not persist a no-op write.
    if (didMove) {
      optsRef.current.onCommit(final);
    }
  };

  const handlers: ResizeDragHandlers = {
    onPointerDown: (e) => {
      if (optsRef.current.disabled) {
        return;
      }
      // Ignore secondary pointers: a non-primary pointer (a second finger on the
      // same handle) or a pointer-down while a drag is already active would
      // overwrite `drag.current` and orphan the first pointer (its pointerup no
      // longer matches, the pending rAF flushes against the wrong state).
      if (!e.isPrimary || drag.current) {
        return;
      }
      // Primary mouse button only; touch/pen always pass.
      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort; the drag still works via element moves */
      }
      const base = optsRef.current.getCurrent();
      drag.current = {
        pointerId: e.pointerId,
        target,
        start: optsRef.current.orientation === "vertical" ? e.clientX : e.clientY,
        base,
        next: base,
        raf: null
      };
      moved.current = false;
      setDragging(true);
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) {
        return;
      }
      const coord = optsRef.current.orientation === "vertical" ? e.clientX : e.clientY;
      d.next = clampValue(d.base + (coord - d.start));
      moved.current = true;
      if (d.raf === null) {
        d.raf = requestAnimationFrame(flush);
      }
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onDoubleClick: (e) => {
      if (optsRef.current.disabled) {
        return;
      }
      e.preventDefault();
      optsRef.current.onReset?.();
    },
    onClickCapture: (e) => {
      if (moved.current) {
        e.preventDefault();
        e.stopPropagation();
        moved.current = false;
      }
    }
  };

  return { dragging, handlers };
}
