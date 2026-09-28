import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipString,
  isJsonContainer,
  jsonChildCount,
  jsonChildPath,
  jsonChildren,
  jsonCopyText,
  jsonDefaultExpanded,
  jsonExpression,
  jsonKind,
  jsonPathSegment,
  jsonPreview
} from "./json-tree.ts";

describe("json tree helpers", () => {
  it("names a value's kind", () => {
    assert.equal(jsonKind(null), "null");
    assert.equal(jsonKind(undefined), "undefined");
    assert.equal(jsonKind([]), "array");
    assert.equal(jsonKind({}), "object");
    assert.equal(jsonKind("x"), "string");
    assert.equal(jsonKind(1), "number");
    assert.equal(jsonKind(false), "boolean");
    assert.equal(isJsonContainer([1]), true);
    assert.equal(isJsonContainer("x"), false);
    assert.equal(jsonChildCount({ a: 1, b: 2 }), 2);
    assert.equal(jsonChildCount("abc"), 0);
  });

  it("builds `{{…}}` paths: dots for identifiers, brackets for the rest", () => {
    assert.equal(jsonPathSegment("title"), ".title");
    assert.equal(jsonPathSegment(3), "[3]");
    assert.equal(jsonPathSegment("a key"), '["a key"]');
    assert.equal(jsonPathSegment('q"x'), '["q\\"x"]');
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

  it("previews a value in one short line", () => {
    assert.equal(jsonPreview("hello"), '"hello"');
    assert.equal(jsonPreview("line one\nline two"), '"line one ⏎ line two"');
    assert.equal(jsonPreview("x".repeat(200), 20), `"${"x".repeat(19)}…"`);
    assert.equal(jsonPreview(42), "42");
    assert.equal(jsonPreview(null), "null");
    assert.equal(jsonPreview([]), "[]");
    assert.equal(jsonPreview([1, 2, 3]), "[3 items]");
    assert.equal(jsonPreview([1]), "[1 item]");
    assert.equal(jsonPreview({}), "{}");
    assert.equal(jsonPreview({ a: 1, b: 2 }), "{ a, b }");
    assert.equal(jsonPreview({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }), "{ a, b, c, d, e, f, … }");
    assert.equal(jsonPreview({ averyveryverylongkeyname: 1, anotherquitelongkeyname: 2 }, 20), "{2 keys}");
  });

  it("copies strings raw and everything else as pretty JSON", () => {
    assert.equal(jsonCopyText("raw text"), "raw text");
    assert.equal(jsonCopyText({ a: [1] }), '{\n  "a": [\n    1\n  ]\n}');
    assert.equal(jsonCopyText(undefined), "");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(jsonCopyText(cyclic), "[object Object]");
  });

  it("opens the root and small first levels by default", () => {
    assert.equal(jsonDefaultExpanded(0, { a: 1 }), true);
    assert.equal(jsonDefaultExpanded(1, { a: 1 }), true);
    assert.equal(jsonDefaultExpanded(1, Array.from({ length: 21 })), false);
    assert.equal(jsonDefaultExpanded(2, { a: 1 }), false);
    assert.equal(jsonDefaultExpanded(0, "x"), false);
  });

  it("clips long strings for display", () => {
    assert.deepEqual(clipString("short"), { text: "short", clipped: false });
    const clipped = clipString("y".repeat(5000), 2000);
    assert.equal(clipped.text.length, 2000);
    assert.equal(clipped.clipped, true);
  });
});
