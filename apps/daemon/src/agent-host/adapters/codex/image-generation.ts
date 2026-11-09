/**
 * Codex adapter — Codex's own built-in image tool (design
 * `2026-11-10-gpt-image-plugin-design.md` §9.4).
 *
 * The app-server reports a generated image as an `imageGeneration` item whose
 * completion carries the picture whole: `result` (base64), and on newer CLIs
 * `savedPath` (the copy Codex wrote under `$CODEX_HOME/generated_images/`).
 * The bytes never go into the event log: the session stores them as one of
 * the thread's attachments, behind the frame hold (`McpAppFrameHold`, so the
 * row keeps its place ahead of the reply), and writes only the reference —
 * `data.imageRef`, an {@link ImageToolReference} — on the completed row.
 *
 * Replay never stores: the log holds the reference, and a resumed thread's
 * history import (`history.ts`) projects the item without one.
 */

import {
  IMAGE_GENERATION_ITEM_TYPE,
  MAX_TURN_IMAGE_BYTES,
  readImageToolReference,
  type ChatImageMimeType,
  type ImageToolReference
} from "@orquester/api/agent-chat";

import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { AdapterContext } from "../../adapter.ts";
import { withDeadline } from "../../support/deadline.ts";
import type { CodexProtocol } from "./_generated/index.ts";
import type { CodexThreadItem } from "./items.ts";
import type { RuntimeEventDraft } from "./normalise.ts";

export type CodexImageGenerationItem = Extract<CodexThreadItem, { type: "imageGeneration" }>;

/** How long storing one image may hold the session's frames. */
const IMAGE_STORE_TIMEOUT_MS = 30_000;

/** A completed image item's failure details when its picture is missing or was not stored. */
export const NO_IMAGE = "Codex image generation returned no image";
export const IMAGE_NOT_SAVED = "Codex generated an image, but it could not be saved";

/** What a completed image item comes to: the stored image's reference, or why there is none. */
export type CodexImageOutcome = { imageRef: ImageToolReference } | { failure: string };

/** The detail of a failed image item, from the provider's failure (or none). */
export function imageGenerationFailureDetail(failure: CodexProtocol.ImageGenerationFailure | null): string {
  if (failure?.type === "usageLimitExceeded") {
    const resets = resetTime(failure.resetsAt);
    return `Codex image generation failed: usage limit reached${resets !== null ? `; it resets at ${resets}` : ""}`;
  }
  return "Codex image generation failed";
}

