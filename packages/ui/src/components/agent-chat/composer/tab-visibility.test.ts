import test from "node:test";
import assert from "node:assert/strict";

import { isChatTabListenerActive } from "./tab-visibility.ts";

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
