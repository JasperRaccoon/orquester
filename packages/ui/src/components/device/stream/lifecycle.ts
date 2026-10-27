/**
 * The state machine every video session shares: one connection attempt at a
 * time, `live` on painted frames, `stalled` after silence (the canvas keeps its
 * last frame), a reconnect after long silence or a failure with jittered
 * backoff (the shared daemon reconnect policy, woken early when the page comes
 * back), fatal errors that stop retrying, and rolling stats.
 */

import {
  backoffDelayMs,
  RECONNECT_BACKOFF,
  scheduleRetry,
  type BackoffPolicy,
  type PendingRetry
} from "../../../lib/connection/backoff.ts";
import {
  DeviceStreamError,
  type DeviceStreamCallbacks,
  type DeviceStreamState,
  type DeviceStreamStats,
  type DeviceTransport
} from "./types.ts";

export const DEFAULT_STALL_MS = 2_000;
export const DEFAULT_RECONNECT_AFTER_MS = 15_000;
/** Consecutive attempts without a frame before the state reads `error` (retries continue). */
export const ERROR_AFTER_FAILURES = 3;
const RATE_WINDOW_MS = 2_000;

/** Frames and bytes over a sliding window. */
export class RateMeter {
  private readonly samples: Array<{ at: number; frames: number; bytes: number }> = [];

  constructor(
    private readonly now: () => number,
    private readonly windowMs = RATE_WINDOW_MS
  ) {}

  add(frames: number, bytes: number): void {
    this.samples.push({ at: this.now(), frames, bytes });
    this.prune();
  }

  rates(): { fps: number; kbps: number } {
    this.prune();
    let frames = 0;
    let bytes = 0;
    for (const sample of this.samples) {
      frames += sample.frames;
      bytes += sample.bytes;
    }
    const seconds = this.windowMs / 1000;
    return { fps: Math.round((frames / seconds) * 10) / 10, kbps: Math.round((bytes * 8) / 1000 / seconds) };
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at <= cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }
}

/** One connection attempt. Its signal aborts when it is superseded or the session closes. */
export interface StreamAttempt {
  readonly id: number;
  readonly signal: AbortSignal;
  /** Still the session's attempt and the session is open. */
  current(): boolean;
}

export interface StreamLifecycleOptions {
  readonly transport: DeviceTransport;
  readonly callbacks: DeviceStreamCallbacks;
  readonly connect: (attempt: StreamAttempt) => void;
  readonly now: () => number;
  readonly random: () => number;
  /** `null` disables stall detection (input-only sockets, slow screenshot polls use their own). */
  readonly stallMs?: number | null;
  readonly reconnectAfterMs?: number;
  readonly backoff?: BackoffPolicy;
  /** The stream went quiet: a chance to ask for a keyframe. */
  readonly onStall?: () => void;
  /**
   * Long silence ends the attempt with this error; `hadFrame` says whether
   * this session ever painted. Default: a retryable `no-video`.
   */
  readonly silenceError?: (hadFrame: boolean) => DeviceStreamError;
}

export class StreamLifecycle {
  private stateValue: DeviceStreamState = "connecting";
  private errorValue: DeviceStreamError | null = null;
  private attemptId = 0;
  private controller: AbortController | null = null;
  private retry: PendingRetry | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private backoffAttempt = 0;
  private failures = 0;
  private started = false;
  private everPainted = false;
  private readonly meter: RateMeter;
  private framesPainted = 0;
  private bytesReceived = 0;
  private reconnects = 0;
  private width = 0;
  private height = 0;
  private decoder: string | null = null;
  private readonly stallMs: number | null;
  private readonly reconnectAfterMs: number;

  constructor(private readonly options: StreamLifecycleOptions) {
    this.meter = new RateMeter(options.now);
    this.stallMs = options.stallMs === undefined ? DEFAULT_STALL_MS : options.stallMs;
    this.reconnectAfterMs = options.reconnectAfterMs ?? DEFAULT_RECONNECT_AFTER_MS;
  }

  get state(): DeviceStreamState {
    return this.stateValue;
  }

  get error(): DeviceStreamError | null {
    return this.errorValue;
  }

  get closed(): boolean {
    return this.stateValue === "closed";
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.connectNext();
  }

