/**
 * `readSseFrames` protocol tests (spec §9).
 *
 * The committed fixtures store already-decoded frames, so the replay harness
 * never exercises this parser: multi-line `data:`, `:`-comment keep-alives,
 * CRLF and chunk boundaries landing mid-frame were verified by nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readSseFrames } from "./sse.ts";

async function framesFrom(chunks: readonly string[]): Promise<{ data: string; event?: string; id?: string }[]> {
  const out: { data: string; event?: string; id?: string }[] = [];
  for await (const frame of readSseFrames(streamOf(chunks).body)) {
    out.push(frame);
  }
  return out;
}

test("a frame split across chunk boundaries is reassembled", async () => {
  // The boundary lands mid-field, mid-value and mid-terminator in turn.
  const frames = await framesFrom(["da", "ta: hel", "lo wor", "ld\n", "\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["hello world"]
  );
});

test("multi-line data is joined with newlines, per the SSE spec", async () => {
  const frames = await framesFrom(["data: line one\ndata: line two\ndata: line three\n\n"]);
  assert.equal(frames[0]?.data, "line one\nline two\nline three");
});

test("`:`-comment keep-alives produce no frame and do not break the next one", async () => {
  const frames = await framesFrom([": keep-alive\n\n", "data: real\n\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["real"]
  );
});

test("CRLF line endings decode the same as LF", async () => {
  const frames = await framesFrom(["event: ping\r\ndata: payload\r\n\r\n"]);
  assert.equal(frames[0]?.data, "payload");
  assert.equal(frames[0]?.event, "ping");
});

test("one leading space after the colon is stripped, further ones are data", async () => {
  const frames = await framesFrom(["data:  two spaces\n\n"]);
  assert.equal(frames[0]?.data, " two spaces");
});

test("a field with no colon, and unknown fields, are ignored", async () => {
  const frames = await framesFrom(["retry: 5000\nfoo\ndata: kept\n\n"]);
  assert.deepEqual(
    frames.map((frame) => frame.data),
    ["kept"]
  );
});

test("a blank line with no data emits nothing", async () => {
  assert.deepEqual(await framesFrom(["\n\n", "event: lonely\n\n"]), []);
});

test("an unterminated trailing frame is NOT emitted until its blank line", async () => {
  assert.deepEqual(await framesFrom(["data: pending\n"]), []);
  assert.deepEqual((await framesFrom(["data: pending\n", "\n"])).map((frame) => frame.data), ["pending"]);
});

test("a BOM is stripped once, at the start of the STREAM", async () => {
  const frames = await framesFrom(["\uFEFFdata: first\n\n", "\uFEFFdata: second\n\n"]);
  assert.deepEqual(frames.map((frame) => frame.data), ["first"]);
});

test("a BOM mid-stream is preserved verbatim in the data", async () => {
  const frames = await framesFrom(["data: first\n\n", "data: \uFEFFbom-inside\n\n"]);
  assert.deepEqual(frames.map((frame) => frame.data), ["first", "\uFEFFbom-inside"]);
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

test("readSseFrames on a null body ends immediately", async () => {
  const seen: unknown[] = [];
  for await (const frame of readSseFrames(null)) {
    seen.push(frame);
  }
  assert.deepEqual(seen, []);
});
