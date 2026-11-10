import test from "node:test";
import assert from "node:assert/strict";

import { keysymForCodePoint, keysymForKeyEvent, keysymForNamedKey, keysymsForText, pasteKeystroke, shiftedKeysym } from "./desktop-keys.ts";

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
  // Ctrl+Shift+V (terminals): `V`, so Xvnc does not release the held Shift.
  assert.deepEqual(keysyms(pasteKeystroke({ shift: true, alt: false, meta: false }, false)), [[0xffe3, true], [0x56, true], [0x56, false], [0xffe3, false]]);
});

test("Cmd+V on a Mac releases what noVNC sent for either Cmd key before Ctrl+V", () => {
  const steps = pasteKeystroke({ shift: false, alt: false, meta: true }, true);
  assert.deepEqual(steps.slice(0, 2), [
    { keysym: 0xffe9, code: "MetaLeft", down: false },
    { keysym: 0xffeb, code: "MetaRight", down: false }
  ]);
  assert.deepEqual(steps.slice(2).map((s) => s.keysym), [0xffe3, 0x76, 0x76, 0xffe3]);
  assert.deepEqual(pasteKeystroke({ shift: false, alt: false, meta: true }, false).slice(0, 2), [
    { keysym: 0xffeb, code: "MetaLeft", down: false },
    { keysym: 0xffec, code: "MetaRight", down: false }
  ]);
});

test("a paste chord with Option/Alt releases both sides of it", () => {
  assert.deepEqual(pasteKeystroke({ shift: false, alt: true, meta: false }, true).slice(0, 2), [
    { keysym: 0xff7e, code: "AltLeft", down: false },
    { keysym: 0xfe03, code: "AltRight", down: false }
  ]);
  assert.deepEqual(pasteKeystroke({ shift: false, alt: true, meta: false }, false).slice(0, 2), [
    { keysym: 0xffe9, code: "AltLeft", down: false },
    { keysym: 0xffea, code: "AltRight", down: false }
  ]);
});

test("named keys", () => {
  assert.equal(keysymForNamedKey("Backspace"), 0xff08);
  assert.equal(keysymForNamedKey("ArrowUp"), 0xff52);
  assert.equal(keysymForNamedKey("a"), null);
});

test("a key under a latched Shift uses the capital's keysym, so Xvnc keeps Shift held", () => {
  assert.equal(shiftedKeysym(0x74), 0x54); // t → T (Ctrl+Shift+T)
  assert.equal(shiftedKeysym(0xe9), 0xc9); // é → É
  assert.equal(shiftedKeysym(0xf7), 0xf7); // ÷ has no capital
  assert.equal(shiftedKeysym(0x31), 0x31);
  assert.equal(shiftedKeysym(0xff09), 0xff09); // Tab: Shift+Tab as is
});

test("hardware key events map to keysyms by key, with the modifier's side from its code", () => {
  const ks = (key: string, code: string, apple = false) => keysymForKeyEvent({ key, code }, apple);
  assert.equal(ks("a", "KeyA"), 0x61);
  assert.equal(ks("Ä", "Quote"), 0xc4);
  assert.equal(ks("ж", "Semicolon"), 0x01000436);
  assert.equal(ks("F12", "F12"), 0xffc9);
  assert.equal(ks("Insert", "Insert"), 0xff63);
  assert.equal(ks("Control", "ControlRight"), 0xffe4);
  assert.equal(ks("Shift", "ShiftLeft"), 0xffe1);
  assert.equal(ks("Dead", "BracketLeft"), null);
  assert.equal(ks("Process", "KeyA"), null);
});

test("on Apple platforms Cmd and Option map as noVNC maps them, so the paste chord releases them", () => {
  const ks = (key: string, code: string) => keysymForKeyEvent({ key, code }, true);
  const released = pasteKeystroke({ shift: false, alt: true, meta: true }, true)
    .filter((s) => !s.down)
    .map((s) => s.keysym);
  for (const [key, code] of [["Meta", "MetaLeft"], ["Meta", "MetaRight"], ["Alt", "AltLeft"], ["Alt", "AltRight"]]) {
    assert.ok(released.includes(ks(key!, code!)!), `${code} is released by the paste chord`);
  }
  assert.equal(ks("Meta", "MetaLeft"), 0xffe9);
});
