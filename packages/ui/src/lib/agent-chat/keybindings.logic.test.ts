import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatShortcutLabel,
  composerControlSelector,
  COMPOSER_SHORTCUT_ATTRIBUTE,
  isOperableControl,
  resolveChatShortcut,
  type ChatShortcutEventLike
} from "./keybindings.logic";

const key = (overrides: Partial<ChatShortcutEventLike>): ChatShortcutEventLike => ({
  key: "a",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides
});

describe("resolveChatShortcut", () => {
  it("interrupts on a bare Escape", () => {
    assert.deepEqual(resolveChatShortcut(key({ key: "Escape" })), { kind: "interrupt" });
  });

  it("sends the head of the queue on mod+Shift+Enter", () => {
    assert.deepEqual(resolveChatShortcut(key({ key: "Enter", ctrlKey: true, shiftKey: true })), {
      kind: "steer-queued"
    });
    assert.deepEqual(resolveChatShortcut(key({ key: "Enter", metaKey: true, shiftKey: true })), {
      kind: "steer-queued"
    });
  });

  it("uses mod+Shift+M for the mode picker — mod+Shift+A is the Attention Center's", () => {
    assert.deepEqual(resolveChatShortcut(key({ key: "m", ctrlKey: true, shiftKey: true })), {
      kind: "control",
      command: "mode"
    });
    assert.equal(resolveChatShortcut(key({ key: "a", ctrlKey: true, shiftKey: true })), null);
  });

  it("opens the model and effort controls", () => {
    assert.deepEqual(resolveChatShortcut(key({ key: "/", metaKey: true })), {
      kind: "control",
      command: "model"
    });
    assert.deepEqual(resolveChatShortcut(key({ key: "e", metaKey: true })), {
      kind: "control",
      command: "effort"
    });
  });

  it("ignores a held key and an Alt chord", () => {
    assert.equal(resolveChatShortcut(key({ key: "Escape", repeat: true })), null);
    assert.equal(resolveChatShortcut(key({ key: "e", metaKey: true, altKey: true })), null);
  });

  it("ignores an unbound chord", () => {
    assert.equal(resolveChatShortcut(key({ key: "q", metaKey: true })), null);
    assert.equal(resolveChatShortcut(key({ key: "q" })), null);
  });
});

describe("chatShortcutLabel", () => {
  it("uses the platform's modifier glyph", () => {
    assert.equal(chatShortcutLabel({ kind: "steer-queued" }, true), "⌘+Shift+Enter");
    assert.equal(chatShortcutLabel({ kind: "steer-queued" }, false), "Ctrl+Shift+Enter");
    assert.equal(chatShortcutLabel({ kind: "interrupt" }, false), "Esc");
    assert.equal(chatShortcutLabel({ kind: "control", command: "attach" }, false), null);
  });
});

describe("the data-composer-shortcut convention", () => {
  it("builds a selector that skips disabled controls and matches a multi-token value", () => {
    assert.equal(
      composerControlSelector("mode"),
      `button[${COMPOSER_SHORTCUT_ATTRIBUTE}~="mode"]:not(:disabled)`
    );
  });

  it("refuses an inert or invisible control", () => {
    assert.equal(isOperableControl({}), true);
    assert.equal(isOperableControl({ hasAttribute: () => true }), false);
    assert.equal(
      isOperableControl({ hasAttribute: () => false, closest: () => ({}) }),
      false
    );
    assert.equal(
      isOperableControl({
        hasAttribute: () => false,
        closest: () => null,
        getClientRects: () => ({ length: 0 })
      }),
      false
    );
    assert.equal(
      isOperableControl({
        hasAttribute: () => false,
        closest: () => null,
        getClientRects: () => ({ length: 1 })
      }),
      true
    );
  });
});
