import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NdjsonLineBuffer,
  parseStreamLine,
  RECONNECT_MAX_MS,
  reconnectDelayMs,
  resumeCursorFor,
  shouldApplyFrame
} from "./stream.logic";

describe("NdjsonLineBuffer", () => {
  it("splits complete lines and holds the partial one", () => {
    const buffer = new NdjsonLineBuffer();
    assert.deepEqual(buffer.push('{"a":1}\n{"b'), ['{"a":1}']);
    assert.equal(buffer.rest(), '{"b');
    assert.deepEqual(buffer.push('":2}\n'), ['{"b":2}']);
    assert.equal(buffer.rest(), "");
  });

  it("handles a chunk boundary inside a line and several lines at once", () => {
    const buffer = new NdjsonLineBuffer();
    assert.deepEqual(buffer.push("a"), []);
    assert.deepEqual(buffer.push("b\nc\nd"), ["ab", "c"]);
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

  it("decodes the three frame kinds", () => {
    const snapshot = parseStreamLine(JSON.stringify({ kind: "snapshot", thread: { seq: 3, items: [] } }));
    assert.equal(snapshot.kind, "frame");
    const event = parseStreamLine(
      JSON.stringify({ kind: "event", seq: 4, event: { type: "thread.created", seq: 4 } })
    );
    assert.equal(event.kind, "frame");
    const sync = parseStreamLine(JSON.stringify({ kind: "synchronized", hostInstanceId: "h1" }));
    assert.equal(sync.kind, "frame");
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

describe("reconnectDelayMs", () => {
  it("grows exponentially and is capped", () => {
    const fixed = () => 1;
    assert.equal(reconnectDelayMs(0, fixed), 500);
    assert.equal(reconnectDelayMs(1, fixed), 1000);
    assert.equal(reconnectDelayMs(2, fixed), 2000);
    assert.equal(reconnectDelayMs(20, fixed), RECONNECT_MAX_MS);
  });

  it("applies full jitter between half and the full delay", () => {
    assert.equal(reconnectDelayMs(1, () => 0), 500);
    assert.equal(reconnectDelayMs(1, () => 1), 1000);
  });
});

describe("resumeCursorFor", () => {
  it("resumes by sequence on the same host", () => {
    assert.equal(
      resumeCursorFor({ lastSeq: 12, knownHostInstanceId: "h1", observedHostInstanceId: "h1" }),
      12
    );
  });

  it("asks for a snapshot when the host instance changed", () => {
    assert.equal(
      resumeCursorFor({ lastSeq: 12, knownHostInstanceId: "h1", observedHostInstanceId: "h2" }),
      undefined
    );
  });

  it("asks for a snapshot from a cold start", () => {
    assert.equal(
      resumeCursorFor({ lastSeq: 0, knownHostInstanceId: null, observedHostInstanceId: null }),
      undefined
    );
  });
});

describe("shouldApplyFrame", () => {
  it("drops events at or below the cursor and keeps the rest", () => {
    const at = (seq: number) =>
      shouldApplyFrame({ kind: "event", seq, event: { seq } as never }, 5);
    assert.equal(at(5), false);
    assert.equal(at(4), false);
    assert.equal(at(6), true);
  });

  it("always applies a snapshot, which replaces loaded history", () => {
    assert.equal(
      shouldApplyFrame({ kind: "snapshot", thread: { seq: 1 } as never }, 100),
      true
    );
  });
});
