import assert from "node:assert/strict";
import { describe,it } from "node:test";

import {
NdjsonLineBuffer,
parseStreamLine
} from "./stream.logic";

describe("NdjsonLineBuffer", () => {
  it("splits complete lines and holds the partial one", () => {
    const buffer = new NdjsonLineBuffer();
    assert.deepEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
    assert.deepEqual(buffer.push('":2}\n'), ['{"b":2}']);
  });

});

describe("parseStreamLine", () => {
  it("reads the heartbeat comment as a heartbeat, not a frame", () => {
    assert.deepEqual(parseStreamLine(":hb"), { kind: "heartbeat" });
    assert.deepEqual(parseStreamLine(": anything"), { kind: "heartbeat" });
  });

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

  it("accepts an event whose payload carries fields this bundle does not know", () => {
    const line = JSON.stringify({
      kind: "event",
      seq: 9,
      event: { type: "thread.created", seq: 9, payload: { futureField: true } }
    });
    assert.equal(parseStreamLine(line).kind, "frame");
  });
});
