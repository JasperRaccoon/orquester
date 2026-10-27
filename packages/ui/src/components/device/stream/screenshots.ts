/**
 * Fallback for Android without WebCodecs: poll
 * `…/vendor/serve-emu/api/screenshot?device=<serial>` about once a second and
 * paint each PNG. serve-emu answers 405 to GET, so the default method is POST
 * (it captures and returns the image; nothing on the device changes).
 */

import { paintCanvas } from "./decoder.ts";
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

export const SCREENSHOT_INTERVAL_MS = 1_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

export interface ScreenshotPollOptions extends VideoSessionOptions {
  readonly intervalMs?: number;
  readonly method?: "GET" | "POST";
}

export class ScreenshotPollSession implements DeviceVideoSession {
  readonly transport = "screenshots" as const;
  private readonly deps: StreamDeps;
  private readonly lifecycle: StreamLifecycle;
  private readonly intervalMs: number;

  constructor(private readonly options: ScreenshotPollOptions) {
    this.deps = resolveDeps(options.deps);
    this.intervalMs = options.intervalMs ?? SCREENSHOT_INTERVAL_MS;
    this.lifecycle = new StreamLifecycle({
      transport: this.transport,
      callbacks: options,
      connect: (attempt) => void this.run(attempt),
      now: this.deps.now,
      random: this.deps.random,
      // A capture can take a few seconds on a busy host; only call it stalled well past the interval.
      stallMs: options.stallMs ?? Math.max(this.intervalMs * 3, 3_000),
      reconnectAfterMs: options.reconnectAfterMs ?? SCREENSHOT_TIMEOUT_MS + this.intervalMs
    });
    this.lifecycle.setDecoder("png");
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
  }

  private async run(attempt: StreamAttempt): Promise<void> {
    while (attempt.current()) {
      const started = this.deps.now();
      try {
        const response = await this.deps.fetch(this.options.url, {
          method: this.options.method ?? "POST",
          signal: attempt.signal,
          cache: "no-store"
        });
        if (!attempt.current()) return;
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          this.lifecycle.fail(httpError(response.status));
          return;
        }
        const blob = await response.blob();
        if (!attempt.current()) return;
        this.lifecycle.received(blob.size);
        if (blob.size > 0) {
          const bitmap = await this.deps.createImageBitmap(blob);
          try {
            if (attempt.current() && paintCanvas(this.options.canvas, bitmap, bitmap.width, bitmap.height)) {
              this.lifecycle.frame(bitmap.width, bitmap.height);
            }
          } finally {
            bitmap.close();
          }
        }
      } catch (cause) {
        if (attempt.current()) this.lifecycle.fail(networkError(cause));
        return;
      }
      const wait = Math.max(0, this.intervalMs - (this.deps.now() - started));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        attempt.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
