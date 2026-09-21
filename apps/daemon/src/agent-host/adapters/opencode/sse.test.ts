/**
 * `SseParser` / `readSseFrames` unit tests (spec §9).
 *
 * The committed fixtures store already-decoded frames, so the replay harness
 * never exercises this parser: multi-line `data:`, `:`-comment keep-alives,
 * CRLF and chunk boundaries landing mid-frame were verified by nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SseParser, readSseFrames } from "./sse.ts";

function framesFrom(chunks: readonly string[]): { data: string; event?: string; id?: string }[] {
  const parser = new SseParser();
  const out: { data: string; event?: string; id?: string }[] = [];
  for (const chunk of chunks) {
    out.push(...parser.push(chunk));
  }
  return out;
}

test("one frame per blank line, in order", () => {
  const frames = framesFrom(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ['{"a":1}', '{"b":2}']
  );
});

test("a frame split across chunk boundaries is reassembled", () => {
  // The boundary lands mid-field, mid-value and mid-terminator in turn.
  const frames = framesFrom(["da", "ta: hel", "lo wor", "ld\n", "\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["hello world"]
  );
});

test("multi-line data is joined with newlines, per the SSE spec", () => {
  const frames = framesFrom(["data: line one\ndata: line two\ndata: line three\n\n"]);
  assert.equal(frames[0]?.data, "line one\nline two\nline three");
});

test("`:`-comment keep-alives produce no frame and do not break the next one", () => {
  const frames = framesFrom([": keep-alive\n\n", "data: real\n\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["real"]
  );
});

test("CRLF line endings decode the same as LF", () => {
  const frames = framesFrom(["event: ping\r\ndata: payload\r\n\r\n"]);
  assert.equal(frames[0]?.data, "payload");
  assert.equal(frames[0]?.event, "ping");
});

test("`event` and `id` are carried, then reset for the next frame", () => {
  const frames = framesFrom(["event: a\nid: 1\ndata: first\n\n", "data: second\n\n"]);
  assert.equal(frames[0]?.event, "a");
  assert.equal(frames[0]?.id, "1");
  assert.equal(frames[1]?.event, undefined);
  assert.equal(frames[1]?.id, undefined);
});

test("one leading space after the colon is stripped, further ones are data", () => {
  const frames = framesFrom(["data:  two spaces\n\n"]);
  assert.equal(frames[0]?.data, " two spaces");
});

test("a field with no colon, and unknown fields, are ignored", () => {
  const frames = framesFrom(["retry: 5000\nfoo\ndata: kept\n\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["kept"]
  );
});

test("a blank line with no data emits nothing", () => {
  assert.deepEqual(framesFrom(["\n\n", "event: lonely\n\n"]), []);
});

test("an unterminated trailing frame is NOT emitted until its blank line", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: pending\n"), []);
  assert.deepEqual(
    parser.push("\n").map((frame) => frame.data),
    ["pending"]
  );
});

test("a BOM is stripped once, at the start of the STREAM", () => {
  // Regression: keying the strip on an empty remainder re-ran it after every
  // frame that ended on a chunk boundary, so a payload legitimately starting
  // with U+FEFF silently lost it.
  const parser = new SseParser();
  assert.deepEqual(
    parser.push("﻿data: first\n\n").map((frame) => frame.data),
    ["first"],
    "the stream's own BOM is stripped"
  );
  // A later chunk starting with U+FEFF is payload, not a BOM: the field name
  // becomes `﻿data`, which is not `data`, so nothing is emitted. Before
  // the fix the BOM was stripped again and this wrongly produced a frame.
  assert.deepEqual(parser.push("﻿data: second\n\n"), []);
});

test("a BOM mid-stream is preserved verbatim in the data", () => {
  const parser = new SseParser();
  parser.push("data: first\n\n");
  const frames = parser.push("data: ﻿bom-inside\n\n");
  assert.equal(frames[0]?.data, "﻿bom-inside");
});

// ---------------------------------------------------------------------------
// readSseFrames
// ---------------------------------------------------------------------------

function streamOf(chunks: readonly string[]): {
  body: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]!));
      index += 1;
    },
    cancel() {
      cancelled = true;
    }
  });
  return { body, cancelled: () => cancelled };
}

test("readSseFrames yields every frame and ends at EOF", async () => {
  const { body } = streamOf(["data: a\n\n", "data: b\n\n"]);
  const seen: string[] = [];
  for await (const frame of readSseFrames(body)) {
    seen.push(frame.data);
  }
  assert.deepEqual(seen, ["a", "b"]);
});

test("readSseFrames CANCELS the body when the consumer breaks out", async () => {
  // Regression: the `finally` only released the lock, leaving the fetch body
  // unconsumed and its socket open — one leaked connection per reconnect.
  const { body, cancelled } = streamOf(["data: a\n\n", "data: b\n\n", "data: c\n\n"]);
  for await (const frame of readSseFrames(body)) {
    assert.equal(frame.data, "a");
    break;
  }
  assert.equal(cancelled(), true);
});

test("readSseFrames cancels the body when the consumer throws", async () => {
  const { body, cancelled } = streamOf(["data: a\n\n", "data: b\n\n"]);
  const boom = new Error("handler blew up");
  await assert.rejects(
    (async () => {
      for await (const frame of readSseFrames(body)) {
        void frame;
        throw boom;
      }
    })(),
    (error: unknown) => error === boom
  );
  assert.equal(cancelled(), true);
});

test("readSseFrames does NOT cancel after a clean EOF", async () => {
  const { body, cancelled } = streamOf(["data: a\n\n"]);
  for await (const frame of readSseFrames(body)) {
    void frame;
  }
  assert.equal(cancelled(), false, "a drained stream needs no cancel");
});

test("readSseFrames on a null body ends immediately", async () => {
  const seen: unknown[] = [];
  for await (const frame of readSseFrames(null)) {
    seen.push(frame);
  }
  assert.deepEqual(seen, []);
});
