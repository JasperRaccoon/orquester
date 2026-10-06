import type { DesktopVncControlMessage } from "@orquester/api";

/**
 * The RFB relay socket for a desktop viewer (spec §7.2).
 *
 * `/ws-desktop/:id` carries RFB bytes in binary frames and a small control side
 * channel in text frames: the client sends `{type:"ping", t}` every 2 s and the
 * relay answers `{type:"pong", t}` queued behind any RFB data it still has to
 * send. noVNC must never see those text frames, so it gets this thin
 * WebSocket-like wrapper instead of the socket itself:
 *
 * - binary frames are handed to noVNC's `onmessage` unchanged;
 * - text frames are consumed here; a pong yields an RTT sample (the congestion
 *   signal for adaptive quality, §11.2);
 * - no frame at all for 20 seconds (pongs arrive every 2 s even on an idle
 *   display) closes the socket, so a dead link turns into a reconnect.
 *
 * noVNC's `Websock.attach` requires the channel to expose `send`, `close`,
 * `binaryType`, `onerror`, `onmessage`, `onopen`, `protocol` and `readyState`
 * as own keys or prototype members; it then assigns the `on*` handlers and
 * compares `readyState` against the `WebSocket.*` numeric constants.
 */

/** The subset of `WebSocket` this wrapper drives (a fake one in tests). */
export interface VncRawSocket {
  readonly readyState: number;
  readonly protocol: string;
  binaryType: BinaryType;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

export interface DesktopVncChannelOptions {
  /** One RTT sample (ms) per answered ping. */
  onRtt?: (rttMs: number) => void;
}

const DESKTOP_VNC_PING_INTERVAL_MS = 2000;
const DESKTOP_VNC_STALE_AFTER_MS = 20_000;
/** Close code used when the link went silent (application range). */
const DESKTOP_VNC_STALE_CLOSE_CODE = 4000;

const OPEN = 1;

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function parseControl(text: string): DesktopVncControlMessage | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const rec = value as Record<string, unknown>;
    if ((rec.type === "ping" || rec.type === "pong") && typeof rec.t === "number" && Number.isFinite(rec.t)) {
      return { type: rec.type, t: rec.t };
    }
    return null;
  } catch {
    return null;
  }
}

export class DesktopVncChannel {
  // Assigned by noVNC after attach. Instance fields, so they are own keys.
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;

  /** Latest RTT sample, or null before the first pong. */
  lastRttMs: number | null = null;

  private readonly socket: VncRawSocket;
  private readonly onRtt: ((rttMs: number) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;

  constructor(socket: VncRawSocket, options: DesktopVncChannelOptions = {}) {
    this.socket = socket;
    this.onRtt = options.onRtt;
    socket.binaryType = "arraybuffer";
    socket.onopen = (ev) => {
      this.lastFrameAt = defaultNow();
      this.startPinging();
      this.onopen?.(ev);
    };
    socket.onmessage = (ev) => this.receive(ev);
    socket.onclose = (ev) => {
      this.stopPinging();
      this.onclose?.(ev);
    };
    socket.onerror = (ev) => this.onerror?.(ev);
    if (socket.readyState === OPEN) {
      this.lastFrameAt = defaultNow();
      this.startPinging();
    }
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(value: BinaryType) {
    // noVNC sets "arraybuffer", which is what the wrapper needs anyway.
    this.socket.binaryType = value;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.stopPinging();
    this.socket.close(code, reason);
  }

  private receive(ev: MessageEvent): void {
    this.lastFrameAt = defaultNow();
    if (typeof ev.data === "string") {
      const msg = parseControl(ev.data);
      if (msg?.type === "pong") {
        const rtt = Math.max(0, defaultNow() - msg.t);
        this.lastRttMs = rtt;
        this.onRtt?.(rtt);
      }
      return; // control frames never reach noVNC
    }
    this.onmessage?.(ev);
  }

  private tick(): void {
    if (this.socket.readyState !== OPEN) return;
    const now = defaultNow();
    if (now - this.lastFrameAt > DESKTOP_VNC_STALE_AFTER_MS) {
      this.close(DESKTOP_VNC_STALE_CLOSE_CODE, "stale");
      return;
    }
    const ping: DesktopVncControlMessage = { type: "ping", t: now };
    this.socket.send(JSON.stringify(ping));
  }

  private startPinging(): void {
    if (this.timer !== null) return;
    this.tick(); // an early sample instead of waiting a full period
    this.timer = setInterval(() => this.tick(), DESKTOP_VNC_PING_INTERVAL_MS);
  }

  private stopPinging(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Open the relay socket for `url` (from `api.desktopSocketUrl`) and wrap it. */
export function openDesktopVncChannel(url: string, options: DesktopVncChannelOptions = {}): DesktopVncChannel {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return new DesktopVncChannel(socket, options);
}
