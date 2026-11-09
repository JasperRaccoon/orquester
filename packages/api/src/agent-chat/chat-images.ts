/**
 * Agent chat — images shown inline in a chat (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §9).
 *
 * Three producers put an image in front of the user as an inline image row:
 * - the session tool `show_image` (any image file the agent points at, §9.3);
 * - the session tool `generate_image` (GPT Image, §6);
 * - Codex's own built-in image tool, an `image_generation` item (§9.4).
 *
 * Each image is a stored attachment of the thread; the row reads it back
 * through the existing attachment read-back route
 * (`agentChatRoutes.attachment`). The reference travels as the session-tool
 * reference key `imageRef` (kept by the slimming, `session-tools.ts`), or —
 * for a Codex item — as `data.imageRef` on the `image_generation` item.
 */

import { sessionToolNameOfData, sessionToolReferences } from "./session-tools.ts";

/** The session tool that shows image files the agent points at (§9.3). */
export const SHOW_IMAGE_TOOL_NAME = "show_image";
/** The session tool that generates or edits an image with GPT Image (§6). */
export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
/** The session tools whose result carries an {@link ImageToolReference}. */
export const IMAGE_TOOL_NAMES: readonly string[] = [SHOW_IMAGE_TOOL_NAME, GENERATE_IMAGE_TOOL_NAME];

/** The result field (and slim-kept session-tool reference key) the reference travels in. */
export const IMAGE_TOOL_REFERENCE_KEY = "imageRef";

/** At most this many images in one reference (one `show_image` call). */
export const IMAGE_TOOL_MAX_IMAGES = 6;
/** Caption and title bounds, in UTF-16 code units. */
export const IMAGE_CAPTION_MAX_LENGTH = 300;
export const IMAGE_TITLE_MAX_LENGTH = 160;
/** A project path is kept up to this length; a longer one is dropped. */
const IMAGE_PATH_MAX_LENGTH = 1024;

/** The image MIME types an inline image may have. */
export const CHAT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number];

/**
 * A stored attachment id (`<thread segment>-<uuid>[-<ext>]`, the host's
 * `createAttachmentId`): letters, digits, `_` and `-` only — never a path.
 */
const ATTACHMENT_ID = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;
const ATTACHMENT_ID_MAX_LENGTH = 256;

/** Whether a value is shaped like a stored attachment id (the host still resolves it). */
export function isChatImageAttachmentId(value: unknown): value is string {
  return typeof value === "string" && value.length <= ATTACHMENT_ID_MAX_LENGTH && ATTACHMENT_ID.test(value);
}

/** One image of an inline image row. */
export interface ChatImageReference {
  /** The thread attachment holding the image's bytes. */
  attachmentId: string;
  mimeType?: ChatImageMimeType;
  /** Pixel size, when the producer knows it. */
  width?: number;
  height?: number;
  /** A one-line caption: `show_image`'s caption, or the prompt a generated image was made from. */
  caption?: string;
  /**
   * The project file the image was also written to (`generate_image` with a
   * project save), as a host path inside the workspaces sandbox. Absent when
   * the image lives only with the chat.
   */
  path?: string;
}

/** The reference an image-producing call carries: one inline image row. */
export interface ImageToolReference {
  /** One line above the images (`show_image`'s `title`). */
  title?: string;
  images: ChatImageReference[];
  /** `generate_image`: the prompt the model actually used, when it came back. */
  revisedPrompt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : undefined;
}

/** A validated image, or undefined when `value` is not one. */
export function readChatImageReference(value: unknown): ChatImageReference | undefined {
  const record = asRecord(value);
  if (record === undefined || !isChatImageAttachmentId(record.attachmentId)) return undefined;
  const out: ChatImageReference = { attachmentId: record.attachmentId };
  if (typeof record.mimeType === "string" && (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(record.mimeType)) {
    out.mimeType = record.mimeType as ChatImageMimeType;
  }
  const width = dimension(record.width);
  const height = dimension(record.height);
  if (width !== undefined && height !== undefined) {
    out.width = width;
    out.height = height;
  }
  const caption = oneLine(record.caption, IMAGE_CAPTION_MAX_LENGTH);
  if (caption !== undefined) out.caption = caption;
  if (typeof record.path === "string" && record.path.length > 0 && record.path.length <= IMAGE_PATH_MAX_LENGTH && !/[\u0000-\u001f]/.test(record.path)) {
    out.path = record.path;
  }
  return out;
}

/**
 * A validated reference, or undefined when `value` is not one. Invalid images
 * are skipped; a reference with no valid image is none. At most
 * {@link IMAGE_TOOL_MAX_IMAGES} images are kept.
 */
export function readImageToolReference(value: unknown): ImageToolReference | undefined {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record.images)) return undefined;
  const images = record.images.flatMap((entry) => {
    const image = readChatImageReference(entry);
    return image === undefined ? [] : [image];
  }).slice(0, IMAGE_TOOL_MAX_IMAGES);
  if (images.length === 0) return undefined;
  const out: ImageToolReference = { images };
  const title = oneLine(record.title, IMAGE_TITLE_MAX_LENGTH);
  if (title !== undefined) out.title = title;
  const revisedPrompt = oneLine(record.revisedPrompt, IMAGE_CAPTION_MAX_LENGTH * 4);
  if (revisedPrompt !== undefined) out.revisedPrompt = revisedPrompt;
  return out;
}

