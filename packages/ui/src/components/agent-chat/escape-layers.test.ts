/**
 * Escape while a floating layer is open (fix round 1, goals §8.2's popover).
 *
 * The regression: the goal popover — any `Dropdown` — is portaled outside the
 * composer shell, so with it open an Escape reached the shell's capture-phase
 * `window` listener first, which interrupted a running turn (and, on Codex,
 * paused the goal through Stop) and swallowed the key, so the popover never
 * closed. Idle, the same Escape armed the first half of the Esc-Esc rewind.
 *
 * An open layer now registers itself (`lib/keyboard-layers.ts`), the one gate
 * both chat Escape owners read (`anotherLayerOwnsTheKeyboard`) says so, and
 * both stand down — the layer's own listener closes it, and that is all the
 * Escape does. These tests drive the real gate through the real resolvers.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { openKeyboardLayer, resetKeyboardLayers } from "../../lib/keyboard-layers";
import { anotherLayerOwnsTheKeyboard } from "../attention/GlobalShortcutListener";
import { composerOwnsEscape } from "./composer/tab-visibility";
import { chatEscapeSequenceStep, resolveChatEscape, type ChatEscapeInput } from "./escape-action";

beforeEach(() => {
  resetKeyboardLayers();
});

/** An Escape landing in the portaled popover: outside the composer shell. */
const escapeInPopover = (overrides: Partial<ChatEscapeInput> = {}): ChatEscapeInput => ({
  key: "Escape",
  defaultPrevented: false,
  isActiveTab: true,
  blockingLayerOpen: anotherLayerOwnsTheKeyboard(),
  insideComposer: false,
  drillInOpen: false,
  turnActive: false,
  secondPress: false,
  rewindAvailable: false,
  ...overrides
});

describe("an open popover owns Escape", () => {
  it("is a layer the gate reports, and only while it is open", () => {
    assert.equal(anotherLayerOwnsTheKeyboard(), false);
    const close = openKeyboardLayer();
    assert.equal(anotherLayerOwnsTheKeyboard(), true);
    close();
    assert.equal(anotherLayerOwnsTheKeyboard(), false);
  });

  it("popover open + running turn ⇒ the popover closes and nothing else happens", () => {
    const close = openKeyboardLayer();
    assert.equal(
      resolveChatEscape(escapeInPopover({ turnActive: true })),
      "ignore",
      "the shell neither interrupts the turn nor swallows the key"
    );
    assert.equal(
      composerOwnsEscape({
        defaultPrevented: false,
        insideComposerShell: false,
        isTextarea: false,
        isTurnActive: true,
        blockingLayerOpen: anotherLayerOwnsTheKeyboard()
      }),
      false,
      "and the composer does not take it either"
    );
    close();
    assert.equal(
      resolveChatEscape(escapeInPopover({ turnActive: true })),
      "interrupt",
      "once the popover is closed, the next Escape stops the turn as it always did"
    );
  });

  it("popover open + idle ⇒ the popover closes, and no rewind is armed", () => {
    const close = openKeyboardLayer();
    assert.equal(
      chatEscapeSequenceStep({ ...escapeInPopover(), repeat: false, insideFloatingLayer: false }),
      "reset",
      "closing a popover is never the first half of Esc-Esc"
    );
    assert.equal(
      resolveChatEscape(escapeInPopover({ secondPress: true, rewindAvailable: true })),
      "ignore",
      "nor its second half"
    );
    close();
    assert.equal(
      chatEscapeSequenceStep({ ...escapeInPopover(), repeat: false, insideFloatingLayer: false }),
      "press",
      "an idle Escape with nothing open counts again"
    );
  });

  it("popover open + drill-in ⇒ the popover closes first; the drill-in stays", () => {
    const close = openKeyboardLayer();
    assert.equal(resolveChatEscape(escapeInPopover({ drillInOpen: true })), "ignore");
    close();
    assert.equal(resolveChatEscape(escapeInPopover({ drillInOpen: true })), "close-drill-in");
  });
});
