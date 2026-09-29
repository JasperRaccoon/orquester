import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeFilePath } from "./composer-files.ts";

describe("file paths in the prompt", () => {
  it("removing a file drops its path and one adjacent space", () => {
    assert.equal(removeFilePath("see /t/a.xlsx now", "/t/a.xlsx"), "see now");
    assert.equal(removeFilePath("/t/a.xlsx", "/t/a.xlsx"), "");
    assert.equal(removeFilePath("look at /t/a.xlsx", "/t/a.xlsx"), "look at");
    assert.equal(removeFilePath("/t/a.xlsx then", "/t/a.xlsx"), "then");
    assert.equal(removeFilePath("nothing here", "/t/a.xlsx"), "nothing here");
  });

  it("removes exactly one occurrence, so a path the user repeated stays", () => {
    assert.equal(removeFilePath("/t/a.xlsx and /t/a.xlsx", "/t/a.xlsx"), "and /t/a.xlsx");
  });

  it("treats the path literally: metacharacters in a name never widen the match", () => {
    assert.equal(removeFilePath("x /t/a(1).xlsx y", "/t/a(1).xlsx"), "x y");
    assert.equal(removeFilePath("x /t/a.xlsx y", "/t/a-xlsx"), "x /t/a.xlsx y");
    assert.equal(removeFilePath("x /t/a.xlsx y", ""), "x /t/a.xlsx y");
  });

});
