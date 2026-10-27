// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * Android: one WebSocket `…/vendor/serve-emu/ws?device=<serial>&frame-meta=1`
 * carries SEMU-framed Annex-B H.264 down and JSON input up. The decoder is
 * configured from the first keyframe's SPS; a `video-session` message (the
 * encoder restarted at a new size, e.g. on rotation) rebuilds it. With
 * `video: false` (URL with `video=0`) the socket is input-only.
 */

import { H264Decoder, paintCanvas } from "./decoder.ts";
import { codecFromSps, scanAccessUnit } from "./h264.ts";
import { chunkText } from "./keymap.ts";
import { networkError, StreamLifecycle, type StreamAttempt } from "./lifecycle.ts";
import { clampUnit } from "./pointer.ts";
import { parseSemuPacket } from "./semu.ts";
import {
  DeviceStreamError,
  resolveDeps,
  type DeviceButton,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceVideoSession,
  type StreamDeps,
  type TouchPhase,
  type VideoSessionOptions
} from "./types.ts";

/** Keyframe requests are rate-limited; serve-emu also restarts its encoder for one. */
const KEYFRAME_REQUEST_INTERVAL_MS = 500;

export interface ServeEmuSessionOptions extends VideoSessionOptions {
  /** False for an input-only socket (the URL carries `video=0`); default true. */
  readonly video?: boolean;
  /** The socket opened (input accepted) or closed. */
  readonly onInputReady?: (ready: boolean) => void;
}

/** Units held while the decoder configures; past this the queue restarts from the next keyframe. */
const MAX_QUEUED_UNITS = 60;

interface QueuedUnit {
  readonly isKey: boolean;
  readonly data: Uint8Array;
  readonly timestamp: number | null;
}

const TOUCH_ACTIONS = { begin: "down", move: "move", end: "up" } as const;

export class ServeEmuSession implements DeviceVideoSession {
  readonly transport = "serve-emu" as const;
  private readonly deps: StreamDeps;
  private readonly lifecycle: StreamLifecycle;
  private readonly decoder: H264Decoder;
  private readonly video: boolean;
  private socket: WebSocket | null = null;
  private configuring = false;
  /** Access units from the configuring keyframe on, decoded in order once the decoder is ready. */
  private queued: QueuedUnit[] | null = null;
  /** Bumped when the encoder restarts (new attempt or `video-session`); stale configurations are dropped. */
  private videoEpoch = 0;
  private lastKeyframeRequest = -Infinity;

  constructor(private readonly options: ServeEmuSessionOptions) {
    this.deps = resolveDeps(options.deps);
    this.video = options.video !== false;
    this.decoder = new H264Decoder({
      deps: this.deps,
      onFrame: (frame) => {
        if (paintCanvas(options.canvas, frame, frame.displayWidth, frame.displayHeight)) {
          this.lifecycle.frame(frame.displayWidth, frame.displayHeight);
        }
      },
      onError: (error) => {
        this.lifecycle.warn(`H.264 decoder error, waiting for a keyframe: ${error.message}`);
        this.lifecycle.setDecoder(null);
        this.requestKeyframe(true);
      }
    });
    this.lifecycle = new StreamLifecycle({
      transport: this.transport,
      callbacks: options,
      connect: (attempt) => this.connect(attempt),
      now: this.deps.now,
      random: this.deps.random,
      stallMs: this.video ? options.stallMs : null,
      reconnectAfterMs: options.reconnectAfterMs,
      onStall: () => this.requestKeyframe(true)
    });
    this.lifecycle.start();
  }

  get state(): DeviceStreamState {
    return this.lifecycle.state;
  }

  get error(): DeviceStreamError | null {
    return this.lifecycle.error;
  }

  /** The socket is open and accepts input. */
  get inputReady(): boolean {
    return this.socket?.readyState === this.deps.WebSocket.OPEN;
  }

  stats(): DeviceStreamStats {
    return this.lifecycle.stats();
  }

  close(): void {
    this.lifecycle.close();
    this.decoder.close();
    this.socket = null;
  }

