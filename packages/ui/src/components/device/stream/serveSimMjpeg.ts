/**
 * iOS MJPEG: `GET …/vendor/serve-sim/helper/<udid>/stream.mjpeg`, a
 * `multipart/x-mixed-replace` body parsed incrementally and painted with
 * `createImageBitmap`. One JPEG decodes at a time; parts that arrive meanwhile
 * replace each other, so a slow client shows the newest frame, not a backlog.
 *
 * serve-sim takes no per-request quality or size parameters: `--max-dimension`
 * and `--mjpeg-quality` are helper launch flags (the device host sets them).
 */

import { paintCanvas } from "./decoder.ts";
import { httpError, networkError, StreamLifecycle, type StreamAttempt } from "./lifecycle.ts";
import { MjpegParser, multipartBoundary } from "./mjpeg.ts";
import {
  DeviceStreamError,
  resolveDeps,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceVideoSession,
  type StreamDeps,
  type VideoSessionOptions
} from "./types.ts";

export class ServeSimMjpegSession implements DeviceVideoSession {
  readonly transport = "serve-sim-mjpeg" as const;
  private readonly deps: StreamDeps;
  private readonly lifecycle: StreamLifecycle;
  private decoding = false;
  private pending: { jpeg: Uint8Array; attempt: StreamAttempt } | null = null;

  constructor(private readonly options: VideoSessionOptions) {
    this.deps = resolveDeps(options.deps);
    this.lifecycle = new StreamLifecycle({
      transport: this.transport,
      callbacks: options,
      connect: (attempt) => void this.run(attempt),
      now: this.deps.now,
      random: this.deps.random,
      stallMs: options.stallMs,
      reconnectAfterMs: options.reconnectAfterMs
    });
    this.lifecycle.setDecoder("mjpeg");
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
    this.pending = null;
    this.lifecycle.close();
  }

  private async run(attempt: StreamAttempt): Promise<void> {
    try {
      const response = await this.deps.fetch(this.options.url, {
        ...(this.options.headers ? { headers: { ...this.options.headers } } : {}),
        signal: attempt.signal,
        cache: "no-store"
      });
      if (!attempt.current()) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        this.lifecycle.fail(httpError(response.status));
        return;
      }
      const boundary = multipartBoundary(response.headers.get("content-type"));
      if (!boundary) {
        await response.body.cancel().catch(() => {});
        this.lifecycle.fail(new DeviceStreamError("protocol", "The device stream is not a multipart MJPEG stream."));
        return;
      }
      const parser = new MjpegParser(boundary);
      const reader = response.body.getReader();
      attempt.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (!attempt.current()) return;
        if (done) break;
        this.lifecycle.received(value.byteLength);
        const parts = parser.push(value);
        const latest = parts[parts.length - 1];
        if (latest) this.present(latest, attempt);
        if (parser.done) break;
      }
      if (attempt.current()) this.lifecycle.fail(new DeviceStreamError("network", "The device stream ended. Reconnecting…"));
    } catch (cause) {
      if (!attempt.current()) return;
      this.lifecycle.fail(
        cause instanceof Error && /MJPEG part/.test(cause.message)
          ? new DeviceStreamError("protocol", "The device stream sent an oversized frame. Reconnecting…")
          : networkError(cause)
      );
    }
  }

  /** Decode `jpeg` now, or keep it as the next frame if a decode is running. */
  private present(jpeg: Uint8Array, attempt: StreamAttempt): void {
    if (this.decoding) {
      this.pending = { jpeg, attempt };
      return;
    }
    this.decoding = true;
    void this.decode(jpeg, attempt).finally(() => {
      this.decoding = false;
      const next = this.pending;
      this.pending = null;
      if (next && next.attempt.current()) this.present(next.jpeg, next.attempt);
    });
  }

  private async decode(jpeg: Uint8Array, attempt: StreamAttempt): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.deps.createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
    } catch {
      this.lifecycle.warn("Skipped an MJPEG frame that failed to decode.");
      return;
    }
    try {
      if (attempt.current() && paintCanvas(this.options.canvas, bitmap, bitmap.width, bitmap.height)) {
        this.lifecycle.frame(bitmap.width, bitmap.height);
      }
    } finally {
      bitmap.close();
    }
  }
}
