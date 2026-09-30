import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalDuration } from "./durations.ts";

describe("canonicalDuration", () => {
  it("converts typed values to the canonical unit without float noise", () => {
    assert.equal(canonicalDuration(0.5, "hours", "minutes"), 30);
    assert.equal(canonicalDuration(0.1, "hours", "minutes"), 6);
    assert.equal(canonicalDuration(1 / 3, "hours", "minutes"), 20);
    assert.equal(canonicalDuration(1.5, "minutes", "seconds"), 90);
  });

  it("clamps in the canonical unit, never at a converted bound", () => {
    // 0 h with a 1 min floor stores 1 min exactly (the converted floor would be 0.016667 h → 1.00002 min).
    assert.equal(canonicalDuration(0, "hours", "minutes", 1, 1440), 1);
    assert.equal(canonicalDuration(30, "hours", "minutes", 1, 1440), 1440);
    assert.equal(canonicalDuration(2, "days", "minutes", 1, 10080), 2880);
    assert.equal(canonicalDuration(-4, "seconds", "seconds", 0, 3600), 0);
  });
});
