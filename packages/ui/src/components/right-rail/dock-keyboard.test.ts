import test from "node:test";
import assert from "node:assert/strict";

import { dockKeyAction, type DockKeyInput } from "./dock-keyboard.ts";

const escape: DockKeyInput = {
  key: "Escape",
  repeat: false,
  defaultPrevented: false,
  isComposing: false,
  targetInsideDock: true,
  otherLayerOpen: () => false
};

test("an Escape nothing inside the dock handled leaves the dock", () => {
  assert.equal(dockKeyAction(escape), "leave");
});

test("an Escape the panel consumed (the search field clearing itself) stays the panel's", () => {
  assert.equal(dockKeyAction({ ...escape, defaultPrevented: true }), "ignore");
});

test("an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone", () => {
  assert.equal(dockKeyAction({ ...escape, otherLayerOpen: () => true }), "ignore");
});

test("an IME composition's Escape cancels the composition, nothing else", () => {
  assert.equal(dockKeyAction({ ...escape, isComposing: true }), "ignore");
});

test("a held Escape leaves once: its auto-repeat is not another press", () => {
  // Otherwise the repeats land in the composer the first one focused, and a
  // repeated Escape there interrupts a running turn.
  assert.equal(dockKeyAction({ ...escape, repeat: true }), "ignore");
});

test("keys from a portaled child (a dropdown the panel opened) are never the dock's", () => {
  // React bubbles a portal's events through the dock; the DOM target is outside it.
  assert.equal(dockKeyAction({ ...escape, targetInsideDock: false }), "ignore");
  assert.equal(dockKeyAction({ ...escape, key: "1", targetInsideDock: false }), "ignore");
});

test("every other key typed in the dock is contained there", () => {
  // A question card answers on a bare digit when focus is outside an editable
  // field — a focused prompt card is exactly that, and an answer is final.
  for (const key of ["1", "9", "a", "Enter", "ArrowDown", " ", "Tab"]) {
    assert.equal(dockKeyAction({ ...escape, key }), "contain", key);
  }
  assert.equal(dockKeyAction({ ...escape, key: "1", defaultPrevented: true }), "contain");
  assert.equal(dockKeyAction({ ...escape, key: "Process", isComposing: true }), "contain");
});
