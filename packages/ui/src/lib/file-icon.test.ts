import assert from "node:assert/strict";

import { describe, it } from "node:test";

import { fileIconIdFor } from "./file-icon.ts";

describe("file-type icons", () => {

  it("reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown", () => {
    assert.equal(fileIconIdFor({ name: "notes.constructor" }), "file");
    assert.equal(fileIconIdFor({ name: "x.__proto__" }), "file");
    assert.equal(fileIconIdFor({ name: "README", mimeType: "constructor" }), "file");
  });
});
