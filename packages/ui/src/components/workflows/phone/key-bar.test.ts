import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyKeyBarKey, keyBarInsertion, keyBarKeys } from "./key-bar.ts";

describe("key bar", () => {
  it("offers Tab, {{ }} and the hidden characters, in order", () => {
    const ids = keyBarKeys().map((key) => key.id);
    assert.deepEqual(ids.slice(0, 2), ["tab", "expr"]);
    for (const char of ["{", "}", "(", ")", "[", "]", ";", ":", '"', "'", "=", "<", ">", "/", "\\", "|", "$"]) {
      assert.ok(ids.includes(char), char);
    }
    assert.equal(keyBarKeys({ templates: false }).some((key) => key.id === "expr"), false, "a code editor has no templates");
    assert.ok(keyBarKeys().every((key) => key.title.length > 0));
  });

  it("a character replaces the selection; the caret goes after it", () => {
    assert.deepEqual(applyKeyBarKey("ab", 1, 1, ";"), { text: "a;b", selection: 2 });
    assert.deepEqual(applyKeyBarKey("abcd", 1, 3, "="), { text: "a=d", selection: 2 });
    assert.deepEqual(applyKeyBarKey("abcd", 3, 1, "|"), { text: "a|d", selection: 2 }, "a backwards selection too");
  });

  it("{{ }} puts the caret inside, or wraps the selection", () => {
    assert.deepEqual(keyBarInsertion("expr"), { text: "{{  }}", caret: 3 });
    assert.deepEqual(applyKeyBarKey("Hi ", 3, 3, "expr"), { text: "Hi {{  }}", selection: 6 });
    assert.deepEqual(applyKeyBarKey("Hi input.name", 3, 13, "expr"), { text: "Hi {{ input.name }}", selection: 19 });
  });

  it("Tab indents by the editor's unit", () => {
    assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab"), { text: "  x", selection: 2 });
    assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab", "\t"), { text: "\tx", selection: 1 });
  });

  it("an out-of-range selection is clamped", () => {
    assert.deepEqual(applyKeyBarKey("ab", 9, 12, "$"), { text: "ab$", selection: 3 });
  });
});
