// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.ts
/**
 * iOS H.264: `GET …/vendor/serve-sim/helper/<udid>/stream.avcc`, a fetch body
 * of avcc envelopes decoded with WebCodecs. The JPEG seed paints until the
 * first decoded frame. Each new subscription makes serve-sim send its
 * description and a fresh IDR, so decoder trouble reconnects the fetch.
 *
 * Blacksmith macOS VMs have no working H.264 encoder: only the seed arrives.
 * A session that never decodes a frame ends with a fatal `no-video` error so
 * the caller can switch to MJPEG.
 */

import { AvccDemuxer } from "./avcc.ts";
import { simulatorAvcConfig } from "./avcConfig.ts";
import { H264Decoder, paintCanvas } from "./decoder.ts";
import { codecFromAvcC } from "./h264.ts";
import { httpError, networkError, StreamLifecycle, type StreamAttempt } from "./lifecycle.ts";
import {
  DeviceStreamError,
  resolveDeps,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceVideoSession,
  type StreamDeps,
  type VideoSessionOptions
} from "./types.ts";

/**
 * Silence before a reconnect; also how long a session waits for its first
 * decoded frame before deciding the host has no H.264 encoder.
 */
export const H264_FIRST_FRAME_MS = 8_000;

export class ServeSimH264Session implements DeviceVideoSession {
  readonly transport = "serve-sim-h264" as const;
  private readonly deps: StreamDeps;
  private readonly lifecycle: StreamLifecycle;
  private readonly decoder: H264Decoder;
  private decodedFrame = false;

  constructor(private readonly options: VideoSessionOptions) {
    this.deps = resolveDeps(options.deps);
    this.decoder = new H264Decoder({
      deps: this.deps,
      onFrame: (frame) => {
        if (paintCanvas(options.canvas, frame, frame.displayWidth, frame.displayHeight)) {
          this.decodedFrame = true;
          this.lifecycle.frame(frame.displayWidth, frame.displayHeight);
        }
      },
      onError: (error) => {
        this.lifecycle.warn(`H.264 decoder error: ${error.message}`);
        this.lifecycle.fail(new DeviceStreamError("decode", "The video decoder failed. Reconnecting…"));
      }
    });
    this.lifecycle = new StreamLifecycle({
      transport: this.transport,
      callbacks: options,
      connect: (attempt) => void this.run(attempt),
      now: this.deps.now,
      random: this.deps.random,
      stallMs: options.stallMs,
      reconnectAfterMs: options.reconnectAfterMs ?? H264_FIRST_FRAME_MS,
      silenceError: (hadFrame) =>
        this.decodedFrame
          ? new DeviceStreamError("no-video", "The device stopped sending video. Reconnecting…")
          : new DeviceStreamError(
              "no-video",
              hadFrame
                ? "The device host sent no H.264 video (only a still image)."
                : "The device host sent no H.264 video.",
              true
            )
    });
    this.lifecycle.start();
  }

  get state(): DeviceStreamState {
    return this.lifecycle.state;
  }

  get error(): DeviceStreamError | null {
    return this.lifecycle.error;
  }

  stats(): DeviceStreamStats {
    return this.lifecycle.stats();
  }

  close(): void {
    this.lifecycle.close();
    this.decoder.close();
  }

  private async run(attempt: StreamAttempt): Promise<void> {
    this.decoder.reset();
    const demuxer = new AvccDemuxer();
    let seedPending = false;
    try {
      const response = await this.deps.fetch(this.options.url, { signal: attempt.signal, cache: "no-store" });
      if (!attempt.current()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        this.lifecycle.fail(httpError(response.status));
        return;
      }
      const reader = response.body.getReader();
      attempt.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (!attempt.current()) return;
        if (done) break;
        this.lifecycle.received(value.byteLength);
        for (const chunk of demuxer.push(value)) {
          if (!attempt.current()) return;
          switch (chunk.type) {
            case "seed":
              // A seed only bridges the wait for video; never paint it over decoded frames.
              if (this.decodedFrame || seedPending) break;
              seedPending = true;
              void this.paintSeed(chunk.payload, attempt).finally(() => {
                seedPending = false;
              });
              break;
            case "description": {
              const codec = codecFromAvcC(chunk.payload);
              if (!codec) {
                this.lifecycle.warn("Ignored a malformed avcC description.");
                break;
              }
              const configured = await this.decoder.configure(codec, simulatorAvcConfig(chunk.payload));
              if (!attempt.current()) return;
              if (!configured) {
                this.lifecycle.setDecoder(null);
                this.lifecycle.fail(
                  new DeviceStreamError("unsupported", `This browser can't decode the device's ${codec} video.`, true)
                );
                return;
              }
              this.lifecycle.setDecoder(codec);
              break;
            }
            case "keyframe":
            case "delta": {
              const result = this.decoder.decode(chunk.type === "keyframe", chunk.payload);
              if (result === "overflow" || result === "error") {
                this.lifecycle.fail(
                  new DeviceStreamError(
                    "decode",
                    result === "overflow" ? "The video decoder fell behind. Reconnecting…" : "A video frame failed to decode. Reconnecting…"
                  )
                );
                return;
              }
              break;
            }
          }
        }
      }
      if (attempt.current()) this.lifecycle.fail(new DeviceStreamError("network", "The device stream ended. Reconnecting…"));
    } catch (cause) {
      if (!attempt.current()) return;
      this.lifecycle.fail(
        cause instanceof Error && /avcc envelope/.test(cause.message)
          ? new DeviceStreamError("protocol", "The device stream sent malformed video. Reconnecting…")
          : networkError(cause)
      );
    }
  }

  private async paintSeed(jpeg: Uint8Array, attempt: StreamAttempt): Promise<void> {
    try {
      const bitmap = await this.deps.createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
      try {
        if (attempt.current() && !this.decodedFrame && paintCanvas(this.options.canvas, bitmap, bitmap.width, bitmap.height)) {
          this.lifecycle.frame(bitmap.width, bitmap.height);
        }
      } finally {
        bitmap.close();
      }
    } catch {
      // A broken seed is harmless; video follows.
    }
  }
}
