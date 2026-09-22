import test from "node:test";
import assert from "node:assert/strict";

import {
  activeChatSessionIdFor,
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

/*
 * The call site (V1 §10, item 8): the registry above only reports what it is
 * told, so Q2-1/Q2-2 are only really closed if the derivation feeding it is.
 */

const tabs = [
  { id: "t1", type: "agent-chat" as const, sessionId: "s1" },
  { id: "t2", type: "agent-chat" as const, sessionId: "s2" },
  { id: "t3", type: "terminal" as const, sessionId: "s3" },
  { id: "t4", type: "files" as const }
];

test("the active chat tab is the one showing, not merely one that is mounted", () => {
  assert.equal(activeChatSessionIdFor(tabs, "t1"), "s1");
  assert.equal(activeChatSessionIdFor(tabs, "t2"), "s2");
});

test("a terminal tab on screen means NO chat tab owns the keyboard", () => {
  // The bug shape: every chat tab stays mounted, so "the last chat tab" would
  // keep answering chords while the user is typing in a shell.
  assert.equal(activeChatSessionIdFor(tabs, "t3"), null);
  assert.equal(activeChatSessionIdFor(tabs, "t4"), null);
});

test("no active tab, or an id naming none, owns nothing", () => {
  assert.equal(activeChatSessionIdFor(tabs, null), null);
  assert.equal(activeChatSessionIdFor(tabs, undefined), null);
  assert.equal(activeChatSessionIdFor(tabs, ""), null);
  // Mid-close: the id outlives the tab for a render.
  assert.equal(activeChatSessionIdFor(tabs, "gone"), null);
  assert.equal(activeChatSessionIdFor([], "t1"), null);
});

test("a legacy `agent` terminal record is a PTY tab, never a chat tab", () => {
  assert.equal(
    activeChatSessionIdFor([{ id: "t5", type: "terminal", sessionId: "legacy" }], "t5"),
    null
  );
});
