import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkText, mapKeyboardEvent, textToHidStrokes } from "./keymap.ts";

it("maps ASCII text to USB HID, drops CR and counts characters it cannot type", () => {
  assert.deepEqual(textToHidStrokes("aA0)!(?\"\r\n✓é"), {
    strokes: [
      { usage: 0x04, shift: false }, { usage: 0x04, shift: true },
      { usage: 0x27, shift: false }, { usage: 0x27, shift: true },
      { usage: 0x1e, shift: true }, { usage: 0x26, shift: true },
      { usage: 0x38, shift: true }, { usage: 0x34, shift: true },
      { usage: 0x28, shift: false }
    ],
    unsupported: 2
  });
});

describe("mapKeyboardEvent", () => {
  it("iOS: HID down/up by code, with the typed character on down", () => {
    for (const [code, usage] of [
      ["KeyA", 0x04], ["KeyZ", 0x1d], ["Digit1", 0x1e], ["Digit9", 0x26], ["Digit0", 0x27],
      ["F1", 0x3a], ["F12", 0x45], ["Enter", 0x28], ["Backspace", 0x2a], ["ArrowUp", 0x52], ["MetaLeft", 0xe3]
    ] as const) {
      assert.deepEqual(mapKeyboardEvent("ios", { key: "Unidentified", code }, "up"), { kind: "hid", type: "up", usage });
    }
    assert.deepEqual(mapKeyboardEvent("ios", { key: "q", code: "KeyQ" }, "down"), { kind: "hid", type: "down", usage: 0x14, key: "q" });
    assert.deepEqual(mapKeyboardEvent("ios", { key: "q", code: "KeyQ" }, "up"), { kind: "hid", type: "up", usage: 0x14 });
    assert.deepEqual(mapKeyboardEvent("ios", { key: "Shift", code: "ShiftLeft" }, "down"), { kind: "hid", type: "down", usage: 0xe1 });
    assert.equal(mapKeyboardEvent("ios", { key: "Unidentified", code: "" }, "down"), null);
  });

  it("Android: printable keys type text on down only; chords and editing keys send keycodes", () => {
    for (const [code, keycode] of [
      ["KeyA", 29], ["KeyZ", 54], ["Digit0", 7], ["Digit9", 16], ["F1", 131],
      ["Backspace", 67], ["Delete", 112], ["Enter", 66], ["ArrowLeft", 21]
    ] as const) {
      assert.deepEqual(mapKeyboardEvent("android", { key: "Unidentified", code }, "up"), { kind: "android-key", action: "up", keycode, metaState: 0 });
    }
    assert.deepEqual(mapKeyboardEvent("android", { key: "A", code: "KeyA", shiftKey: true, ctrlKey: true }, "down"), { kind: "android-key", action: "down", keycode: 29, metaState: 0x1001 });
    assert.deepEqual(mapKeyboardEvent("android", { key: "a", code: "KeyA", altKey: true, metaKey: true }, "down"), { kind: "android-key", action: "down", keycode: 29, metaState: 0x10002 });
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
    const text = "x".repeat(300 * 129);
    const { chunks, truncated } = chunkText(text);
    assert.ok(chunks.length > 0 && chunks.length < 128, "the paste retains a useful prefix below serve-emu's input queue depth");
    assert.equal(truncated, true);
    assert.ok(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 300));
    assert.ok(text.startsWith(chunks.join("")) && chunks.join("").length < text.length);
  });
});
