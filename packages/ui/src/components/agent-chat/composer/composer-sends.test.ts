/**
 * A send in flight belongs to the thread it left from, not to the composer
 * that sent it (§7.4): a project switch unmounts that composer while the post
 * keeps retrying, and the one that shows the thread when its tab comes back
 * must still see it — or the user sends the same message a second time.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  beginComposerSend,
  isComposerSending,
  resetComposerSends,
  subscribeComposerSends
} from "./composer-sends";

describe("the per-thread in-flight send registry", () => {
  afterEach(() => resetComposerSends());

  it("a send in flight is seen by every reader of its thread, and by no other thread", () => {
    const settle = beginComposerSend("A");
    assert.equal(isComposerSending("A"), true, "a composer mounted for A after the send left still sees it");
    assert.equal(isComposerSending("B"), false);
    settle();
    assert.equal(isComposerSending("A"), false);
  });

  it("each settle closes its own send only, and a second call is a no-op", () => {
    const first = beginComposerSend("A");
    const second = beginComposerSend("A");
    first();
    assert.equal(isComposerSending("A"), true, "the other send on A is still in flight");
    first();
    assert.equal(isComposerSending("A"), true, "settling twice must not close someone else's send");
    second();
    assert.equal(isComposerSending("A"), false);
  });

  it("a send that left A, settling late, never re-enables B's send", () => {
    // The composer that sent from A may show B by then (the defensive swap):
    // its late settle touches A's entry and nothing else.
    const fromA = beginComposerSend("A");
    const fromB = beginComposerSend("B");
    fromA();
    assert.equal(isComposerSending("B"), true);
    fromB();
    assert.equal(isComposerSending("B"), false);
  });

  it("tells subscribers about every change, until they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeComposerSends(() => {
      calls += 1;
    });
    const settle = beginComposerSend("A");
    settle();
    settle();
    assert.equal(calls, 2, "open and close — an idempotent repeat is silent");
    unsubscribe();
    beginComposerSend("A")();
    assert.equal(calls, 2);
  });
});
