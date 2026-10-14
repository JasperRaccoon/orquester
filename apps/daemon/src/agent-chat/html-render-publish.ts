/**
 * Publishing an agent's HTML page into its thread (spec 2026-10-14 §2.1,
 * §2.2) — what the `orquester` server's `html_render` handler calls.
 *
 * Ported from T3 Code (MIT): `apps/server/src/htmlRender/HtmlRender.ts`
 * (`prepare`, `publish`, local image inlining), adapted to Orquester's
 * boundaries: the page is stored through the agent host's attachment upload
 * (the host owns the thread's attachment namespace, its id, and its delete
 * cascade), and a local image is inlined only from inside the thread's own
 * project after realpath.
 *
 * The page that is stored is self-contained: the theme + bridge bootstrap
 * (`injectHtmlRenderBootstrap`) at the head, every local absolute image path
 * replaced by a data URI. The returned {@link HtmlRenderReference} is the
 * only record of it — the tool's result carries it into the thread's log.
 */

import { constants } from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import * as path from "node:path";

import {
  HTML_RENDER_MAX_TITLE_LENGTH,
  clampHtmlRenderHeight,
  htmlRenderFileName,
  injectHtmlRenderBootstrap,
  isHtmlRenderAttachmentId,
  readHtmlRenderReference,
  type HtmlRenderReference
} from "@orquester/api/agent-chat";

const MIB = 1024 * 1024;
/** One inlined image (spec §2.1). */
export const HTML_RENDER_MAX_IMAGE_BYTES = 10 * MIB;
/** The whole stored page, images inlined (spec §2.1). */
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * MIB;
/** The tool's `html` bound (spec §2.1); the publisher refuses past it too. */
export const HTML_RENDER_MAX_HTML_CHARS = 512_000;

const formatMib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

export type HtmlRenderPublishErrorCode =
  | "invalid-input"
  | "images-not-found"
  | "images-outside-project"
  | "image-too-large"
  | "page-too-large"
  | "store-failed"
  | "cancelled";

/** A refusal the tool handler answers as an MCP error result, message verbatim. */
export class HtmlRenderPublishError extends Error {
  constructor(
    readonly code: HtmlRenderPublishErrorCode,
    message: string
  ) {
    super(message);
    this.name = "HtmlRenderPublishError";
  }
}

export type HtmlRenderHeights = NonNullable<HtmlRenderReference["heights"]>;

export interface HtmlRenderPublishDeps {
  /**
   * Store `bytes` as an attachment of `threadId` named `fileName` (an
   * `.html` name, so the host mints a `-html` id), answering the id. The
   * daemon's is the agent-chat service's upload to the host.
   */
  storeAttachment(threadId: string, fileName: string, bytes: Buffer): Promise<string>;
  /**
   * The realpath of the directory local images must sit inside — the
   * thread's project, already confined to the workspaces root — or null when
   * the thread has none (then no local image is inlined).
   */
  sandboxRoot(threadId: string): Promise<string | null>;
}

export interface PublishHtmlRenderInput {
  threadId: string;
  html: string;
  title: string;
  /** The agent's frame height; clamped to 80..2000. */
  height: number;
  /** `[width, contentHeight]` pairs already measured (Task 5's preview service). */
  heights?: HtmlRenderHeights;
  /**
   * Measures the PREPARED page (bootstrap in, images inlined) at the client
   * widths, or answers undefined (no browser). Used only when `heights` is
   * absent; a throw publishes without heights.
   */
  measure?: (preparedHtml: string) => Promise<HtmlRenderHeights | undefined>;
  /** The call's own: once aborted, nothing is stored (no page nobody will reference). */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Local image inlining
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon"
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid"
);

interface ImageReference {
  start: number;
  end: number;
  path: string;
}

