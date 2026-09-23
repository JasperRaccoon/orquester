import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFileKind, extOf } from "./file-kind.ts";

describe("detectFileKind", () => {
  it("never resolves a prototype member: an extension like `constructor` is the text fallback", () => {
    assert.deepEqual(detectFileKind("notes.constructor"), { kind: "text", mime: "text/plain" });
    assert.deepEqual(detectFileKind("x.__proto__"), { kind: "text", mime: "text/plain" });
    assert.deepEqual(detectFileKind("x.CONSTRUCTOR"), { kind: "text", mime: "text/plain" });
  });

  it("classifies by lowercased extension and collapses .tar.* names", () => {
    assert.deepEqual(detectFileKind("shot.PNG"), { kind: "image", mime: "image/png" });
    assert.deepEqual(detectFileKind("bundle.tar.gz"), { kind: "archive", mime: "application/gzip" });
    assert.deepEqual(detectFileKind("README"), { kind: "text", mime: "text/plain" });
    assert.equal(extOf("a.tar.bz2"), "tar");
  });
});
