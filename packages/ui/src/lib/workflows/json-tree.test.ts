import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jsonChildPath, jsonChildren, jsonCopyText, jsonExpression } from "./json-tree.ts";

describe("json tree helpers", () => {
  it("builds `{{…}}` paths: dots for identifiers, brackets for the rest", () => {
    assert.equal(jsonChildPath("input", "a key"), 'input["a key"]');
    assert.equal(jsonChildPath("input", 'q"x'), 'input["q\\"x"]');
    assert.equal(jsonChildPath("nodes.Review.output", "items"), "nodes.Review.output.items");
    assert.equal(jsonChildPath("nodes.Review.output.items", 0), "nodes.Review.output.items[0]");
    assert.equal(jsonChildPath("", "items"), "items");
    assert.equal(jsonChildPath("", 2), "[2]");
    assert.equal(jsonExpression("nodes.A.output"), "{{nodes.A.output}}");
    assert.equal(jsonExpression(""), "");
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