  /** Ask serve-emu for a keyframe (rate-limited unless `force`). */
  requestKeyframe(force = false): boolean {
    const now = this.deps.now();
    if (!force && now - this.lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return false;
    if (!this.send({ type: "reset-video", ack: false })) return false;
    this.lastKeyframeRequest = now;
    return true;
  }

  /** Normalized 0..1 coordinates in the frame as displayed (Android frames are already rotated). */
  sendTouch(phase: TouchPhase, x: number, y: number): boolean {
    // Acks for every move would flood the socket; touch failures are not actionable.
    return this.send({ type: "touch", action: TOUCH_ACTIONS[phase], x: clampUnit(x), y: clampUnit(y), ack: false });
  }

  /** Android `KeyEvent` keycode; without `action` the host sends down and up. */
  sendKey(keycode: number, action?: "down" | "up", metaState = 0): boolean {
    return this.send({
      type: "key",
      keycode,
      ...(action ? { action } : {}),
      ...(metaState ? { metaState } : {})
    });
  }

  /** Type `text` in ≤300-byte chunks (at most 64); false when anything was not sent. */
  sendText(text: string): boolean {
    const { chunks, truncated } = chunkText(text);
    for (const chunk of chunks) if (!this.send({ type: "text", text: chunk })) return false;
    if (truncated) this.lifecycle.warn("Pasted text was too long; the rest was dropped.");
    return !truncated;
  }

  sendButton(button: DeviceButton): boolean {
    return this.send({ type: button });
  }

  private send(message: object): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.deps.WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private connect(attempt: StreamAttempt): void {
    this.decoder.reset();
    this.lifecycle.setDecoder(null);
    this.videoEpoch++;
    this.configuring = false;
    this.queued = null;
    let socket: WebSocket;
    try {
      socket = new this.deps.WebSocket(this.options.url);
    } catch (cause) {
      this.lifecycle.fail(networkError(cause));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    attempt.signal.addEventListener(
      "abort",
      () => {
        if (this.socket === socket) {
          this.socket = null;
          this.options.onInputReady?.(false);
        }
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      },
      { once: true }
    );
    socket.onopen = () => {
      if (!attempt.current()) return;
      this.options.onInputReady?.(true);
      if (!this.video) this.lifecycle.ready();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (!attempt.current()) return;
      if (typeof event.data === "string") this.onText(event.data);
      else if (event.data instanceof ArrayBuffer) this.onBinary(event.data, attempt);
    };
    socket.onclose = (event: CloseEvent) => {
      if (!attempt.current()) return;
      this.socket = null;
      this.options.onInputReady?.(false);
      if (event.code === 1008 || event.code === 4401 || event.code === 4403) {
        this.lifecycle.fail(new DeviceStreamError("unauthorized", "The device stream refused this session's credentials.", true));
        return;
      }
      const reason = event.reason ? `: ${event.reason}` : "";
      this.lifecycle.fail(new DeviceStreamError("network", `The device stream closed (${event.code}${reason}). Reconnecting…`));
    };
  }

  private onText(text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.lifecycle.warn(`Unreadable serve-emu message: ${text.slice(0, 120)}`);
      return;
    }
    const record = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
    if (record.type === "video-session") {
      // The encoder restarted (rotation or resize); its next keyframe carries a new SPS.
      this.decoder.reset();
      this.lifecycle.setDecoder(null);
      this.videoEpoch++;
      this.configuring = false;
      this.queued = null;
      this.requestKeyframe(true);
      return;
    }
    if (record.ok === true) return;
    if (record.ok === false) {
      this.lifecycle.warn(`The device rejected input: ${typeof record.error === "string" ? record.error : "unknown error"}`);
      return;
    }
    this.lifecycle.warn(`Unhandled serve-emu message: ${text.slice(0, 120)}`);
  }

  private onBinary(raw: ArrayBuffer, attempt: StreamAttempt): void {
    this.lifecycle.received(raw.byteLength);
    if (!this.video) return;
    const packet = parseSemuPacket(raw);
    const configured = this.decoder.configured;
    const scanned = packet.isKey === null || (packet.isKey && !configured) ? scanAccessUnit(packet.data) : null;
    const isKey = packet.isKey ?? scanned?.isKey ?? false;
    if (!configured) {
      if (this.configuring) {
        const unit = { isKey, data: packet.data, timestamp: packet.timestamp };
        if (isKey) this.queued = [unit];
        else if (this.queued && this.queued.length < MAX_QUEUED_UNITS) this.queued.push(unit);
        else this.queued = null;
        return;
      }
      const codec = scanned?.sps ? codecFromSps(scanned.sps) : null;
      if (!codec || !isKey) {
        this.requestKeyframe();
        return;
      }
      this.configuring = true;
      this.queued = [{ isKey: true, data: packet.data, timestamp: packet.timestamp }];
      const epoch = this.videoEpoch;
      void this.decoder.configure(codec).then((ok) => {
        if (!attempt.current() || epoch !== this.videoEpoch) return;
        this.configuring = false;
        if (!ok) {
          this.lifecycle.fail(
            new DeviceStreamError("unsupported", `This browser can't decode the device's ${codec} video.`, true)
          );
          return;
        }
        this.lifecycle.setDecoder(codec);
        const units = this.queued;
        this.queued = null;
        if (!units) this.requestKeyframe(true);
        for (const unit of units ?? []) this.decode(unit.isKey, unit.data, unit.timestamp);
      });
      return;
    }
    this.decode(isKey, packet.data, packet.timestamp);
  }

  private decode(isKey: boolean, data: Uint8Array, timestamp: number | null): void {
    const result = this.decoder.decode(isKey, data, timestamp);
    if (result === "awaiting-keyframe") this.requestKeyframe();
    else if (result === "overflow" || result === "error") {
      this.lifecycle.warn(result === "overflow" ? "The video decoder fell behind; resyncing." : "A video frame failed to decode; resyncing.");
      this.lifecycle.setDecoder(null);
      this.requestKeyframe(true);
    }
  }
}
