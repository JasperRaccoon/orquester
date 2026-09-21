import test from "node:test";
import assert from "node:assert/strict";
import { shortcutKeys } from "./shortcut.ts";

test("mod resolves per platform", () => {
  assert.deepEqual(shortcutKeys("mod+k", true), ["⌘", "K"]);
  assert.deepEqual(shortcutKeys("mod+k", false), ["Ctrl", "K"]);
});

test("modifiers render in the platform's canonical order, not the typed order", () => {
  // Two hints for the same chord must never disagree about order.
  assert.deepEqual(shortcutKeys("shift+mod+enter", true), ["⇧", "⌘", "↵"]);
  assert.deepEqual(shortcutKeys("mod+shift+enter", true), ["⇧", "⌘", "↵"]);
  assert.deepEqual(shortcutKeys("shift+mod+enter", false), ["Ctrl", "Shift", "Enter"]);
});

test("cmd and meta are aliases of mod, deduped", () => {
  assert.deepEqual(shortcutKeys("mod+cmd+k", true), ["⌘", "K"]);
});

test("named keys become glyphs on Apple and words elsewhere", () => {
  assert.deepEqual(shortcutKeys("escape", true), ["Esc"]);
  assert.deepEqual(shortcutKeys("backspace", true), ["⌫"]);
  assert.deepEqual(shortcutKeys("backspace", false), ["Backspace"]);
  assert.deepEqual(shortcutKeys("alt+up", true), ["⌥", "↑"]);
});

test("unknown tokens pass through, single characters upper-cased", () => {
  assert.deepEqual(shortcutKeys("f5", false), ["f5"]);
  assert.deepEqual(shortcutKeys("mod+/", false), ["Ctrl", "/"]);
});

test("empty segments never produce a blank key cap", () => {
  assert.deepEqual(shortcutKeys("mod++k", false), ["Ctrl", "K"]);
  assert.deepEqual(shortcutKeys("mod+k+", false), ["Ctrl", "K"]);
  assert.deepEqual(shortcutKeys("  mod + k ", false), ["Ctrl", "K"]);
  assert.deepEqual(shortcutKeys("", false), []);
});
