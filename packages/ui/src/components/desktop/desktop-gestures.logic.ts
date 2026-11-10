/**
 * The touch gesture recogniser for the desktop view (spec 2026-11-10 R3.1–R3.2).
 * Touch pointer sequences go in; pointer, button, key and scroll calls on a
 * `DesktopInputSink` and local zoom / cursor changes come out. Pure apart from
 * the long-press timer (`setTimeout`, mockable).
 *
 * | Gesture             | Trackpad                                   | Touch                          |
 * |---------------------|--------------------------------------------|--------------------------------|
 * | 1-finger tap        | left click at the cursor                   | move to the finger, left click |
 * | 2-finger tap        | right click at the cursor                  | right click at the finger      |
 * | 3-finger tap        | middle click at the cursor                 | same                           |
 * | long press (400 ms) | left button down, drag moves, lift ends it | right click (haptic)           |
 * | 1-finger drag       | relative move × 1.5 × display px per css px | left drag from the touch point |
 * | 2-finger drag       | natural scroll in display px (pans while zoomed) | same                     |
 * | pinch (> 15 %)      | local zoom 1–5× around the midpoint, snaps to 1× below 1.05× | same         |
 * | double tap          | double click (the second tap lands on the first's point) | same             |
 *
 * A tap is shorter than 350 ms and stays within 10 CSS px. Latched key-bar
 * modifiers are held around taps, clicks and drags (Shift-tap = Shift-click).
 * Points are viewport CSS px (relative to the view's top-left).
 */

import type { DesktopInputSink, DesktopPointerButton } from "./stream/types";
import type { DesktopInputMode } from "../../lib/desktop-prefs";
import {
  UNZOOMED,
  clampToDisplay,
  clampZoom,
  displayPxPerCssPx,
  followCursor,
  panZoom,
  pinchZoom,
  settleZoom,
  viewTransform,
  viewportToDisplay,
  type DesktopViewportGeometry,
  type LocalZoom,
  type Point
} from "./desktop-viewport.logic";

export const TAP_MAX_MS = 350;
export const TAP_SLOP_PX = 10;
export const LONG_PRESS_MS = 400;
/** A second tap this soon after the first, this close to it, double-clicks at the first tap's point. */
export const DOUBLE_TAP_MS = 400;
export const DOUBLE_TAP_SLOP_PX = 30;
export const TRACKPAD_GAIN = 1.5;
/** Relative change of the two fingers' distance that makes a two-finger gesture a pinch. */
export const PINCH_THRESHOLD = 0.15;

export interface GesturePointer {
  id: number;
  x: number;
  y: number;
  /** Event time (ms, `PointerEvent.timeStamp`). */
  t: number;
}

export interface DesktopGestureState {
  zoom: LocalZoom;
  /** The pointer position the gesture layer last sent (display px), or null before any. */
  cursor: Point | null;
}

export interface DesktopGestureHost {
  /** The view's current geometry, or null while there is no display to drive. */
  geometry(): DesktopViewportGeometry | null;
  sink: DesktopInputSink;
  /** Keysyms of the latched modifiers to hold around the next click or drag (spends the one-shots). */
  takeModifiers(): number[];
  /** The zoom or the cursor changed. */
  onChange(state: DesktopGestureState): void;
  /** A long press fired a right click (Touch mode): a short vibration where supported. */
  haptic?(): void;
}

type GestureKind =
  /** Fingers down, nothing decided yet (a tap, a long press, a drag, a two-finger gesture…). */
  | "pending"
  /** Trackpad: one finger moving the cursor. */
  | "move"
  /** Left button held: Touch mode's one-finger drag or Trackpad's long-press drag lock. */
  | "drag"
  | "scroll"
  | "pan"
  | "pinch"
  /** Done (a long-press right click, a moved three-finger touch): ignored until every finger is up. */
  | "spent";

interface Finger {
  start: GesturePointer;
  last: GesturePointer;
}

