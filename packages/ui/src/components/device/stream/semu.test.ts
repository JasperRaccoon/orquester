import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSemuPacket } from "./semu.ts";
import { readWsFixture } from "./testing/fakes.ts";

const frames = readWsFixture("serve-emu-semu-v1.bin") as ArrayBuffer[];

/** Re-wrap a v1 packet as v2 (what serve-emu's Bun server sends): adds the u64 send time. */
function toV2(v1: ArrayBuffer, sendTimeUs: bigint): ArrayBuffer {
  const source = new Uint8Array(v1);
  const out = new Uint8Array(source.length + 8);
  out.set(source.subarray(0, 16));
  out[4] = 2;
  new DataView(out.buffer).setBigUint64(16, sendTimeUs);
  out.set(source.subarray(16), 24);
  return out.buffer;
}

describe("SEMU frame metadata", () => {
  it("parses the recorded expo-device-hub stream as v1 with keyframe flag and pts", () => {
    assert.ok(frames.length >= 5);
    const packets = frames.map((frame) => parseSemuPacket(frame));
    assert.deepEqual(
      packets.map((packet) => packet.isKey),
      [true, ...Array(frames.length - 1).fill(false)]
    );
    const pts = packets.map((packet) => packet.timestamp!);
    assert.deepEqual(pts, [42152605, 42481638, 42584979, 42685988, 42786445, 43456101, 43969561, 44469827, 44975995], "captured microsecond timestamps");
    // The payload starts at the first Annex-B start code.
    assert.deepEqual([...packets[0]!.data.subarray(0, 5)], [0, 0, 0, 1, 0x67]);
    assert.equal(packets[0]!.data.byteLength, frames[0]!.byteLength - 16);
  });

  it("parses v2 payloads after their extra server-time header", () => {
    const v2 = parseSemuPacket(toV2(frames[1]!, 1_793_074_131_428_500n));
    assert.equal(v2.isKey, false);
    assert.equal(v2.timestamp, 42481638);
    assert.deepEqual(v2.data, new Uint8Array(frames[1]!, 16));
  });

  it("parses headers inside a larger buffer (Uint8Array views)", () => {
    const padded = new Uint8Array(frames[0]!.byteLength + 7);
    padded.set(new Uint8Array(frames[0]!), 7);
    const packet = parseSemuPacket(padded.subarray(7));
    assert.equal(packet.isKey, true);
  });

  it("treats packets without the magic, unknown versions and bare headers as raw Annex-B", () => {
    const raw = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseSemuPacket(raw), { data: raw, isKey: null, timestamp: null });
    const v3 = new Uint8Array(frames[1]!.slice(0));
    v3[4] = 3;
    assert.deepEqual(parseSemuPacket(v3), { data: v3, isKey: null, timestamp: null });
    const bare = new Uint8Array(16);
    new DataView(bare.buffer).setUint32(0, 0x53454d55);
    bare[4] = 1;
    assert.deepEqual(parseSemuPacket(bare), { data: bare, isKey: null, timestamp: null });
    const v2Bare = new Uint8Array(24);
    new DataView(v2Bare.buffer).setUint32(0, 0x53454d55);
    v2Bare[4] = 2;
    assert.deepEqual(parseSemuPacket(v2Bare), { data: v2Bare, isKey: null, timestamp: null });
  });

  it("drops a pts beyond 2^53 rather than losing precision", () => {
    const big = new Uint8Array(frames[1]!.slice(0));
    new DataView(big.buffer).setBigUint64(8, 2n ** 60n);
    assert.equal(parseSemuPacket(big).timestamp, null);
  });
});
