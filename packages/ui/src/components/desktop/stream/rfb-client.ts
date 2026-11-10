/// <reference path="../../../types/novnc.d.ts" />
import type RFB from "@novnc/novnc";
import type { DesktopSize } from "@orquester/api";
import {
  DESKTOP_COMPRESSION_LEVEL,
  DESKTOP_QUALITY_INITIAL,
  initialDesktopQuality,
  nextDesktopQuality
} from "../../../lib/desktop-quality";
import { openDesktopVncChannel, type DesktopVncChannel } from "../../../lib/desktop-vnc-socket";
import { exitPoint } from "../desktop-pointer";
import { WheelAccumulator } from "./wheel-steps";
import type {
  DesktopPointerButton,
  DesktopStreamClient,
  DesktopStreamEvents,
  DesktopViewMode
} from "./types";

/**
 * The RFB stream client: noVNC 1.7 over the daemon's RFB relay socket
 * (`/ws-desktop/:id`, spec 2026-09-30 §7.2), behind `DesktopStreamClient`.
 *
 * It keeps the v1 viewer's behaviour: noVNC loads lazily, the relay's
 * ping/pong RTT adapts the video quality (`desktop-quality.ts`), the three view
 * modes map onto noVNC's scale/clip/resize properties, fixed sizes go through
 * `requestRemoteSize` with retries, the desktop's clipboard reaches this
 * machine's while the window has focus, and a mouse leaving the display parks
 * the remote pointer on the edge it crossed.
 *
 * Gesture-layer input (`setNativeInput(false)`) goes straight out as RFB
 * PointerEvents through noVNC's message API (see `NoVncHooks`).
 */

type RfbCtor = typeof RFB;

/** RTT samples (one per 2 s) to spend getting a fixed size applied before giving up. */
const FIXED_SIZE_ATTEMPTS = 5;
const DISPLAY_BACKGROUND = "rgb(10, 10, 10)";
/** RFB button-mask bits for the left, middle and right buttons. */
const BUTTON_BITS = 0x07;
/** RFB button-mask bits of the wheel: up, down, left, right (X buttons 4–7). */
const WHEEL_UP = 1 << 3;
const WHEEL_DOWN = 1 << 4;
const WHEEL_LEFT = 1 << 5;
const WHEEL_RIGHT = 1 << 6;

