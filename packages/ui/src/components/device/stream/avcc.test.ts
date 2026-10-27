import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AvccDemuxer, MAX_AVCC_ENVELOPE_BYTES } from "./avcc.ts";
import { encodeAvccEnvelope } from "./testing/fakes.ts";

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const description = Uint8Array.from([1, 100, 0, 51, 255, 225, 0, 4, 39, 100, 0, 51, 1, 0, 2, 40, 238]);
const keyframe = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
const delta = Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]);
const seed = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const stream = concat(
  encodeAvccEnvelope(4, seed),
  encodeAvccEnvelope(1, description),
  encodeAvccEnvelope(2, keyframe),
  encodeAvccEnvelope(3, delta)
);
const expected = [
  { type: "seed", payload: seed },
  { type: "description", payload: description },
  { type: "keyframe", payload: keyframe },
  { type: "delta", payload: delta }
];

describe("AvccDemuxer", () => {
  it("counts the tag byte in the envelope length (as serve-sim writes it)", () => {
    const envelope = encodeAvccEnvelope(3, delta);
    assert.equal(new DataView(envelope.buffer).getUint32(0), delta.length + 1);
    assert.deepEqual(new AvccDemuxer().push(envelope), [{ type: "delta", payload: delta }]);
  });

  it("reassembles envelopes split at every byte offset across two reads", () => {
    for (let split = 0; split <= stream.length; split++) {
      const demuxer = new AvccDemuxer();
      const chunks = [...demuxer.push(stream.subarray(0, split)), ...demuxer.push(stream.subarray(split))];
      assert.deepEqual(chunks, expected, `split at ${split}`);
      assert.equal(demuxer.pending, 0);
    }
  });

  it("reassembles a stream fed one byte per read", () => {
    const demuxer = new AvccDemuxer();
    const chunks = [];
    for (let i = 0; i < stream.length; i++) chunks.push(...demuxer.push(stream.subarray(i, i + 1)));
    assert.deepEqual(chunks, expected);
  });

  it("grows past its initial buffer for large keyframes", () => {
    const big = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) & 0xff);
    const envelope = encodeAvccEnvelope(2, big);
    const demuxer = new AvccDemuxer();
    assert.deepEqual(demuxer.push(envelope.subarray(0, 70_000)), []);
    assert.deepEqual(demuxer.push(envelope.subarray(70_000)), [{ type: "keyframe", payload: big }]);
  });

  it("skips unknown tags and empty envelopes", () => {
    const empty = new Uint8Array(4);
    const chunks = new AvccDemuxer().push(concat(encodeAvccEnvelope(9, seed), empty, encodeAvccEnvelope(3, delta)));
    assert.deepEqual(chunks, [{ type: "delta", payload: delta }]);
  });

  it("returns payload copies that survive later reads", () => {
    const demuxer = new AvccDemuxer();
    const [first] = demuxer.push(encodeAvccEnvelope(3, delta));
    demuxer.push(encodeAvccEnvelope(3, Uint8Array.from([9, 9, 9, 9, 9, 9])));
    assert.deepEqual(first!.payload, delta);
  });

  it("throws on an envelope length no screen frame has, and recovers after reset", () => {
    const demuxer = new AvccDemuxer();
    const bogus = new Uint8Array(8);
    new DataView(bogus.buffer).setUint32(0, MAX_AVCC_ENVELOPE_BYTES + 1);
    assert.throws(() => demuxer.push(bogus), /avcc envelope/);
    assert.equal(demuxer.pending, 0);
    assert.deepEqual(demuxer.push(encodeAvccEnvelope(3, delta)), [{ type: "delta", payload: delta }]);
  });
});
