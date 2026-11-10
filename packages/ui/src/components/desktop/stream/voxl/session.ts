// The receive side of a voxl stream, independent of where it runs (the decode worker, or the page
// when workers are unavailable) and of WebCodecs itself, which it reaches through a factory: one
// decoder per stripe, stripe updates reassembled into whole frames presented in order, an ack per
// presented frame, throttled keyframe requests, and ping replies.
//
// Portions derived from voxl (https://github.com/tembo/voxl), MIT License, Copyright (c) 2026 Tembo
// (web/src/worker.ts).

import {
  VOXL_FALLBACK_CODEC,
  VOXL_VIDEO_HEADER_BYTES,
  VoxlBin,
  parseVoxlServerText,
  parseVoxlVideoHeader,
  voxlCmd,
  voxlCodecFromSps,
  type VoxlHello,
  type VoxlStripe
} from "./protocol";

/** The least a decoded frame must offer (WebCodecs' `VideoFrame` does). */
export interface VoxlDecodedFrame {
  readonly timestamp: number;
  close(): void;
}

/** One chunk for a decoder; the WebCodecs factory wraps it in an `EncodedVideoChunk`. */
export interface VoxlChunk {
  type: "key" | "delta";
  timestamp: number;
  data: Uint8Array;
}

export interface VoxlDecoder {
  readonly state: string;
  decode(chunk: VoxlChunk): void;
  close(): void;
}

export type VoxlDecoderFactory<F extends VoxlDecodedFrame> = (
  codec: string,
  output: (frame: F) => void,
  error: (message: string) => void
) => VoxlDecoder;

/** A decoded stripe ready to paint at row `y`. */
export interface VoxlStripePart<F> {
  stripe: number;
  y: number;
  frame: F;
}

/** What the session reports besides frames. */
export type VoxlSessionEvent =
  | { t: "hello"; hello: VoxlHello }
  | { t: "clip"; d: string }
  | { t: "cursor"; buf: ArrayBuffer }
  | { t: "close" }
  | { t: "log"; s: string };

export interface VoxlSessionStats {
  fps: number;
  kbps: number;
  dropped: number;
}

export interface VoxlSessionOptions<F extends VoxlDecodedFrame> {
  send(text: string): void;
  /** Every stripe of one frame, in one call; the callee owns (and closes) the frames. */
  present(parts: VoxlStripePart<F>[]): void;
  emit(event: VoxlSessionEvent): void;
  createDecoder: VoxlDecoderFactory<F>;
}

/** Keyframe requests go out at most this often (voxl's own client: 500 ms). */
export const VOXL_KEYFRAME_THROTTLE_MS = 500;

interface StripeState {
  decoder: VoxlDecoder | null;
  codec: string | null;
  waitingKey: boolean;
  ts: number;
  /** Decoder timestamp → frame id. */
  ids: Map<number, number>;
}

interface PendingFrame<F> {
  need: number;
  got: VoxlStripePart<F>[];
}

export class VoxlStreamSession<F extends VoxlDecodedFrame> {
  private layout: VoxlStripe[] = [];
  private stripes: StripeState[] = [];
  private readonly frames = new Map<number, PendingFrame<F>>();
  /** Frame ids awaiting presentation, oldest first. */
  private order: number[] = [];
  private keyframeCooldown: ReturnType<typeof setTimeout> | null = null;
  private wantVideo = true;
  private closed = false;
  private counts = { frames: 0, bytes: 0, dropped: 0 };

  constructor(private readonly options: VoxlSessionOptions<F>) {}

  /** The socket opened: say which streams this viewer wants (video on unless paused, audio off). */
  open(): void {
    this.options.send(voxlCmd.video(this.wantVideo));
    this.options.send(voxlCmd.audio(false));
  }

  handleText(text: string): void {
    if (this.closed) return;
    const message = parseVoxlServerText(text);
    if (!message) return;
    switch (message.t) {
      case "ping":
        this.options.send(voxlCmd.pong(message.s));
        return;
      case "hello":
        // Sent on connect and after every resize; the stripes may change, so decoders restart.
        this.layout = message.stripes;
        this.reset();
        this.options.emit({ t: "hello", hello: message });
        return;
      case "clip":
        this.options.emit({ t: "clip", d: message.d });
        return;
      case "close":
        this.options.emit({ t: "close" });
        return;
    }
  }

  handleBinary(buf: ArrayBuffer): void {
    if (this.closed || buf.byteLength === 0) return;
    const b = new Uint8Array(buf);
    switch (b[0]) {
      case VoxlBin.Video:
        this.onVideo(b);
        return;
      case VoxlBin.Cursor:
        this.options.emit({ t: "cursor", buf });
        return;
      // Audio stays off (Orquester has its own audio path); clipboard images are not offered.
    }
  }

  /** Pause or resume video; resuming starts from a fresh keyframe. */
  setVideo(on: boolean): void {
    if (this.closed || on === this.wantVideo) return;
    this.wantVideo = on;
    if (on) this.reset();
    this.options.send(voxlCmd.video(on));
    if (on) this.requestKeyframe();
  }

