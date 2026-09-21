/**
 * Attachment ids and paths (spec §5.1, §6.3).
 *
 * Ported from T3 Code (MIT): `apps/server/src/attachmentStore.ts` and
 * `apps/server/src/attachmentPaths.ts`.
 *
 * Bytes live under `<thread>/attachments/`, never in an event and never inline
 * on the wire. An id is `<threadSegment>-<uuid>[-<ext>]` with the thread
 * segment sanitised to `[a-z0-9_-]`, so an id NAMES its owning thread and a
 * traversal-shaped name cannot survive: every lookup re-derives the directory
 * from the thread id and refuses an id whose segment does not match.
 */

import * as NodePath from "node:path";

const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i"
);

/** The reserved segment for an upload made before its thread exists (§5.1). */
export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
/** A `pending`-segment upload is swept after this long (§5.1). */
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A `.part` file left by an interrupted upload is swept after this long. */
export const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

/** Extensions an attachment file may carry on disk. */
const ATTACHMENT_FILENAME_EXTENSIONS = [
  ".gif",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bin"
] as const;

/**
 * Normalise a path fragment that must stay inside the attachments dir.
 * Returns null for anything absolute, escaping or NUL-bearing.
 */
export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

/** Resolve a relative path inside `attachmentsDir`, or null if it escapes. */
export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }
  const attachmentsRoot = NodePath.resolve(input.attachmentsDir);
  const filePath = NodePath.resolve(NodePath.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}

/**
 * The `[a-z0-9_-]` segment an id carries. `pending` is reserved, so a thread
 * that sanitises to it is stored as `_pending` instead.
 */
export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

/**
 * The on-disk extension for a stored file. `.part` is reserved for in-flight
 * uploads — a stored `archive.part` would look stale to the sweep and be
 * deleted.
 */
export function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).toLowerCase();
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

/** Mint an id owned by `threadId`. Null when the thread id sanitises to nothing. */
export function createAttachmentId(
  threadId: string,
  uuid: string,
  extension?: string
): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${uuid}${attachmentIdExtensionSuffix(extension)}`;
}

/** Mint an id for an upload whose thread does not exist yet (§5.1). */
export function createPendingAttachmentId(uuid: string, extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}${attachmentIdExtensionSuffix(extension)}`;
}

function matchAttachmentId(attachmentId: string): RegExpMatchArray | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN);
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  return matchAttachmentId(attachmentId)?.[1]?.toLowerCase() ?? null;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  return matchAttachmentId(attachmentId)?.[2]?.toLowerCase() ?? null;
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  return matchAttachmentId(attachmentId)?.[3]?.toLowerCase() ?? null;
}

/** The id encoded in a stored file name, or null when the name is not one. */
export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}

/**
 * Every candidate file name an id could be stored under, most specific first.
 * The id's own extension suffix names the file when present; older ids without
 * one are probed against the known extensions.
 */
export function attachmentFileNameCandidates(attachmentId: string): string[] {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return [];
  }
  const fileExtension = parseAttachmentFileExtension(normalizedId);
  if (fileExtension) {
    return [`${normalizedId}.${fileExtension}`];
  }
  return ATTACHMENT_FILENAME_EXTENSIONS.map((extension) => `${normalizedId}${extension}`);
}
