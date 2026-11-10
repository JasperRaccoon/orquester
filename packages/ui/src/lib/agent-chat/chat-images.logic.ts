/**
 * Agent chat — images in the chat (design 2026-11-10 §9): the pure half of
 * the inline image row's actions. "Save to project…" proposes a project path
 * and never overwrites a file (`-v2`, `-v3`, … as the image service does,
 * §7.3); "Copy image" needs to know what the bytes are.
 *
 * No React import.
 */

import type { ChatImageMimeType } from "@orquester/api/agent-chat";

/** Where "Save to project…" proposes to put an image, relative to the project. */
export const SAVED_IMAGE_DIRECTORY = "assets/generated";

/**
 * How many names "Save to project…" tries (`name.png`, `name-v2.png`, …)
 * before it gives up. Each try uploads the whole image, so it stays small.
 */
export const SAVE_IMAGE_MAX_ATTEMPTS = 20;

const EXTENSIONS: Readonly<Record<ChatImageMimeType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/** The file extension for an image type; PNG when the type is not known. */
export function imageFileExtension(mimeType: string | undefined): string {
  return (mimeType !== undefined && EXTENSIONS[mimeType as ChatImageMimeType]) || "png";
}

/** The image type a file's leading bytes name (PNG, JPEG, WebP or GIF), or null. */
export function sniffImageMimeType(bytes: ArrayBuffer | Uint8Array): ChatImageMimeType | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const at = (offset: number, ...values: number[]) => values.every((value, index) => b[offset + index] === value);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** ASCII words of `text`, hyphen-joined, at most about 40 characters (the image service's slug, §7.2). */
function slug(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let out = "";
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if (next.length > 40) break;
    out = next;
  }
  return out || (words[0]?.slice(0, 40) ?? "");
}

/**
 * The project-relative path "Save to project…" proposes: the generated-images
 * folder, a slug of the image's caption (else the row's title, else
 * "image"), and the extension of its type.
 */
export function defaultSavedImagePath(input: { caption?: string; title?: string; mimeType?: string }): string {
  const name = slug(input.caption ?? "") || slug(input.title ?? "") || "image";
  return `${SAVED_IMAGE_DIRECTORY}/${name}.${imageFileExtension(input.mimeType)}`;
}

/**
 * A project-relative path the user typed, normalised (`./`, doubled and
 * leading or trailing separators dropped), or null when it is no file path
 * inside the project: empty, absolute, home-relative, or reaching out with
 * `..`.
 */
export function normalizeProjectRelativePath(input: string): string | null {
  const text = input.trim().replace(/\\/g, "/");
  if (text.length === 0 || text.startsWith("/") || text.startsWith("~") || /^[a-z]:/i.test(text)) return null;
  if (text.endsWith("/")) return null;
  const segments = text.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    return null;
  }
  return segments.join("/");
}

/**
 * The `version`th name for a file: the path itself first, then `-v2`, `-v3`,
 * … before its extension (`assets/dog.png` → `assets/dog-v2.png`).
 */
export function versionedFilePath(path: string, version: number): string {
  if (version <= 1) return path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension.
  const hasExtension = dot > slash + 1;
  return hasExtension ? `${path.slice(0, dot)}-v${version}${path.slice(dot)}` : `${path}-v${version}`;
}

/**
 * What one exclusive write answers, as the file browser's upload route
 * (`POST /api/fs/upload` with `onConflict: "error"`) does: written at
 * `path`, or refused (`conflict`) because of what was in the way
 * (`conflictKind`) — `"file"` when a file already holds the name, anything
 * else (a folder there, a file where a folder on the way should be, or not
 * said) when no other name would help.
 */
export interface ExclusiveWriteResult {
  conflict?: boolean;
  conflictKind?: string;
  path: string;
}

/** Why no name could be written: one sentence for the user. */
function blockedWriteMessage(path: string, conflictKind: string | undefined): string {
  if (conflictKind === "dir") return `${path} is a folder. Choose another name.`;
  const slash = path.lastIndexOf("/");
  if (conflictKind === "parent" && slash > 0) {
    return `A file is in the way: ${path.slice(0, slash)} is not a folder.`;
  }
  return `${path} could not be saved: something is in the way.`;
}

/**
 * Write a file without ever replacing one: `write` is asked for the path,
 * then `-v2`, `-v3`, … while it answers that a file already holds the name,
 * up to {@link SAVE_IMAGE_MAX_ATTEMPTS} names. Any other refusal stops at
 * once, since no other name gets past it. Answers where it landed; rejects
 * when every name was taken, when something else is in the way, or with
 * `write`'s own failure.
 */
export async function writeWithoutOverwrite(
  path: string,
  write: (path: string) => Promise<ExclusiveWriteResult>,
  maxAttempts: number = SAVE_IMAGE_MAX_ATTEMPTS
): Promise<string> {
  for (let version = 1; version <= maxAttempts; version += 1) {
    const result = await write(versionedFilePath(path, version));
    if (result.conflict !== true) return result.path;
    if (result.conflictKind !== "file") throw new Error(blockedWriteMessage(path, result.conflictKind));
  }
  throw new Error(`${path} and its next ${maxAttempts - 1} versions already exist.`);
}
