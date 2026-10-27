// Adapted in part from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/stream.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codecFromAvcC, codecFromSps, scanAccessUnit } from "./h264.ts";
import { parseSemuPacket } from "./semu.ts";
import { readWsFixture } from "./testing/fakes.ts";

// serve-sim's fallback-encoder avcC (High 5.1), from T3 Code's avcConfig fixtures.
const serveSimAvcC = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40, 238, 60, 176
]);

describe("H.264 codec strings", () => {
  it("reads profile, constraints and level from an avcC record", () => {
    assert.equal(codecFromAvcC(serveSimAvcC), "avc1.640033");
    assert.equal(codecFromAvcC(serveSimAvcC.subarray(0, 3)), null);
    assert.equal(codecFromAvcC(Uint8Array.from([0, 100, 0, 51])), null);
  });

  it("reads the codec from the recorded Android emulator SPS (Baseline, level 3.2)", () => {
    const first = readWsFixture("serve-emu-semu-v1.bin")[0] as ArrayBuffer;
    const { sps, isKey } = scanAccessUnit(parseSemuPacket(first).data);
    assert.equal(isKey, true);
    assert.ok(sps);
    assert.equal(codecFromSps(sps), "avc1.42c020");
  });

  it("rejects a non-SPS NAL and short input", () => {
    assert.equal(codecFromSps(Uint8Array.from([0x68, 0x42, 0, 0x1f])), null);
    assert.equal(codecFromSps(Uint8Array.from([0x67, 0x42])), null);
  });
});

describe("scanAccessUnit", () => {
  it("finds SPS and IDR NAL units behind 3- and 4-byte start codes", () => {
    const unit = Uint8Array.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x20, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x65, 0x88]);
    const scanned = scanAccessUnit(unit);
    assert.equal(scanned.isKey, true);
    assert.deepEqual([...scanned.sps!.subarray(0, 4)], [0x67, 0x42, 0xc0, 0x20]);
  });

  it("reports a delta slice as not key and ignores a start code at the very end", () => {
    assert.deepEqual(scanAccessUnit(Uint8Array.from([0, 0, 1, 0x41, 0x9a])), { isKey: false, sps: null });
    assert.deepEqual(scanAccessUnit(Uint8Array.from([0x41, 0, 0, 1])), { isKey: false, sps: null });
  });

});
