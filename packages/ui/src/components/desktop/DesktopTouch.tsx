import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { DesktopSize } from "@orquester/api";
import type { DesktopInputMode } from "../../lib/desktop-prefs";
import { DesktopGestureRecognizer, type GesturePointer } from "./desktop-gestures.logic";
import {
  IDENTITY,
  displayToViewport,
  transformCss,
  viewTransform,
  type DesktopViewportGeometry,
  type Point,
  type ViewTransform
} from "./desktop-viewport.logic";
import type { DesktopInputSink, DesktopPointerButton, DesktopStreamClient } from "./stream/types";

/**
 * The touch input layer of the desktop view (spec 2026-11-10 R3.1–R3.2, R3.6–R3.7).
 *
 * Touch pointers on the view are taken in the capture phase and fed to the
 * gesture recogniser; the client's own touch handling is switched off on the
 * first touch, before the browser's touch events reach it. The local zoom (and
 * sharp fit) is a CSS transform on the stage, written straight to its style;
 * the cursor overlay and other overlays read it from the returned store.
 *
 * Mouse input passes through untouched (and pen input while the client's touch
 * handling is on). Using a mouse drops any zoom first, synchronously: the
 * client maps mouse positions itself and a transformed stage would skew them.
 */

export interface DesktopTouchSnapshot {
  /** The stage's transform (identity unless zoomed or sharp-fitted). */
  transform: ViewTransform;
  /** The view's geometry when the stage was last laid out, or null with no display. */
  geometry: DesktopViewportGeometry | null;
  /** Where the gesture layer's pointer is (Trackpad: where a tap clicks), in viewport px; null with no display. */
  cursor: Point | null;
  zoomed: boolean;
}

export interface DesktopTouchStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DesktopTouchSnapshot;
}

export interface DesktopTouchOptions {
  /** The view's (untransformed) box, which takes the pointer events. */
  viewportRef: React.RefObject<HTMLElement | null>;
  /** The element around the client's container that the local zoom transforms. */
  stageRef: React.RefObject<HTMLElement | null>;
  client: () => DesktopStreamClient | null;
  /** The display's size as the client reports it. */
  displaySize: DesktopSize | null;
  connected: boolean;
  /** Touch rendering (local zoom, sharp fit) is on: the last input was a touch. */
  rendering: boolean;
  /** Sharp fit is allowed. */
  sharp: boolean;
  /** A pen drives the sink directly (the client's own touch handling is off). */
  directPen: boolean;
  mode: DesktopInputMode;
  /** Keysyms of the latched key-bar modifiers for the next click (spends the one-shots). */
  takeModifiers: () => number[];
  /** A touch landed on the view (called before it is handled). */
  onTouch: () => void;
  /** A mouse or pen was used on the view. */
  onFinePointer: () => void;
  /** Give the keyboard to the display (the hidden input while the soft keyboard is up). */
  focusDisplay: () => void;
}

/** `PointerEvent.button` of a pen: the tip, the barrel button (right), the middle one. */
const PEN_BUTTONS: Record<number, DesktopPointerButton> = { 0: 1, 1: 2, 2: 3 };

const EMPTY: DesktopTouchSnapshot = { transform: IDENTITY, geometry: null, cursor: null, zoomed: false };

