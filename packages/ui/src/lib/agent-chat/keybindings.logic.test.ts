import assert from "node:assert/strict";
import { describe,it } from "node:test";

import {
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
