import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isSingleEmoji } from "./repo-identities.ts";

const FAMILY = "👨‍👩‍👧‍👦";
const COUPLE = "👩‍❤️‍👨";
const ENGLAND = "🏴󠁧󠁢󠁥󠁮󠁧󠁿";
const FLAG = "🇵🇦";
const KEYCAP = "1️⃣";

const cases: Array<[string, boolean]> = [
  ["🦝", true],
  [FAMILY, true],
  [COUPLE, true],
  [ENGLAND, true],
  [FLAG, true],
  [KEYCAP, true],
  ["👍🏽", true],
  ["", false],
  ["a", false],
  ["a🦝", false],
  ["🦝 ", false],
  ["🦝\u0000", false]
];

describe("isSingleEmoji", () => {
  it("accepts exactly one emoji grapheme", () => {
    for (const [value, expected] of cases) assert.equal(isSingleEmoji(value), expected, JSON.stringify(value));
    assert.equal(isSingleEmoji("🦝🦝"), false);
  });

  describe("without Intl.Segmenter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    afterEach(() => {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    });

    it("falls back to a conservative check instead of throwing", () => {
      Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true, writable: true });
      assert.equal(typeof Intl.Segmenter, "undefined");
      for (const [value, expected] of cases) assert.equal(isSingleEmoji(value), expected, JSON.stringify(value));
      assert.equal(isSingleEmoji("🦝 "), false, "no whitespace of any kind");
      assert.equal(isSingleEmoji("🦝🦝🦝🦝🦝🦝🦝🦝🦝🦝🦝"), false, "too many code points (and bytes)");
      assert.equal(isSingleEmoji("©".repeat(11)), false, "too many code points within the byte cap");
    });
  });
});
