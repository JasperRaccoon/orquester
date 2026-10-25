/**
 * The daemon's leg of a chat stream (§6.3): the host's NDJSON, forwarded to a
 * client that may sit behind a slow, lossy mobile link.
 *
 * Two things happen here that the host cannot do for every client:
 * - **compression**: a cold open's `snapshot` line is the whole retained
 *   window — megabytes of JSON on a long thread — and no proxy in front of the
 *   daemon compresses it (Caddy's `encode` skips `application/x-ndjson` and
 *   honours the stream's `no-transform`). So the daemon gzips it for a client
 *   that asks (`Accept-Encoding`), flushing every write so a heartbeat or a
 *   live event is never held back for a fuller deflate block;
 * - **a faster heartbeat**: a `:hb` line every {@link DAEMON_STREAM_HEARTBEAT_MS}
 *   of silence, written only between two lines, so a client can tell a dead
 *   link from a quiet thread sooner than the host's own 15 s cadence allows —
 *   and so bytes flow while the host is still folding a cold thread.
 */

import { Transform, type TransformCallback } from "node:stream";
import { constants as zlibConstants, createGzip, type Gzip } from "node:zlib";

import { AGENT_CHAT_DAEMON_HEARTBEAT_MS, AGENT_CHAT_HEARTBEAT_LINE } from "@orquester/api/agent-chat";

/** How long a forwarded stream may stay silent before the daemon writes a `:hb` line. */
export const DAEMON_STREAM_HEARTBEAT_MS = AGENT_CHAT_DAEMON_HEARTBEAT_MS;

const HEARTBEAT = Buffer.from(`${AGENT_CHAT_HEARTBEAT_LINE}\n`);
const NEWLINE = 0x0a;

/**
 * Whether an `Accept-Encoding` header admits gzip (RFC 9110 §12.5.3): listed
 * by name, or through `*`, with a non-zero quality. An explicit `gzip;q=0`
 * refuses it whatever `*` says.
 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : header;
  let gzip: number | null = null;
  let wildcard: number | null = null;
  for (const part of value.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const [key, raw] = param.split("=");
      if (key?.trim().toLowerCase() === "q") {
        const parsed = Number.parseFloat(raw?.trim() ?? "");
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (name === "gzip" || name === "x-gzip") gzip = quality;
    else if (name === "*") wildcard = quality;
  }
  if (gzip !== null) return gzip > 0;
  return wildcard !== null && wildcard > 0;
}

/**
 * A pass-through that knows whether the bytes it has forwarded end on a line
 * boundary, so a heartbeat can be slipped in without splitting a line.
 */
export class NdjsonForwarder extends Transform {
  private atLineStart = true;
  private lastForwardAt: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    super();
    this.now = now;
    this.lastForwardAt = now();
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (bytes.length > 0) {
      this.atLineStart = bytes[bytes.length - 1] === NEWLINE;
      this.lastForwardAt = this.now();
    }
    callback(null, bytes);
  }

  /**
   * Write a `:hb` line when the stream has been quiet for `idleMs` and sits
   * between two lines. Mid-line — a long `snapshot` still crossing — it waits:
   * bytes are flowing anyway, and a comment there would corrupt the line.
   */
  heartbeatIfIdle(idleMs: number): boolean {
    if (!this.atLineStart || this.destroyed || this.writableEnded) return false;
    if (this.now() - this.lastForwardAt < idleMs) return false;
    this.lastForwardAt = this.now();
    this.push(HEARTBEAT);
    return true;
  }
}

/** A gzip encoder that flushes every write, so a stream's lines leave at once. */
export function createStreamingGzip(): Gzip {
  return createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
}