function findLocalImages(html: string): ImageReference[] {
  return Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });
}

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string): string =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (file: string): string =>
  `data:${IMAGE_MIME_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text: string, token: string, from: number): number => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/** The index just past a doctype whose body starts at `from`, honouring quotes and its internal subset. */
function afterDoctype(text: string, from: number): number {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
}

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
function hasSvgRoot(text: string): boolean {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
}

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink
 * or a renamed file cannot carry other data — a secret — into a page.
 */
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

/** Whether `child` is `root` or inside it (both already realpaths). */
function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Open `real` — a realpath already checked to sit inside `root` — for reading,
 * and prove the descriptor is still that file inside `root`. Between the
 * realpath and the open, a component of the path can be swapped for a
 * symlink out of the project; so the last component is opened with
 * `O_NOFOLLOW`, and the descriptor's own path (`/proc/self/fd`, where there is
 * one) must still resolve inside `root`. Elsewhere, the path is resolved again
 * and must name the very file the descriptor holds (same device and inode).
 * Null when it does not: the image is then treated as outside the project.
 */
export async function openInsideRoot(real: string, root: string): Promise<FileHandle | null> {
  const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a file");
    const fdPath = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (fdPath !== null) {
      if (!isInside(root, fdPath)) throw new Error("escaped");
    } else {
      const again = await realpath(real);
      const now = await stat(again);
      if (!isInside(root, again) || now.dev !== info.dev || now.ino !== info.ino) throw new Error("escaped");
    }
    return handle;
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

/** At most `limit + 1` bytes from an open file: one past the limit tells "too large" from "exactly". */
async function readBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  try {
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

interface InlineResult {
  html: string;
  /** Paths that do not name a readable image file. */
  missing: string[];
  /** Paths that resolve outside the sandbox root (or there is none). */
  outside: string[];
}

/**
 * Replaces every local image reference whose real path is a regular image
 * file inside `sandboxRoot` with a data URI. Any other path stays as written
 * and is reported, missing or outside.
 */
export async function inlineLocalImages(html: string, sandboxRoot: string | null): Promise<InlineResult> {
  const references = findLocalImages(html);
  const unique = [...new Set(references.map((reference) => reference.path))];
  const missing: string[] = [];
  const outside: string[] = [];
  const files: Array<{ path: string; real: string; size: number }> = [];
  for (const reference of unique) {
    const real = await realpath(filePathFor(reference)).catch(() => null);
    const info = real === null ? null : await stat(real).catch(() => null);
    if (real === null || info === null || !info.isFile()) {
      missing.push(reference);
      continue;
    }
    if (sandboxRoot === null || !isInside(sandboxRoot, real)) {
      outside.push(reference);
      continue;
    }
    if (info.size > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderPublishError(
        "image-too-large",
        `${reference} is ${formatMib(info.size)}; each local image must be at most ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}.`
      );
    }
    files.push({ path: reference, real, size: info.size });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total + dataUriPrefix(reference.path).length + Math.ceil(size / 3) * 4 - Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > HTML_RENDER_MAX_PAGE_BYTES) {
    throw pageTooLarge(pageBytes);
  }
  // Files can grow after `stat`: each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  const dataUris = new Map<string, string>();
  let readBytes = 0;
  for (const file of files) {
    const handle = sandboxRoot === null ? null : await openInsideRoot(file.real, sandboxRoot);
    if (handle === null) {
      outside.push(file.path);
      continue;
    }
    const bytes = await readBounded(handle, HTML_RENDER_MAX_IMAGE_BYTES).catch(() => null);
    if (bytes === null || !isImageBytes(bytes)) {
      missing.push(file.path);
      continue;
    }
    if (bytes.byteLength > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderPublishError(
        "image-too-large",
        `${file.path} is over ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}; each local image must be at most that.`
      );
    }
    readBytes += Math.ceil(bytes.byteLength / 3) * 4;
    if (readBytes > HTML_RENDER_MAX_PAGE_BYTES) {
      throw pageTooLarge(readBytes);
    }
    dataUris.set(file.path, dataUriPrefix(file.path) + bytes.toString("base64"));
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > HTML_RENDER_MAX_PAGE_BYTES) {
    throw pageTooLarge(inlinedBytes);
  }
  return { html: inlined, missing, outside };
}

function pageTooLarge(bytes: number): HtmlRenderPublishError {
  return new HtmlRenderPublishError(
    "page-too-large",
    `With its images inlined the page is ${formatMib(bytes)}; the limit is ${formatMib(HTML_RENDER_MAX_PAGE_BYTES)}. Use smaller images.`
  );
}

// ---------------------------------------------------------------------------
// Prepare + publish
// ---------------------------------------------------------------------------

/**
 * The self-contained page that gets stored: the bootstrap first (so its head
 * scan never runs over inlined image data), then local images inlined. A
 * page naming an image it cannot inline is refused, with every such path.
 */
export async function prepareHtmlRender(html: string, sandboxRoot: string | null): Promise<string> {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new HtmlRenderPublishError("invalid-input", "The page is empty.");
  }
  if (html.length > HTML_RENDER_MAX_HTML_CHARS) {
    throw new HtmlRenderPublishError(
      "invalid-input",
      `The page is ${html.length} characters; the limit is ${HTML_RENDER_MAX_HTML_CHARS}.`
    );
  }
  const inlined = await inlineLocalImages(injectHtmlRenderBootstrap(html), sandboxRoot);
  if (inlined.outside.length > 0) {
    throw new HtmlRenderPublishError(
      "images-outside-project",
      `These local images are outside this thread's project, so they cannot be shown: ${inlined.outside.join(", ")}. Copy them into the project, or remove them.`
    );
  }
  if (inlined.missing.length > 0) {
    throw new HtmlRenderPublishError(
      "images-not-found",
      `These local images could not be read: ${inlined.missing.join(", ")}. Use absolute paths to existing image files, or remove them.`
    );
  }
  return inlined.html;
}

