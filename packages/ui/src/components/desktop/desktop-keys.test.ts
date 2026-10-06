import test from "node:test";
import assert from "node:assert/strict";

import { keysymForCodePoint, keysymForNamedKey, keysymsForText } from "./desktop-keys.ts";

test("Latin-1 characters are their own keysym", () => {
  assert.equal(keysymForCodePoint("a".codePointAt(0)!), 0x61);
  assert.equal(keysymForCodePoint("A".codePointAt(0)!), 0x41);
  assert.equal(keysymForCodePoint(" ".codePointAt(0)!), 0x20);
  assert.equal(keysymForCodePoint("é".codePointAt(0)!), 0xe9);
});

test("other code points use the Unicode keysym range", () => {
  assert.equal(keysymForCodePoint("€".codePointAt(0)!), 0x010020ac);
  assert.equal(keysymForCodePoint("😀".codePointAt(0)!), 0x0101f600);
});

test("newline and tab map to Return and Tab; other controls are dropped", () => {
  assert.equal(keysymForCodePoint(0x0a), 0xff0d);
  assert.equal(keysymForCodePoint(0x09), 0xff09);
  assert.equal(keysymForCodePoint(0x01), null);
  assert.equal(keysymForCodePoint(0x85), null);
});

test("text splits by code point, not UTF-16 unit", () => {
  assert.deepEqual(keysymsForText("a😀\n"), [0x61, 0x0101f600, 0xff0d]);
});

test("named keys", () => {
  assert.equal(keysymForNamedKey("Backspace"), 0xff08);
  assert.equal(keysymForNamedKey("ArrowUp"), 0xff52);
  assert.equal(keysymForNamedKey("a"), null);
});
