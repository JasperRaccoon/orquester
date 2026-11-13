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

/**
 * Stream a file's bytes as an attachment. The handler MUST `return` the result,
 * NOT `void reply.send(stream); return;`: in an async handler a stream send is
 * still piping when the function resolves to `undefined`, so Fastify sends that
 * `undefined` and clobbers the stream — content-length:0, empty body. Returning
 * the reply tells Fastify the response is taken. `size` (from the stat) gives
 * the browser a progress bar.
 */
export function sendFileDownload(reply: FastifyReply, name: string, size: number, body: Readable): FastifyReply {
  return reply
    .header("Content-Disposition", contentDisposition(name))
    .header("Content-Length", String(size))
    .header("X-Content-Type-Options", "nosniff")
    .type("application/octet-stream")
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
