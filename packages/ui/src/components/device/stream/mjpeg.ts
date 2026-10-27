/**
 * Incremental `multipart/x-mixed-replace` parser for serve-sim `stream.mjpeg`.
 * serve-sim writes `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<jpeg>\r\n`
 * per part; the parser also handles parts without Content-Length (the body
 * ends at the next delimiter), LF-only line endings, a preamble, transport
 * padding after the boundary, and the closing `--boundary--`.
 */

/** Boundary from a Content-Type header, without the leading `--`; null when absent. */
export function multipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  let boundary = match?.[1] ?? match?.[2] ?? null;
  // Some servers put the delimiter's dashes in the parameter itself.
  if (boundary?.startsWith("--")) boundary = boundary.slice(2);
  return boundary || null;
}

/** One part larger than this is not a screen frame; the parser throws. */
export const MAX_MJPEG_PART_BYTES = 32 * 1024 * 1024;

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const latin1 = new TextDecoder("latin1");

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number, to: number): number {
  const first = needle[0]!;
  const last = to - needle.length;
  outer: for (let i = hay.indexOf(first, from); i !== -1 && i <= last; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

type ParserState = "boundary" | "headers" | "body" | "done";

export class MjpegParser {
  private readonly delimiter: Uint8Array;
  private buffer = new Uint8Array(256 * 1024);
  private start = 0;
  private end = 0;
  private state: ParserState = "boundary";
  private contentLength: number | null = null;

  constructor(boundary: string) {
    this.delimiter = new TextEncoder().encode(`--${boundary}`);
  }

  /** True after the closing delimiter. */
  get done(): boolean {
    return this.state === "done";
  }

  /** Append bytes from one read; return every part body they complete, in order. */
  push(bytes: Uint8Array): Uint8Array[] {
    if (this.state === "done") return [];
    this.append(bytes);
    const parts: Uint8Array[] = [];
    for (;;) {
      if (this.state === "boundary") {
        if (!this.readBoundary()) break;
      } else if (this.state === "headers") {
        if (!this.readHeaders()) break;
      } else if (this.state === "body") {
        const part = this.readBody();
        if (!part) break;
        parts.push(part);
      } else break;
    }
    this.compact();
    return parts;
  }

  private append(bytes: Uint8Array): void {
    if (this.end + bytes.length > this.buffer.length) {
      const live = this.end - this.start;
      if (live + bytes.length <= this.buffer.length) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        let capacity = this.buffer.length;
        while (capacity < live + bytes.length) capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.buffer.subarray(this.start, this.end));
        this.buffer = next;
      }
      this.start = 0;
      this.end = live;
    }
    this.buffer.set(bytes, this.end);
    this.end += bytes.length;
    if (this.end - this.start > MAX_MJPEG_PART_BYTES + 64 * 1024) {
      this.start = this.end = 0;
      this.state = "boundary";
      throw new Error("MJPEG part exceeds the size limit");
    }
  }

  private compact(): void {
    if (this.start === this.end) this.start = this.end = 0;
  }

  /** Find `--boundary`, then consume up to the end of its line. */
  private readBoundary(): boolean {
    const at = indexOf(this.buffer, this.delimiter, this.start, this.end);
    if (at === -1) {
      // Keep a tail that could hold the start of a split delimiter.
      this.start = Math.max(this.start, this.end - this.delimiter.length + 1);
      return false;
    }
    let cursor = at + this.delimiter.length;
    if (this.end - cursor < 2) return false;
    if (this.buffer[cursor] === DASH && this.buffer[cursor + 1] === DASH) {
      this.state = "done";
      this.start = this.end;
      return false;
    }
    const lineEnd = this.buffer.indexOf(LF, cursor);
    if (lineEnd === -1 || lineEnd >= this.end) {
      this.start = at;
      return false;
    }
    cursor = lineEnd + 1;
    this.start = cursor;
    this.state = "headers";
    this.contentLength = null;
    return true;
  }

  private readHeaders(): boolean {
    // Headers end at an empty line (CRLF CRLF or LF LF).
    let cursor = this.start;
    for (;;) {
      const lineEnd = this.buffer.indexOf(LF, cursor);
      if (lineEnd === -1 || lineEnd >= this.end) return false;
      const lineStop = lineEnd > cursor && this.buffer[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd;
      if (lineStop === cursor) {
        this.start = lineEnd + 1;
        this.state = "body";
        return true;
      }
      const line = latin1.decode(this.buffer.subarray(cursor, lineStop));
      const colon = line.indexOf(":");
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "content-length") {
        const value = Number(line.slice(colon + 1).trim());
        this.contentLength = Number.isSafeInteger(value) && value >= 0 ? value : null;
        if (this.contentLength !== null && this.contentLength > MAX_MJPEG_PART_BYTES) {
          this.start = this.end = 0;
          this.state = "boundary";
          throw new Error("MJPEG part exceeds the size limit");
        }
      }
      cursor = lineEnd + 1;
    }
  }

  private readBody(): Uint8Array | null {
    if (this.contentLength !== null) {
      if (this.end - this.start < this.contentLength) return null;
      const part = this.buffer.slice(this.start, this.start + this.contentLength);
      this.start += this.contentLength;
      this.state = "boundary";
      return part;
    }
    // No length: the body ends before the line break that precedes the next delimiter.
    const at = indexOf(this.buffer, this.delimiter, this.start, this.end);
    if (at === -1) return null;
    let stop = at;
    if (stop > this.start && this.buffer[stop - 1] === LF) stop--;
    if (stop > this.start && this.buffer[stop - 1] === CR) stop--;
    const part = this.buffer.slice(this.start, stop);
    this.start = at;
    this.state = "boundary";
    return part;
  }
}
