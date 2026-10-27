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
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceVideoSession,
  type VideoSessionOptions
} from "./types.ts";

const SCREENSHOT_INTERVAL_MS = 1_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

export class ScreenshotPollSession implements DeviceVideoSession {
  readonly transport = "screenshots" as const;
  private readonly lifecycle: StreamLifecycle;

  constructor(private readonly options: VideoSessionOptions) {
    this.lifecycle = new StreamLifecycle({
      transport: this.transport,
      callbacks: options,
      connect: (attempt) => void this.run(attempt),
      // A capture can take a few seconds on a busy host; only call it stalled well past the interval.
      stallMs: Math.max(SCREENSHOT_INTERVAL_MS * 3, 3_000),
      reconnectAfterMs: SCREENSHOT_TIMEOUT_MS + SCREENSHOT_INTERVAL_MS
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
      const started = performance.now();
      try {
        const response = await fetch(this.options.url, {
          method: "POST",
          ...(this.options.headers ? { headers: { ...this.options.headers } } : {}),
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
          const bitmap = await createImageBitmap(blob);
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
      const wait = Math.max(0, SCREENSHOT_INTERVAL_MS - (performance.now() - started));
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          attempt.signal.removeEventListener("abort", onAbort);
          resolve();
        }, wait);
        attempt.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
