/**
 * Raw-body upload plumbing shared by `POST /api/fs/upload` and
 * `POST /api/sessions/:id/upload`.
 *
 * Uploads used to travel as base64 inside a JSON body. That caps the file at
 * ~380 MB for a reason no bodyLimit can fix: Fastify buffers a JSON body into
 * ONE V8 string before parsing, and V8 strings top out at ~512 MiB (the same
 * ceiling bites the browser building the data URL). So the file now arrives as
 * `application/octet-stream`, metadata rides the query string, and the body is
 * streamed straight to disk: memory stays flat whatever the size, and the only
 * limit left is the shared MAX_UPLOAD_BYTES — a disk/UX guard, not a runtime one.
 *
 * Fastify's `bodyLimit` does not apply to a stream parser, so the cap is
 * enforced here twice: a declared Content-Length above it is refused before a
 * byte is read, and {@link receiveUpload} counts what actually arrives.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { MAX_UPLOAD_BYTES } from "@orquester/api";

/** The body exceeded MAX_UPLOAD_BYTES. The partial temp file is already gone. */
export class UploadTooLargeError extends Error {
  constructor() {
    super(`File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Let an (encapsulated) Fastify scope accept `application/octet-stream` and hand
 * the route the raw request stream untouched — no buffering, no bodyLimit. Kept
 * per scope rather than app-wide so every other route keeps answering 415 to a
 * binary body instead of receiving a stream where it expects JSON.
 */
export function acceptRawBody(scope: FastifyInstance): void {
  scope.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
}

/** True when the client declared a Content-Length above the cap. */
export function declaredLengthExceedsCap(headers: IncomingHttpHeaders): boolean {
  const declared = Number(headers["content-length"]);
  return Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES;
}

/**
 * Reply to an upload BEFORE its body was consumed. Node would otherwise keep
 * the connection alive and read the rest of the (possibly huge) body off the
 * wire just to discard it; `Connection: close` makes it shut the socket once
 * the reply is flushed instead, which also stops the client's upload. Used for
 * every refusal that precedes or interrupts the body read (validation, 404,
 * the two 413 paths) — a reply sent after the body was fully received needs no
 * such care.
 */
export function refuseUpload(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  reply.header("connection", "close");
  return reply.code(status).send({ code, message });
}

/** A fresh temp path inside `dir` for an in-flight upload (renamed into place on success). */
export function uploadTempPath(dir: string): string {
  return join(dir, `.orq-upload-${randomUUID().slice(0, 8)}.part`);
}

/** Best-effort removal of a temp/partial upload; a missing file is not an error. */
export async function discardUpload(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * Stream the raw request body into `path` (created exclusively, `mode` if given),
 * counting bytes and aborting the moment MAX_UPLOAD_BYTES is exceeded. Resolves
 * with the byte count. On ANY failure — cap, client abort, ENOSPC, … — the
 * partial file is unlinked before the error propagates, so the caller only has
 * to map the error.
 *
 * The body is read with `destroyOnReturn:false` on purpose: `stream.pipeline`
 * (or a plain `for await`) would destroy the IncomingMessage when we bail on
 * the cap, and destroying a half-read request tears the socket down — the 413
 * would never reach the client. Leaving the request paused lets Fastify send
 * the reply; {@link refuseUpload}'s `Connection: close` then ends the socket.
 */
export async function receiveUpload(source: IncomingMessage, path: string, mode?: number): Promise<number> {
  const file = createWriteStream(path, { flags: "wx", mode });
  // A write error (ENOSPC, EIO) can fire between two awaits; without a listener
  // it would be an unhandled 'error' event. Capture it and surface it below.
  let writeError: Error | undefined;
  file.on("error", (error) => {
    writeError ??= error;
  });
  let size = 0;
  try {
    // Surface EEXIST/EACCES/ENOTDIR on the temp file before reading the body.
    await once(file, "open");
    for await (const chunk of source.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      if (writeError) {
        throw writeError;
      }
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        throw new UploadTooLargeError();
      }
      if (!file.write(chunk)) {
        await once(file, "drain");
      }
    }
    file.end();
    await finished(file);
    if (writeError) {
      throw writeError;
    }
    return size;
  } catch (error) {
    file.destroy();
    await discardUpload(path);
    throw error;
  }
}
