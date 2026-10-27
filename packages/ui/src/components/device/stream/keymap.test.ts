import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  androidKeycodeForCode,
  androidMetaState,
  chunkText,
  hidStrokeForChar,
  hidUsageForCode,
  mapKeyboardEvent,
  textToHidStrokes
} from "./keymap.ts";

describe("HID usages (iOS)", () => {
  it("maps letters, digits, function keys and named keys by physical code", () => {
    assert.equal(hidUsageForCode("KeyA"), 0x04);
    assert.equal(hidUsageForCode("KeyZ"), 0x1d);
    assert.equal(hidUsageForCode("Digit1"), 0x1e);
    assert.equal(hidUsageForCode("Digit9"), 0x26);
    assert.equal(hidUsageForCode("Digit0"), 0x27);
    assert.equal(hidUsageForCode("F1"), 0x3a);
    assert.equal(hidUsageForCode("F12"), 0x45);
    assert.equal(hidUsageForCode("Enter"), 0x28);
    assert.equal(hidUsageForCode("Backspace"), 0x2a);
    assert.equal(hidUsageForCode("ArrowUp"), 0x52);
    assert.equal(hidUsageForCode("MetaLeft"), 0xe3);
    assert.equal(hidUsageForCode("F13"), null);
    assert.equal(hidUsageForCode("Fn"), null);
  });

  it("types US-layout ASCII with shift where needed", () => {
    assert.deepEqual(hidStrokeForChar("a"), { usage: 0x04, shift: false });
    assert.deepEqual(hidStrokeForChar("A"), { usage: 0x04, shift: true });
    assert.deepEqual(hidStrokeForChar("0"), { usage: 0x27, shift: false });
    assert.deepEqual(hidStrokeForChar(")"), { usage: 0x27, shift: true });
    assert.deepEqual(hidStrokeForChar("!"), { usage: 0x1e, shift: true });
    assert.deepEqual(hidStrokeForChar("("), { usage: 0x26, shift: true });
    assert.deepEqual(hidStrokeForChar("?"), { usage: 0x38, shift: true });
    assert.deepEqual(hidStrokeForChar('"'), { usage: 0x34, shift: true });
    assert.deepEqual(hidStrokeForChar("\n"), { usage: 0x28, shift: false });
    assert.equal(hidStrokeForChar("é"), null);
    assert.equal(hidStrokeForChar("ab"), null);
  });

  it("drops CR and counts characters it can't type", () => {
    const { strokes, unsupported } = textToHidStrokes("Hi\r\n✓é");
    assert.deepEqual(strokes, [
      { usage: 0x0b, shift: true },
      { usage: 0x0c, shift: false },
      { usage: 0x28, shift: false }
    ]);
    assert.equal(unsupported, 2);
  });
});

describe("Android keycodes", () => {
  it("maps letters, digits, function and editing keys", () => {
    assert.equal(androidKeycodeForCode("KeyA"), 29);
    assert.equal(androidKeycodeForCode("KeyZ"), 54);
    assert.equal(androidKeycodeForCode("Digit0"), 7);
    assert.equal(androidKeycodeForCode("Digit9"), 16);
    assert.equal(androidKeycodeForCode("F1"), 131);
    assert.equal(androidKeycodeForCode("Backspace"), 67);
    assert.equal(androidKeycodeForCode("Delete"), 112);
    assert.equal(androidKeycodeForCode("Enter"), 66);
    assert.equal(androidKeycodeForCode("ArrowLeft"), 21);
    assert.equal(androidKeycodeForCode("Fn"), null);
  });

  it("builds the meta state bitmask", () => {
    assert.equal(androidMetaState({ key: "a", code: "KeyA" }), 0);
    assert.equal(androidMetaState({ key: "A", code: "KeyA", shiftKey: true, ctrlKey: true }), 0x1001);
    assert.equal(androidMetaState({ key: "a", code: "KeyA", altKey: true, metaKey: true }), 0x10002);
  });
});

describe("mapKeyboardEvent", () => {
  it("iOS: HID down/up by code, with the typed character on down", () => {
    assert.deepEqual(mapKeyboardEvent("ios", { key: "q", code: "KeyQ" }, "down"), { kind: "hid", type: "down", usage: 0x14, key: "q" });
    assert.deepEqual(mapKeyboardEvent("ios", { key: "q", code: "KeyQ" }, "up"), { kind: "hid", type: "up", usage: 0x14 });
    assert.deepEqual(mapKeyboardEvent("ios", { key: "Shift", code: "ShiftLeft" }, "down"), { kind: "hid", type: "down", usage: 0xe1 });
    assert.equal(mapKeyboardEvent("ios", { key: "Unidentified", code: "" }, "down"), null);
  });

  it("Android: printable keys type text on down only; chords and editing keys send keycodes", () => {
    assert.deepEqual(mapKeyboardEvent("android", { key: "é", code: "KeyE" }, "down"), { kind: "text", text: "é" });
    assert.equal(mapKeyboardEvent("android", { key: "é", code: "KeyE" }, "up"), null);
    assert.deepEqual(mapKeyboardEvent("android", { key: "c", code: "KeyC", ctrlKey: true }, "down"), {
      kind: "android-key",
      action: "down",
      keycode: 31,
      metaState: 0x1000
    });
    assert.deepEqual(mapKeyboardEvent("android", { key: "Backspace", code: "Backspace" }, "up"), {
      kind: "android-key",
      action: "up",
      keycode: 67,
      metaState: 0
    });
    assert.deepEqual(mapKeyboardEvent("android", { key: "Escape", code: "Escape" }, "down"), { kind: "button", button: "back" });
    assert.equal(mapKeyboardEvent("android", { key: "Escape", code: "Escape" }, "up"), null);
    assert.equal(mapKeyboardEvent("android", { key: "Dead", code: "IntlRo" }, "down"), null);
  });
});

describe("chunkText", () => {
  it("keeps short text in one chunk", () => {
    assert.deepEqual(chunkText("hello"), { chunks: ["hello"], truncated: false });
    assert.deepEqual(chunkText(""), { chunks: [], truncated: false });
  });

  it("splits at the byte limit without breaking multi-byte code points", () => {
    const text = "a".repeat(299) + "é" + "b"; // é is 2 bytes and would straddle 300
    const { chunks } = chunkText(text);
    assert.deepEqual(chunks, ["a".repeat(299), "éb"]);
    const emoji = "😀".repeat(100); // 4 bytes each → 75 per chunk
    const split = chunkText(emoji).chunks;
    assert.deepEqual(split.map((c) => [...c].length), [75, 25]);
    assert.ok(split.every((c) => new TextEncoder().encode(c).length <= 300));
    assert.equal(split.join(""), emoji);
  });

  it("caps the chunk count and reports truncation", () => {
    const { chunks, truncated } = chunkText("x".repeat(300 * 70));
    assert.equal(chunks.length, 64);
    assert.equal(truncated, true);
    assert.deepEqual(chunkText("x".repeat(300 * 64)).truncated, false);
    assert.deepEqual(chunkText("x".repeat(300 * 64 + 1)), { chunks: Array(64).fill("x".repeat(300)), truncated: true });
    assert.deepEqual(chunkText("abcdef", 2, 2), { chunks: ["ab", "cd"], truncated: true });
  });
});
