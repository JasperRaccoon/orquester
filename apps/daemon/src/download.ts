// Download responses shared by /api/fs/download and the storage download route:
// a file streamed as-is, or a folder zipped on the fly by a host tool and streamed.

import type { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

import { spawnDirZip } from "./zip";

/**
 * Build a `Content-Disposition: attachment` value. The ASCII filename="" form is
 * a fallback with control/quote/backslash and non-ASCII bytes replaced by "_";
 * the RFC 5987 filename*=UTF-8'' form carries the real (possibly non-ASCII) name
 * for browsers that honor it.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Inclusive byte offsets of a file to send. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * The single byte range a `Range` header asks of a file of `size` bytes:
 * null to send the whole file (no header, a syntax this doesn't serve — e.g.
 * several ranges — or an empty file), "unsatisfiable" for a range wholly past
 * the end (RFC 9110 §14.1.2: `bytes=a-b`, `bytes=a-`, `bytes=-n`).
 */
function requestedRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (header === undefined || size === 0) return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (match[2] !== "" && end < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

// Audio and video go out under their own type, so a player (Safari's in
// particular) streams them from the download URL; everything else stays opaque.
const MEDIA_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac"
};

function downloadType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext]! : "application/octet-stream";
}

/**
 * Stream a file's bytes as an attachment — the whole file, or the one byte
 * range `rangeHeader` asks for (206), so a media player can stream and seek
 * without fetching the whole file. The handler MUST `return` the result, NOT
 * `void reply.send(stream); return;`: in an async handler a stream send is
 * still piping when the function resolves to `undefined`, so Fastify sends that
 * `undefined` and clobbers the stream — content-length:0, empty body. Returning
 * the reply tells Fastify the response is taken. `size` (from the stat) gives
 * the browser a progress bar and bounds the body: `open` is asked for exactly
 * the bytes sent (not called for an empty file), so a file that grew since the
 * stat — or one whose stat size is 0 but reads non-empty — never sends more bytes
 * than the Content-Length promised (which would desync a keep-alive connection).
 * `open` runs before any header is set, so a caller can answer its failure with
 * its own error.
 */
export async function sendFileDownload(
  reply: FastifyReply,
  rangeHeader: string | undefined,
  name: string,
  size: number,
  open: (range: ByteRange) => Readable | Promise<Readable>
): Promise<FastifyReply> {
  const range = requestedRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return reply.code(416).header("Content-Range", `bytes */${size}`).header("Accept-Ranges", "bytes").send();
  }
  const sent = range ?? { start: 0, end: size - 1 };
  const length = sent.end - sent.start + 1;
  const body = length > 0 ? await open(sent) : Buffer.alloc(0);
  if (range) reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  return reply
    .header("Accept-Ranges", "bytes")
    .header("Content-Disposition", contentDisposition(name))
    .header("Content-Length", String(length))
    .header("X-Content-Type-Options", "nosniff")
    .type(downloadType(name))
    .send(body);
}

/**
 * Zip `absDir` with a host tool and stream it as `<name>.zip` (hijacking the
 * reply, as the session-output route does; the size is unknown up front, so the
 * response is chunked). Returns false — nothing sent — when no zip tool is on
 * PATH, for the caller to answer in its own error shape.
 */
export function sendFolderZip(request: FastifyRequest, reply: FastifyReply, absDir: string, name: string): boolean {
  const child = spawnDirZip(absDir);
  if (!child) return false;
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": contentDisposition(`${name}.zip`),
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache"
  });
  // pipe() ends reply.raw when stdout ends. Drain stderr so a chatty tool
  // (zip warns on e.g. empty dirs) can't block on a full pipe. Kill the
  // child if the client disconnects; destroy the socket on a spawn error.
  child.stdout.pipe(reply.raw);
  child.stderr.resume();
  child.on("error", () => reply.raw.destroy());
  // A non-zero exit (e.g. an unreadable subdir) means the zip is incomplete.
  // stdout closing would otherwise end the chunked response cleanly, so the
  // client would see a truncated body as a successful 200. Destroy the socket
  // instead so the aborted transfer fails visibly. Harmless on a clean exit
  // (code 0 → no-op; destroy() on an already-finished socket is idempotent).
  child.on("close", (code) => {
    if (code) reply.raw.destroy();
  });
  request.raw.on("close", () => child.kill());
  return true;
}
