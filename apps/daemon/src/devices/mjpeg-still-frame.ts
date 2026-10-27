// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): apps/server/src/device/mjpegStillFrame.ts
/**
 * Browsers paint a `multipart/x-mixed-replace` part only once the next part begins, and the hub
 * writes a part only when the screen changes: left alone, an `<img>` viewer never shows a still
 * screen and always hides the last frame of a change. {@link repeatStillFrame} re-sends the last
 * complete part once after a short quiet period so it paints (devices spec §8).
 */

import { Transform, type TransformCallback } from "node:stream";

/** How long the stream must be quiet before the last part is sent again. */
const STILL_FRAME_DELAY_MS = 100;

const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;
// Device frames are far smaller; a larger claim is unknown framing, not something to retain.
const MAX_PART_BYTES = 16 * 1024 * 1024;

function partLength(headers: string): number | undefined {
  if (!headers.startsWith("--")) return undefined;
  const match = /^content-length:\s*(\d+)\s*$/im.exec(headers);
  if (!match) return undefined;
  const length = Number(match[1]);
  return length <= MAX_PART_BYTES ? length : undefined;
}

function endsWithCrlf(part: readonly Buffer[]): boolean {
  const bytes: number[] = [];
  for (let i = part.length - 1; i >= 0 && bytes.length < 2; i -= 1) {
    const piece = part[i]!;
    for (let j = piece.length - 1; j >= 0 && bytes.length < 2; j -= 1) bytes.unshift(piece[j]!);
  }
  return bytes[0] === 0x0d && bytes[1] === 0x0a;
}

/**
 * Follows the hub's part framing (`--frame`, `Content-Length`, CRLF CRLF, body, CRLF) and keeps
 * the last complete part as views into the forwarded chunks (frame bytes are never copied). Any
 * other framing turns tracking off and the rest passes through untouched.
 */
class MjpegPartTracker {
  /** The last complete part, while the stream sits at a part boundary; null otherwise. */
  still: Buffer[] | null = null;
  private pieces: Buffer[] = [];
  private size = 0;
  private partEnd: number | null = null;
  private tracking = true;

  feed(chunk: Buffer): void {
    if (!this.tracking) return;
    let rest = chunk;
    let part: Buffer[] | undefined;
    while (rest.length > 0) {
      if (this.partEnd === null) {
        // A header split across chunks is re-scanned per chunk; only a header-sized prefix of the
        // new chunk joins the scan.
        const head = this.size === 0 ? rest : Buffer.concat([...this.pieces, rest.subarray(0, MAX_HEADER_BYTES + HEADER_END.length)]);
        const headerEnd = head.indexOf(HEADER_END);
        if (headerEnd < 0 && head.length <= MAX_HEADER_BYTES) {
          this.pieces.push(rest);
          this.size += rest.length;
          break;
        }
        const length = headerEnd < 0 || headerEnd > MAX_HEADER_BYTES ? undefined : partLength(head.subarray(0, headerEnd).toString("latin1"));
        if (length === undefined) {
          this.tracking = false;
          break;
        }
        this.partEnd = headerEnd + HEADER_END.length + length + 2;
      }
      const taken = rest.subarray(0, this.partEnd - this.size);
      this.pieces.push(taken);
      this.size += taken.length;
      rest = rest.subarray(taken.length);
      if (this.size < this.partEnd) break;
      const complete = this.pieces;
      if (!endsWithCrlf(complete)) {
        this.tracking = false;
        break;
      }
      part = complete;
      this.pieces = [];
      this.size = 0;
      this.partEnd = null;
    }
    if (!this.tracking) this.pieces = [];
    this.still = this.tracking && this.size === 0 ? (part ?? this.still) : null;
  }
}

/** A pass-through that re-sends the latest complete part once when the stream goes quiet. */
export function repeatStillFrame(): Transform {
  const tracker = new MjpegPartTracker();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      clear();
      tracker.feed(chunk);
      this.push(chunk);
      const still = tracker.still;
      if (still) {
        timer = setTimeout(() => {
          timer = null;
          if (stream.destroyed || stream.writableEnded) return;
          tracker.still = null;
          for (const piece of still) stream.push(piece);
        }, STILL_FRAME_DELAY_MS);
        timer.unref?.();
      }
      callback();
    },
    flush(callback) {
      clear();
      callback();
    },
    destroy(error, callback) {
      clear();
      callback(error);
    }
  });
  return stream;
}