// noVNC is loaded on first use: it is only needed once a desktop tab is shown,
// and its `core/util/browser.js` has a top-level await that is better kept out
// of the app's entry chunk.
let rfbModule: Promise<RfbCtor> | null = null;
function loadRfb(): Promise<RfbCtor> {
  rfbModule ??= import("@novnc/novnc").then((m) => m.default).catch((err: unknown) => {
    rfbModule = null; // a failed chunk load may succeed on the next attempt
    throw err;
  });
  return rfbModule;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the server for exactly `size`, using noVNC's public API only.
 *
 * noVNC 1.7 has no "request W×H" call. With `resizeSession` on, it requests
 * the size of its screen element (the `width/height: 100%` div it appends to
 * the target), measured synchronously inside the `resizeSession` setter. So
 * for one synchronous moment the target is laid out at W×H CSS px,
 * `resizeSession` goes on (noVNC measures and sends SetDesktopSize) and
 * straight back off, and the inline size is restored. No frame is painted in
 * between, and noVNC's ResizeObserver sees no change.
 *
 * A CSS-transform wrapper (lay the target out at W×H and scale it visually)
 * does not work: noVNC maps pointer coordinates through getBoundingClientRect
 * divided by its own display scale, so a transformed ancestor skews every
 * click.
 *
 * noVNC silently drops the request before the server has announced
 * ExtendedDesktopSize (the first framebuffer update), while an earlier resize
 * is pending, or within 100 ms of the last one; the caller retries on the next
 * RTT sample until the framebuffer has the new size.
 */
function requestRemoteSize(rfb: RFB, target: HTMLElement, size: DesktopSize): void {
  const { style } = target;
  const saved = { right: style.right, bottom: style.bottom, width: style.width, height: style.height };
  style.right = "auto";
  style.bottom = "auto";
  style.width = `${size.width}px`;
  style.height = `${size.height}px`;
  try {
    rfb.resizeSession = true;
    rfb.resizeSession = false;
  } finally {
    style.right = saved.right;
    style.bottom = saved.bottom;
    style.width = saved.width;
    style.height = saved.height;
  }
}

/**
 * Apply a view mode to a live RFB.
 *
 * - **Fit:** `scaleViewport`, and `resizeSession` only while the view says this
 *   viewer drives the size — so with several viewers the one last used sets the
 *   display size and the others scale it.
 * - **Fixed, scale:** the shared display at whatever size it is, scaled to fit.
 * - **Fixed, pan:** 1:1, clipped to the tab, drag to pan (`clipViewport` +
 *   `dragViewport`).
 */
function applyViewMode(rfb: RFB, mode: DesktopViewMode): void {
  if (mode.kind === "fit") {
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.scaleViewport = true;
    rfb.resizeSession = mode.driveSize;
  } else if (mode.kind === "fixed-pan") {
    rfb.resizeSession = false;
    rfb.scaleViewport = false;
    rfb.clipViewport = true;
    rfb.dragViewport = true;
  } else {
    rfb.resizeSession = false;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.scaleViewport = true;
  }
}

// ---------------------------------------------------------------------------
// noVNC internals
// ---------------------------------------------------------------------------

/** The noVNC 1.7 private fields the hooks read, all unverified until checked. */
interface NoVncPrivate {
  _sock?: unknown;
  _rfbConnectionState?: unknown;
  _mouseButtonMask?: unknown;
  _fbWidth?: unknown;
  _fbHeight?: unknown;
  _screen?: unknown;
  _canvas?: unknown;
  _display?: { _viewportLoc?: { x?: unknown; y?: unknown } } | null;
  _keyboard?: { _allKeysUp?: unknown } | null;
  _screenSize?: unknown;
  _resize?: unknown;
}

type PointerMessage = (sock: unknown, x: number, y: number, mask: number) => void;

/**
 * The few places the client reaches past noVNC's public API, each checked
 * before use so a different noVNC degrades to the public paths instead of
 * throwing:
 *
 * - **Pointer events** go out with `RFB.messages.pointerEvent(sock, x, y,
 *   mask)` (absolute framebuffer pixels), the call noVNC's own `_sendMouse`
 *   makes, and `_mouseButtonMask` is kept in step so noVNC's mouse handling
 *   (a mouse on a touch laptop) carries on from the same buttons. Without it
 *   the client dispatches synthetic mouse events on the canvas instead.
 * - **Layout measurement:** noVNC sizes the canvas and the requested display
 *   from `getBoundingClientRect()` of its screen element, which a CSS transform
 *   on an ancestor (the view's local zoom) would scale. `_screenSize` is
 *   replaced on this instance by the screen's computed (layout) size, which is
 *   the same number whenever nothing is transformed.
 * - **Framebuffer size:** `_fbWidth`/`_fbHeight`, reported on every `_resize`.
 * - **Releasing keys:** `_keyboard._allKeysUp()` when the page hides.
 */
class NoVncHooks {
  private readonly raw: NoVncPrivate;
  private readonly pointerMessage: PointerMessage | null;

  constructor(
    private readonly rfb: RFB,
    Rfb: RfbCtor
  ) {
    this.raw = rfb as unknown as NoVncPrivate;
    const message = (Rfb as unknown as { messages?: { pointerEvent?: unknown } }).messages?.pointerEvent;
    this.pointerMessage =
      typeof message === "function" && this.raw._sock != null && typeof this.raw._mouseButtonMask === "number"
        ? (message as PointerMessage)
        : null;
  }

  /** Send a PointerEvent (framebuffer px, RFB button mask); false when this noVNC has no message API to do it with. */
  sendPointer(x: number, y: number, mask: number): boolean {
    if (!this.pointerMessage) return false;
    if (this.raw._rfbConnectionState !== "connected" || this.rfb.viewOnly) return true;
    this.pointerMessage(this.raw._sock, x, y, mask & 0x7f);
    this.raw._mouseButtonMask = mask & BUTTON_BITS;
    return true;
  }

  framebufferSize(): DesktopSize | null {
    const { _fbWidth: width, _fbHeight: height } = this.raw;
    return typeof width === "number" && typeof height === "number" && width > 0 && height > 0 ? { width, height } : null;
  }

  /** The clipped viewport's top-left in framebuffer px (0, 0 unless panned). */
  viewportOrigin(): { x: number; y: number } {
    const loc = this.raw._display?._viewportLoc;
    return typeof loc?.x === "number" && typeof loc.y === "number" ? { x: loc.x, y: loc.y } : { x: 0, y: 0 };
  }

  canvas(): HTMLCanvasElement | null {
    return this.raw._canvas instanceof HTMLCanvasElement ? this.raw._canvas : null;
  }

  releaseKeys(): void {
    const keyboard = this.raw._keyboard;
    if (keyboard && typeof keyboard._allKeysUp === "function") (keyboard._allKeysUp as () => void).call(keyboard);
  }

  /** Measure the screen element's layout size, not its (possibly transformed) client rect. */
  measureLayout(): void {
    const { _screen: screen, _screenSize: original } = this.raw;
    if (!(screen instanceof HTMLElement) || typeof original !== "function") return;
    const fallback = original as () => { w: number; h: number };
    this.raw._screenSize = () => {
      const style = getComputedStyle(screen);
      const w = parseFloat(style.width);
      const h = parseFloat(style.height);
      return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : fallback.call(this.rfb);
    };
  }

  /** Call `listener` after every framebuffer resize. */
  onResize(listener: () => void): void {
    const original = this.raw._resize;
    if (typeof original !== "function") return;
    this.raw._resize = (width: number, height: number) => {
      (original as (w: number, h: number) => void).call(this.rfb, width, height);
      listener();
    };
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface RfbStreamClientOptions {
  /** The authenticated RFB relay URL, or null where this transport has none. */
  socketUrl: string | null;
}

export class RfbStreamClient implements DesktopStreamClient {
  readonly backend = "rfb" as const;

  private rfb: RFB | null = null;
  private hooks: NoVncHooks | null = null;
  private channel: DesktopVncChannel | null = null;
  private container: HTMLElement | null = null;
  private events: DesktopStreamEvents | null = null;
  private started = false;
  private disposed = false;
  private failure: string | null = null;

  private mode: DesktopViewMode = { kind: "fit", driveSize: false };
  private nativeInput = true;
  private sizeRequest: { size: DesktopSize; attempts: number } | null = null;
  private reportedSize: DesktopSize | null = null;

  /** Gesture-layer pointer state: position (framebuffer px) and RFB button mask. */
  private pointer = { x: 0, y: 0 };
  private buttons = 0;
  private readonly wheel = new WheelAccumulator();
  /** Keys pressed through the sink and not yet released: keysym → code. */
  private readonly heldKeys = new Map<number, string>();
  private readonly cleanups: (() => void)[] = [];
  private removeTouchBlock: (() => void) | null = null;

  constructor(private readonly options: RfbStreamClientOptions) {}

  async connect(container: HTMLElement, events: DesktopStreamEvents): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.container = container;
    this.events = events;
    this.applyNativeInput();
    events.state("connecting");
    let Rfb: RfbCtor;
    try {
      Rfb = await loadRfb();
    } catch (err) {
      throw new Error(`Could not load the viewer: ${errorText(err)}`);
    }
    if (this.disposed) return;
    const url = this.options.socketUrl;
    if (!url) throw new Error("Desktop tabs require a remote (HTTP) connection.");

    let quality = initialDesktopQuality();
    events.stats({ quality: quality.level });
    const channel = openDesktopVncChannel(url, {
      onRtt: (ms) => {
        if (this.disposed) return;
        quality = nextDesktopQuality(quality, ms);
        const rfb = this.rfb;
        if (rfb && rfb.qualityLevel !== quality.level) rfb.qualityLevel = quality.level;
        events.stats({ rttMs: ms, quality: rfb ? rfb.qualityLevel : quality.level });
        this.reportSize();
        this.tryRequest();
      }
    });
    this.channel = channel;
    let rfb: RFB;
    try {
      rfb = new Rfb(container, channel, { shared: true });
    } catch (err) {
      channel.close();
      this.channel = null;
      throw err;
    }
    this.rfb = rfb;
    const hooks = new NoVncHooks(rfb, Rfb);
    this.hooks = hooks;
    hooks.measureLayout();
    hooks.onResize(() => {
      if (this.disposed) return;
      this.reportSize();
      this.tryRequest();
    });
    rfb.background = DISPLAY_BACKGROUND;
    rfb.focusOnClick = true;
    rfb.qualityLevel = DESKTOP_QUALITY_INITIAL;
    rfb.compressionLevel = DESKTOP_COMPRESSION_LEVEL;
    applyViewMode(rfb, this.mode);

    rfb.addEventListener("connect", () => {
      if (this.disposed || this.rfb !== rfb) return;
      applyViewMode(rfb, this.mode);
      this.reportSize();
      events.state("connected");
    });
    rfb.addEventListener("disconnect", () => {
      if (this.disposed || this.rfb !== rfb) return;
      // noVNC closed the channel and cannot reconnect: the view makes a new client.
      this.rfb = null;
      this.channel = null;
      events.state("disconnected", this.failure ?? undefined);
    });
    rfb.addEventListener("securityfailure", (e) => {
      if (!this.disposed) this.failure = e.detail.reason ?? `Security failure (${e.detail.status})`;
    });
    rfb.addEventListener("clipboard", (e) => {
      if (this.disposed) return;
      const text = e.detail.text;
      events.clipboard(text);
      if (document.hasFocus()) {
        navigator.clipboard?.writeText(text).catch(() => undefined);
      }
    });
    rfb.addEventListener("desktopname", (e) => {
      if (!this.disposed) events.name(e.detail.name);
    });
    this.parkPointerOnExit(container);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.removeTouchBlock?.();
    this.removeTouchBlock = null;
    const rfb = this.rfb;
    this.rfb = null;
    if (rfb) {
      try {
        rfb.disconnect();
      } catch {
        this.channel?.close();
      }
    } else {
      this.channel?.close();
    }
    this.channel = null;
    this.hooks = null;
  }

  setViewMode(mode: DesktopViewMode): void {
    const previous = this.mode;
    this.mode = mode;
    // A new mode supersedes a pending size request (the view asks again when it still wants one).
    this.sizeRequest = null;
    const rfb = this.rfb;
    if (!rfb) return;
    if (mode.kind === "fit" && previous.kind === "fit") {
      // The handover toggles on every local input: only `resizeSession` changes.
      rfb.resizeSession = mode.driveSize;
      return;
    }
    applyViewMode(rfb, mode);
  }

  requestSize(size: DesktopSize): void {
    this.sizeRequest = { size: { width: size.width, height: size.height }, attempts: 0 };
    this.tryRequest();
  }

  setNativeInput(enabled: boolean): void {
    if (enabled === this.nativeInput) return;
    this.nativeInput = enabled;
    this.applyNativeInput();
  }

  focus(): void {
    this.rfb?.focus({ preventScroll: true });
  }

  surface(): HTMLElement | null {
    return this.canvas();
  }

  clientToDisplay(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.canvas();
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || rect.width <= 0 || rect.height <= 0) return null;
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
    const origin = this.hooks?.viewportOrigin() ?? { x: 0, y: 0 };
    return {
      x: origin.x + ((clientX - rect.left) / rect.width) * canvas.width,
      y: origin.y + ((clientY - rect.top) / rect.height) * canvas.height
    };
  }

  displayToClient(x: number, y: number): { x: number; y: number } | null {
    const canvas = this.canvas();
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect || canvas.width <= 0 || canvas.height <= 0) return null;
    const origin = this.hooks?.viewportOrigin() ?? { x: 0, y: 0 };
    return {
      x: rect.left + ((x - origin.x) / canvas.width) * rect.width,
      y: rect.top + ((y - origin.y) / canvas.height) * rect.height
    };
  }

  // ---- DesktopInputSink ------------------------------------------------------

  pointerMove(x: number, y: number): void {
    const size = this.framebufferSize();
    if (!size) return;
    this.pointer = {
      x: Math.min(Math.max(Math.round(x), 0), size.width - 1),
      y: Math.min(Math.max(Math.round(y), 0), size.height - 1)
    };
    this.sendPointer(this.buttons, "mousemove");
  }

  pointerButton(button: DesktopPointerButton, down: boolean): void {
    const bit = 1 << (button - 1);
    this.buttons = down ? this.buttons | bit : this.buttons & ~bit;
    this.sendPointer(this.buttons, down ? "mousedown" : "mouseup", button);
  }

  scroll(dx: number, dy: number): void {
    const steps = this.wheel.add(dx, dy);
    for (let i = 0; i < Math.abs(steps.y); i++) this.wheelClick(steps.y > 0 ? WHEEL_DOWN : WHEEL_UP, 0, steps.y);
    for (let i = 0; i < Math.abs(steps.x); i++) this.wheelClick(steps.x > 0 ? WHEEL_RIGHT : WHEEL_LEFT, steps.x, 0);
  }

  key(keysym: number, down: boolean, code?: string): void {
    const rfb = this.rfb;
    if (!rfb) return;
    rfb.sendKey(keysym, code ?? "", down);
    if (down) this.heldKeys.set(keysym, code ?? "");
    else this.heldKeys.delete(keysym);
  }

  releaseAll(): void {
    const rfb = this.rfb;
    for (const [keysym, code] of this.heldKeys) rfb?.sendKey(keysym, code, false);
    this.heldKeys.clear();
    if (this.buttons !== 0) {
      this.buttons = 0;
      this.sendPointer(0, "mouseup");
    }
    this.wheel.reset();
    this.hooks?.releaseKeys();
  }

  setClipboard(text: string): void {
    this.rfb?.clipboardPasteFrom(text);
  }

  // ---- Internals --------------------------------------------------------------

  private canvas(): HTMLCanvasElement | null {
    return this.hooks?.canvas() ?? this.container?.querySelector("canvas") ?? null;
  }

  private framebufferSize(): DesktopSize | null {
    const size = this.hooks?.framebufferSize();
    if (size) return size;
    // Unclipped, noVNC's canvas is the framebuffer's size.
    const canvas = this.canvas();
    return canvas && canvas.width > 0 && canvas.height > 0 && this.mode.kind !== "fixed-pan"
      ? { width: canvas.width, height: canvas.height }
      : null;
  }

  private reportSize(): void {
    const size = this.framebufferSize();
    if (!size || (this.reportedSize?.width === size.width && this.reportedSize.height === size.height)) return;
    this.reportedSize = size;
    this.events?.size(size);
  }

  /** Retry the pending size request until the framebuffer has that size or attempts run out. */
  private tryRequest(): void {
    const request = this.sizeRequest;
    const rfb = this.rfb;
    const container = this.container;
    if (!request || !rfb || !container) return;
    const current = this.framebufferSize();
    if (current && current.width === request.size.width && current.height === request.size.height) {
      this.sizeRequest = null;
      return;
    }
    if (request.attempts >= FIXED_SIZE_ATTEMPTS) {
      this.sizeRequest = null;
      return;
    }
    request.attempts += 1;
    requestRemoteSize(rfb, container, request.size);
  }

  private wheelClick(bit: number, dx: number, dy: number): void {
    this.sendPointer(this.buttons | bit, "wheel", undefined, { dx, dy });
    this.sendPointer(this.buttons, "wheel-release");
  }

  /**
   * Send the pointer state. The message path is exact; the fallback replays
   * the step as a synthetic mouse event on the canvas, which noVNC maps itself.
   */
  private sendPointer(
    mask: number,
    kind: "mousemove" | "mousedown" | "mouseup" | "wheel" | "wheel-release",
    button?: DesktopPointerButton,
    wheel?: { dx: number; dy: number }
  ): void {
    if (!this.rfb) return;
    if (this.hooks?.sendPointer(this.pointer.x, this.pointer.y, mask)) return;
    const canvas = this.canvas();
    const at = this.displayToClient(this.pointer.x + 0.5, this.pointer.y + 0.5);
    if (!canvas || !at || kind === "wheel-release") return;
    const init = { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, view: window, buttons: domButtons(mask) };
    if (kind === "wheel") {
      canvas.dispatchEvent(new WheelEvent("wheel", { ...init, deltaX: Math.sign(wheel?.dx ?? 0) * 50, deltaY: Math.sign(wheel?.dy ?? 0) * 50 }));
    } else {
      canvas.dispatchEvent(new MouseEvent(kind, { ...init, button: button === undefined ? 0 : DOM_BUTTON[button] }));
    }
  }

  /** Off: touches in the container never reach noVNC (its gesture handler, its canvas focus) nor make mouse events. */
  private applyNativeInput(): void {
    const container = this.container;
    if (!container || this.disposed) return;
    if (this.nativeInput) {
      this.removeTouchBlock?.();
      this.removeTouchBlock = null;
      return;
    }
    if (this.removeTouchBlock) return;
    const block = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const type of types) container.addEventListener(type, block, { capture: true, passive: false });
    this.removeTouchBlock = () => {
      for (const type of types) container.removeEventListener(type, block, { capture: true });
    };
  }

  /**
   * The mouse leaving the display parks the remote pointer where it crossed
   * the edge (see desktop-pointer.ts): otherwise the button it last hovered
   * stays hovered and its tooltip floats above every window raised next.
   */
  private parkPointerOnExit(container: HTMLElement): void {
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons !== 0) return; // a drag keeps noVNC's capture
      const canvas = this.canvas();
      if (!canvas || !this.rfb) return;
      const at = exitPoint(canvas.getBoundingClientRect(), e.clientX, e.clientY);
      canvas.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, view: window }));
    };
    container.addEventListener("pointerleave", onPointerLeave);
    this.cleanups.push(() => container.removeEventListener("pointerleave", onPointerLeave));
  }
}

/** `MouseEvent.button` for an X button. */
const DOM_BUTTON: Record<DesktopPointerButton, number> = { 1: 0, 2: 1, 3: 2 };

/** RFB button mask → `MouseEvent.buttons` (DOM swaps middle and right). */
function domButtons(mask: number): number {
  return (mask & 1) | (mask & 2 ? 4 : 0) | (mask & 4 ? 2 : 0);
}
