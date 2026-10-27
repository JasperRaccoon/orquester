// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts, frame.ts
/**
 * Painting into the caller's canvas, and a WebCodecs H.264 decoder that gates
 * on keyframes, configures for latency, bounds its queue, and discards output
 * from a decoder it has already replaced.
 */

import type { StreamDeps } from "./types.ts";

/** Draw `source` at its native size; resizes the canvas when the frame size changes. */
export function paintCanvas(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number): boolean {
  const context = canvas.getContext("2d");
  if (!context || width <= 0 || height <= 0) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(source, 0, 0, width, height);
  return true;
}

/** Decoded frames waiting beyond this mean the decoder is falling behind the feed. */
export const SOFT_DECODE_QUEUE = 8;
const FRAME_DURATION_US = 16_667;

export type DecodeResult = "decoded" | "awaiting-keyframe" | "unconfigured" | "overflow" | "error";

export interface H264DecoderOptions {
  readonly deps: Pick<StreamDeps, "VideoDecoder" | "EncodedVideoChunk">;
  /** A decoded frame; borrowed, closed after the callback returns. */
  readonly onFrame: (frame: VideoFrame) => void;
  /** The decoder failed asynchronously; it has been reset and waits for a keyframe. */
  readonly onError: (error: Error) => void;
}

export class H264Decoder {
  private decoder: VideoDecoder | null = null;
  private awaitingKeyframe = true;
  private timestamp = 0;
  private epoch = 0;
  private codecValue: string | null = null;

  constructor(private readonly options: H264DecoderOptions) {}

  get configured(): boolean {
    return this.decoder?.state === "configured";
  }

  get codec(): string | null {
    return this.codecValue;
  }

  /**
   * Configure for `codec` (Annex-B input without `description`, AVCC with it).
   * Resolves false when the browser cannot decode it or the decoder was reset
   * meanwhile.
   */
  async configure(codec: string, description?: Uint8Array): Promise<boolean> {
    const VideoDecoderCtor = this.options.deps.VideoDecoder;
    if (!VideoDecoderCtor) return false;
    const epoch = ++this.epoch;
    const config: VideoDecoderConfig = {
      codec,
      optimizeForLatency: true,
      ...(description ? { description } : {})
    };
    const support = await VideoDecoderCtor.isConfigSupported(config).catch(() => ({ supported: false }));
    if (epoch !== this.epoch || !support.supported) return false;
    try {
      if (!this.decoder || this.decoder.state === "closed") this.decoder = this.create(VideoDecoderCtor);
      this.decoder.configure(config);
      this.awaitingKeyframe = true;
      this.codecValue = codec;
      return true;
    } catch {
      this.reset();
      return false;
    }
  }

  /** Decode one access unit; deltas before the first keyframe are dropped. */
  decode(isKey: boolean, data: Uint8Array, timestampUs?: number | null): DecodeResult {
    const decoder = this.decoder;
    const Chunk = this.options.deps.EncodedVideoChunk;
    if (!decoder || decoder.state !== "configured" || !Chunk) return "unconfigured";
    if (this.awaitingKeyframe) {
      if (!isKey) return "awaiting-keyframe";
      this.awaitingKeyframe = false;
    }
    if (decoder.decodeQueueSize > SOFT_DECODE_QUEUE) {
      this.reset();
      return "overflow";
    }
    try {
      decoder.decode(new Chunk({ type: isKey ? "key" : "delta", timestamp: timestampUs ?? this.timestamp, data }));
      this.timestamp += FRAME_DURATION_US;
      return "decoded";
    } catch {
      this.reset();
      return "error";
    }
  }

  /** Drop the decoder; the next `configure` builds a new one and waits for a keyframe. */
  reset(): void {
    this.epoch++;
    const decoder = this.decoder;
    this.decoder = null;
    this.awaitingKeyframe = true;
    this.codecValue = null;
    try {
      if (decoder && decoder.state !== "closed") decoder.close();
    } catch {
      // Closing a decoder that already failed throws; it is gone either way.
    }
  }

  close(): void {
    this.reset();
  }

  private create(VideoDecoderCtor: typeof VideoDecoder): VideoDecoder {
    const decoder: VideoDecoder = new VideoDecoderCtor({
      output: (frame) => {
        try {
          if (this.decoder === decoder) this.options.onFrame(frame);
        } finally {
          frame.close();
        }
      },
      error: (error) => {
        if (this.decoder !== decoder) return;
        this.reset();
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return decoder;
  }
}
