/**
 * Agent host — a minimal SSE reader for OpenCode's `GET /event`.
 *
 * `@opencode-ai/sdk` would bring its own; this is ~60 lines against a stream
 * whose every frame is a single `data:` line of JSON (verified across all 14
 * captures in `apps/daemon/test/fixtures/opencode/`). Written to the spec
 * rather than to the observed shape, so a future multi-line `data:` or a
 * comment keep-alive still decodes.
 */

/** One decoded SSE frame. `event` is absent on OpenCode's stream. */
export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incremental SSE parser. Feed decoded text; get back the frames it completed.
 * Carries a remainder across chunk boundaries and tolerates `\r\n`, a UTF-8
 * BOM and `:`-comment keep-alives.
 */
export class SseParser {
  private remainder = "";
  private event: string | undefined;
  private id: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.remainder += this.remainder.length === 0 ? chunk.replace(/^﻿/, "") : chunk;
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const nl = this.remainder.indexOf("\n", start);
      if (nl === -1) {
        break;
      }
      let end = nl;
      if (end > start && this.remainder.charCodeAt(end - 1) === 13) {
        end -= 1;
      }
      const line = this.remainder.slice(start, end);
      start = nl + 1;

      if (line.length === 0) {
        const frame = this.take();
        if (frame !== null) {
          frames.push(frame);
        }
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "data") {
        this.data.push(value);
      } else if (field === "event") {
        this.event = value;
      } else if (field === "id") {
        this.id = value;
      }
      // `retry:` and unknown fields are ignored, per the SSE spec.
    }
    this.remainder = this.remainder.slice(start);
    return frames;
  }

  private take(): SseFrame | null {
    if (this.data.length === 0) {
      this.event = undefined;
      this.id = undefined;
      return null;
    }
    const frame: SseFrame = {
      ...(this.event !== undefined ? { event: this.event } : {}),
      ...(this.id !== undefined ? { id: this.id } : {}),
      data: this.data.join("\n")
    };
    this.event = undefined;
    this.id = undefined;
    this.data = [];
    return frame;
  }
}

/**
 * Read a `text/event-stream` response body as decoded frames. Ends when the
 * body ends (the server went away, or the caller aborted the fetch).
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array> | null
): AsyncGenerator<SseFrame> {
  if (body === null) {
    return;
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
        yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