interface Gesture {
  kind: GestureKind;
  /** Fingers still down. */
  fingers: Map<number, Finger>;
  /** Where every finger of the gesture touched down, lifted ones included. */
  starts: Map<number, GesturePointer>;
  /** The first two fingers, which a two-finger gesture follows. */
  order: number[];
  maxFingers: number;
  startedAt: number;
  moved: boolean;
  /** Keysyms held for a drag. */
  held: number[];
  /** Two-finger reference: distance and midpoint, and the zoom, when the current phase began. */
  ref: { dist: number; mid: Point; zoom: LocalZoom } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class DesktopGestureRecognizer {
  private gesture: Gesture | null = null;
  private zoomState: LocalZoom = UNZOOMED;
  private cursorAt: Point | null = null;
  private lastTap: { t: number; at: Point; display: Point } | null = null;
  private inputMode: DesktopInputMode;

  constructor(
    private readonly host: DesktopGestureHost,
    mode: DesktopInputMode
  ) {
    this.inputMode = mode;
  }

  get mode(): DesktopInputMode {
    return this.inputMode;
  }

  set mode(mode: DesktopInputMode) {
    if (mode === this.inputMode) return;
    this.cancel();
    this.inputMode = mode;
  }

  get state(): DesktopGestureState {
    return { zoom: this.zoomState, cursor: this.cursorAt };
  }

  get active(): boolean {
    return this.gesture !== null;
  }

  // ---- Pointer input --------------------------------------------------------

  down(p: GesturePointer): void {
    const g = this.gesture;
    if (!g) {
      const gesture: Gesture = {
        kind: "pending",
        fingers: new Map([[p.id, { start: p, last: p }]]),
        starts: new Map([[p.id, p]]),
        order: [p.id],
        maxFingers: 1,
        startedAt: p.t,
        moved: false,
        held: [],
        ref: null,
        timer: null
      };
      gesture.timer = setTimeout(() => this.longPress(gesture), LONG_PRESS_MS);
      this.gesture = gesture;
      return;
    }
    if (g.fingers.has(p.id) || g.starts.has(p.id)) return;
    g.fingers.set(p.id, { start: p, last: p });
    g.starts.set(p.id, p);
    if (g.order.length < 2) g.order.push(p.id);
    g.maxFingers = Math.max(g.maxFingers, g.fingers.size);
    this.clearTimer(g);
    if (g.kind === "pending" && g.fingers.size === 2) g.ref = this.twoFingerRef(g);
  }

  move(p: GesturePointer): void {
    const g = this.gesture;
    const finger = g?.fingers.get(p.id);
    if (!g || !finger) return;
    const prev = finger.last;
    finger.last = p;
    if (distance(finger.start, p) > TAP_SLOP_PX && !g.moved) {
      g.moved = true;
      this.clearTimer(g);
    }
    switch (g.kind) {
      case "pending":
        this.decide(g, finger, p);
        return;
      case "move":
      case "drag":
      case "scroll":
      case "pan":
      case "pinch":
        if (!this.follows(g, p.id)) return;
        if (g.kind === "move" || g.kind === "drag") this.oneFingerMove(g, prev, p);
        else this.twoFingerMove(g, prev, p);
        return;
      case "spent":
        return;
    }
  }

  up(p: GesturePointer): void {
    const g = this.gesture;
    const finger = g?.fingers.get(p.id);
    if (!g || !finger) return;
    g.fingers.delete(p.id);
    if (g.fingers.size === 0) {
      this.finish(g, p.t);
      return;
    }
    // A finger the gesture follows lifted while others stay down: it ends here.
    if (g.kind !== "pending" && g.kind !== "spent" && this.follows(g, p.id)) this.end(g);
  }

  /** The browser took the pointer (pointercancel): end the gesture without clicking. */
  cancelPointer(p: GesturePointer): void {
    const g = this.gesture;
    if (!g?.fingers.has(p.id)) return;
    g.fingers.delete(p.id);
    this.end(g);
    if (g.fingers.size === 0) this.gesture = null;
  }

  /** Drop any gesture in progress, letting go of a held button and keys. */
  cancel(): void {
    const g = this.gesture;
    if (!g) return;
    this.end(g);
    this.gesture = null;
  }

  // ---- Zoom -----------------------------------------------------------------

  resetZoom(): void {
    if (this.zoomState === UNZOOMED) return;
    this.zoomState = UNZOOMED;
    this.emit();
  }

  /** The geometry changed (resize, display size, soft keyboard): re-clamp the zoom and the cursor. */
  refresh(): void {
    const geo = this.host.geometry();
    if (!geo) return;
    const zoom = clampZoom(geo, this.zoomState);
    const cursor = this.cursorAt && clampToDisplay(geo, this.cursorAt);
    const changed =
      zoom.zoom !== this.zoomState.zoom ||
      zoom.x !== this.zoomState.x ||
      zoom.y !== this.zoomState.y ||
      cursor?.x !== this.cursorAt?.x ||
      cursor?.y !== this.cursorAt?.y;
    this.zoomState = zoom;
    this.cursorAt = cursor;
    if (changed) this.emit();
  }

  // ---- Phases ---------------------------------------------------------------

  private decide(g: Gesture, finger: Finger, p: GesturePointer): void {
    const geo = this.host.geometry();
    if (!geo) return;
    if (g.fingers.size === 1 && g.maxFingers === 1) {
      if (!g.moved) return;
      if (this.inputMode === "trackpad") {
        g.kind = "move";
        this.oneFingerMove(g, finger.start, p);
      } else {
        g.kind = "drag";
        this.pressDrag(g, this.displayAt(geo, finger.start));
        this.moveTo(this.displayAt(geo, p));
      }
      return;
    }
    if (g.fingers.size === 2 && g.maxFingers === 2 && g.ref) {
      const [a, b] = this.twoFingers(g);
      if (!a || !b) return;
      if (this.pinching(g.ref.dist, distance(a, b))) {
        this.beginPhase(g, "pinch");
      } else if (g.moved) {
        this.beginPhase(g, this.zoomState.zoom > 1 ? "pan" : "scroll");
      }
      return;
    }
    // Three fingers (or two after a third lifted) that moved: no gesture.
    if (g.moved) g.kind = "spent";
  }

  private beginPhase(g: Gesture, kind: "scroll" | "pan" | "pinch"): void {
    g.kind = kind;
    g.ref = this.twoFingerRef(g);
  }

  private oneFingerMove(g: Gesture, prev: GesturePointer, p: GesturePointer): void {
    const geo = this.host.geometry();
    if (!geo) return;
    if (g.kind === "drag" && this.inputMode === "touch") {
      this.moveTo(this.displayAt(geo, p));
      return;
    }
    // Trackpad: relative motion, the same visual speed at any zoom.
    const gain = TRACKPAD_GAIN * displayPxPerCssPx(geo, viewTransform(geo, this.zoomState));
    const from = this.cursorAt ?? this.displayCenter(geo);
    this.cursorAt = clampToDisplay(geo, { x: from.x + (p.x - prev.x) * gain, y: from.y + (p.y - prev.y) * gain });
    this.host.sink.pointerMove(Math.round(this.cursorAt.x), Math.round(this.cursorAt.y));
    this.zoomState = followCursor(geo, this.zoomState, this.cursorAt);
    this.emit();
  }

  private twoFingerMove(g: Gesture, prev: GesturePointer, p: GesturePointer): void {
    const geo = this.host.geometry();
    const ref = g.ref;
    const [a, b] = this.twoFingers(g);
    if (!geo || !ref || !a || !b) return;
    const dist = distance(a, b);
    const mid = midpoint(a, b);
    if (g.kind !== "pinch" && this.pinching(ref.dist, dist)) {
      this.beginPhase(g, "pinch");
      return;
    }
    if (g.kind === "pinch") {
      this.zoomState = pinchZoom(geo, ref.zoom, ref.dist > 0 ? dist / ref.dist : 1, ref.mid, mid);
      this.emit();
      return;
    }
    // The midpoint moves by half of one finger's step.
    const dx = (p.x - prev.x) / 2;
    const dy = (p.y - prev.y) / 2;
    if (g.kind === "pan") {
      this.zoomState = panZoom(geo, this.zoomState, dx, dy);
      this.emit();
      return;
    }
    // Natural scrolling: fingers moving up move the content up (scroll down).
    const perCss = displayPxPerCssPx(geo, viewTransform(geo, this.zoomState));
    this.host.sink.scroll(-dx * perCss, -dy * perCss);
  }

  private longPress(g: Gesture): void {
    g.timer = null;
    if (this.gesture !== g || g.kind !== "pending" || g.moved || g.maxFingers !== 1) return;
    const geo = this.host.geometry();
    const finger = g.fingers.get(g.order[0]);
    if (!geo || !finger) return;
    if (this.inputMode === "trackpad") {
      g.kind = "drag";
      this.pressDrag(g, this.cursorAt ?? this.displayCenter(geo));
      return;
    }
    g.kind = "spent";
    this.host.haptic?.();
    this.click(3, this.displayAt(geo, finger.start));
  }

  /** The last finger lifted. */
  private finish(g: Gesture, t: number): void {
    this.clearTimer(g);
    this.gesture = null;
    if (g.kind !== "pending") {
      this.end(g);
      return;
    }
    if (g.moved || t - g.startedAt >= TAP_MAX_MS) return;
    const geo = this.host.geometry();
    if (!geo) return;
    const start = g.starts.get(g.order[0]);
    if (!start) return;
    if (g.maxFingers >= 3) {
      this.click(2, this.cursorAt ?? this.displayCenter(geo));
    } else if (g.maxFingers === 2) {
      this.click(3, this.inputMode === "touch" ? this.displayAt(geo, start) : (this.cursorAt ?? this.displayCenter(geo)));
    } else {
      this.tap(geo, start, t);
    }
  }

  private tap(geo: DesktopViewportGeometry, start: GesturePointer, t: number): void {
    let at = this.inputMode === "touch" ? this.displayAt(geo, start) : (this.cursorAt ?? this.displayCenter(geo));
    const last = this.lastTap;
    if (last && start.t - last.t <= DOUBLE_TAP_MS && distance(last.at, start) <= DOUBLE_TAP_SLOP_PX) at = last.display;
    this.click(1, at);
    this.lastTap = { t, at: { x: start.x, y: start.y }, display: at };
  }

  /** End a gesture that is in progress: let go of a drag, settle a pinch. */
  private end(g: Gesture): void {
    this.clearTimer(g);
    if (g.kind === "drag") {
      this.host.sink.pointerButton(1, false);
      this.releaseKeys(g.held);
      g.held = [];
    } else if (g.kind === "pinch") {
      const geo = this.host.geometry();
      if (geo) {
        this.zoomState = settleZoom(geo, this.zoomState);
        this.emit();
      }
    }
    g.kind = "spent";
  }

  // ---- Output ---------------------------------------------------------------

  private click(button: DesktopPointerButton, at: Point): void {
    this.moveTo(at);
    const keys = this.host.takeModifiers();
    for (const k of keys) this.host.sink.key(k, true);
    this.host.sink.pointerButton(button, true);
    this.host.sink.pointerButton(button, false);
    this.releaseKeys(keys);
  }

  private pressDrag(g: Gesture, at: Point): void {
    this.moveTo(at);
    g.held = this.host.takeModifiers();
    for (const k of g.held) this.host.sink.key(k, true);
    this.host.sink.pointerButton(1, true);
  }

  private releaseKeys(keys: number[]): void {
    for (const k of [...keys].reverse()) this.host.sink.key(k, false);
  }

  private moveTo(at: Point): void {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    this.cursorAt = { x, y };
    this.host.sink.pointerMove(x, y);
    this.emit();
  }

  private emit(): void {
    this.host.onChange(this.state);
  }

  // ---- Helpers --------------------------------------------------------------

  private displayAt(geo: DesktopViewportGeometry, p: Point): Point {
    return clampToDisplay(geo, viewportToDisplay(geo, viewTransform(geo, this.zoomState), p));
  }

  private displayCenter(geo: DesktopViewportGeometry): Point {
    return { x: Math.floor(geo.display.width / 2), y: Math.floor(geo.display.height / 2) };
  }

  /** Whether the gesture in progress follows finger `id`: the first one, or the first two for two-finger gestures. */
  private follows(g: Gesture, id: number): boolean {
    return g.kind === "move" || g.kind === "drag" ? id === g.order[0] : g.order.includes(id);
  }

  /** The fingers' distance changed by more than the pinch threshold (and more than a tap's jitter). */
  private pinching(from: number, to: number): boolean {
    return from > 0 && Math.abs(to / from - 1) > PINCH_THRESHOLD && Math.abs(to - from) > TAP_SLOP_PX;
  }

  private twoFingers(g: Gesture): [GesturePointer | undefined, GesturePointer | undefined] {
    return [g.fingers.get(g.order[0])?.last, g.fingers.get(g.order[1])?.last];
  }

  private twoFingerRef(g: Gesture): Gesture["ref"] {
    const [a, b] = this.twoFingers(g);
    if (!a || !b) return null;
    return { dist: distance(a, b), mid: midpoint(a, b), zoom: this.zoomState };
  }

  private clearTimer(g: Gesture): void {
    if (g.timer !== null) clearTimeout(g.timer);
    g.timer = null;
  }
}