/**
 * Prepare, measure (when asked), store, and answer the page's reference.
 * Runs in the daemon. Nothing is stored before the page is ready, so a
 * refusal leaves nothing behind; a page stored and then never referenced
 * (the call's result lost) is collected by the host's attachment sweep.
 */
export async function publishHtmlRender(
  deps: HtmlRenderPublishDeps,
  input: PublishHtmlRenderInput
): Promise<HtmlRenderReference> {
  if (typeof input.title !== "string" || !Number.isFinite(input.height)) {
    throw new HtmlRenderPublishError("invalid-input", "A page needs a title and a height.");
  }
  const title = input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML";
  const root = await deps.sandboxRoot(input.threadId);
  // Compared against each image's realpath, so it must be one too.
  const sandboxRoot = root === null ? null : await realpath(root).catch(() => null);
  const html = await prepareHtmlRender(input.html, sandboxRoot);
  let heights = input.heights;
  if (heights === undefined && input.measure !== undefined) {
    heights = await input.measure(html).catch(() => undefined);
  }
  if (input.signal?.aborted) {
    throw new HtmlRenderPublishError("cancelled", "The call was cancelled.");
  }
  let attachmentId: string;
  try {
    attachmentId = await deps.storeAttachment(input.threadId, htmlRenderFileName(title), Buffer.from(html, "utf8"));
  } catch (error) {
    throw new HtmlRenderPublishError(
      "store-failed",
      `The page could not be saved${error instanceof Error && error.message ? `: ${error.message}` : "."}`
    );
  }
  if (!isHtmlRenderAttachmentId(attachmentId)) {
    throw new HtmlRenderPublishError("store-failed", "The page could not be saved.");
  }
  // Through the shared reader, so the reference is exactly what every client
  // will read back: clamped, sorted, and heights dropped whole if any is bad.
  const reference = readHtmlRenderReference({
    attachmentId,
    title,
    height: clampHtmlRenderHeight(input.height),
    ...(heights === undefined ? {} : { heights })
  });
  if (reference === undefined) {
    throw new HtmlRenderPublishError("store-failed", "The page could not be saved.");
  }
  return reference;
}
