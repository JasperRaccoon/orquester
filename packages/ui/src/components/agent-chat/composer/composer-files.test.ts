import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeFilePath, textNamesPath } from "./composer-files.ts";

describe("file paths in the prompt", () => {
  it("removing a file drops its path and one adjacent space", () => {
    assert.equal(removeFilePath("see /t/a.xlsx now", "/t/a.xlsx"), "see now");
    assert.equal(removeFilePath("/t/a.xlsx", "/t/a.xlsx"), "");
    assert.equal(removeFilePath("look at /t/a.xlsx", "/t/a.xlsx"), "look at");
    assert.equal(removeFilePath("/t/a.xlsx then", "/t/a.xlsx"), "then");
    assert.equal(removeFilePath("nothing here", "/t/a.xlsx"), "nothing here");
  });

  it("a path against punctuation still goes, and only the path: no space is owed there", () => {
    // Neither space-taking alternative matches (`,` follows), so the bare one does.
    assert.equal(removeFilePath("see /t/a.xlsx, now", "/t/a.xlsx"), "see , now");
  });

  it("removes exactly one occurrence, so a path the user repeated stays", () => {
    assert.equal(removeFilePath("/t/a.xlsx and /t/a.xlsx", "/t/a.xlsx"), "and /t/a.xlsx");
  });

  it("treats the path literally: metacharacters in a name never widen the match", () => {
    assert.equal(removeFilePath("x /t/a(1).xlsx y", "/t/a(1).xlsx"), "x y");
    assert.equal(removeFilePath("x /t/a.xlsx y", "/t/a-xlsx"), "x /t/a.xlsx y");
    assert.equal(removeFilePath("x /t/a.xlsx y", ""), "x /t/a.xlsx y");
  });

  it("knows whether the text already names a path", () => {
    assert.equal(textNamesPath("see /t/a.xlsx", "/t/a.xlsx"), true);
    assert.equal(textNamesPath("see /t/b.xlsx", "/t/a.xlsx"), false);
    assert.equal(textNamesPath("anything", ""), false);
  });
});
