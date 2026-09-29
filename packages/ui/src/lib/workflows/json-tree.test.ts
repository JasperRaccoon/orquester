import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jsonChildren, jsonCopyText } from "./json-tree.ts";

describe("json tree helpers", () => {
  it("escapes quoted keys and keeps root paths usable", () => {
    assert.deepEqual(jsonChildren({ 'q"x': 1 }, "input"), [
      { key: 'q"x', path: 'input["q\\"x"]', value: 1 }
    ]);
    assert.deepEqual(jsonChildren({ items: 2 }, ""), [{ key: "items", path: "items", value: 2 }]);
    assert.deepEqual(jsonChildren([3], ""), [{ key: 0, path: "[0]", value: 3 }]);
  });

  it("pages children with their paths", () => {
    const list = Array.from({ length: 250 }, (_, index) => index);
    const page = jsonChildren(list, "out", 100, 100);
    assert.equal(page.length, 100);
    assert.deepEqual(page[0], { key: 100, path: "out[100]", value: 100 });
    assert.equal(jsonChildren(list, "out", 200, 100).length, 50);
    assert.deepEqual(jsonChildren({ a: 1, "b c": 2 }, "o"), [
      { key: "a", path: "o.a", value: 1 },
      { key: "b c", path: 'o["b c"]', value: 2 }
    ]);
    assert.deepEqual(jsonChildren("leaf", "o"), []);
  });

  it("copies strings raw and preserves JSON values", () => {
    assert.equal(jsonCopyText("raw text"), "raw text");
    assert.deepEqual(JSON.parse(jsonCopyText({ a: [1] })), { a: [1] });
    assert.equal(jsonCopyText(undefined), "");
  });
});