/** Whether two references show the same images the same way. */
export function imageToolReferencesEqual(left: ImageToolReference, right: ImageToolReference): boolean {
  return (
    left.title === right.title &&
    left.revisedPrompt === right.revisedPrompt &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => {
      const other = right.images[index]!;
      return (
        image.attachmentId === other.attachmentId &&
        image.mimeType === other.mimeType &&
        image.width === other.width &&
        image.height === other.height &&
        image.caption === other.caption &&
        image.path === other.path
      );
    })
  );
}

/** The canonical item type Codex's own built-in image tool becomes (`runtime-events.ts`). */
export const IMAGE_GENERATION_ITEM_TYPE = "image_generation";

/**
 * The image reference on an activity row, or undefined:
 * - a session-tool `show_image` / `generate_image` call (the ingestion's
 *   `data.sessionTool` provenance marker, so a user's same-named server never
 *   renders), read through the session tools' one reader — slimmed or not, in
 *   every provider's result layout;
 * - a Codex `image_generation` item, whose adapter put the reference on
 *   `data.imageRef`.
 *
 * The status is the caller's to judge: a failed call carries no reference.
 */
export function imageToolReferenceOfActivityPayload(payload: unknown): ImageToolReference | undefined {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (record === undefined || data === undefined) return undefined;
  const tool = sessionToolNameOfData(data);
  if (tool !== null) {
    if (!IMAGE_TOOL_NAMES.includes(tool)) return undefined;
    return readImageToolReference(sessionToolReferences(data, [IMAGE_TOOL_REFERENCE_KEY])?.[IMAGE_TOOL_REFERENCE_KEY]);
  }
  if (record.itemType === IMAGE_GENERATION_ITEM_TYPE) {
    return readImageToolReference(data[IMAGE_TOOL_REFERENCE_KEY]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Image sources an agent names (tool arguments and Markdown, §6.1 / §9.2)
// ---------------------------------------------------------------------------

/** The newest image of a chat is `recent:1`; this many back is the limit. */
export const CHAT_IMAGE_RECENT_MAX = 50;

/**
 * A chat image an agent names without a path:
 * - `recent:N` — the Nth most recent image in this chat, pasted by the user or
 *   shown/generated in it (`recent:1` is the latest). Tool arguments only: the
 *   daemon resolves it against the calling thread.
 * - `attachment:<id>` — one stored attachment of this chat (an `attachmentId`
 *   a tool result returned). Tool arguments and Markdown image sources.
 */
export type ChatImageSource =
  | { kind: "recent"; n: number }
  | { kind: "attachment"; attachmentId: string };

/** The parsed source, or null when `value` is not a chat image source (e.g. a path). */
export function parseChatImageSource(value: unknown): ChatImageSource | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const recent = /^recent:([1-9][0-9]{0,2})$/.exec(text);
  if (recent) {
    const n = Number(recent[1]);
    return n <= CHAT_IMAGE_RECENT_MAX ? { kind: "recent", n } : null;
  }
  const attachment = /^attachment:(.+)$/.exec(text);
  if (attachment && isChatImageAttachmentId(attachment[1])) {
    return { kind: "attachment", attachmentId: attachment[1] };
  }
  return null;
}

/** The Markdown an agent writes to show a stored chat image again (`![alt](attachment:<id>)`). */
export function chatImageMarkdown(attachmentId: string, alt: string): string {
  const label = (oneLine(alt, 120) ?? "image").replace(/[[\]\\]/g, "");
  return `![${label}](attachment:${attachmentId})`;
}
