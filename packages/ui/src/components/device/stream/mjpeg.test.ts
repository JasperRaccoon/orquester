import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MjpegParser, multipartBoundary } from "./mjpeg.ts";

const enc = new TextEncoder();
const jpeg = (n: number, length = 40) =>
  Uint8Array.from({ length }, (_, i) => (i === 0 ? 0xff : i === 1 ? 0xd8 : (n * 31 + i) & 0xff));
const concat = (...parts: Array<Uint8Array | string>) => {
  const bytes = parts.map((part) => (typeof part === "string" ? enc.encode(part) : part));
  const out = new Uint8Array(bytes.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of bytes) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
/** Exactly what serve-sim writes per frame. */
const serveSimPart = (body: Uint8Array) =>
  concat(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`, body, "\r\n");

function parseInSplits(parser: () => MjpegParser, bytes: Uint8Array, split: number): Uint8Array[] {
  const p = parser();
  return [...p.push(bytes.subarray(0, split)), ...p.push(bytes.subarray(split))];
}

describe("multipartBoundary", () => {
  it("reads plain, quoted, dash-prefixed and case-varied boundary parameters", () => {
    assert.equal(multipartBoundary("multipart/x-mixed-replace; boundary=frame"), "frame");
    assert.equal(multipartBoundary('multipart/x-mixed-replace;boundary="my frame"'), "my frame");
    assert.equal(multipartBoundary("multipart/x-mixed-replace; BOUNDARY=--frame; charset=x"), "frame");
    assert.equal(multipartBoundary("multipart/x-mixed-replace ; boundary = abc"), "abc");
  });

  it("returns null without a boundary", () => {
    assert.equal(multipartBoundary("image/jpeg"), null);
    assert.equal(multipartBoundary(null), null);
    assert.equal(multipartBoundary("multipart/x-mixed-replace; boundary="), null);
  });
});

describe("MjpegParser", () => {
  const frames = [jpeg(1), jpeg(2, 3), jpeg(3, 500)];
  const stream = concat(...frames.map(serveSimPart));

  it("parses serve-sim parts split at every byte offset", () => {
    for (let split = 0; split <= stream.length; split++) {
      assert.deepEqual(parseInSplits(() => new MjpegParser("frame"), stream, split), frames, `split at ${split}`);
    }
  });

  it("parses a stream fed one byte per read", () => {
    const parser = new MjpegParser("frame");
    const out = [];
    for (let i = 0; i < stream.length; i++) out.push(...parser.push(stream.subarray(i, i + 1)));
    assert.deepEqual(out, frames);
  });

  it("finds part ends by delimiter when Content-Length is missing", () => {
    const body = concat(jpeg(4), "\r\n--fram", jpeg(5)); // a near-miss delimiter inside the body
    const bytes = concat(
      "--frame\r\nContent-Type: image/jpeg\r\n\r\n",
      body,
      "\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n",
      jpeg(6),
      "\r\n--frame\r\n"
    );
    for (let split = 0; split <= bytes.length; split++) {
      assert.deepEqual(parseInSplits(() => new MjpegParser("frame"), bytes, split), [body, jpeg(6)], `split at ${split}`);
    }
  });

  it("accepts LF-only line endings, a preamble, padding after the boundary and odd header case", () => {
    const bytes = concat(
      "preamble text\r\n",
      "--frame  \ncontent-length: 40\nX-Other: 1\n\n",
      jpeg(7),
      "\n--frame\ncontent-type: image/jpeg\n\n",
      jpeg(8),
      "\n--frame\n"
    );
    assert.deepEqual(new MjpegParser("frame").push(bytes), [jpeg(7), jpeg(8)]);
  });

  it("stops at the closing delimiter", () => {
    const parser = new MjpegParser("frame");
    const out = parser.push(concat(serveSimPart(jpeg(9)), "--frame--\r\n", serveSimPart(jpeg(10))));
    assert.deepEqual(out, [jpeg(9)]);
    assert.equal(parser.done, true);
    assert.deepEqual(parser.push(serveSimPart(jpeg(11))), []);
  });

  it("keeps working after many frames (buffer compaction) and with large frames", () => {
    const parser = new MjpegParser("frame");
    const big = jpeg(12, 700_000);
    let count = 0;
    for (let i = 0; i < 50; i++) count += parser.push(serveSimPart(i % 10 === 0 ? big : jpeg(i))).length;
    assert.equal(count, 50);
  });

  it("throws on a Content-Length beyond the frame limit", () => {
    const parser = new MjpegParser("frame");
    assert.throws(() => parser.push(enc.encode("--frame\r\nContent-Length: 999999999\r\n\r\n")), /size limit/);
  });
});