export function useDesktopTouch(options: DesktopTouchOptions): DesktopTouchStore {
  const opts = useRef(options);
  opts.current = options;

  const store = useMemo(() => {
    let snapshot = EMPTY;
    const listeners = new Set<() => void>();
    return {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getSnapshot: () => snapshot,
      set(next: DesktopTouchSnapshot) {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      }
    };
  }, []);

  const geometry = (): DesktopViewportGeometry | null => {
    const { viewportRef, displaySize, sharp } = opts.current;
    const el = viewportRef.current;
    if (!el || !displaySize) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const visibleHeight = vv ? Math.min(Math.max(vv.offsetTop + vv.height - rect.top, 0), rect.height) : rect.height;
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      visibleHeight,
      display: displaySize,
      devicePixelRatio: window.devicePixelRatio || 1,
      sharp
    };
  };

  /** Lay the stage out for the recogniser's zoom and publish it. */
  const layout = (): void => {
    const recognizer = recognizerRef.current;
    const stage = opts.current.stageRef.current;
    if (!recognizer) return;
    const geo = geometry();
    const { zoom, cursor } = recognizer.state;
    const transform = geo && opts.current.rendering ? viewTransform(geo, zoom) : IDENTITY;
    if (stage) {
      stage.style.transformOrigin = "0 0";
      stage.style.transform = transformCss(transform);
    }
    const prev = store.getSnapshot();
    // Before any gesture, Trackpad mode's first click goes to the display's center (the recogniser's default).
    const pointer = cursor ?? (geo ? { x: Math.floor(geo.display.width / 2), y: Math.floor(geo.display.height / 2) } : null);
    const at = geo && pointer ? displayToViewport(geo, transform, pointer) : null;
    const next: DesktopTouchSnapshot = { transform, geometry: geo, cursor: at, zoomed: zoom.zoom > 1 };
    const same =
      prev.transform.scale === next.transform.scale &&
      prev.transform.x === next.transform.x &&
      prev.transform.y === next.transform.y &&
      prev.cursor?.x === next.cursor?.x &&
      prev.cursor?.y === next.cursor?.y &&
      prev.zoomed === next.zoomed &&
      sameGeometry(prev.geometry, next.geometry);
    if (!same) store.set(next);
  };

  const recognizerRef = useRef<DesktopGestureRecognizer | null>(null);
  if (!recognizerRef.current) {
    // Every sink call goes to whichever client is connected at the time.
    const sink: DesktopInputSink = {
      pointerMove: (x, y) => opts.current.client()?.pointerMove(x, y),
      pointerButton: (button, down) => opts.current.client()?.pointerButton(button, down),
      scroll: (dx, dy) => opts.current.client()?.scroll(dx, dy),
      key: (keysym, down, code) => opts.current.client()?.key(keysym, down, code),
      releaseAll: () => opts.current.client()?.releaseAll(),
      setClipboard: (text) => opts.current.client()?.setClipboard(text)
    };
    recognizerRef.current = new DesktopGestureRecognizer(
      {
        geometry,
        sink,
        takeModifiers: () => opts.current.takeModifiers(),
        onChange: () => layout(),
        haptic: () => navigator.vibrate?.(10)
      },
      options.mode
    );
  }

  const recognizer = recognizerRef.current;
  useEffect(() => {
    recognizer.mode = options.mode;
  }, [recognizer, options.mode]);

  // Re-lay out when the geometry or what may be shown changes.
  const { displaySize, rendering, sharp, connected } = options;
  useEffect(() => {
    if (!rendering) recognizer.resetZoom();
    if (!connected) recognizer.cancel();
    recognizer.refresh();
    layout();
    // `layout` reads everything through refs.
  }, [displaySize?.width, displaySize?.height, rendering, sharp, connected, recognizer]);

  useEffect(() => {
    const el = options.viewportRef.current;
    if (!el) return;
    let frame = 0;
    const relayout = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recognizer.refresh();
        layout();
      });
    };
    const observer = new ResizeObserver(relayout);
    observer.observe(el);
    window.visualViewport?.addEventListener("resize", relayout);
    window.visualViewport?.addEventListener("scroll", relayout);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", relayout);
      window.visualViewport?.removeEventListener("scroll", relayout);
    };
  }, [options.viewportRef, recognizer]);

  useEffect(() => {
    const el = options.viewportRef.current;
    if (!el) return;
    const touches = new Set<number>();
    const pens = new Set<number>();
    let fine = false;
    const point = (e: PointerEvent): GesturePointer => {
      const rect = el.getBoundingClientRect();
      return { id: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top, t: e.timeStamp };
    };
    /** On the display (not an overlay or a notice above it). */
    const onDisplay = (target: EventTarget | null) => {
      const stage = opts.current.stageRef.current;
      return target === el || (target instanceof Node && stage?.contains(target) === true);
    };
    const finePointer = () => {
      // Before the client maps this event: drop the zoom so its mapping is right.
      if (store.getSnapshot().transform !== IDENTITY || recognizer.state.zoom.zoom > 1) {
        recognizer.cancel();
        recognizer.resetZoom();
        const stage = opts.current.stageRef.current;
        if (stage) stage.style.transform = "none";
      }
      if (!fine) {
        fine = true;
        opts.current.onFinePointer();
      }
    };

    // With the client's touch handling off, a pen goes through the sink as a
    // direct pointer (its touch events, on iPad, are blocked with the rest).
    const penDirect = (e: PointerEvent) => e.pointerType === "pen" && opts.current.directPen && opts.current.connected;
    const penButton = (e: PointerEvent): DesktopPointerButton | null => PEN_BUTTONS[e.button] ?? null;

    const onPointerDown = (e: PointerEvent) => {
      if (penDirect(e)) {
        if (!onDisplay(e.target)) return;
        const button = penButton(e);
        if (button === null) return;
        e.preventDefault();
        pens.add(e.pointerId);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
        opts.current.focusDisplay();
        recognizer.penButton(button, true, point(e));
        return;
      }
      if (e.pointerType !== "touch") {
        if (onDisplay(e.target)) finePointer();
        return;
      }
      if (!onDisplay(e.target)) return;
      fine = false;
      // Before touchstart: the client must not see this touch.
      opts.current.client()?.setNativeInput(false);
      opts.current.onTouch();
      if (!opts.current.connected) return;
      e.preventDefault();
      touches.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      if (touches.size === 1) opts.current.focusDisplay();
      recognizer.down(point(e));
    };
    const onPointerMove = (e: PointerEvent) => {
      if (penDirect(e)) {
        if (pens.has(e.pointerId) || onDisplay(e.target)) recognizer.penMove(point(e));
        return;
      }
      if (e.pointerType !== "touch") {
        if (!fine && e.pointerType === "mouse" && onDisplay(e.target)) finePointer();
        return;
      }
      if (!touches.has(e.pointerId)) return;
      e.preventDefault();
      recognizer.move(point(e));
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pens.delete(e.pointerId)) {
        const button = penButton(e);
        e.preventDefault();
        if (button !== null) recognizer.penButton(button, false, point(e));
        return;
      }
      if (!touches.delete(e.pointerId)) return;
      e.preventDefault();
      recognizer.up(point(e));
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (pens.delete(e.pointerId)) {
        recognizer.cancel();
        return;
      }
      if (!touches.delete(e.pointerId)) return;
      recognizer.cancelPointer(point(e));
    };
    // A long press must not open the browser's menu, and iOS's page pinch must not start.
    const onContextMenu = (e: Event) => {
      if (!fine && onDisplay(e.target)) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    // Nothing stays held when the page goes away mid-gesture.
    const release = () => {
      touches.clear();
      pens.clear();
      recognizer.cancel();
      opts.current.client()?.releaseAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") release();
    };

    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("pointermove", onPointerMove, true);
    el.addEventListener("pointerup", onPointerUp, true);
    el.addEventListener("pointercancel", onPointerCancel, true);
    el.addEventListener("contextmenu", onContextMenu, true);
    el.addEventListener("gesturestart", onGesture);
    el.addEventListener("gesturechange", onGesture);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", release);
    window.addEventListener("blur", release);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("pointermove", onPointerMove, true);
      el.removeEventListener("pointerup", onPointerUp, true);
      el.removeEventListener("pointercancel", onPointerCancel, true);
      el.removeEventListener("contextmenu", onContextMenu, true);
      el.removeEventListener("gesturestart", onGesture);
      el.removeEventListener("gesturechange", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", release);
      window.removeEventListener("blur", release);
      recognizer.cancel();
    };
  }, [options.viewportRef, recognizer, store]);

  return store;
}

function sameGeometry(a: DesktopViewportGeometry | null, b: DesktopViewportGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.left === b.left &&
    a.top === b.top &&
    a.visibleHeight === b.visibleHeight &&
    a.display.width === b.display.width &&
    a.display.height === b.display.height &&
    a.devicePixelRatio === b.devicePixelRatio &&
    a.sharp === b.sharp
  );
}

/**
 * Trackpad mode's local cursor (R3.2): an arrow over the video at the pointer,
 * its hotspot at the tip, so the finger never hides what it points at.
 */
export const DesktopTouchCursor: React.FC<{ store: DesktopTouchStore }> = ({ store }) => {
  const { cursor } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!cursor) return null;
  return (
    <svg
      aria-hidden
      width={18}
      height={26}
      viewBox="0 0 18 26"
      className="pointer-events-none absolute left-0 top-0 drop-shadow"
      // The arrow's tip is at (1, 1).
      style={{ transform: `translate(${cursor.x - 1}px, ${cursor.y - 1}px)` }}
    >
      <path d="M1 1 L1 21 L6 16 L9.5 24 L13 22.5 L9.5 15 L16.5 15 Z" fill="white" stroke="black" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
};
