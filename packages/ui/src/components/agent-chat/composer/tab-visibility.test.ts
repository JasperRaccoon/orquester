import test from "node:test";
import assert from "node:assert/strict";

import {
  composerEscapeAction,
  composerOwnsEscape,
  type ComposerEscapeInput
} from "./tab-visibility.ts";

const activeComposer = { defaultPrevented: false, insideComposerShell: true, isTextarea: false, isTurnActive: true, drillInOpen: false, layerOpen: false };

// ---------------------------------------------------------------------------
// Escape ownership (V1 §10.1) — one Escape must yield exactly one interrupt
// ---------------------------------------------------------------------------

test("while a layer is up, the composer yields Escape", () => {
  assert.equal(composerOwnsEscape({ ...activeComposer, layerOpen: true }), false);
  assert.equal(composerOwnsEscape({ ...activeComposer, layerOpen: true, drillInOpen: true }), false);
});

test("with a subagent view open, the composer claims Escape even while idle", () => {
  assert.equal(composerOwnsEscape({ ...activeComposer, drillInOpen: true }), true);
  assert.equal(composerOwnsEscape({ ...activeComposer, drillInOpen: true, isTurnActive: false }), true);
});

test("the composer claims running-turn Escape only inside its shell", () => {
  assert.equal(composerOwnsEscape(activeComposer), true);
  assert.equal(composerOwnsEscape({ ...activeComposer, insideComposerShell: false }), false);
});

test("the textarea keeps Escape to itself — the token menu gets first refusal", () => {
  assert.equal(
    composerOwnsEscape({
      defaultPrevented: false,
      insideComposerShell: true,
      isTextarea: true,
      isTurnActive: true,
      drillInOpen: false,
      layerOpen: false
    }),
    false
  );
});

test("whoever ran first can stand the other down via defaultPrevented", () => {
  assert.equal(composerOwnsEscape({ ...activeComposer, defaultPrevented: true }), false);
});

test("Escape with no turn running never interrupts from the composer", () => {
  assert.equal(composerOwnsEscape({ ...activeComposer, isTurnActive: false }), false);
});

// ---------------------------------------------------------------------------
// The textarea's own Escape (§7.4) — the composer's other arm
// ---------------------------------------------------------------------------

const idleTextarea: ComposerEscapeInput = {
  repeat: false,
  menuOpen: false,
  layerOpen: false,
  drillInOpen: false,
  isTurnActive: false
};

test("the token menu takes the textarea's Escape before anything else", () => {
  // Closing a menu the user just opened must not also stop the agent.
  assert.equal(composerEscapeAction({ ...idleTextarea, menuOpen: true }), "close-menu");
  assert.equal(
    composerEscapeAction({ ...idleTextarea, menuOpen: true, isTurnActive: true }),
    "close-menu"
  );
});

test("an open layer takes the textarea's Escape: no interrupt, and no half of Esc Esc", () => {
  // The context meter opens on hover, so its panel can be up while the caret
  // sits in the textarea — whose React handler runs before the panel's own
  // `document` listener. Interrupting there stopped the turn AND closed the
  // panel; counting it made the next Escape open the rewind picker.
  assert.equal(
    composerEscapeAction({ ...idleTextarea, layerOpen: true, isTurnActive: true }),
    "yield-to-layer"
  );
  assert.equal(composerEscapeAction({ ...idleTextarea, layerOpen: true }), "yield-to-layer");
});

test("with a subagent's view open, the textarea's Escape leaves it — never an interrupt", () => {
  // The drill-in wins over the interrupt (`resolveChatEscape`): a user who is
  // watching a child and presses Escape means "take me back", wherever the
  // caret is. The textarea used to stop the parent's turn instead — and when
  // idle, start Esc Esc under the child.
  assert.equal(
    composerEscapeAction({ ...idleTextarea, drillInOpen: true, isTurnActive: true }),
    "leave-drill-in"
  );
  assert.equal(composerEscapeAction({ ...idleTextarea, drillInOpen: true }), "leave-drill-in");
});

test("with a subagent's view open, a menu or a layer still takes its Escape first", () => {
  // Leaving the child is the next Escape's.
  assert.equal(
    composerEscapeAction({ ...idleTextarea, drillInOpen: true, menuOpen: true }),
    "close-menu"
  );
  assert.equal(
    composerEscapeAction({ ...idleTextarea, drillInOpen: true, layerOpen: true }),
    "yield-to-layer"
  );
});

test("with nothing open, Escape stops a running turn, and an idle one is half of Esc Esc", () => {
  assert.equal(composerEscapeAction({ ...idleTextarea, isTurnActive: true }), "interrupt");
  assert.equal(composerEscapeAction(idleTextarea), "rewind-press");
});

test("a held Escape is one press: its auto-repeat does nothing, whatever is open", () => {
  // The first keydown closed the menu, yielded to a layer or left the
  // drill-in; ~500 ms later the repeats found nothing of that left and
  // stopped the turn. A repeat is never half of Esc Esc either.
  for (const menuOpen of [false, true]) {
    for (const layerOpen of [false, true]) {
      for (const drillInOpen of [false, true]) {
        for (const isTurnActive of [false, true]) {
          const input = { repeat: true, menuOpen, layerOpen, drillInOpen, isTurnActive };
          assert.equal(composerEscapeAction(input), "hold", JSON.stringify(input));
        }
      }
    }
  }
});
