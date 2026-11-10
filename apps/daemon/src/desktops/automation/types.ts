// The desktop automation engine's interface (spec 2026-11-10 §2.3): one per running desktop, its own
// X11 connection, capture + XTEST input + DAMAGE-driven waits + the CLIPBOARD selection. The engine
// (`./engine.ts`) implements it; the manager owns one per desktop and the routes call it.

import type { Duplex } from "node:stream";
import type { DesktopModifier, DesktopRect, DesktopSize } from "@orquester/api";
import type { DesktopPixelFormat } from "./pixels.ts";

/** How the engine reaches a display: as the window tracker does (`DesktopWindowTrackerOptions`). */
export interface DesktopAutomationTarget {
  /** X display number. */
  display: number;
  /** A stream to the display's X socket (this machine's `/tmp/.X11-unix/X<n>`, or a VM's over the box link). */
  connect(): Promise<Duplex>;
  /** The desktop's MIT-MAGIC-COOKIE-1 authority file bytes. */
  readAuthority(): Promise<Buffer>;
}

/** A raw capture: the server's 32-bit pixels, row-major, converted to RGB only in the image workers (`./pixels.ts`). */
export interface DesktopCapture {
  width: number;
  height: number;
  /** The captured rectangle's top-left in display pixels. */
  origin: { x: number; y: number };
  /**
   * width × height × 4 bytes in `format`, on an ArrayBuffer of its own: encoding transfers it to
   * an image worker, after which it is empty here.
   */
  pixels: Buffer;
  format: DesktopPixelFormat;
  /** The screen sequence when the capture was taken. */
  seq: number;
  /** The display size at capture time. */
  display: DesktopSize;
  cursor: { x: number; y: number };
}

export interface DesktopWaitOptions {
  for: "idle" | "change";
  /** idle: how long the region must stay still. */
  idleMs: number;
  /**
   * idle: the stillness is counted from this time (`Date.now()` ms) or from the region's last
   * change, whichever is later; default the wait's start. So a screen that is already still waits
   * `idleMs` more ("still for N ms from now"), and a wait right after input gives the app that long
   * to start redrawing before it counts as settled.
   */
  notBefore?: number;
  /** change: a change after this sequence (default: the current one). */
  since?: number;
  /** Display pixels, watched at the damage grid's 16×16 block granularity (a change in a block it touches counts). */
  region?: DesktopRect;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DesktopWaitResult {
  changed: boolean;
  timedOut: boolean;
  seq: number;
  waitedMs: number;
}

/** X pointer buttons: 1 left, 2 middle, 3 right, 4/5 wheel up/down, 6/7 wheel left/right. */
export type XButton = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DesktopAutomation {
  /** The display size now. */
  size(): DesktopSize;
  /** The current screen sequence. */
  seq(): number;
  pointer(): Promise<{ x: number; y: number }>;
  capture(region?: DesktopRect): Promise<DesktopCapture>;
  wait(options: DesktopWaitOptions): Promise<DesktopWaitResult>;
  // Input runs one call at a time. Its `signal` (the service's: the user took over, or the caller
  // went away) stops a call that has not started, or one running between its steps (characters,
  // drag steps, clicks, repeats); what it pressed is released and it rejects with the signal's reason.
  move(x: number, y: number, signal?: AbortSignal): Promise<void>;
  /** Press/release one button at the current pointer position. */
  button(button: XButton, down: boolean, signal?: AbortSignal): Promise<void>;
  /** Click `count` times (1–3) at (x, y) with `modifiers` held. */
  click(x: number, y: number, button: XButton, count: number, modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }, button: XButton, modifiers: readonly DesktopModifier[], signal?: AbortSignal): Promise<void>;
  /** `amount` wheel clicks at (x, y) (or the current position) in a direction. */
  scroll(
    at: { x: number; y: number } | null,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    modifiers: readonly DesktopModifier[],
    signal?: AbortSignal
  ): Promise<void>;
  /** A `+`-separated combo ("ctrl+shift+t"), `repeat` times. Throws `DesktopAutomationError` (`INVALID_ARGUMENT`) for an unknown key name. */
  key(combo: string, repeat: number, signal?: AbortSignal): Promise<void>;
  /** Type Unicode text (`\n` → Return, `\t` → Tab). */
  type(text: string, signal?: AbortSignal): Promise<void>;
  getClipboard(): Promise<string>;
  /** Queued with input; `signal` as for input. */
  setClipboard(text: string, signal?: AbortSignal): Promise<void>;
  /** Fires when the display size changes. */
  onResize(listener: (size: DesktopSize) => void): () => void;
  /** Release everything held, give up the selection, close the connection. Idempotent. */
  close(): Promise<void>;
  /** The connection dropped (the engine is unusable; open a new one). */
  readonly closed: boolean;
  /**
   * It owns the CLIPBOARD selection (from setClipboard until another client takes it or it
   * closes): closing it loses what was copied, so the idle close leaves it open.
   */
  readonly ownsClipboard: boolean;
}

export type DesktopAutomationErrorCode =
  | "DESKTOP_UNSUPPORTED_VISUAL"
  | "INVALID_ARGUMENT"
  | "CLIPBOARD_UNAVAILABLE"
  | "DESKTOP_NOT_RUNNING";

/** A refusal the routes map to an HTTP error with `code`. */
export class DesktopAutomationError extends Error {
  constructor(readonly code: DesktopAutomationErrorCode, message: string) {
    super(message);
    this.name = "DesktopAutomationError";
  }
}

/** Opens an engine for a target (the manager calls this; tests inject a fake). */
export type OpenDesktopAutomation = (target: DesktopAutomationTarget) => Promise<DesktopAutomation>;
