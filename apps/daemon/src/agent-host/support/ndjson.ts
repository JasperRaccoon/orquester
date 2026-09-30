/**
 * Agent host — NDJSON line framing (spec §3.1, §4.5 Codex transport, §9).
 *
 * Codex's app-server speaks one JSON object per line with **no `jsonrpc`
 * field**; `events.ndjson` and `raw.ndjson` are the same framing on disk. Both
 * directions live here so a replay test reads exactly what the transport
 * writes.
 */

const BOM = "﻿";

/**
 * A single line longer than this is abandoned rather than buffered. A child
 * that writes megabytes with no newline would otherwise grow the buffer
 * without limit (R4 #17); the reader resyncs at the next newline.
 */
const NDJSON_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Carries partial lines and UTF-8 across chunks, strips CRLF and a leading BOM. */
export class NdjsonLineReader {
  private buffer = "";
  private atStart = true;
  private decoder = new TextDecoder("utf-8");
  private skipping = false;

  /** Feed a chunk; returns the complete lines it produced, in order. */
  push(chunk: Uint8Array | string): string[] {
    const text =
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text.length === 0) {
      return [];
    }
    this.buffer += text;
    if (this.atStart) {
      if (this.buffer.startsWith(BOM)) {
        this.buffer = this.buffer.slice(BOM.length);
        this.atStart = false;
      } else if (this.buffer.length > 0) {
        this.atStart = false;
      }
    }

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      if (nl === -1) {
        break;
      }
      let end = nl;
      if (end > start && this.buffer.charCodeAt(end - 1) === 13) {
        end -= 1;
      }
      if (this.skipping) {
        // The tail of an abandoned line: drop it and resync here.
        this.skipping = false;
      } else {
        lines.push(this.buffer.slice(start, end));
      }
      start = nl + 1;
    }
    this.buffer = this.buffer.slice(start);

    if (this.buffer.length > NDJSON_MAX_LINE_BYTES) {
      this.buffer = "";
      this.skipping = true;
    }

    // A trailing lone "\r" may be the first half of a CRLF split across
    // chunks. Keeping it in the buffer costs nothing and avoids emitting a
    // phantom blank line on the next push.
    return lines;
  }

  /**
   * Flush whatever is left when the stream ends. An unterminated final line is
   * still a line; a truly empty tail yields nothing.
   */
  flush(): string[] {
    const tail = this.buffer.replace(/\r$/, "");
    const skipping = this.skipping;
    this.buffer = "";
    this.atStart = false;
    this.skipping = false;
    return tail.length > 0 && !skipping ? [tail] : [];
  }
}

/** Parse one NDJSON line. Blank lines and `:` comments yield `undefined`. */
export function parseNdjsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith(":")) {
    return undefined;
  }
  return JSON.parse(trimmed) as unknown;
}

/**
 * The minimum a sink must offer. A Node `Writable` satisfies it structurally;
 * so does a test double, which is the point — the writer's backpressure rule
 * is the thing under test, not a stream implementation.
 */
export interface NdjsonSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

/**
 * A backpressure-aware NDJSON writer.
 *
 * `write()` never returns a promise the caller has to await — diagnostics must
 * never block a turn (§3.1) — but it does honour `drain`: once the sink says
 * it is full, later records queue in memory instead of piling into the socket.
 * Past the 4 MiB queued-byte budget, records are **dropped**: an unbounded
 * queue lets a slow consumer exhaust host memory (§6.3 makes the same trade
 * for a slow stream).
 */
export class NdjsonWriter {
  private queue: string[] = [];
  private queuedBytes = 0;
  private draining = false;
  private closed = false;

  constructor(private readonly sink: NdjsonSink) {}

  /** Serialise and enqueue one record. Returns false when it was dropped. */
  write(record: unknown): boolean {
    if (this.closed) {
      return false;
    }
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // A cyclic or non-serialisable payload must not take the writer down.
      return false;
    }
    return this.writeLine(line);
  }

  /** Enqueue an already-serialised line (a `\n` is appended when missing). */
  writeLine(line: string): boolean {
    if (this.closed) {
      return false;
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.byteLength(payload);

    if (this.draining) {
      if (this.queuedBytes + bytes > 4 * 1024 * 1024) {
        return false;
      }
      this.queue.push(payload);
      this.queuedBytes += bytes;
      return true;
    }

    if (!this.sink.write(payload)) {
      this.draining = true;
      this.sink.once("drain", () => this.onDrain());
    }
    return true;
  }

  /** Stop accepting records and forget the queue. */
  close(): void {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
  }

  private onDrain(): void {
    this.draining = false;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(next);
      if (!this.sink.write(next)) {
        this.draining = true;
        this.sink.once("drain", () => this.onDrain());
        return;
      }
    }
    this.queuedBytes = 0;
  }
}
