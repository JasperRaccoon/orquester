// The voxl stream client: H.264 stripes over the daemon's voxl relay (`/ws-desktop-voxl/:id`, spec
// 2026-11-10 R4.4–R4.5), decoded with WebCodecs, behind `DesktopStreamClient`.
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/client/{main,video,cursor,keyboard,pointer,clipboard,resize}.ts).

import type { DesktopSize } from "@orquester/api";
import { exitPoint } from "../desktop-pointer";
import { isModifierCode, keysymForKeyEvent } from "../desktop-keys";
import type { DesktopPointerButton, DesktopStreamClient, DesktopStreamEvents, DesktopViewMode } from "./types";
import { openVoxlConnection, type VoxlConnectionEvent, type VoxlConnectionHandle } from "./voxl/connection";
import {
  actualSizeBox,
  clientToDisplayPoint,
  containBox,
  cursorScale,
  displayToClientPoint,
  fitRequestSize,
  voxlRequestSize,
  type DisplayBox
} from "./voxl/layout";
import { parseVoxlCursor, voxlCmd, voxlCommandAllowed, type VoxlHello } from "./voxl/protocol";
import type { VoxlFromWorker, VoxlToWorker } from "./voxl/worker-protocol";
import VoxlWorker from "./voxl/voxl.worker.ts?worker";

/**
 * Decoding runs in a dedicated worker that owns the socket and paints an OffscreenCanvas, so frames
 * reach the screen without waiting on the page's main thread (React renders, layout, the gesture
 * layer); the page keeps layout, input, the cursor and the clipboard. Where a worker or an
 * OffscreenCanvas is unavailable, or the worker script fails to load, the same connection code
 * runs on the page with the visible canvas.
 *
 * - **Layout:** the canvas is the display's size in pixels, laid out by CSS: contained and centered
 *   for Fit and fixed-scale, 1:1 and drag-to-pan for fixed-pan. Sizes come from the container's
 *   layout size (a `ResizeObserver`), never its client rect, which the view's zoom transforms.
 * - **Size:** Fit with `driveSize` asks for the container's size in device pixels (`sz`), debounced;
 *   `requestSize` sends `sz` until a `hello` reports the size. Only when the server resizes.
 * - **Input:** mouse (and pen and touch while native input is on) on the canvas, keys while it has
 *   focus, the sink for the gesture layer and key bar; all as voxl commands.
 * - **Clipboard:** the desktop's text goes to the `clipboard` event only; the view offers it.
 * - **Video** pauses while the page is hidden and restarts from a keyframe.
 */

const DISPLAY_BACKGROUND = "rgb(10, 10, 10)";
/** Fit-mode size requests wait for the container to settle (sidebar drags, rotation). */
export const VOXL_FIT_DEBOUNCE_MS = 250;
/** `requestSize`: send `sz` this many times, this far apart, until a `hello` has the size. */
const SIZE_ATTEMPTS = 5;
const SIZE_RETRY_MS = 1500;
/** A left-button drag of more than this many CSS px pans the actual-size view instead of clicking. */
const PAN_THRESHOLD_PX = 3;
/** noVNC's Mac/iOS test, as the view's: Cmd maps to Alt_L there. */
const APPLE_PLATFORM = typeof navigator !== "undefined" && /mac|ipad|iphone|ipod/i.test(navigator.platform);

/** `MouseEvent.buttons` bits → X buttons (DOM swaps middle and right). */
const DOM_BUTTON_BITS: readonly [bit: number, xButton: number][] = [
  [1, 1],
  [4, 2],
  [2, 3],
  [8, 8],
  [16, 9]
];

interface Transport {
  send(text: string): void;
  setVideo(on: boolean): void;
  close(): void;
}

export interface VoxlStreamClientOptions {
  /** The authenticated voxl relay URL, or null where this transport has none. */
  socketUrl: string | null;
}

export class VoxlStreamClient implements DesktopStreamClient {
  readonly backend = "voxl" as const;

  private container: HTMLElement | null = null;
  private root: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private events: DesktopStreamEvents | null = null;
  private transport: Transport | null = null;
  private started = false;
  private disposed = false;
  private ended = false;

  private hello: VoxlHello | null = null;
  private box: DisplayBox | null = null;
  private mode: DesktopViewMode = { kind: "fit", driveSize: false };
  private nativeInput = true;
  private videoOn = true;