/** `resetsAt` as ISO-8601; the protocol's stamps are Unix seconds (milliseconds tolerated). */
function resetTime(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Whether a completed item has an image to store (it may still fail to read). */
export function hasImageSource(item: CodexImageGenerationItem): boolean {
  return item.failure === null && ((typeof item.result === "string" && item.result.length > 0) || typeof item.savedPath === "string");
}

export interface StoreCodexImageInput {
  context: Pick<AdapterContext, "logger"> & Partial<Pick<AdapterContext, "storeAttachment">>;
  threadId: string;
  item: CodexImageGenerationItem;
  /**
   * The host CODEX_HOME the session runs with; `savedPath` is read only from
   * inside it. Absent (unknown, or a box's path), `savedPath` is never read.
   */
  codexHome?: string;
  signal: AbortSignal;
}

/**
 * Store a completed item's image as a thread attachment and answer its
 * reference, or why it could not be. Never throws.
 */
export async function storeCodexImage(input: StoreCodexImageInput): Promise<CodexImageOutcome> {
  const notSaved = { failure: IMAGE_NOT_SAVED };
  const store = input.context.storeAttachment;
  if (store === undefined) return notSaved;
  const where = { threadId: input.threadId, itemId: input.item.id };
  try {
    return await withDeadline(
      async () => {
        const bytes = await imageBytes(input);
        if (bytes === null) return { failure: NO_IMAGE };
        const sniffed = sniffImage(bytes);
        if (sniffed === null) return { failure: "Codex image generation returned something that is not an image" };
        if (input.signal.aborted) return notSaved;
        const attachmentId = await store(input.threadId, {
          name: `codex-image.${MIME_EXTENSIONS[sniffed.mimeType]}`,
          mimeType: sniffed.mimeType,
          bytes: bytes.toString("base64"),
          encoding: "base64"
        });
        const revisedPrompt = input.item.revisedPrompt ?? undefined;
        const imageRef = readImageToolReference({
          images: [
            {
              attachmentId,
              mimeType: sniffed.mimeType,
              ...(sniffed.width !== undefined ? { width: sniffed.width, height: sniffed.height } : {}),
              ...(revisedPrompt !== undefined ? { caption: revisedPrompt } : {})
            }
          ],
          ...(revisedPrompt !== undefined ? { revisedPrompt } : {})
        });
        return imageRef === undefined ? notSaved : { imageRef };
      },
      { label: "codex image store", timeoutMs: IMAGE_STORE_TIMEOUT_MS, signal: input.signal }
    );
  } catch (error) {
    input.context.logger.warn("codex: a generated image could not be stored", {
      ...where,
      error: error instanceof Error ? error.message : String(error)
    });
    return notSaved;
  }
}

/** The image's bytes: `result` decoded, else the `savedPath` file; null when neither holds any. */
async function imageBytes(input: StoreCodexImageInput): Promise<Buffer | null> {
  const { item } = input;
  if (typeof item.result === "string" && item.result.length > 0) {
    // Base64 is 4 characters per 3 bytes: refuse before decoding what the store would refuse anyway.
    if (item.result.length > Math.ceil(MAX_TURN_IMAGE_BYTES / 3) * 4 + 4) {
      throw new Error("the generated image is over the image size limit");
    }
    const bytes = Buffer.from(item.result, "base64");
    if (bytes.length > 0) return bytes;
  }
  if (typeof item.savedPath === "string" && input.codexHome !== undefined) {
    return readSavedImage(item.savedPath, input.codexHome);
  }
  return null;
}

/**
 * The file Codex saved, read only when it is a regular file (never a
 * symlink) inside the session's CODEX_HOME after realpath resolution, and
 * within the image size limit.
 */
async function readSavedImage(savedPath: string, codexHome: string): Promise<Buffer | null> {
  if (!path.isAbsolute(savedPath)) return null;
  const [home, real] = await Promise.all([realpath(codexHome), realpath(savedPath)]);
  if (!real.startsWith(home + path.sep)) return null;
  const stat = await lstat(real);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TURN_IMAGE_BYTES) return null;
  const handle = await open(real, "r");
  try {
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, stat.size, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The completed row of `itemIds` (the item's own id, and a collab child's
 * namespaced one) with the outcome on it: the reference on `data.imageRef`
 * and `completed`, or `failed` with the reason as its `detail`.
 */
export function withImageOutcome(
  itemIds: ReadonlySet<string>,
  outcome: CodexImageOutcome
): (draft: RuntimeEventDraft) => RuntimeEventDraft {
  return (draft) => {
    if (
      draft.type !== "item.completed" ||
      draft.itemId === undefined ||
      !itemIds.has(draft.itemId) ||
      draft.payload.itemType !== IMAGE_GENERATION_ITEM_TYPE
    ) {
      return draft;
    }
    // The classified row (`items.ts`) carries no `data`, and a `detail` only when failed.
    return {
      ...draft,
      payload:
        "imageRef" in outcome
          ? { ...draft.payload, status: "completed", data: { imageRef: outcome.imageRef } }
          : { ...draft.payload, status: "failed", detail: outcome.failure }
    };
  };
}

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

const MIME_EXTENSIONS: Record<ChatImageMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

interface SniffedImage {
  mimeType: ChatImageMimeType;
  width?: number;
  height?: number;
}

/**
 * The image type a file's magic bytes name, with its pixel size when the
 * header gives it; null for anything that is not a PNG, JPEG, WebP or GIF.
 */
function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sized = (mimeType: ChatImageMimeType, width: number, height: number): SniffedImage =>
    width > 0 && height > 0 ? { mimeType, width, height } : { mimeType };
  // PNG: signature, then the IHDR chunk's width and height (big-endian).
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return b.toString("latin1", 12, 16) === "IHDR" ? sized("image/png", b.readUInt32BE(16), b.readUInt32BE(20)) : { mimeType: "image/png" };
  }
  // GIF: `GIF87a` / `GIF89a`, then the logical screen size (little-endian).
  if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6))) {
    return sized("image/gif", b.readUInt16LE(6), b.readUInt16LE(8));
  }
  // WebP: `RIFF....WEBP`, then a VP8 / VP8L / VP8X chunk.
  if (b.length >= 16 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 " && b.length >= 30) {
      return sized("image/webp", b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    }
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X" && b.length >= 30) {
      return sized("image/webp", b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    }
    return { mimeType: "image/webp" };
  }
  // JPEG: SOI, then segments up to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let offset = 2;
    while (offset + 9 <= b.length) {
      if (b[offset] !== 0xff) break;
      const marker = b[offset + 1]!;
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = b.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return sized("image/jpeg", b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5));
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg" };
  }
  return null;
}
