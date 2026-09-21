import test from "node:test";
import assert from "node:assert/strict";

import { resolveChatShortcut, shortcutLabelFor } from "./composer-shortcuts.ts";
import type { ChatShortcutEventLike } from "./composer-shortcuts.ts";

/**
 * The table itself is W11's (`lib/agent-chat/keybindings.logic.ts`) and is
 * tested there. What is tested here is the contract this module promises the
 * composer components: the adapter really is the shared table (not a second
 * one), and the label a chip prints is the chord that actually fires.
 */

function event(overrides: Partial<ChatShortcutEventLike>): ChatShortcutEventLike {
  return { key: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

test("the composer's chords come from the shared table", () => {
  assert.deepEqual(resolveChatShortcut(event({ key: "/", ctrlKey: true })), {
    kind: "control",
    command: "model"
  });
  assert.deepEqual(resolveChatShortcut(event({ key: "e", metaKey: true })), {
    kind: "control",
    command: "effort"
  });
  assert.deepEqual(resolveChatShortcut(event({ key: "M", ctrlKey: true, shiftKey: true })), {
    kind: "control",
    command: "mode"
  });
  assert.deepEqual(resolveChatShortcut(event({ key: "Enter", metaKey: true, shiftKey: true })), {
    kind: "steer-queued"
  });
});

test("the runtime-mode picker is NOT on the Attention Center's chord", () => {
  // T3 binds mode to mod+shift+A; that chord cycles the Attention Center here.
  assert.equal(resolveChatShortcut(event({ key: "a", ctrlKey: true, shiftKey: true })), null);
});

test("the old second table's chord is gone", () => {
  // This module used to resolve the mode picker on mod+shift+Y. Two tables
  // meant a chip could print one chord while another fired.
  assert.equal(resolveChatShortcut(event({ key: "y", ctrlKey: true, shiftKey: true })), null);
});

test("every chord a chip prints is one the table resolves to that same control", () => {
  const cases: Array<{ command: "model" | "effort" | "mode"; event: ChatShortcutEventLike }> = [
    { command: "model", event: event({ key: "/", ctrlKey: true }) },
    { command: "effort", event: event({ key: "e", ctrlKey: true }) },
    { command: "mode", event: event({ key: "m", ctrlKey: true, shiftKey: true }) }
  ];
  for (const entry of cases) {
    const label = shortcutLabelFor(entry.command, false);
    assert.ok(label, `${entry.command} must print a chord`);
    assert.deepEqual(
      resolveChatShortcut(entry.event),
      { kind: "control", command: entry.command },
      `${entry.command} prints ${label} but that chord resolves elsewhere`
    );
  }
});

test("the printed chord is platform-resolved text, ready for Kbd children", () => {
  assert.equal(shortcutLabelFor("mode", true), "⌘+Shift+M");
  assert.equal(shortcutLabelFor("mode", false), "Ctrl+Shift+M");
  assert.equal(shortcutLabelFor("model", false), "Ctrl+/");
});

test("a control with no chord prints nothing rather than inventing one", () => {
  assert.equal(shortcutLabelFor("attach", false), null);
  assert.equal(shortcutLabelFor("plan", false), null);
});

test("Escape and the scroll chord resolve, but are not the composer's to run", () => {
  // Both are in the shared table; the composer's window listener ignores them
  // (Escape is the textarea's, so the token menu gets first refusal).
  assert.deepEqual(resolveChatShortcut(event({ key: "Escape" })), { kind: "interrupt" });
  assert.deepEqual(resolveChatShortcut(event({ key: "j", ctrlKey: true })), {
    kind: "scroll-to-end"
  });
});

test("a repeat or an Alt chord is nobody's", () => {
  assert.equal(resolveChatShortcut(event({ key: "/", ctrlKey: true, repeat: true })), null);
  assert.equal(resolveChatShortcut(event({ key: "/", ctrlKey: true, altKey: true })), null);
});
