import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { NdjsonLineReader, NdjsonWriter, parseNdjsonLine } from "./ndjson.ts";

test("line reader carries a remainder across chunk boundaries", () => {
  const reader = new NdjsonLineReader();
  assert.deepEqual(reader.push('{"a":'), []);
  assert.deepEqual(reader.push('1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(reader.flush(), []);
});

test("line reader strips CRLF and never emits a phantom blank line on a split CRLF", () => {
  const reader = new NdjsonLineReader();
  // The chunk ends on the CR of a CRLF.
  assert.deepEqual(reader.push("one\r"), []);
  assert.deepEqual(reader.push("\ntwo\r\n"), ["one", "two"]);
  assert.deepEqual(reader.flush(), []);
});

test("line reader strips a leading BOM exactly once", () => {
  const reader = new NdjsonLineReader();
  assert.deepEqual(reader.push('﻿{"a":1}\n﻿tail\n'), ['{"a":1}', "﻿tail"]);
});

test("line reader flushes an unterminated final line", () => {
  const reader = new NdjsonLineReader();
  assert.deepEqual(reader.push("a\nb"), ["a"]);
  assert.deepEqual(reader.flush(), ["b"]);
  assert.deepEqual(reader.flush(), []);
});

test("line reader decodes a multi-byte codepoint split across chunks", () => {
  const reader = new NdjsonLineReader();
  const bytes = Buffer.from("é\n", "utf8");
  assert.deepEqual(reader.push(bytes.subarray(0, 1)), []);
  assert.deepEqual(reader.push(bytes.subarray(1)), ["é"]);
});

test("parseNdjsonLine skips blanks and comments", () => {
  assert.equal(parseNdjsonLine(""), undefined);
  assert.equal(parseNdjsonLine("   "), undefined);
  assert.equal(parseNdjsonLine(":hb"), undefined);
  assert.deepEqual(parseNdjsonLine(' {"a":1} '), { a: 1 });
});

/** A sink that reports "full" until `release()` emits drain, like a real socket. */
class FakeSink extends EventEmitter {
  written: string[] = [];
  accepting = true;

  write(chunk: string): boolean {
    this.written.push(chunk);
    return this.accepting;
  }

  release(): void {
    this.accepting = true;
    this.emit("drain");
  }
}

test("writer queues behind backpressure and flushes in order on drain", () => {
  const sink = new FakeSink();
  const writer = new NdjsonWriter(sink);

  sink.accepting = false;
  writer.write({ n: 1 }); // goes straight through, sink then says full
  assert.equal(writer.isBackpressured, true);

  writer.write({ n: 2 });
  writer.write({ n: 3 });
  assert.deepEqual(sink.written, ['{"n":1}\n']);
  assert.ok(writer.pendingBytes > 0);

  sink.release();
  assert.deepEqual(sink.written, ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']);
  assert.equal(writer.pendingBytes, 0);
  assert.equal(writer.isBackpressured, false);
});

test("writer drops rather than growing past the queue budget", () => {
  const sink = new FakeSink();
  const dropped: number[] = [];
  // One queued record (25 bytes) fits; the second would take it past 40.
  const writer = new NdjsonWriter(sink, { maxQueuedBytes: 40, onDrop: (n) => dropped.push(n) });

  sink.accepting = false;
  writer.write({ a: 1 });
  assert.equal(writer.write({ padding: "0123456789" }), true);
  assert.equal(writer.write({ padding: "0123456789" }), false, "second queued record drops");
  assert.equal(writer.droppedCount, 1);
  assert.equal(dropped.length, 1);
});

test("writer survives a non-serialisable record without taking the stream down", () => {
  const sink = new FakeSink();
  const writer = new NdjsonWriter(sink);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assert.equal(writer.write(cyclic), false);
  assert.equal(writer.write({ ok: true }), true);
  assert.deepEqual(sink.written, ['{"ok":true}\n']);
});

test("writer appends the newline only when missing, and stops after close", () => {
  const sink = new FakeSink();
  const writer = new NdjsonWriter(sink);
  writer.writeLine('{"a":1}');
  writer.writeLine('{"b":2}\n');
  writer.close();
  writer.writeLine('{"c":3}');
  assert.deepEqual(sink.written, ['{"a":1}\n', '{"b":2}\n']);
});
