import test from "node:test";
import assert from "node:assert/strict";

import {
  activeModifiers,
  applyLatchedModifiers,
  applyModifiers,
  consumeModifiers,
  ctrlChar,
  encodeKey,
  getModifierLatches,
  parseInputKey,
  resetModifierLatches,
  tapModifier,
  type Modifiers
} from "./terminal-keys.ts";

const NONE: Modifiers = { ctrl: false, alt: false };
const CTRL: Modifiers = { ctrl: true, alt: false };
const ALT: Modifiers = { ctrl: false, alt: true };
const BOTH: Modifiers = { ctrl: true, alt: true };

test("Ctrl+letter maps to 0x01–0x1A regardless of case", () => {
  for (let i = 0; i < 26; i += 1) {
    const lower = String.fromCharCode(97 + i);
    assert.equal(ctrlChar(lower), String.fromCharCode(i + 1));
    assert.equal(ctrlChar(lower.toUpperCase()), String.fromCharCode(i + 1));
  }
});

test("Ctrl on symbols follows xterm's C0 table; unmapped characters pass through", () => {
  assert.deepEqual(
    ["@", " ", "[", "\\", "]", "^", "_", "/", "?", "2", "3", "8"].map(ctrlChar),
    ["\x00", "\x00", "\x1b", "\x1c", "\x1d", "\x1e", "\x1f", "\x1f", "\x7f", "\x00", "\x1b", "\x7f"]
  );
  assert.equal(ctrlChar("~"), "~");
  assert.equal(ctrlChar("|"), "|");
  assert.equal(ctrlChar("é"), "é");
});

test("characters: Alt is an ESC prefix, Ctrl+Alt prefixes the control byte", () => {
  assert.equal(encodeKey({ kind: "char", char: "b" }, NONE), "b");
  assert.equal(encodeKey({ kind: "char", char: "b" }, ALT), "\x1bb");
  assert.equal(encodeKey({ kind: "char", char: "r" }, CTRL), "\x12");
  assert.equal(encodeKey({ kind: "char", char: "x" }, BOTH), "\x1b\x18");
  assert.equal(encodeKey({ kind: "char", char: " " }, CTRL), "\x00");
});

test("cursor and editing keys carry xterm's modifier parameter", () => {
  const up = { kind: "special", key: "up" } as const;
  assert.equal(encodeKey(up, NONE), "\x1b[A");
  assert.equal(encodeKey(up, ALT), "\x1b[1;3A");
  assert.equal(encodeKey(up, CTRL), "\x1b[1;5A");
  assert.equal(encodeKey(up, BOTH), "\x1b[1;7A");
  assert.equal(encodeKey({ kind: "special", key: "down" }, NONE), "\x1b[B");
  assert.equal(encodeKey({ kind: "special", key: "right" }, CTRL), "\x1b[1;5C");
  assert.equal(encodeKey({ kind: "special", key: "left" }, ALT), "\x1b[1;3D");
  assert.equal(encodeKey({ kind: "special", key: "home" }, NONE), "\x1b[H");
  assert.equal(encodeKey({ kind: "special", key: "end" }, CTRL), "\x1b[1;5F");
  assert.equal(encodeKey({ kind: "special", key: "delete" }, NONE), "\x1b[3~");
  assert.equal(encodeKey({ kind: "special", key: "delete" }, CTRL), "\x1b[3;5~");
  assert.equal(encodeKey({ kind: "special", key: "pageUp" }, ALT), "\x1b[5;3~");
  assert.equal(encodeKey({ kind: "special", key: "pageDown" }, BOTH), "\x1b[6;7~");
  assert.equal(encodeKey({ kind: "special", key: "insert" }, NONE), "\x1b[2~");
});

test("Esc, Tab, Enter and Backspace follow xterm's legacy encoding", () => {
  assert.equal(encodeKey({ kind: "special", key: "escape" }, NONE), "\x1b");
  assert.equal(encodeKey({ kind: "special", key: "escape" }, ALT), "\x1b\x1b");
  assert.equal(encodeKey({ kind: "special", key: "tab" }, NONE), "\t");
  assert.equal(encodeKey({ kind: "special", key: "tab" }, ALT), "\x1b\t");
  assert.equal(encodeKey({ kind: "special", key: "enter" }, NONE), "\r");
  assert.equal(encodeKey({ kind: "special", key: "enter" }, CTRL), "\r");
  assert.equal(encodeKey({ kind: "special", key: "enter" }, ALT), "\x1b\r");
  assert.equal(encodeKey({ kind: "special", key: "backspace" }, NONE), "\x7f");
  assert.equal(encodeKey({ kind: "special", key: "backspace" }, CTRL), "\b");
  assert.equal(encodeKey({ kind: "special", key: "backspace" }, ALT), "\x1b\x7f");
});