  /** Counters since the last call, as rates over `elapsedMs`. */
  takeStats(elapsedMs: number): VoxlSessionStats {
    const seconds = Math.max(elapsedMs, 1) / 1000;
    const stats = {
      fps: this.counts.frames / seconds,
      kbps: (this.counts.bytes * 8) / 1000 / seconds,
      dropped: this.counts.dropped
    };
    this.counts = { frames: 0, bytes: 0, dropped: 0 };
    return stats;
  }

  close(): void {
    if (this.closed) return;
    this.reset();
    this.closed = true;
    if (this.keyframeCooldown !== null) clearTimeout(this.keyframeCooldown);
    this.keyframeCooldown = null;
  }

  // ---- Internals -------------------------------------------------------------

  /** Close every decoder and drop every frame in flight. */
  private reset(): void {
    for (const stripe of this.stripes) {
      if (stripe.decoder && stripe.decoder.state !== "closed") {
        try {
          stripe.decoder.close();
        } catch {
          /* already closed */
        }
      }
    }
    this.stripes = [];
    for (const frame of this.frames.values()) for (const part of frame.got) part.frame.close();
    this.frames.clear();
    this.order = [];
  }

  private requestKeyframe(): void {
    if (this.keyframeCooldown !== null || this.closed) return;
    this.options.send(voxlCmd.keyframe);
    this.keyframeCooldown = setTimeout(() => {
      this.keyframeCooldown = null;
    }, VOXL_KEYFRAME_THROTTLE_MS);
  }

  private stripeState(i: number): StripeState {
    let state = this.stripes[i];
    if (!state) {
      state = { decoder: null, codec: null, waitingKey: true, ts: 0, ids: new Map() };
      this.stripes[i] = state;
    }
    return state;
  }

  private makeDecoder(i: number, state: StripeState, codec: string): VoxlDecoder {
    return this.options.createDecoder(
      codec,
      (frame) => {
        // A decoder replaced by a reset may still deliver: its stripe state is gone.
        const id = this.stripes[i] === state ? state.ids.get(frame.timestamp) : undefined;
        if (id !== undefined) state.ids.delete(frame.timestamp);
        const pending = id === undefined ? undefined : this.frames.get(id);
        if (!pending || this.closed) {
          frame.close();
          return;
        }
        pending.got.push({ stripe: i, y: this.layout[i]?.[0] ?? 0, frame });
        this.flush();
      },
      (message) => {
        if (this.closed || this.stripes[i] !== state) return;
        this.options.emit({ t: "log", s: `stripe ${i} decoder error: ${message}` });
        this.reset();
        this.requestKeyframe();
      }
    );
  }

  /** Present every complete frame at the head of the queue, acking each. */
  private flush(): void {
    while (this.order.length > 0) {
      const id = this.order[0]!;
      const pending = this.frames.get(id);
      if (pending && pending.got.length < pending.need) return;
      this.order.shift();
      this.frames.delete(id);
      if (!pending) continue;
      if (pending.got.length > 0) this.options.present(pending.got);
      this.options.send(voxlCmd.ack(id));
      this.counts.frames += 1;
    }
  }

  private onVideo(b: Uint8Array): void {
    const header = parseVoxlVideoHeader(b);
    if (!header) return;
    const data = b.subarray(VOXL_VIDEO_HEADER_BYTES);
    this.counts.bytes += b.length;
    let pending = this.frames.get(header.frame);
    if (!pending) {
      pending = { need: header.parts, got: [] };
      this.frames.set(header.frame, pending);
      this.order.push(header.frame);
    }
    const state = this.stripeState(header.stripe);
    if (state.waitingKey && !header.key) {
      // Undecodable without its keyframe: this stripe drops out of the frame.
      pending.need -= 1;
      this.counts.dropped += 1;
      this.requestKeyframe();
      this.flush();
      return;
    }
    if (header.key) {
      const codec = voxlCodecFromSps(data) ?? VOXL_FALLBACK_CODEC;
      if (!state.decoder || state.decoder.state === "closed" || codec !== state.codec) {
        if (state.decoder && state.decoder.state !== "closed") {
          try {
            state.decoder.close();
          } catch {
            /* already closed */
          }
        }
        state.codec = codec;
        state.ids.clear();
        try {
          state.decoder = this.makeDecoder(header.stripe, state, codec);
        } catch (err) {
          state.decoder = null;
          this.options.emit({ t: "log", s: `configure failed: ${err instanceof Error ? err.message : String(err)}` });
          pending.need -= 1;
          this.flush();
          return;
        }
      }
      state.waitingKey = false;
    }
    const decoder = state.decoder;
    if (!decoder) {
      pending.need -= 1;
      this.flush();
      return;
    }
    state.ts += 1;
    state.ids.set(state.ts, header.frame);
    try {
      decoder.decode({ type: header.key ? "key" : "delta", timestamp: state.ts, data });
    } catch (err) {
      this.options.emit({ t: "log", s: `decode threw: ${err instanceof Error ? err.message : String(err)}` });
      this.reset();
      this.requestKeyframe();
    }
  }
}
