/**
 * Images in chats (design `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §6.1, §9.3): the one
 * resolver every image-taking tool uses (`show_image`, `generate_image`), and the store that puts an image in the
 * calling chat.
 *
 * An input names an image by `path` or by `ref`, and is read only from:
 * - the workspaces sandbox (`api.fsRoot`), a path taken as `read_file` takes it (`callerHostPath`, relative = under
 *   the root);
 * - the CALLING thread's own attachments directory (resolved from `caller.threadId`, never from an argument);
 * - the host's temp directories (the daemon's `TMPDIR`, and the one its agents get) — where screenshots land;
 * - in a box chat, the chat's own project box: every path is the box's, read there (`DaemonApi.boxReadChatFile`);
 * - `ref`: `recent:N` (the Nth newest image of the calling thread: user messages' image attachments and earlier
 *   image rows, newest first) or `attachment:<id>` (one stored attachment of the calling thread).
 *
 * Every path is checked after realpath; the file must be a regular file, a PNG, JPEG, WebP or GIF by its magic bytes
 * (never its extension), and at most `MAX_TURN_IMAGE_BYTES`. Bytes are read and copied, never linked. Another thread's
 * attachments are refused wherever they sit, a temp directory included.
 *
 * Reachable from the catalog, which the agent host loads statically: it reaches the daemon only through `DaemonApi`.
 */

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";

import {
  agentChatRoutes,
  imageToolReferenceOfActivityPayload,
  MAX_TURN_IMAGE_BYTES,
  parseChatImageSource,
  sniffChatImage,
  THREAD_HISTORY_MAX_TURNS,
  type ChatImageMimeType,
  type ThreadItem
} from "@orquester/api/agent-chat";

import { callerHostPath } from "./addressing.ts";
import type { ThreadCaller, ToolCaller } from "./catalog/contract.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { daemonError, ToolError } from "./errors.ts";
import { readThread } from "./reads.ts";

/** One image a caller names: exactly one of the two. */
export interface ChatImageInput {
  path?: string;
  ref?: string;
}

export interface ResolvedChatImage {
  bytes: Buffer;
  mimeType: ChatImageMimeType;
  /** A file name with the extension of its real type (`shot.png`, `image.jpg`). */
  name: string;
  width?: number;
  height?: number;
  /** Already a stored attachment of the calling thread (a `ref`): showing it again needs no copy. */
  attachmentId?: string;
  /** The host path inside the workspaces sandbox it was read from (a project file); absent elsewhere. */
  path?: string;
}

/** How many pages of older history `recent:N` reads past the retained window before giving up. */
const RECENT_HISTORY_PAGES = 5;
const CAP_MIB = MAX_TURN_IMAGE_BYTES / (1024 * 1024);
const EXTENSION: Readonly<Record<ChatImageMimeType, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const NOT_ALLOWED = (): ToolError =>
  new ToolError("PATH_NOT_ALLOWED", "path is not allowed: only the workspaces, this chat's attachments and the temp folders.");
const NOT_FOUND = (): ToolError => new ToolError("INVALID_ARGUMENT", "file not found.");
const NOT_AN_IMAGE = (): ToolError => new ToolError("INVALID_ARGUMENT", "not a PNG, JPEG, WebP or GIF image.");
const TOO_LARGE = (size?: number): ToolError =>
  new ToolError("INVALID_ARGUMENT", `${size === undefined ? "the image is too large" : `the image is ${size} bytes`}; images are capped at ${CAP_MIB} MiB.`);

function chatThread(caller: ToolCaller): ThreadCaller {
  if (caller.kind !== "thread") throw new ToolError("PERMISSION_DENIED", "Chat images belong to an agent chat.");
  return caller;
}

const errnoOf = (error: unknown): unknown => (typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined);

/** `child` is `parent` or inside it (both absolute and normalized). */
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The image type by its magic bytes and its pixel size (`sniffChatImage`, shared with the Codex adapter's
 * `image_generation` items).
 */
