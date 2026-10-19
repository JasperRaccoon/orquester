/**
 * Prepare a chosen image for `uploadRepoIcon` (spec 2026-10-18 §3a): sent as
 * it is when the daemon takes it (PNG/JPEG/WebP/SVG within the cap), else
 * decoded, drawn onto a canvas at most 512px on its longest side and
 * re-encoded as WebP (PNG where the browser can't), stepping quality and then
 * size down until it fits. The step decisions live in `shrink.logic.ts`; this
 * is only the browser plumbing. The daemon's cap and type check stay
 * authoritative. Animated images keep their first frame.
 */

import type { RepoIconUploadType } from "@orquester/api";

import {
  IMAGE_UNREADABLE,
  SHRINK_START_QUALITY,
  canSendUnchanged,
  encodedFormat,
  initialShrinkSize,
  nextShrinkStep,
  type ShrinkAttempt
} from "./shrink.logic";

export interface PreparedRepoIcon {
  blob: Blob;
  contentType: RepoIconUploadType;
  originalBytes: number;
  /** Re-encoded (too large, or a type the daemon doesn't take). */
  shrunk: boolean;
}

/** A failure whose message is fit to show the user. */
export class RepoIconPrepareError extends Error {
  override name = "RepoIconPrepareError";
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

/** Through an `<img>` on an object URL: SVG, and anything `createImageBitmap` rejects. */
async function decodeWithImage(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("decode"));
      image.src = url;
    });
    // An SVG without intrinsic size reports 0: draw it at the full icon size.
    const width = image.naturalWidth || 512;
    const height = image.naturalHeight || 512;
    return { source: image, width, height, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function decode(file: Blob): Promise<Decoded> {
  if (file.type !== "image/svg+xml" && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to <img>, which decodes more (and SVG).
    }
  }
  return decodeWithImage(file);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(decoded: Decoded, attempt: ShrinkAttempt): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = attempt.width;
  canvas.height = attempt.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new RepoIconPrepareError(IMAGE_UNREADABLE);
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded.source, 0, 0, attempt.width, attempt.height);
  const blob = await toBlob(canvas, attempt.format, attempt.quality);
  if (blob === null) throw new RepoIconPrepareError(IMAGE_UNREADABLE);
  return blob;
}

export async function prepareRepoIconUpload(file: Blob): Promise<PreparedRepoIcon> {
  const originalBytes = file.size;
  if (canSendUnchanged(file.type, originalBytes)) {
    return { blob: file, contentType: file.type, originalBytes, shrunk: false };
  }
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new RepoIconPrepareError(IMAGE_UNREADABLE);
  }
  try {
    let attempt: ShrinkAttempt = {
      ...initialShrinkSize(decoded.width, decoded.height),
      format: "image/webp",
      quality: SHRINK_START_QUALITY
    };
    let blob = await encode(decoded, attempt);
    const produced = encodedFormat(blob.type);
    if (produced !== "image/webp") {
      // No WebP encoder (older Safari): PNG instead.
      attempt = { ...attempt, format: "image/png" };
      if (produced !== "image/png") blob = await encode(decoded, attempt);
    }
    for (;;) {
      const step = nextShrinkStep(attempt, blob.size);
      if (step.kind === "done") break;
      if (step.kind === "give-up") throw new RepoIconPrepareError(step.reason);
      attempt = step.attempt;
      blob = await encode(decoded, attempt);
    }
    const contentType = encodedFormat(blob.type);
    if (contentType === null) throw new RepoIconPrepareError(IMAGE_UNREADABLE);
    return { blob, contentType, originalBytes, shrunk: true };
  } catch (error) {
    if (error instanceof RepoIconPrepareError) throw error;
    // A tainted canvas (an SVG pulling in outside content), an encoder failure.
    throw new RepoIconPrepareError(IMAGE_UNREADABLE);
  } finally {
    decoded.close();
  }
}
