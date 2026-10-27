/**
 * A fleet card's thumbnail (devices phase 2 §2.9, §2.11): about one screenshot a second through
 * the hub proxy, never video, and only while the card is on screen and the page is visible.
 *
 * One request at a time: the next starts an interval after the previous one started (later when
 * the capture itself took longer). A failure keeps the last frame and retries with a growing
 * pause. Going off screen or hidden aborts the request in flight and keeps the last frame,
 * `paused`; coming back fetches at once when the interval has passed. Frames are object URLs; the
 * previous one is revoked as the next replaces it, and the last on `dispose`.
 */

/** About 1 fps. */
export const THUMBNAIL_INTERVAL_MS = 1_000;
/** The pauses after 1, 2, 3, … failures in a row (the last repeats). */
export const THUMBNAIL_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

/**
 * - `off` — nothing to show (no URL, or never active yet).
 * - `loading` — the first frame is on its way.
 * - `live` — frames arrive.
 * - `paused` — off screen or hidden; the last frame stays.
 * - `error` — the last request failed; it retries (the last frame, if any, stays).
 */
export type ThumbnailStatus = "off" | "loading" | "live" | "paused" | "error";

export interface ThumbnailSnapshot {
  status: ThumbnailStatus;
  /** The latest frame's object URL, or null. */
  src: string | null;
  /** Why the last request failed (status `error`); null otherwise. */
  error: string | null;
  /** When the latest frame arrived (deps' clock), or null. */
  frameAt: number | null;
}

export interface ThumbnailDeps {
  fetch: (url: string, init: { method: "POST"; cache: "no-store"; headers: Record<string, string>; signal: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "blob">>;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

export function defaultThumbnailDeps(): ThumbnailDeps {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url)
  };
}

/** The pause after `failures` failures in a row. */
export function thumbnailBackoffMs(failures: number): number {
  if (failures <= 0) return THUMBNAIL_INTERVAL_MS;
  return THUMBNAIL_BACKOFF_MS[Math.min(failures, THUMBNAIL_BACKOFF_MS.length) - 1]!;
}

/** A failed request in the card's words. */
export function thumbnailErrorText(status: number | null): string {
  if (status === null) return "Can't reach the host";
  if (status === 401 || status === 403) return "Not allowed to view it";
  if (status === 404) return "The device is gone";
  if (status === 409 || status === 423) return "The device is busy";
  if (status >= 500) return "The host did not answer";
  return `The host answered ${status}`;
}

function sameHeaders(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

export const OFF_SNAPSHOT: ThumbnailSnapshot = Object.freeze({ status: "off", src: null, error: null, frameAt: null });

export class ThumbnailPoller {
  private url: string | null = null;
  /** Sent with every request: the transport's auth headers (never a `?token=` in the URL). */
  private headers: Readonly<Record<string, string>> = {};
  private onScreen = false;
  private pageVisible = true;
  private disposed = false;
  private timer: unknown = null;
  private request: AbortController | null = null;
  private lastStartAt: number | null = null;
  private failures = 0;
  private current: ThumbnailSnapshot = OFF_SNAPSHOT;

  constructor(
    private readonly deps: ThumbnailDeps,
    private readonly onChange: (snapshot: ThumbnailSnapshot) => void
  ) {}

  get snapshot(): ThumbnailSnapshot {
    return this.current;
  }

  /** Whether it polls now: a URL, on screen, page visible. */
  get active(): boolean {
    return !this.disposed && this.url !== null && this.onScreen && this.pageVisible;
  }

  /** A different URL is a different device (and new headers a new credential): its frames start over. */
  setUrl(url: string | null, headers: Readonly<Record<string, string>> = {}): void {
    if (this.disposed || (url === this.url && sameHeaders(headers, this.headers))) return;
    this.stop();
    this.url = url;
    this.headers = { ...headers };
    this.failures = 0;
    this.lastStartAt = null;
    this.revokeSrc(null);
    this.emit(OFF_SNAPSHOT);
    this.sync();
  }

  setOnScreen(onScreen: boolean): void {
    if (this.disposed || onScreen === this.onScreen) return;
    this.onScreen = onScreen;
    this.sync();
  }

  setPageVisible(visible: boolean): void {
    if (this.disposed || visible === this.pageVisible) return;
    this.pageVisible = visible;
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.revokeSrc(null);
    this.current = OFF_SNAPSHOT;
  }

  /** Start or stop to match {@link active}. */
  private sync(): void {
    if (!this.active) {
      if (this.timer !== null || this.request !== null) this.stop();
      if (this.url !== null && (this.current.status === "live" || this.current.status === "loading" || this.current.status === "error")) {
        this.emit({ ...this.current, status: this.current.src ? "paused" : "off", error: null });
      }
      return;
    }
    if (this.timer !== null || this.request !== null) return;
    const wait = this.lastStartAt === null ? 0 : Math.max(0, this.pauseMs() - (this.deps.now() - this.lastStartAt));
    if (wait === 0) void this.fetchFrame();
    else this.schedule(wait);
    if (this.current.status === "paused" || this.current.status === "off") {
      this.emit({ ...this.current, status: this.current.src ? "live" : "loading" });
    }
  }

  private pauseMs(): number {
    return this.failures > 0 ? thumbnailBackoffMs(this.failures) : THUMBNAIL_INTERVAL_MS;
  }

  private schedule(ms: number): void {
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      if (this.active) void this.fetchFrame();
    }, ms);
  }

  private stop(): void {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.request !== null) {
      this.request.abort();
      this.request = null;
    }
  }

  private async fetchFrame(): Promise<void> {
    const url = this.url;
    if (url === null) return;
    const request = new AbortController();
    this.request = request;
    this.lastStartAt = this.deps.now();
    let failedStatus: number | null | undefined;
    try {
      const response = await this.deps.fetch(url, { method: "POST", cache: "no-store", headers: { ...this.headers }, signal: request.signal });
      if (this.request !== request) return;
      if (!response.ok) {
        failedStatus = response.status;
      } else {
        const blob = await response.blob();
        if (this.request !== request) return;
        this.failures = 0;
        if (blob.size > 0) {
          const src = this.deps.createObjectURL(blob);
          this.revokeSrc(src);
          this.emit({ status: "live", src, error: null, frameAt: this.deps.now() });
        } else {
          this.emit({ ...this.current, status: this.current.src ? "live" : "loading", error: null });
        }
      }
    } catch {
      if (this.request !== request) return;
      failedStatus = null;
    }
    this.request = null;
    if (failedStatus !== undefined) {
      this.failures += 1;
      this.emit({ ...this.current, status: "error", error: thumbnailErrorText(failedStatus) });
    }
    if (this.active) this.schedule(Math.max(0, this.pauseMs() - (this.deps.now() - (this.lastStartAt ?? 0))));
  }

  /** Revoke the frame on show unless it is `keep` (the frame replacing it). */
  private revokeSrc(keep: string | null): void {
    const previous = this.current.src;
    if (previous !== null && previous !== keep) this.deps.revokeObjectURL(previous);
  }

  private emit(next: ThumbnailSnapshot): void {
    const previous = this.current;
    if (previous.status === next.status && previous.src === next.src && previous.error === next.error && previous.frameAt === next.frameAt) return;
    this.current = next;
    this.onChange(next);
  }
}
