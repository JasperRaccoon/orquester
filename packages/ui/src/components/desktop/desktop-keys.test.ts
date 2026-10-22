import test from "node:test";
import assert from "node:assert/strict";

import { keysymForCodePoint, keysymForNamedKey, keysymsForText, pasteKeystroke } from "./desktop-keys.ts";

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

test("a paste chord replays as Ctrl+V, keeping Shift with an uppercase keysym", () => {
  const keysyms = (steps: ReturnType<typeof pasteKeystroke>) => steps.map((s) => [s.keysym, s.down]);
  assert.deepEqual(keysyms(pasteKeystroke(null, false)), [[0xffe3, true], [0x76, true], [0x76, false], [0xffe3, false]]);
  assert.deepEqual(keysyms(pasteKeystroke({ shift: false, alt: false, meta: false }, false)), keysyms(pasteKeystroke(null, false)));
  // Ctrl+Shift+V (terminals): `V`, so Xvnc does not release the held Shift.
  assert.deepEqual(keysyms(pasteKeystroke({ shift: true, alt: false, meta: false }, false)), [[0xffe3, true], [0x56, true], [0x56, false], [0xffe3, false]]);
});

test("Cmd+V on a Mac releases the Alt noVNC sent for Cmd before Ctrl+V", () => {
  const steps = pasteKeystroke({ shift: false, alt: false, meta: true }, true);
  assert.deepEqual(steps[0], { keysym: 0xffe9, code: "MetaLeft", down: false });
  assert.deepEqual(steps.slice(1).map((s) => s.keysym), [0xffe3, 0x76, 0x76, 0xffe3]);
  assert.deepEqual(pasteKeystroke({ shift: false, alt: false, meta: true }, false)[0], { keysym: 0xffeb, code: "MetaLeft", down: false });
});

test("named keys", () => {
  assert.equal(keysymForNamedKey("Backspace"), 0xff08);
  assert.equal(keysymForNamedKey("ArrowUp"), 0xff52);
  assert.equal(keysymForNamedKey("a"), null);
});