export const sniffImage = sniffChatImage;

/** `bytes` as an image named after `name` with its real type's extension, or the refusal. */
function asImage(bytes: Buffer, name: string, extra: Pick<ResolvedChatImage, "attachmentId" | "path"> = {}): ResolvedChatImage {
  const sniffed = sniffImage(bytes);
  if (sniffed === null) throw NOT_AN_IMAGE();
  const stem = basename(name, extname(name)).replace(/[\u0000-\u001f\u007f/\\]+/g, " ").trim().slice(0, 100) || "image";
  return { bytes, name: `${stem}.${EXTENSION[sniffed.mimeType]}`, ...sniffed, ...extra };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A realpath'd regular file read whole: never a FIFO or device, never past the cap, never through a final symlink. */
async function readImageFile(real: string, name: string, extra: Pick<ResolvedChatImage, "attachmentId" | "path"> = {}): Promise<ResolvedChatImage> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch((error: unknown) => {
    const code = errnoOf(error);
    throw code === "ENOENT" || code === "ENOTDIR" ? NOT_FOUND() : code === "ELOOP" ? NOT_ALLOWED() : new ToolError("INVALID_ARGUMENT", "file could not be read.");
  });
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new ToolError("INVALID_ARGUMENT", "not a regular file.");
    if (st.size > MAX_TURN_IMAGE_BYTES) throw TOO_LARGE(st.size);
    const buffer = Buffer.alloc(st.size);
    let filled = 0;
    while (filled < st.size) {
      const { bytesRead } = await handle.read(buffer, filled, st.size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return asImage(buffer.subarray(0, filled), name, extra);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("INVALID_ARGUMENT", "file could not be read.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The roots a host path may resolve into, realpath'd (a root that does not exist is none). */
async function hostRoots(api: DaemonApi, threadId: string): Promise<{ lexical: string[]; sandbox: string | null; attachments: string | null; threads: string | null; temp: string[] }> {
  const roots = api.chatImageRoots?.(threadId) ?? { attachmentsDir: "", tempDirs: [] };
  const lexical = [api.fsRoot, roots.attachmentsDir, ...roots.tempDirs].filter((path) => path !== "");
  const real = (path: string): Promise<string | null> => (path ? realpath(path).catch(() => null) : Promise.resolve(null));
  const [sandbox, attachments, ...temp] = await Promise.all([real(api.fsRoot), real(roots.attachmentsDir), ...roots.tempDirs.map(real)]);
  return {
    lexical,
    sandbox: sandbox ?? null,
    attachments: attachments ?? null,
    // `threads/<id>/attachments`: every thread's directory sits under `threads/`.
    threads: attachments ? dirname(dirname(attachments)) : null,
    temp: temp.filter((path): path is string => path !== null)
  };
}

async function readHostPath(api: DaemonApi, caller: ThreadCaller, raw: string): Promise<ResolvedChatImage> {
  if (raw.includes("\0")) throw new ToolError("INVALID_ARGUMENT", "path is not a usable path.");
  // As read_file takes it: a box's spelling mapped first, a relative path under the sandbox root.
  const target = resolve(api.fsRoot, callerHostPath(caller, raw, api.fsRoot));
  const roots = await hostRoots(api, caller.threadId);
  const allowed = [roots.sandbox, roots.attachments, ...roots.temp].filter((root): root is string => root !== null);
  let real: string;
  try {
    real = await realpath(target);
  } catch (error) {
    // Missing: "not found" only where a file could be shown from, so no other path is probed.
    if (![...roots.lexical, ...allowed].some((root) => inside(resolve(root), target))) throw NOT_ALLOWED();
    const code = errnoOf(error);
    throw code === "ENOENT" || code === "ENOTDIR" ? NOT_FOUND() : new ToolError("INVALID_ARGUMENT", "file could not be read.");
  }
  if (!allowed.some((root) => inside(root, real))) throw NOT_ALLOWED();
  // Another thread's attachments never, wherever its directory sits (a temp directory set above the appdir).
  if (roots.threads !== null && inside(roots.threads, real) && !(roots.attachments !== null && inside(roots.attachments, real))) throw NOT_ALLOWED();
  const inSandbox = roots.sandbox !== null && inside(roots.sandbox, real);
  return readImageFile(real, basename(real), inSandbox ? { path: real } : {});
}

async function readBoxPath(api: DaemonApi, raw: string): Promise<ResolvedChatImage> {
  if (!api.boxReadChatFile) throw new ToolError("UNAVAILABLE", "This chat runs in a box, and its files cannot be read here.");
  const outcome = await api.boxReadChatFile(raw, MAX_TURN_IMAGE_BYTES);
  if (!outcome.ok) {
    if (outcome.code === "TOO_LARGE") throw TOO_LARGE();
    if (outcome.code === "NOT_FOUND") throw NOT_FOUND();
    throw new ToolError(outcome.code, outcome.message);
  }
  return asImage(outcome.value.bytes, raw.split(/[\\/]/).pop() ?? "image");
}

/** One stored attachment of the calling thread, from its own directory only (never the shared pending one). */
async function readAttachment(api: DaemonApi, threadId: string, attachmentId: string, name: string | undefined): Promise<ResolvedChatImage> {
  const missing = new ToolError("INVALID_ARGUMENT", `no attachment "${attachmentId}" in this chat.`);
  const path = (await api.chatAttachmentPath?.(threadId, attachmentId)) ?? null;
  if (path === null) throw missing;
  const roots = await hostRoots(api, threadId);
  const real = await realpath(path).catch(() => null);
  if (real === null || roots.attachments === null || !inside(roots.attachments, real)) throw missing;
  return readImageFile(real, name ?? "image", { attachmentId });
}

// ---------------------------------------------------------------------------
// recent:N
// ---------------------------------------------------------------------------

interface ChatImageAt {
  attachmentId: string;
  name?: string;
}

/** A row's images in the order it shows them: a user message's image attachments, an image row's images. */
function imagesOfItem(item: ThreadItem): ChatImageAt[] {
  if (item.kind === "message") {
    if (item.role !== "user") return [];
    return (item.attachments ?? []).filter((attachment) => attachment.type === "image").map((attachment) => ({ attachmentId: attachment.id, name: attachment.name }));
  }
  return (imageToolReferenceOfActivityPayload(item.payload)?.images ?? []).map((image) => ({ attachmentId: image.attachmentId }));
}

/**
 * The calling thread's newest `n` images, newest first: its retained window, then pages of older history while the
 * window holds fewer (each row once — a page may repeat a few window rows). A subagent's rows are not the chat's.
 */
async function recentImages(api: DaemonApi, threadId: string, n: number): Promise<ChatImageAt[]> {
  const found: ChatImageAt[] = [];
  const seenImages = new Set<string>();
  const seenRows = new Set<string>();
  const take = (items: readonly ThreadItem[]): void => {
    for (let i = items.length - 1; i >= 0 && found.length < n; i -= 1) {
      const item = items[i]!;
      if (seenRows.has(item.id)) continue;
      seenRows.add(item.id);
      if (item.agentId !== undefined) continue;
      const images = imagesOfItem(item);
      for (let j = images.length - 1; j >= 0 && found.length < n; j -= 1) {
        if (seenImages.has(images[j]!.attachmentId)) continue;
        seenImages.add(images[j]!.attachmentId);
        found.push(images[j]!);
      }
    }
  };
  const snapshot = await readThread(api, threadId);
  take(snapshot.items);
  const bounds = snapshot.history;
  let more = bounds?.indexed === true && bounds.hasOlder === true;
  let cursor = typeof bounds?.beforeCursor === "string" ? bounds.beforeCursor : null;
  for (let pages = 0; more && found.length < n && pages < RECENT_HISTORY_PAGES; pages += 1) {
    const query: Record<string, string> = { turns: String(THREAD_HISTORY_MAX_TURNS), ...(cursor !== null ? { before: cursor } : {}) };
    const res = await api.request("GET", agentChatRoutes.history(threadId), { query }).catch(() => null);
    const page = res !== null && res.status < 400 ? (res.body as { items?: unknown; page?: { beforeCursor?: unknown } } | null) : null;
    if (!page || !Array.isArray(page.items)) break;
    take(page.items as ThreadItem[]);
    cursor = typeof page.page?.beforeCursor === "string" ? page.page.beforeCursor : null;
    more = cursor !== null;
  }
  return found;
}

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

/**
 * Validate and read every input, in order; nothing partial. Throws a `ToolError` whose message starts with
 * `${label}[i]: `.
 */
export async function resolveChatImages(api: DaemonApi, caller: ToolCaller, inputs: readonly ChatImageInput[], label = "images"): Promise<ResolvedChatImage[]> {
  const thread = chatThread(caller);
  let recent: { n: number; images: ChatImageAt[] } | null = null;
  const out: ResolvedChatImage[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      const path = typeof input.path === "string" && input.path.trim() !== "" ? input.path : undefined;
      const ref = typeof input.ref === "string" && input.ref.trim() !== "" ? input.ref : undefined;
      if ((path === undefined) === (ref === undefined)) throw new ToolError("INVALID_ARGUMENT", "give exactly one of path or ref.");
      if (path !== undefined) {
        out.push(thread.projectBoxId !== undefined ? await readBoxPath(api, path) : await readHostPath(api, thread, path));
        continue;
      }
      const source = parseChatImageSource(ref);
      if (source === null) throw new ToolError("INVALID_ARGUMENT", 'ref is "recent:N" (1 is the latest image in this chat) or "attachment:<id>".');
      if (source.kind === "attachment") {
        out.push(await readAttachment(api, thread.threadId, source.attachmentId, undefined));
        continue;
      }
      // One walk serves every recent:N of the call: the deepest asked.
      const deepest = Math.max(...inputs.map((entry) => { const parsed = parseChatImageSource(entry.ref); return parsed?.kind === "recent" ? parsed.n : 0; }));
      if (recent === null || recent.n < deepest) recent = { n: deepest, images: await recentImages(api, thread.threadId, deepest) };
      const image = recent.images[source.n - 1];
      if (image === undefined) {
        throw new ToolError("INVALID_ARGUMENT", recent.images.length === 0 ? "this chat has no images yet." : `this chat has only ${recent.images.length} image${recent.images.length === 1 ? "" : "s"}.`);
      }
      out.push(await readAttachment(api, thread.threadId, image.attachmentId, image.name));
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(error.code, `${label}[${index}]: ${error.message}`, error.detail);
      throw error;
    }
  }
  return out;
}

/** Store an image as an attachment of the caller's thread (the chat upload path) and return its id. */
export async function storeChatImage(api: DaemonApi, caller: ToolCaller, image: { bytes: Buffer; mimeType: ChatImageMimeType; name: string }): Promise<{ attachmentId: string }> {
  const thread = chatThread(caller);
  const failed = { code: "HOST_UNAVAILABLE", message: "The image could not be stored in this chat." };
  let res: { status: number; value: unknown };
  try {
    res = await api.uploadAttachment(thread.threadId, { name: image.name, type: image.mimeType }, Readable.from([image.bytes]));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    // The text can name a host path: logged, never returned.
    console.error("[mcp] chat image upload failed", error);
    throw new ToolError(failed.code, failed.message);
  }
  if (res.status >= 400) throw daemonError({ status: res.status, body: res.value }, failed);
  const id = (res.value as { id?: unknown } | null)?.id;
  if (typeof id !== "string") throw new ToolError("INTERNAL", "the host did not return an attachment reference.");
  return { attachmentId: id };
}
