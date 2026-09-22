import test from "node:test";
import assert from "node:assert/strict";

import {
  composerOwnsEscape,
  isChatTabListenerActive,
  shellOwnsEscape
} from "./tab-visibility.ts";

const visible = { getClientRects: () => ({ length: 1 }) };
const hidden = { getClientRects: () => ({ length: 0 }) };

test("the visible, active tab acts", () => {
  assert.equal(isChatTabListenerActive(true, visible), true);
  assert.equal(isChatTabListenerActive(undefined, visible), true);
});

test("an explicitly inactive tab never acts, even while it still has a box", () => {
  // Q2-1/Q2-2: one Ctrl+Shift+Enter must not send every tab's queued message,
  // and one `1` must not answer every tab's question.
  assert.equal(isChatTabListenerActive(false, visible), false);
});

test("a hidden subtree never acts, even when the caller forgot to pass `active`", () => {
  // The backstop: MainView hides inactive tabs with `display:none`, so their
  // subtree has no client rects.
  assert.equal(isChatTabListenerActive(undefined, hidden), false);
  assert.equal(isChatTabListenerActive(true, hidden), false);
});

test("an unmounted listener owner never acts", () => {
  assert.equal(isChatTabListenerActive(true, null), false);
  assert.equal(isChatTabListenerActive(true, undefined), false);
});

// ---------------------------------------------------------------------------
// Escape ownership (V1 §10.1) — one Escape must yield exactly one interrupt
// ---------------------------------------------------------------------------

/** Every shape an Escape can arrive in, for the exhaustive disjointness check. */
function everyEscapeShape(): Array<{
  defaultPrevented: boolean;
  insideComposerShell: boolean;
  isTextarea: boolean;
  isTurnActive: boolean;
  drillInOpen: boolean;
}> {
  const shapes = [];
  for (const defaultPrevented of [false, true]) {
    for (const insideComposerShell of [false, true]) {
      for (const isTextarea of [false, true]) {
        for (const isTurnActive of [false, true]) {
          for (const drillInOpen of [false, true]) {
            // A textarea is by definition inside the shell.
            if (isTextarea && !insideComposerShell) continue;
            shapes.push({
              defaultPrevented,
              insideComposerShell,
              isTextarea,
              isTurnActive,
              drillInOpen
            });
          }
        }
      }
    }
  }
  return shapes;
}

test("one Escape is claimed by at most one owner — never both", () => {
  // The regression: two window listeners both fired ⇒ two interrupts, two
  // POSTs, two commandIds and a redundant queue drain.
  for (const shape of everyEscapeShape()) {
    const composer = composerOwnsEscape(shape);
    const shell = shellOwnsEscape(shape);
    assert.equal(
      composer && shell,
      false,
      `both owners claimed ${JSON.stringify(shape)}`
    );
  }
});

test("an Escape that stops a running turn is claimed by exactly one owner", () => {
  // Coverage the other way round: for a live turn with nothing already
  // handled, some owner must take it — otherwise Escape silently does nothing.
  for (const shape of everyEscapeShape()) {
    if (shape.defaultPrevented || !shape.isTurnActive || shape.isTextarea) continue;
    assert.equal(
      composerOwnsEscape(shape) || shellOwnsEscape(shape),
      true,
      `nobody claimed ${JSON.stringify(shape)}`
    );
  }
});

test("the composer owns Escape inside its shell, the shell owns it outside", () => {
  const live = { defaultPrevented: false, isTurnActive: true, drillInOpen: false };
  assert.equal(
    composerOwnsEscape({ ...live, insideComposerShell: true, isTextarea: false }),
    true
  );
  assert.equal(shellOwnsEscape({ ...live, insideComposerShell: true }), false);
  assert.equal(
    composerOwnsEscape({ ...live, insideComposerShell: false, isTextarea: false }),
    false
  );
  assert.equal(shellOwnsEscape({ ...live, insideComposerShell: false }), true);
});

test("the textarea keeps Escape to itself — the token menu gets first refusal", () => {
  assert.equal(
    composerOwnsEscape({
      defaultPrevented: false,
      insideComposerShell: true,
      isTextarea: true,
      isTurnActive: true
    }),
    false
  );
});

test("whoever ran first can stand the other down via defaultPrevented", () => {
  const handled = { defaultPrevented: true, isTurnActive: true, drillInOpen: true };
  assert.equal(
    composerOwnsEscape({ ...handled, insideComposerShell: true, isTextarea: false }),
    false
  );
  assert.equal(shellOwnsEscape({ ...handled, insideComposerShell: false }), false);
});

test("Escape with no turn running never interrupts from the composer", () => {
  assert.equal(
    composerOwnsEscape({
      defaultPrevented: false,
      insideComposerShell: true,
      isTextarea: false,
      isTurnActive: false
    }),
    false
  );
  // …but the shell still takes it to leave an open drill-in.
  assert.equal(
    shellOwnsEscape({
      defaultPrevented: false,
      insideComposerShell: false,
      isTurnActive: false,
      drillInOpen: true
    }),
    true
  );
});