  /** A frame was painted; `width`×`height` is its size. */
  frame(width: number, height: number): void {
    if (this.closed) return;
    this.framesPainted++;
    this.meter.add(1, 0);
    this.failures = 0;
    this.backoffAttempt = 0;
    this.everPainted = true;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.options.callbacks.onVideoSize?.(width, height);
    }
    if (this.stateValue !== "live") this.setState("live", null);
    this.armWatchdog(true);
    this.options.callbacks.onFrame?.();
  }

  /** Payload bytes arrived (counted for kbps whether or not they paint). */
  received(bytes: number): void {
    if (this.closed) return;
    this.bytesReceived += bytes;
    this.meter.add(0, bytes);
  }

  /** Mark the attempt usable without frames (input-only sockets). */
  ready(): void {
    if (this.closed) return;
    this.clearWatchdog();
    this.failures = 0;
    this.backoffAttempt = 0;
    if (this.stateValue !== "live") this.setState("live", null);
  }

  setDecoder(name: string | null): void {
    this.decoder = name;
  }

  warn(message: string): void {
    if (!this.closed) this.options.callbacks.onWarning?.(message);
  }

  /** End the current attempt: fatal errors stop the session, others reconnect with backoff. */
  fail(error: DeviceStreamError): void {
    // After a fatal error nothing is pending; a late failure from the old attempt is ignored.
    if (this.closed || (this.stateValue === "error" && this.retry === null && this.controller === null)) return;
    this.endAttempt();
    if (error.fatal) {
      this.setState("error", error);
      return;
    }
    this.failures++;
    this.setState(this.failures >= ERROR_AFTER_FAILURES ? "error" : "connecting", error);
    const delay = backoffDelayMs(this.backoffAttempt++, this.options.backoff ?? RECONNECT_BACKOFF, this.options.random);
    this.retry = scheduleRetry(delay, (woken) => {
      this.retry = null;
      if (woken) this.backoffAttempt = 0;
      this.connectNext();
    });
  }

  close(): void {
    if (this.closed) return;
    this.endAttempt();
    this.setState("closed", null);
  }

  stats(): DeviceStreamStats {
    const { fps, kbps } = this.meter.rates();
    return {
      transport: this.options.transport,
      fps,
      kbps,
      decoder: this.decoder,
      framesPainted: this.framesPainted,
      bytesReceived: this.bytesReceived,
      reconnects: this.reconnects,
      width: this.width,
      height: this.height
    };
  }

  private connectNext(): void {
    if (this.closed) return;
    if (this.attemptId > 0) this.reconnects++;
    const id = ++this.attemptId;
    const controller = new AbortController();
    this.controller = controller;
    if (this.stateValue !== "connecting" && this.stateValue !== "error") this.setState("connecting", this.errorValue);
    this.armWatchdog(false);
    const attempt: StreamAttempt = {
      id,
      signal: controller.signal,
      current: () => !this.closed && this.attemptId === id && this.controller === controller
    };
    this.options.connect(attempt);
  }

  private endAttempt(): void {
    this.retry?.cancel();
    this.retry = null;
    this.clearWatchdog();
    const controller = this.controller;
    this.controller = null;
    this.attemptId++;
    controller?.abort();
  }

  private armWatchdog(afterFrame: boolean): void {
    this.clearWatchdog();
    const silence = () => {
      this.watchdog = null;
      const error = this.options.silenceError?.(this.everPainted) ??
        new DeviceStreamError("no-video", "The device stopped sending video. Reconnecting…");
      this.fail(error);
    };
    if (afterFrame && this.stallMs !== null && this.stallMs < this.reconnectAfterMs) {
      this.watchdog = setTimeout(() => {
        this.watchdog = setTimeout(silence, this.reconnectAfterMs - this.stallMs!);
        if (this.stateValue === "live") this.setState("stalled", null);
        this.options.onStall?.();
      }, this.stallMs);
      return;
    }
    if (this.stallMs === null && afterFrame) return;
    this.watchdog = setTimeout(silence, this.reconnectAfterMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private setState(state: DeviceStreamState, error: DeviceStreamError | null): void {
    if (this.stateValue === state && this.errorValue === error) return;
    this.stateValue = state;
    this.errorValue = error;
    this.options.callbacks.onState?.(state, error);
  }
}

/** Map an HTTP status to a stream error: 401/403 are fatal, the rest retry. */
export function httpError(status: number): DeviceStreamError {
  if (status === 401 || status === 403) {
    return new DeviceStreamError("unauthorized", "The device stream refused this session's credentials.", true);
  }
  return new DeviceStreamError("http", `The device stream answered HTTP ${status}.`);
}

export function networkError(cause: unknown): DeviceStreamError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new DeviceStreamError("network", `Device stream connection failed: ${message}`);
}
