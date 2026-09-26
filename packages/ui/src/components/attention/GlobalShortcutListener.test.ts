/**
 * `anotherLayerOwnsTheKeyboard` is the one set every app-level key handler
 * stands down for: the Attention Center's cycle here, and the chat's Escape
 * (`AgentChatView`'s shell listener and the composer's two arms). Those run on
 * `window` in the capture phase — before any layer's own listener — so a layer
 * this gate does not see never gets its Escape: the chat interrupts the turn
 * under an open output viewer instead.
 */

import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { openLayer } from "../../lib/open-layers.ts";
import { anotherLayerOwnsTheKeyboard } from "./GlobalShortcutListener.tsx";

const opened: Array<() => void> = [];
afterEach(() => {
  for (const release of opened.splice(0)) release();
});

it("with nothing up, no other layer owns the keyboard", () => {
  assert.equal(anotherLayerOwnsTheKeyboard(), false);
});

it("an open modal, sheet, menu or popover owns the keyboard until it closes", () => {
  // Every one of them registers through `useOpenLayer`; the output viewer the
  // chat opens over a running turn is a `Modal`.
  const release = openLayer();
  opened.push(release);
  assert.equal(anotherLayerOwnsTheKeyboard(), true);
  release();
  assert.equal(anotherLayerOwnsTheKeyboard(), false);
});
