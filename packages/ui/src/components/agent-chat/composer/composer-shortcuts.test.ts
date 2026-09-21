import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSER_KEYBINDINGS,
  matchComposerKeybinding,
  shortcutComboFor,
  type ComposerKeyEvent
} from "./composer-shortcuts.ts";

function event(overrides: Partial<ComposerKeyEvent>): ComposerKeyEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  };
}

test("the composer chords resolve to their commands on either modifier", () => {
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyM", ctrlKey: true, shiftKey: true })),
    "model"
  );
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyE", metaKey: true, shiftKey: true })),
    "effort"
  );
  assert.equal(
    matchComposerKeybinding(event({ code: "Enter", metaKey: true, shiftKey: true })),
    "steerQueued"
  );
});

test("the runtime-mode picker is deliberately NOT on mod+shift+a", () => {
  // The Attention Center owns that chord on this host.
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyA", ctrlKey: true, shiftKey: true })),
    null
  );
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyY", ctrlKey: true, shiftKey: true })),
    "mode"
  );
});

test("a chord without Shift, without a modifier, with Alt, or repeating is not ours", () => {
  assert.equal(matchComposerKeybinding(event({ code: "KeyM", ctrlKey: true })), null);
  assert.equal(matchComposerKeybinding(event({ code: "KeyM", shiftKey: true })), null);
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyM", ctrlKey: true, shiftKey: true, altKey: true })),
    null
  );
  assert.equal(
    matchComposerKeybinding(event({ code: "KeyM", ctrlKey: true, shiftKey: true, repeat: true })),
    null
  );
});

test("a synthetic event with no `code` falls back to the printable key", () => {
  assert.equal(
    matchComposerKeybinding(event({ key: "M", ctrlKey: true, shiftKey: true })),
    "model"
  );
});

test("every binding has a printable chord and no two share a code", () => {
  assert.equal(shortcutComboFor("model"), "mod+shift+m");
  assert.equal(shortcutComboFor("attach"), null);
  const codes = COMPOSER_KEYBINDINGS.map((binding) => binding.code);
  assert.equal(new Set(codes).size, codes.length);
});
