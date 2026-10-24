import assert from "node:assert/strict";
import { describe,it } from "node:test";

import {
NdjsonLineBuffer,
parseStreamLine
} from "./stream.logic";

describe("NdjsonLineBuffer", () => {
  it("splits a stream the same however it is chunked, a long line included", () => {
    const text = `${"x".repeat(50_000)}\n{"a":1}\n\n:hb\n{"b":"${"y".repeat(7_000)}"}\n{"tail`;
    const expected = text.split("\n").slice(0, -1);
    for (const size of [1, 7, 1400, 4096, text.length]) {
      const buffer = new NdjsonLineBuffer();
      const lines: string[] = [];
      for (let offset = 0; offset < text.length; offset += size) lines.push(...buffer.push(text.slice(offset, offset + size)));
      assert.deepEqual(lines, expected, `chunks of ${size}`);
      assert.deepEqual(buffer.push("\"}\n"), ['{"tail"}'], "the open line is kept across chunks");
      buffer.reset();
      assert.deepEqual(buffer.push("z\n"), ["z"], "a reset drops the open line");
    }
  });


  it("splits complete lines and holds the partial one", () => {
    const buffer = new NdjsonLineBuffer();
    assert.deepEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
    assert.deepEqual(buffer.push('":2}\n'), ['{"b":2}']);
  });

  it("closes a line held across many chunks, and keeps empty lines and a reset", () => {
    const buffer = new NdjsonLineBuffer();
    assert.deepEqual(buffer.push('{"snap'), []);
    assert.deepEqual(buffer.push(""), []);
    assert.deepEqual(buffer.push("shot"), []);
    assert.deepEqual(buffer.push('":1}\n\n:hb\n{"x'), ['{"snapshot":1}', "", ":hb"]);
    buffer.reset();
    assert.deepEqual(buffer.push('"y":2}\n'), ['"y":2}']);
    assert.deepEqual(buffer.push("\n"), [""]);
  });

  it("yields the lines the whole text splits into, however it is chunked", () => {
    // The previous implementation, kept here as the reference the linear one must match.
    const reference = (chunks: readonly string[]): string[] => {
      let held = "";
      const out: string[] = [];
      for (const chunk of chunks) {
        held += chunk;
        let newline = held.indexOf("\n");
        while (newline !== -1) {
          out.push(held.slice(0, newline));
          held = held.slice(newline + 1);
          newline = held.indexOf("\n");
        }
      }
      return out;
    };
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const alphabet = ['{"a":1}', "\n", "é", "x", ":hb", "\n\n", '"', "ü"];
    for (let round = 0; round < 200; round += 1) {
      let text = "";
      const parts = Math.floor(random() * 60);
      for (let index = 0; index < parts; index += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      const chunks: string[] = [];
      for (let at = 0; at < text.length; ) {
        const size = Math.floor(random() * 9);
        chunks.push(text.slice(at, at + size));
        at += size;
      }
      const buffer = new NdjsonLineBuffer();
      assert.deepEqual(
        chunks.flatMap((chunk) => buffer.push(chunk)),
        reference(chunks),
        JSON.stringify(chunks)
      );
    }
  });
});

describe("parseStreamLine", () => {

  it("skips blank lines", () => {
    assert.deepEqual(parseStreamLine(""), { kind: "blank" });
    assert.deepEqual(parseStreamLine("   "), { kind: "blank" });
  });

  it("rejects malformed JSON and structurally wrong frames without throwing", () => {
    assert.equal(parseStreamLine("{not json").kind, "malformed");
    assert.equal(parseStreamLine(JSON.stringify({ kind: "event", seq: "x" })).kind, "malformed");
    assert.equal(parseStreamLine(JSON.stringify({ kind: "snapshot" })).kind, "malformed");
    assert.equal(parseStreamLine(JSON.stringify({ kind: "synchronized" })).kind, "malformed");
    assert.equal(parseStreamLine(JSON.stringify({ kind: "who" })).kind, "malformed");
    assert.equal(parseStreamLine(JSON.stringify([1, 2])).kind, "malformed");
  });

  it("accepts a history-import progress frame and rejects a malformed one", () => {
    const frame = (progress: unknown) => JSON.stringify({ kind: "history-import", progress });
    assert.equal(parseStreamLine(frame({ phase: "reading", done: 0, total: null })).kind, "frame");
    assert.equal(parseStreamLine(frame({ phase: "importing", done: 5, total: 9 })).kind, "frame");
    assert.equal(parseStreamLine(frame({ phase: "later", done: 0, total: null })).kind, "malformed");
    assert.equal(parseStreamLine(frame({ phase: "done", done: "0", total: 0 })).kind, "malformed");
    assert.equal(parseStreamLine(frame(null)).kind, "malformed");
  });

  it("decodes the host's error line, its code kept only when it is a known one", () => {
    assert.deepEqual(parseStreamLine(JSON.stringify({ kind: "error", code: "THREAD_NOT_FOUND", message: "gone" })), {
      kind: "error",
      error: { kind: "error", code: "THREAD_NOT_FOUND", message: "gone" }
    });
    assert.deepEqual(parseStreamLine(JSON.stringify({ kind: "error", code: "NEW_CODE", message: "x" })), {
      kind: "error",
      error: { kind: "error", message: "x" }
    });
    assert.equal(parseStreamLine(JSON.stringify({ kind: "error" })).kind, "malformed");
  });

  it("accepts an event whose payload carries fields this bundle does not know", () => {
    const line = JSON.stringify({
      kind: "event",
      seq: 9,
      event: { type: "thread.created", seq: 9, payload: { futureField: true } }
    });
    assert.equal(parseStreamLine(line).kind, "frame");
  });
});
