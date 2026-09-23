import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeRegExp } from "./regexp.ts";

describe("escapeRegExp", () => {
  it("escapes every metacharacter so the escaped form matches the literal", () => {
    const literal = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o-p/q";
    assert.equal(new RegExp(`^(?:${escapeRegExp(literal)})$`, "u").test(literal), true);
    assert.equal(escapeRegExp(".*+?^${}()|[]\\"), "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\");
    assert.equal(new RegExp(escapeRegExp("a.b")).test("axb"), false);
  });

  it("leaves a plain word untouched", () => {
    assert.equal(escapeRegExp("review-skill"), "review-skill");
  });
});