test("parseInputKey reads single keys and refuses everything else", () => {
  assert.deepEqual(parseInputKey("r"), { kind: "char", char: "r" });
  assert.deepEqual(parseInputKey("😀"), { kind: "char", char: "😀" });
  assert.deepEqual(parseInputKey("\x1bOA"), { kind: "special", key: "up" });
  assert.deepEqual(parseInputKey("\x1b[D"), { kind: "special", key: "left" });
  assert.deepEqual(parseInputKey("\r"), { kind: "special", key: "enter" });
  assert.deepEqual(parseInputKey("\x7f"), { kind: "special", key: "backspace" });
  // IME / autocomplete commits, pastes, control bytes and xterm's own reports.
  for (const data of ["", "rm", "日本", "\x03", "\x1b[I", "\x1b[O", "\x1b[<0;3;4M", "\x1b[12;40R", "\x1b[1;5A", "\x1b[200~x\x1b[201~"]) {
    assert.equal(parseInputKey(data), null, JSON.stringify(data));
  }
});

test("applyModifiers leaves input alone with no modifier or a non-key", () => {
  assert.equal(applyModifiers("r", NONE), null);
  assert.equal(applyModifiers("rm", CTRL), null);
  assert.equal(applyModifiers("\x1b[I", ALT), null);
  assert.equal(applyModifiers("r", CTRL), "\x12");
  assert.equal(applyModifiers("\x1bOA", CTRL), "\x1b[1;5A");
});

test("store: one-shot Ctrl applies to the next key only, on its own session", () => {
  resetModifierLatches();
  tapModifier("s1", "ctrl", 0);
  assert.deepEqual(activeModifiers("s1"), CTRL);
  assert.deepEqual(activeModifiers("s2"), NONE);
  assert.equal(applyLatchedModifiers("s2", "r"), null);
  // A non-key (an IME word) neither gets the modifier nor spends it.
  assert.equal(applyLatchedModifiers("s1", "hello"), null);
  assert.equal(getModifierLatches().ctrl.state, "armed");
  assert.equal(applyLatchedModifiers("s1", "r"), "\x12");
  assert.equal(applyLatchedModifiers("s1", "r"), null);
  tapModifier("s1", "ctrl", 2_000);
  tapModifier("s1", "ctrl", 3_000);
  assert.equal(applyLatchedModifiers("s1", "r"), null, "separate taps disarm rather than lock");
  resetModifierLatches();
});

test("store: locked Alt stays on across keys until tapped again", () => {
  resetModifierLatches();
  tapModifier("s1", "alt", 0);
  tapModifier("s1", "alt", 100);
  assert.equal(getModifierLatches().alt.state, "locked");
  assert.equal(applyLatchedModifiers("s1", "b"), "\x1bb");
  assert.equal(applyLatchedModifiers("s1", "f"), "\x1bf");
  tapModifier("s1", "ctrl", 200);
  assert.equal(applyLatchedModifiers("s1", "x"), "\x1b\x18");
  assert.deepEqual(activeModifiers("s1"), ALT);
  consumeModifiers("s1");
  tapModifier("s1", "alt", 1000);
  assert.deepEqual(activeModifiers("s1"), NONE);
  resetModifierLatches();
});

test("store: tapping on another session starts that session fresh", () => {
  resetModifierLatches();
  tapModifier("s1", "ctrl", 0);
  tapModifier("s2", "alt", 10);
  assert.deepEqual(activeModifiers("s1"), NONE);
  assert.deepEqual(activeModifiers("s2"), ALT);
  resetModifierLatches("s3");
  assert.equal(getModifierLatches().sessionId, "s3");
  assert.deepEqual(activeModifiers("s2"), NONE);
  resetModifierLatches();
});
