import test from "node:test";
import assert from "node:assert/strict";

import {
  activeChatTab,
  isActiveChatTab,
  releaseActiveChatTab,
  setActiveChatTab,
  subscribeActiveChatTab
} from "./agent-chat-active-tab.ts";

test("only the published tab is active; every other mounted tab is not", () => {
  setActiveChatTab("a");
  assert.equal(isActiveChatTab("a"), true);
  // The regression this exists for: two hidden chat tabs must not both act on
  // a window-level chord (Q2-1 sent a queued message on every thread, Q2-2
  // answered a question on every thread).
  assert.equal(isActiveChatTab("b"), false);
  assert.equal(isActiveChatTab("c"), false);
  setActiveChatTab(null);
});

test("no chat tab showing means no chat tab owns the keyboard", () => {
  setActiveChatTab("a");
  setActiveChatTab(null);
  assert.equal(isActiveChatTab("a"), false);
  assert.equal(activeChatTab(), null);
});

test("subscribers see each change once and never a repeat of the same id", () => {
  const seen: (string | null)[] = [];
  const stop = subscribeActiveChatTab((id) => seen.push(id));
  setActiveChatTab("a");
  setActiveChatTab("a");
  setActiveChatTab("b");
  setActiveChatTab(null);
  stop();
  setActiveChatTab("c");
  assert.deepEqual(seen, ["a", "b", null]);
  setActiveChatTab(null);
});

test("a tab releases the keyboard only while it still holds it", () => {
  setActiveChatTab("a");
  // A tab that was never active must not clear someone else's claim.
  releaseActiveChatTab("b");
  assert.equal(activeChatTab(), "a");
  releaseActiveChatTab("a");
  assert.equal(activeChatTab(), null);
});

test("a fast switch keeps the newcomer's claim when the old tab unmounts after it", () => {
  setActiveChatTab("a");
  setActiveChatTab("b");
  // `a`'s unmount effect runs after `b` claimed: a blind clear would leave the
  // keyboard unowned and every chord dead.
  releaseActiveChatTab("a");
  assert.equal(activeChatTab(), "b");
  setActiveChatTab(null);
});
