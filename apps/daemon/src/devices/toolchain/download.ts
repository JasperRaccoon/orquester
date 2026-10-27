/**
 * Pinned downloads: stream a URL to `<dest>.part`, check its SHA-256 against the pinned value,
 * then rename it into place. A file already at `dest` with the right hash is reused (the archive
 * is downloaded once). {@link DownloadFn} is the seam tests replace.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export interface PinnedDownload {
  url: string;
  sha256: string;
  /** Expected size in bytes, for progress when the server sends none. */
  size?: number;
}

export type DownloadFn = (file: PinnedDownload, dest: string, options: { signal: AbortSignal; onProgress?: (received: number, total: number | null) => void }) => Promise<void>;

export async function sha256File(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(path), hash);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export const downloadPinned: DownloadFn = async (file, dest, options) => {
  if ((await sha256File(dest)) === file.sha256) return;
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const response = await fetch(file.url, { signal: options.signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Downloading ${file.url} failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || file.size || null;
  const hash = createHash("sha256");
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (options.onProgress && now - lastReport > 500) {
        lastReport = now;
        options.onProgress(received, total);
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), meter, createWriteStream(part, { mode: 0o600 }), { signal: options.signal });
    const digest = hash.digest("hex");
    if (digest !== file.sha256) throw new Error(`The download of ${file.url} did not match its pinned checksum (got ${digest}).`);
    await rename(part, dest);
    options.onProgress?.(received, total);
  } finally {
    await rm(part, { force: true });
  }
};
