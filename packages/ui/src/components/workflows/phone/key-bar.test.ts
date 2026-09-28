import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyKeyBarKey } from "./key-bar.ts";

describe("key bar", () => {
  it("a character replaces the selection; the caret goes after it", () => {
    assert.deepEqual(applyKeyBarKey("ab", 1, 1, ";"), { text: "a;b", selection: 2 });
    assert.deepEqual(applyKeyBarKey("abcd", 1, 3, "="), { text: "a=d", selection: 2 });
    assert.deepEqual(applyKeyBarKey("abcd", 3, 1, "|"), { text: "a|d", selection: 2 }, "a backwards selection too");
  });

  it("{{ }} puts the caret inside, or wraps the selection", () => {
    assert.deepEqual(applyKeyBarKey("Hi ", 3, 3, "expr"), { text: "Hi {{  }}", selection: 6 });
    assert.deepEqual(applyKeyBarKey("Hi input.name", 3, 13, "expr"), { text: "Hi {{ input.name }}", selection: 19 });
  });

  it("Tab indents by the editor's unit", () => {
    assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab"), { text: "  x", selection: 2 });
    assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab", "\t"), { text: "\tx", selection: 1 });
  });
});
