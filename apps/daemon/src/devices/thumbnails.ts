/**
 * Lease thumbnails for the fleet view (phase 2 spec §2.9, §2.11: ≈1 fps JPEGs, ~20 kbit/s per card,
 * never video): the daemon asks the host's hub for a screenshot (serve-emu or serve-sim
 * `POST …/api/screenshot?device=`, with the hub token), shrinks it to the asked width and
 * re-encodes it as JPEG with the in-tree encoder (`screenshot-image.ts`) in the image workers
 * (`image-pool.ts`: off the event loop; a lease's queued frame gives way to its newer one). One
 * capture per lease per {@link THUMBNAIL_CACHE_MS}: concurrent viewers share it.
 */

import { deviceImages, ImagePoolBusyError, type ImageWorkerPool } from "./image-pool.ts";

export { thumbnailJpeg } from "./screenshot-image.ts";

/** A thumbnail is reused for this long. */
export const THUMBNAIL_CACHE_MS = 1_000;
const HUB_TIMEOUT_MS = 10_000;

/** Where a lease's screen is captured. */
export interface ThumbnailSource {
  /** The hub's loopback origin. */
  origin: string;
  token: string | null;
  /** `serve-emu` (Android) or `serve-sim` (iOS). */
  streamKind: "serve-emu" | "serve-sim";
  deviceParam: string;
}

/** The hub answered no usable screenshot. */
export class ThumbnailError extends Error {}

interface Entry {
  at: number;
  width: number;
  done: Promise<Buffer>;
}

export class DeviceThumbnails {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: { now(): number; fetch?: typeof fetch; cacheMs?: number; images?: Pick<ImageWorkerPool, "thumbnail"> }) {}

  /** The lease's thumbnail: the cached one (same width, younger than the cache time), else a new capture. */
  get(leaseId: string, source: ThumbnailSource, width: number): Promise<Buffer> {
    const now = this.deps.now();
    const cached = this.entries.get(leaseId);
    if (cached && cached.width === width && now - cached.at < (this.deps.cacheMs ?? THUMBNAIL_CACHE_MS)) return cached.done;
    const done = this.capture(leaseId, source, width);
    const entry: Entry = { at: now, width, done };
    this.entries.set(leaseId, entry);
    // A failed capture is not reused.
    done.catch(() => {
      if (this.entries.get(leaseId) === entry) this.entries.delete(leaseId);
    });
    return done;
  }

  forget(leaseId: string): void {
    this.entries.delete(leaseId);
  }

  private async capture(leaseId: string, source: ThumbnailSource, width: number): Promise<Buffer> {
    const url = `${source.origin.replace(/\/$/, "")}/vendor/${source.streamKind}/api/screenshot?device=${encodeURIComponent(source.deviceParam)}`;
    const response = await (this.deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(source.token ? { authorization: `Bearer ${source.token}` } : {}) },
      body: "{}",
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS)
    }).catch((error: unknown) => {
      throw new ThumbnailError(`The device hub could not be reached (${error instanceof Error ? error.message : String(error)}).`);
    });
    if (!response.ok) throw new ThumbnailError(`The device hub answered ${response.status} for the screenshot.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    try {
      return await (this.deps.images ?? deviceImages).thumbnail(leaseId, bytes, width);
    } catch (error) {
      if (error instanceof ImagePoolBusyError) throw new ThumbnailError("Too many thumbnails are being made right now; the next one follows shortly.");
      throw new ThumbnailError("The device hub's screenshot is not an image this build can read.");
    }
  }
}
