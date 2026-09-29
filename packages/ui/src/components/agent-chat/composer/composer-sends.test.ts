/**
 * A send in flight belongs to the thread it left from, not to the composer
 * that sent it (§7.4): a project switch unmounts that composer while the post
 * keeps retrying, and the one that shows the thread when its tab comes back
 * must still see it — or the user sends the same message a second time.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  beginComposerSend,
  beginQueuedSend,
  isComposerSending,
  isQueuedSendInFlight,
  subscribeComposerSends,
  subscribeQueuedSends
} from "./composer-sends";

describe("the per-thread in-flight send registry", () => {

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
    const states: boolean[] = [];
    const unsubscribe = subscribeComposerSends(() => {
      states.push(isComposerSending("A"));
    });
    const settle = beginComposerSend("A");
    settle();
    settle();
    assert.deepEqual(states, [true, false]);
    unsubscribe();
    beginComposerSend("A")();
    assert.deepEqual(states, [true, false]);
  });
});

/**
 * A thread's queued sends leave one at a time, across store generations
 * (§7.4): the generation a project switch tore down may still be posting the
 * head of the queue when the thread's next generation reaches a boundary, and
 * sending the next message then let it overtake — or, when the first failed
 * and was held at the front, jump — the one still on its way.
 */
describe("the per-thread queued-send marker", () => {

  it("holds a thread's queue while any of its queued sends is in flight, and no other thread's", () => {
    const first = beginQueuedSend("A");
    const second = beginQueuedSend("A");
    assert.equal(isQueuedSendInFlight("A"), true);
    assert.equal(isQueuedSendInFlight("B"), false);
    first();
    first();
    assert.equal(isQueuedSendInFlight("A"), true, "the other send still holds it");
    second();
    assert.equal(isQueuedSendInFlight("A"), false);
  });

  it("is not a composer send: a queued send never reads as Sending, and a composer send never holds the queue", () => {
    const queued = beginQueuedSend("A");
    assert.equal(isComposerSending("A"), false);
    queued();
    const sending = beginComposerSend("A");
    assert.equal(isQueuedSendInFlight("A"), false);
    sending();
  });

  it("tells its listeners which thread's queue moved, until they unsubscribe", () => {
    const heard: Array<[string, boolean]> = [];
    const unsubscribe = subscribeQueuedSends((sessionId) => {
      heard.push([sessionId, isQueuedSendInFlight(sessionId)]);
    });
    const settle = beginQueuedSend("A");
    settle();
    settle();
    beginQueuedSend("B")();
    const expected = [["A", true], ["A", false], ["B", true], ["B", false]];
    assert.deepEqual(heard, expected);
    unsubscribe();
    beginQueuedSend("A")();
    assert.deepEqual(heard, expected);
  });
});
