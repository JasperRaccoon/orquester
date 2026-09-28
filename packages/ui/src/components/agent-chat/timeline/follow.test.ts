import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldAnimateFollow } from "./follow";

test("snaps when the user prefers reduced motion, even mid-turn", () => {
  for (const overrides of [{}, { settling: true }, { firstPaint: true }]) {
    assert.equal(shouldAnimateFollow({
      working: true,
      reducedMotion: true,
      firstPaint: false,
      settling: false,
      ...overrides
    }), false);
  }
});
