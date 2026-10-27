// Adapted from T3 Code (MIT, Copyright 2026 T3 Tools Inc.): packages/client-runtime/src/device/avcConfig.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { simulatorAvcConfig } from "./avcConfig.ts";

// Captured from the hub before and after its encoder falls back from low-latency rate control.
const lowLatency = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154, 129,
  1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176,
]);
const fallback = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40,
  238, 60, 176,
]);
const repaired = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35,
  80, 1, 0, 4, 40, 238, 60, 176,
]);

describe("simulator AVC reorder metadata", () => {
  it("adds zero reordering and one reference frame to the captured fallback SPS", () => {
    const original = fallback.slice();
    assert.deepEqual(simulatorAvcConfig(fallback), repaired);
    assert.deepEqual(simulatorAvcConfig(repaired), repaired);
    assert.deepEqual(fallback, original, "the recorded input is never mutated");
    assert.deepEqual(simulatorAvcConfig(lowLatency), lowLatency, "existing VUI is preserved");
  });

  it("repairs multiple SPS entries while preserving PPS and profile extensions", () => {
    const extensions = [0xfd, 0xf8, 0xf8, 0];
    const description = Uint8Array.from([
      ...fallback.subarray(0, 5),
      0xe2,
      ...fallback.subarray(6, 20),
      ...lowLatency.subarray(6, 30),
      ...fallback.subarray(20),
      ...extensions,
    ]);
    assert.deepEqual(
      simulatorAvcConfig(description),
      Uint8Array.from([
        ...description.subarray(0, 6),
        ...repaired.subarray(6, 25),
        ...lowLatency.subarray(6, 30),
        ...fallback.subarray(20),
        ...extensions,
      ]),
    );
  });

  it("preserves unsupported, truncated and malformed codec descriptions", () => {
    for (const config of [fallback, lowLatency]) {
      for (let length = 0; length < config.length; length++) {
        const truncated = config.subarray(0, length);
        assert.deepEqual(simulatorAvcConfig(truncated), truncated);
      }
    }

    const unsupportedProfile = fallback.slice();
    unsupportedProfile[9] = 110;
    const scalingLists = fallback.slice();
    scalingLists[12] = scalingLists[12]! | 1;
    const invalidSpsLength = fallback.slice();
    invalidSpsLength[6] = 0xff;
    const invalidPpsLength = fallback.slice();
    invalidPpsLength[21] = 0xff;
    for (const config of [unsupportedProfile, scalingLists, invalidSpsLength, invalidPpsLength]) {
      assert.deepEqual(simulatorAvcConfig(config), config);
    }

    const invalidPadding = fallback.slice();
    invalidPadding[19] = 0;
    assert.deepEqual(simulatorAvcConfig(invalidPadding), invalidPadding);

    const forbiddenBit = fallback.slice();
    forbiddenBit[8] = forbiddenBit[8]! | 0x80;
    assert.deepEqual(simulatorAvcConfig(forbiddenBit), forbiddenBit);
    const unterminated = fallback.slice();
    unterminated.fill(0, 12, 20);
    assert.deepEqual(simulatorAvcConfig(unterminated), unterminated);
    const overlong = Uint8Array.from([
      ...fallback.subarray(0, 6),
      0,
      13,
      39,
      100,
      0,
      51,
      0,
      0,
      3,
      0,
      0,
      3,
      0,
      0,
      0,
      ...fallback.subarray(20),
    ]);
    assert.deepEqual(simulatorAvcConfig(overlong), overlong);

    const oversizedConfig = new Uint8Array(64 * 1024 + 1);
    oversizedConfig.set(fallback);
    assert.deepEqual(simulatorAvcConfig(oversizedConfig), oversizedConfig);
    const oversizedSps = new Uint8Array(6 + 2 + 4097 + 7);
    oversizedSps.set(fallback.subarray(0, 6));
    oversizedSps.set([0x10, 1], 6);
    oversizedSps.set(fallback.subarray(8, 20), 8);
    oversizedSps.set(fallback.subarray(20), 8 + 4097);
    assert.deepEqual(simulatorAvcConfig(oversizedSps), oversizedSps);
  });
});