  private fitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last Fit-mode size sent, so an unchanged container does not resend it. */
  private lastFitSize: string | null = null;
  private sizeRequest: { size: DesktopSize; attempts: number; timer: ReturnType<typeof setTimeout> | null } | null = null;

  /** X buttons held by native input. */
  private nativeButtons = new Set<number>();
  /** Fixed-pan: a left-button press that pans when it moves, or clicks when it does not. */
  private pan: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  private lastMove = "";
  /** Keys pressed by the hardware keyboard: `code` → the keysym sent, so a release matches. */
  private readonly heldKeys = new Map<string, number>();
  private scrollQueue = { x: 0, y: 0, frame: 0 };

  private cursorMessage: ArrayBuffer | null = null;
  private cursorKey = "";
  private cursorCss = "default";
  /** The last pointer over the canvas was a mouse (its CSS cursor shows even with native input off). */
  private mouseActive = false;

  private readonly cleanups: (() => void)[] = [];
  private removeTouchBlock: (() => void) | null = null;

  constructor(private readonly options: VoxlStreamClientOptions) {}

  async connect(container: HTMLElement, events: DesktopStreamEvents): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const url = this.options.socketUrl;
    if (!url) throw new Error("Desktop tabs require a remote (HTTP) connection.");
    if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") {
      throw new Error("This browser cannot decode H.264 video (WebCodecs).");
    }
    this.container = container;
    this.events = events;

    const root = document.createElement("div");
    root.style.cssText = `position:absolute;inset:0;overflow:hidden;background:${DISPLAY_BACKGROUND}`;
    const canvas = document.createElement("canvas");
    canvas.dataset.desktopSurface = "";
    canvas.tabIndex = -1;
    canvas.style.cssText = "position:absolute;display:block;outline:none;touch-action:none;user-select:none";
    canvas.width = 0;
    canvas.height = 0;
    root.appendChild(canvas);
    container.appendChild(root);
    this.root = root;
    this.canvas = canvas;

    this.applyNativeInput();
    this.listen(container, canvas);
    events.state("connecting");
    this.videoOn = document.visibilityState !== "hidden";
    this.transport = this.startTransport(url, canvas);
    if (!this.videoOn) this.transport.setVideo(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.removeTouchBlock?.();
    this.removeTouchBlock = null;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = null;
    this.clearSizeRequest();
    if (this.scrollQueue.frame !== 0) cancelAnimationFrame(this.scrollQueue.frame);
    this.scrollQueue = { x: 0, y: 0, frame: 0 };
    this.transport?.close();
    this.transport = null;
    this.root?.remove();
    this.root = null;
    this.canvas = null;
    this.container = null;
    this.events = null;
  }

  setViewMode(mode: DesktopViewMode): void {
    const previous = this.mode;
    this.mode = mode;
    // A new mode supersedes a pending size request (the view asks again when it still wants one).
    this.clearSizeRequest();
    if (mode.kind !== "fixed-pan" && this.root) {
      this.root.scrollLeft = 0;
      this.root.scrollTop = 0;
      this.pan = null;
    }
    if (mode.kind === "fit" && mode.driveSize) {
      // Taking the size over (or a new mode): ask again even when the container did not change.
      if (!(previous.kind === "fit" && previous.driveSize)) this.lastFitSize = null;
      this.scheduleFit();
    } else if (this.fitTimer !== null) {
      clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    this.layout();
  }

  requestSize(size: DesktopSize): void {
    this.clearSizeRequest();
    this.sizeRequest = { size: voxlRequestSize(size), attempts: 0, timer: null };
    this.tryRequest();
  }

  setNativeInput(enabled: boolean): void {
    if (enabled === this.nativeInput) return;
    this.nativeInput = enabled;
    this.applyNativeInput();
    this.applyCursor();
  }

  focus(): void {
    this.canvas?.focus({ preventScroll: true });
  }

  surface(): HTMLElement | null {
    return this.hello ? this.canvas : null;
  }

  clientToDisplay(clientX: number, clientY: number): { x: number; y: number } | null {
    const { canvas, hello, root } = this;
    if (!canvas || !hello || !root) return null;
    // Rendered rects: they include the view's zoom transform. Panned at actual size, the canvas
    // reaches past what the root shows.
    return clientToDisplayPoint(canvas.getBoundingClientRect(), { width: hello.w, height: hello.h }, clientX, clientY, root.getBoundingClientRect());
  }

  displayToClient(x: number, y: number): { x: number; y: number } | null {
    const { canvas, hello } = this;
    if (!canvas || !hello) return null;
    return displayToClientPoint(canvas.getBoundingClientRect(), { width: hello.w, height: hello.h }, x, y);
  }

  // ---- DesktopInputSink ------------------------------------------------------

  pointerMove(x: number, y: number): void {
    const hello = this.hello;
    if (!hello) return;
    this.sendMove(Math.min(Math.max(Math.round(x), 0), hello.w - 1), Math.min(Math.max(Math.round(y), 0), hello.h - 1));
  }

  pointerButton(button: DesktopPointerButton, down: boolean): void {
    this.send(voxlCmd.button(button, down));
  }

  scroll(dx: number, dy: number): void {
    this.queueScroll(dx, dy);
  }

  key(keysym: number, down: boolean): void {
    this.send(voxlCmd.key(keysym, down));
  }

  releaseAll(): void {
    this.heldKeys.clear();
    this.nativeButtons.clear();
    this.pan = null;
    if (this.scrollQueue.frame !== 0) cancelAnimationFrame(this.scrollQueue.frame);
    this.scrollQueue = { x: 0, y: 0, frame: 0 };
    this.send(voxlCmd.releaseAll);
  }

  setClipboard(text: string): void {
    this.send(voxlCmd.clipboard(text));
  }

  // ---- Transport ---------------------------------------------------------------

  private startTransport(url: string, canvas: HTMLCanvasElement): Transport {
    const workerUsable =
      typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof canvas.transferControlToOffscreen === "function";
    return workerUsable ? this.startWorker(url, canvas) : this.startOnPage(url, canvas);
  }

  private startOnPage(url: string, canvas: HTMLCanvasElement): Transport {
    const handle: VoxlConnectionHandle = openVoxlConnection(url, canvas, (event) => this.onConnectionEvent(event));
    return handle;
  }

  private startWorker(url: string, canvas: HTMLCanvasElement): Transport {
    let worker: Worker;
    try {
      worker = new VoxlWorker();
    } catch {
      return this.startOnPage(url, canvas);
    }
    let ready = false;
    let fallback: Transport | null = null;
    const post = (message: VoxlToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
    worker.onmessage = (event: MessageEvent<VoxlFromWorker>) => {
      if (this.disposed) return;
      const message = event.data;
      if (message.t === "ready") {
        if (ready) return;
        ready = true;
        // Transferred only now: a worker that never loads leaves the canvas to the page fallback.
        const offscreen = canvas.transferControlToOffscreen();
        post({ t: "init", url, canvas: offscreen }, [offscreen]);
        if (!this.videoOn) post({ t: "video", on: false });
        return;
      }
      this.onConnectionEvent(message);
    };
    worker.onerror = (event) => {
      if (this.disposed) return;
      event.preventDefault();
      if (!ready && !fallback) {
        // The worker script did not load (an old browser, a file:// page): decode on the page.
        worker.terminate();
        fallback = this.startOnPage(url, canvas);
        if (!this.videoOn) fallback.setVideo(false);
        return;
      }
      if (ready) this.end(`The video decoder stopped: ${event.message || "worker error"}`);
    };
    return {
      send: (text) => (fallback ? fallback.send(text) : post({ t: "send", d: text })),
      setVideo: (on) => (fallback ? fallback.setVideo(on) : post({ t: "video", on })),
      close: () => {
        if (fallback) {
          fallback.close();
          return;
        }
        // Closing in the worker first lets the socket say goodbye; terminating closes it regardless.
        try {
          post({ t: "close" });
        } catch {
          /* already gone */
        }
        worker.terminate();
      }
    };
  }

  private onConnectionEvent(event: VoxlConnectionEvent): void {
    if (this.disposed || this.ended) return;
    switch (event.t) {
      case "open":
        return;
      case "hello":
        this.onHello(event.hello);
        return;
      case "clip":
        this.events?.clipboard(event.d);
        return;
      case "cursor":
        this.cursorMessage = event.buf;
        this.cursorKey = "";
        this.applyCursor();
        return;
      case "stats":
        this.events?.stats({ fps: Math.round(event.fps), kbps: Math.round(event.kbps) });
        return;
      case "log":
        console.warn("[voxl]", event.s);
        return;
      case "closed":
        this.end(event.reason);
        return;
    }
  }

  private onHello(hello: VoxlHello): void {
    const first = this.hello === null;
    this.hello = hello;
    this.layout();
    this.events?.size({ width: hello.w, height: hello.h });
    if (first) this.events?.state("connected");
    if (this.sizeRequest) this.tryRequest();
    if (this.mode.kind === "fit" && this.mode.driveSize) this.scheduleFit();
  }

  /** The stream ended on its own: the view disposes this client and connects a new one. */
  private end(reason?: string): void {
    if (this.ended || this.disposed) return;
    this.ended = true;
    this.transport?.close();
    this.transport = null;
    this.events?.state("disconnected", reason);
  }

  private send(text: string): void {
    if (!this.transport || this.ended) return;
    if (!voxlCommandAllowed(text, this.hello?.readOnly === true)) return;
    this.transport.send(text);
  }

  // ---- Layout and size ---------------------------------------------------------

  private layout(): void {
    const { container, canvas, hello } = this;
    if (!container || !canvas || !hello) return;
    const size = { width: container.clientWidth, height: container.clientHeight };
    const display = { width: hello.w, height: hello.h };
    const box = this.mode.kind === "fixed-pan" ? actualSizeBox(size, display) : containBox(size, display);
    this.box = box;
    if (!box) return;
    const { style } = canvas;
    style.left = `${box.left}px`;
    style.top = `${box.top}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    this.applyCursor();
  }

  private scheduleFit(): void {
    if (this.mode.kind !== "fit" || !this.mode.driveSize) return;
    if (this.fitTimer !== null) clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      this.sendFit();
    }, VOXL_FIT_DEBOUNCE_MS);
  }

  private sendFit(): void {
    const { container, hello } = this;
    if (!container || !hello?.resize || hello.readOnly) return;
    if (this.mode.kind !== "fit" || !this.mode.driveSize) return;
    const size = fitRequestSize({ width: container.clientWidth, height: container.clientHeight }, window.devicePixelRatio || 1);
    if (!size) return;
    const key = `${size.width}x${size.height}`;
    if (key === this.lastFitSize) return;
    this.lastFitSize = key;
    if (size.width === hello.w && size.height === hello.h) return;
    this.send(voxlCmd.resize(size.width, size.height));
  }

  private clearSizeRequest(): void {
    if (this.sizeRequest?.timer != null) clearTimeout(this.sizeRequest.timer);
    this.sizeRequest = null;
  }

  /** Send the pending size request again until a `hello` reports it or the attempts run out. */
  private tryRequest(): void {
    const request = this.sizeRequest;
    const hello = this.hello;
    if (!request || !hello) return; // before the first hello: tried again on it
    if (request.timer !== null) clearTimeout(request.timer);
    request.timer = null;
    if (!hello.resize || hello.readOnly) {
      this.sizeRequest = null;
      return;
    }
    if ((hello.w === request.size.width && hello.h === request.size.height) || request.attempts >= SIZE_ATTEMPTS) {
      this.sizeRequest = null;
      return;
    }
    request.attempts += 1;
    this.send(voxlCmd.resize(request.size.width, request.size.height));
    request.timer = setTimeout(() => {
      request.timer = null;
      if (this.sizeRequest === request) this.tryRequest();
    }, SIZE_RETRY_MS);
  }

  // ---- Cursor ------------------------------------------------------------------

  /** The desktop's cursor as the canvas's CSS cursor (no stream latency); hidden while the gesture layer draws its own. */
  private applyCursor(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    if (!this.nativeInput && !this.mouseActive) {
      canvas.style.cursor = "none";
      return;
    }
    canvas.style.cursor = this.remoteCursorCss();
  }

  private remoteCursorCss(): string {
    const message = this.cursorMessage;
    if (!message) return "default";
    const cursor = parseVoxlCursor(message);
    if (!cursor) return "default";
    if (cursor.width === 0 || cursor.height === 0) return "none";
    const dpr = window.devicePixelRatio || 1;
    const scale = cursorScale(this.box?.scale ?? 1, cursor.width, cursor.height);
    const key = `${cursor.serial}:${scale}:${dpr}`;
    if (key === this.cursorKey) return this.cursorCss;
    const source = document.createElement("canvas");
    source.width = cursor.width;
    source.height = cursor.height;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) return "default";
    sourceContext.putImageData(new ImageData(cursor.rgba, cursor.width, cursor.height), 0, 0);
    const cssWidth = Math.max(1, Math.round(cursor.width * scale));
    const cssHeight = Math.max(1, Math.round(cursor.height * scale));
    const scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(cssWidth * dpr));
    scaled.height = Math.max(1, Math.round(cssHeight * dpr));
    const context = scaled.getContext("2d");
    if (!context) return "default";
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, scaled.width, scaled.height);
    const url = scaled.toDataURL("image/png");
    const hx = Math.round(cursor.hotX * scale);
    const hy = Math.round(cursor.hotY * scale);
    this.cursorKey = key;
    this.cursorCss =
      dpr > 1
        ? `-webkit-image-set(url(${url}) ${dpr}x) ${hx} ${hy}, url(${url}) ${hx} ${hy}, default`
        : `url(${url}) ${hx} ${hy}, default`;
    return this.cursorCss;
  }

  // ---- Native input ------------------------------------------------------------

  private listen(container: HTMLElement, canvas: HTMLCanvasElement): void {
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      listener: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions
    ) => {
      target.addEventListener(type, listener, options);
      this.cleanups.push(() => target.removeEventListener(type, listener, options));
    };

    const observer = new ResizeObserver(() => {
      this.layout();
      this.scheduleFit();
    });
    observer.observe(container);
    this.cleanups.push(() => observer.disconnect());
    // A page zoom changes the device pixel ratio without resizing the container.
    const onWindowResize = () => {
      this.applyCursor();
      this.scheduleFit();
    };
    window.addEventListener("resize", onWindowResize);
    this.cleanups.push(() => window.removeEventListener("resize", onWindowResize));

    // Nobody sees a hidden page: stop the video and restart it from a keyframe.
    const onVisibility = () => {
      const on = document.visibilityState !== "hidden";
      if (!on) this.releaseAll();
      if (on === this.videoOn) return;
      this.videoOn = on;
      this.transport?.setVideo(on);
    };
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));

    on(canvas, "pointerdown", (e) => this.onPointer(e, "down"));
    on(canvas, "pointermove", (e) => this.onPointer(e, "move"));
    on(canvas, "pointerup", (e) => this.onPointer(e, "up"));
    on(canvas, "pointercancel", (e) => {
      if (!this.handles(e)) return;
      for (const button of this.nativeButtons) this.send(voxlCmd.button(button, false));
      this.nativeButtons.clear();
      this.pan = null;
    });
    on(canvas, "pointerleave", (e) => this.parkPointer(e));
    on(canvas, "contextmenu", (e) => e.preventDefault());
    on(canvas, "wheel", (e) => this.onWheel(e), { passive: false });
    on(canvas, "keydown", (e) => this.onKeyDown(e));
    on(canvas, "keyup", (e) => this.onKeyUp(e));
    on(canvas, "blur", () => this.releaseKeys());
    const onWindowBlur = () => this.releaseKeys();
    window.addEventListener("blur", onWindowBlur);
    this.cleanups.push(() => window.removeEventListener("blur", onWindowBlur));
  }

  /** Mouse input is always the client's; pen and touch only while its native input is on (else the gesture layer has them). */
  private handles(e: PointerEvent): boolean {
    return e.pointerType === "mouse" || this.nativeInput;
  }

  private onPointer(e: PointerEvent, kind: "down" | "move" | "up"): void {
    const mouse = e.pointerType === "mouse";
    if (mouse !== this.mouseActive && (mouse || !this.nativeInput)) {
      this.mouseActive = mouse;
      this.applyCursor();
    }
    if (!this.handles(e) || !this.hello) return;
    // A layer above took this press (the gesture layer's direct pen).
    if (kind === "down" && e.defaultPrevented) return;
    const canvas = this.canvas;
    if (kind === "down") {
      e.preventDefault();
      canvas?.focus({ preventScroll: true });
      try {
        canvas?.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is already gone */
      }
    } else if (kind === "up") {
      e.preventDefault();
    }
    const at = this.toDisplay(e.clientX, e.clientY);
    const wanted = new Set<number>();
    for (const [bit, button] of DOM_BUTTON_BITS) if (e.buttons & bit) wanted.add(button);

    // Fixed, pan: a left-button drag moves the view (noVNC's dragViewport); a press that does not move clicks.
    if (this.mode.kind === "fixed-pan" && mouse) {
      if (wanted.has(1) && !this.nativeButtons.has(1) && !this.pan && this.root) {
        this.pan = { x: e.clientX, y: e.clientY, left: this.root.scrollLeft, top: this.root.scrollTop, moved: false };
      }
      const pan = this.pan;
      if (pan) {
        wanted.delete(1);
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) > PAN_THRESHOLD_PX) pan.moved = true;
        if (pan.moved && this.root) {
          this.root.scrollLeft = pan.left - dx;
          this.root.scrollTop = pan.top - dy;
        }
        if (!(e.buttons & 1)) {
          this.pan = null;
          if (!pan.moved && at) {
            this.sendMove(at.x, at.y);
            this.send(voxlCmd.button(1, true));
            this.send(voxlCmd.button(1, false));
          }
        }
        if (pan.moved) {
          this.syncButtons(wanted);
          return;
        }
      }
    }

    if (at) this.sendMove(at.x, at.y);
    this.syncButtons(wanted);
  }

  /** Send the button changes from the held set to `wanted`. */
  private syncButtons(wanted: Set<number>): void {
    for (const button of this.nativeButtons) {
      if (!wanted.has(button)) this.send(voxlCmd.button(button, false));
    }
    for (const button of wanted) {
      if (!this.nativeButtons.has(button)) this.send(voxlCmd.button(button, true));
    }
    this.nativeButtons = wanted;
  }

  /** A client point → display pixels, clamped onto the display (a captured drag may leave it). */
  private toDisplay(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.canvas;
    const hello = this.hello;
    if (!canvas || !hello) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.round(((clientX - rect.left) * hello.w) / rect.width);
    const y = Math.round(((clientY - rect.top) * hello.h) / rect.height);
    return { x: Math.max(0, Math.min(hello.w - 1, x)), y: Math.max(0, Math.min(hello.h - 1, y)) };
  }

  private sendMove(x: number, y: number): void {
    const command = voxlCmd.move(x, y);
    if (command === this.lastMove) return;
    this.lastMove = command;
    this.send(command);
  }

  /** The mouse leaving the display parks the remote pointer where it crossed the edge (see desktop-pointer.ts). */
  private parkPointer(e: PointerEvent): void {
    if (e.pointerType !== "mouse" || e.buttons !== 0 || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const edge = exitPoint(rect, e.clientX, e.clientY);
    const at = this.toDisplay(edge.x, edge.y);
    if (at) this.sendMove(at.x, at.y);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const hello = this.hello;
    const canvas = this.canvas;
    if (!hello || !canvas) return;
    const at = this.toDisplay(e.clientX, e.clientY);
    if (at) this.sendMove(at.x, at.y);
    const rect = canvas.getBoundingClientRect();
    const displayPerPx = rect.width > 0 ? hello.w / rect.width : 1;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    this.queueScroll(e.deltaX * unit * displayPerPx, e.deltaY * unit * displayPerPx);
  }

  /** Scroll is batched per animation frame. */
  private queueScroll(dx: number, dy: number): void {
    const queue = this.scrollQueue;
    queue.x += dx;
    queue.y += dy;
    if (queue.frame !== 0) return;
    queue.frame = requestAnimationFrame(() => {
      queue.frame = 0;
      const { x, y } = queue;
      queue.x = 0;
      queue.y = 0;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
      this.send(voxlCmd.scroll(x, y));
    });
  }

  // ---- Keyboard ----------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    const keysym = keysymForKeyEvent(e, APPLE_PLATFORM);
    if (keysym === null) return;
    e.preventDefault();
    const id = e.code || `key:${e.key}`;
    const held = this.heldKeys.get(id);
    // The desktop repeats a held key itself (spec R3.7).
    if (e.repeat && held !== undefined) return;
    // macOS sends no keyup for keys released while Cmd is down: tap them (as noVNC does).
    if (APPLE_PLATFORM && e.metaKey && !isModifierCode(e.code)) {
      this.send(voxlCmd.key(keysym, true));
      this.send(voxlCmd.key(keysym, false));
      return;
    }
    // A key already down keeps the keysym it went down with.
    const sent = held ?? keysym;
    this.heldKeys.set(id, sent);
    this.send(voxlCmd.key(sent, true));
  }

  private onKeyUp(e: KeyboardEvent): void {
    const id = e.code || `key:${e.key}`;
    const keysym = this.heldKeys.get(id);
    if (keysym === undefined) return;
    e.preventDefault();
    this.heldKeys.delete(id);
    this.send(voxlCmd.key(keysym, false));
  }

  private releaseKeys(): void {
    for (const keysym of this.heldKeys.values()) this.send(voxlCmd.key(keysym, false));
    this.heldKeys.clear();
  }

  /** Off: touches in the container never reach the canvas nor make compatibility mouse events. */
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
}
