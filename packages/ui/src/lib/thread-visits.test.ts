import test from "node:test";
import assert from "node:assert/strict";

import { hasUnseenCompletion, markThreadRead, markThreadUnread, loadThreadVisits } from "./thread-visits.ts";

const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:05:00.000Z";

test("a junk blob loads as empty and bad entries are dropped", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let value: unknown;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "orquester.thread-visits" ? JSON.stringify(value) : null
  } });
  try {
    for (value of [null, [1], "x"]) assert.deepEqual(loadThreadVisits(), {});
    value = { a: T0, b: 7, c: "yesterday", "": T0 };
    assert.deepEqual(loadThreadVisits(), { a: T0 });
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("reading a thread stamps the TURN'S COMPLETION, never the clock", () => {
  // *T3: `ChatView.tsx:2108-2125`.* Stamping `now()` would mark as read a
  // completion that has not arrived yet, so a turn finishing a second after
  // the user glanced at the tab would be swallowed. Stamping the completion
  // clears exactly the one on screen.
  assert.deepEqual(markThreadRead({}, "a", T1), { a: T1 });
  assert.equal(hasUnseenCompletion(T1, markThreadRead({}, "a", T1).a), false);

  // A LATER completion, arriving while the same tab is still open, is unread
  // until its own read stamps it — the monotonic mark does not cover it.
  const read = markThreadRead({}, "a", T0);
  assert.equal(hasUnseenCompletion(T1, read.a), true);
  assert.equal(hasUnseenCompletion(T1, markThreadRead(read, "a", T1).a), false);
});

test("a thread whose latest turn never completed has nothing to read", () => {
  const visits = { a: T0 };
  assert.deepEqual(markThreadRead(visits, "a", null), visits, "no completed turn changes no read data");
  assert.deepEqual(markThreadRead(visits, "a", undefined), visits);
  assert.deepEqual(markThreadRead(visits, "a", "garbage"), visits);
});

test("visits are monotonic: an older stamp never moves the mark back", () => {
  const after = markThreadRead({ a: T1 }, "a", T0);
  assert.deepEqual(after, { a: T1 });
  assert.deepEqual(markThreadRead({ a: T0 }, "a", T1), { a: T1 });
});

test("mark-unread makes the completed turn unread without changing another thread", () => {
  const visits = markThreadUnread({ a: T1, b: T0 }, "a", T1);
  assert.equal(hasUnseenCompletion(T1, visits.a), true);
  assert.equal(visits.b, T0);
});

test("mark-unread is a no-op without a completed turn, and is idempotent", () => {
  const visits = { a: T0 };
  assert.deepEqual(markThreadUnread(visits, "a", null), visits);
  assert.deepEqual(markThreadUnread(visits, "a", undefined), visits);
  assert.deepEqual(markThreadUnread(visits, "a", "nope"), visits);
  const once = markThreadUnread(visits, "a", T1);
  assert.deepEqual(markThreadUnread(once, "a", T1), once);
});

test("a never-visited thread is not unread, and a running turn is never unread", () => {
  assert.equal(hasUnseenCompletion(T1, undefined), false);
  assert.equal(hasUnseenCompletion(null, T0), false);
  assert.equal(hasUnseenCompletion(undefined, T0), false);
  assert.equal(hasUnseenCompletion("not a date", T0), false);
});

test("an unreadable visit stamp reads as unread rather than silently read", () => {
  assert.equal(hasUnseenCompletion(T1, "garbled"), true);
});
