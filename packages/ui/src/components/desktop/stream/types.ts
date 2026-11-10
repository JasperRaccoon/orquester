// The seam between DesktopView and whatever renders a desktop's video and carries its input
// (spec 2026-11-10 §4.1): `rfb-client.ts` (noVNC) and `voxl-client.ts` (voxl H.264) implement it.
// Coordinates are display pixels; keys are X keysyms.

import type { DesktopSize, DesktopVideoBackend } from "@orquester/api";

/** Pointer buttons: 1 left, 2 middle, 3 right (X numbering). */
export type DesktopPointerButton = 1 | 2 | 3;

/** Input a gesture layer, key bar or hardware keyboard sends into the desktop. */
export interface DesktopInputSink {
  /** Absolute pointer position in display pixels. */
  pointerMove(x: number, y: number): void;
  pointerButton(button: DesktopPointerButton, down: boolean): void;
  /** Pixel scroll in display pixels (positive dy: content moves up / scroll down). */
  scroll(dx: number, dy: number): void;
  /**
   * `code`: the `KeyboardEvent.code` of the physical key when there is one, for backends that send
   * scancodes (a release must match how the press went out).
   */
  key(keysym: number, down: boolean, code?: string): void;
  /** Release every held key and button. */
  releaseAll(): void;
  /** Put `text` on the desktop's clipboard (does not paste). */
  setClipboard(text: string): void;
}

export type DesktopStreamState = "connecting" | "connected" | "disconnected";

export interface DesktopStreamStats {
  /** Round-trip time of the last ping, in ms. */
  rttMs?: number;
  fps?: number;
  kbps?: number;
  /** The backend's current video quality level, when it adapts one (RFB: 0–9). */
  quality?: number;
}

export interface DesktopStreamEvents {
  /** The connection's state changed; `reason` on a disconnect when known. */
  state(state: DesktopStreamState, reason?: string): void;
  /** The remote display's size (on connect and on every resize). */
  size(size: DesktopSize): void;
  /** The desktop's clipboard changed (text). */
  clipboard(text: string): void;
  stats(stats: DesktopStreamStats): void;
  /** The desktop's name as the backend reports it (RFB: the server's desktop name). */
  name(name: string): void;
}

/**
 * How the client lays the display out in its container. Fit and fixed-scale scale the display to fit
 * the container (contain) and center it: the view's touch layer relies on that to map fingers to
 * display pixels. The view may CSS-transform an ancestor of the container (local zoom), so a client
 * measures layout sizes (`clientWidth`, a `ResizeObserver`), not client rects, for its own sizing.
 */
export type DesktopViewMode =
  /** Scale to the container; the client may resize the display to fit when `driveSize`. */
  | { kind: "fit"; driveSize: boolean }
  /** A fixed display size, scaled to fit. */
  | { kind: "fixed-scale" }
  /** A fixed display size at 1:1, panned. */
  | { kind: "fixed-pan" };

export interface DesktopStreamClient extends DesktopInputSink {
  readonly backend: DesktopVideoBackend;
  /**
   * Mount the video into `container` and connect. Resolves once connecting has started; rejects when
   * it cannot start (the message is shown). A client connects once: after a `disconnected` state the
   * view disposes it and retries with a new one.
   */
  connect(container: HTMLElement, events: DesktopStreamEvents): Promise<void>;
  /** Close everything: sockets, workers, listeners, DOM. Idempotent. */
  dispose(): void;
  /** Also drops a pending {@link requestSize}: the view requests again after it when it still wants a size. */
  setViewMode(mode: DesktopViewMode): void;
  /** Ask the display to become `size` (when the backend can), retrying until it is or giving up. */
  requestSize(size: DesktopSize): void;
  /**
   * Whether the client's own touch handling is on. Off: a gesture layer drives the sink, so the client
   * ignores touch events in its container and suppresses their compatibility mouse events; mouse and
   * pen input stay native either way.
   */
  setNativeInput(enabled: boolean): void;
  focus(): void;
  /** The element the video is drawn in (for coordinate mapping and overlays), once connected. */
  surface(): HTMLElement | null;
  /**
   * Map a client (CSS) point inside the surface to display pixels, or `null` outside it. Overlays
   * use {@link displayToClient} for the reverse.
   */
  clientToDisplay(clientX: number, clientY: number): { x: number; y: number } | null;
  displayToClient(x: number, y: number): { x: number; y: number } | null;
}
