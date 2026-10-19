/**
 * The decisions of the client-side icon shrink (spec 2026-10-18 §3a), as pure
 * functions over measured sizes — `shrink.ts` is the thin canvas wrapper that
 * measures and encodes.
 */

import { REPO_ICON_MAX_BYTES, isRepoIconUploadType, type RepoIconUploadType } from "@orquester/api";

/** Longest side of a re-encoded icon — plenty for a 24px icon on any screen. */
export const SHRINK_MAX_SIDE = 512;
/** Below this longest side the shrink gives up. */
export const SHRINK_MIN_SIDE = 64;
export const SHRINK_START_QUALITY = 0.9;
export const SHRINK_MIN_QUALITY = 0.6;
export const SHRINK_QUALITY_STEP = 0.1;

export const IMAGE_TOO_LARGE = "That image is too large to use";
export const IMAGE_UNREADABLE = "That image couldn't be read";

/** A file the daemon takes as it is: an upload type within the cap. */
export function canSendUnchanged(type: string, bytes: number): type is RepoIconUploadType {
  return isRepoIconUploadType(type) && bytes <= REPO_ICON_MAX_BYTES;
}

/** The first canvas size: the longest side at most {@link SHRINK_MAX_SIDE}, never upscaled. */
export function initialShrinkSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > SHRINK_MAX_SIDE ? SHRINK_MAX_SIDE / longest : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export type ShrinkFormat = "image/webp" | "image/png";

/** What the browser produced for a requested WebP: WebP, or PNG (older Safari) — `null` for anything else. */
export function encodedFormat(blobType: string): ShrinkFormat | null {
  return blobType === "image/webp" || blobType === "image/png" ? blobType : null;
}

export interface ShrinkAttempt {
  width: number;
  height: number;
  format: ShrinkFormat;
  /** WebP only; PNG ignores it. */
  quality: number;
}

export type ShrinkStep =
  | { kind: "done" }
  | { kind: "encode"; attempt: ShrinkAttempt }
  | { kind: "give-up"; reason: typeof IMAGE_TOO_LARGE };

/**
 * After encoding `attempt` into `bytes`: done when it fits the cap; else lower
 * the WebP quality a step (down to {@link SHRINK_MIN_QUALITY}); else halve the
 * dimensions; give up once the longest side would drop below {@link SHRINK_MIN_SIDE}.
 */
export function nextShrinkStep(attempt: ShrinkAttempt, bytes: number): ShrinkStep {
  if (bytes <= REPO_ICON_MAX_BYTES) return { kind: "done" };
  if (attempt.format === "image/webp" && attempt.quality > SHRINK_MIN_QUALITY + 1e-9) {
    const quality = Math.max(SHRINK_MIN_QUALITY, Math.round((attempt.quality - SHRINK_QUALITY_STEP) * 100) / 100);
    return { kind: "encode", attempt: { ...attempt, quality } };
  }
  const width = Math.floor(attempt.width / 2);
  const height = Math.floor(attempt.height / 2);
  if (Math.max(width, height) < SHRINK_MIN_SIDE || Math.min(width, height) < 1) {
    return { kind: "give-up", reason: IMAGE_TOO_LARGE };
  }
  return { kind: "encode", attempt: { ...attempt, width, height } };
}

/** "6.3 MB", "84 KB", "512 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
