import test from "node:test";
import assert from "node:assert/strict";

import {
  THREAD_VISITS_LIMIT,
  hasUnseenCompletion,
  markThreadUnread,
  markThreadVisited,
  sanitizeThreadVisits
} from "./thread-visits.ts";

const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:05:00.000Z";

test("a junk blob loads as empty and bad entries are dropped", () => {
  assert.deepEqual(sanitizeThreadVisits(null), {});
  assert.deepEqual(sanitizeThreadVisits([1]), {});
  assert.deepEqual(sanitizeThreadVisits("x"), {});
  assert.deepEqual(sanitizeThreadVisits({ a: T0, b: 7, c: "yesterday", "": T0 }), { a: T0 });
});

test("the visit map is capped, newest first", () => {
  const raw: Record<string, string> = {};
  for (let i = 0; i < THREAD_VISITS_LIMIT + 10; i++) {
    raw[`s${i}`] = new Date(Date.parse(T0) + i * 1000).toISOString();
  }
  const visits = sanitizeThreadVisits(raw);
  assert.equal(Object.keys(visits).length, THREAD_VISITS_LIMIT);
  // The ten oldest went.
  assert.equal(visits.s0, undefined);
  assert.equal(visits[`s${THREAD_VISITS_LIMIT + 9}`] !== undefined, true);
});

test("visits are monotonic: an older stamp never moves the mark back", () => {
  const after = markThreadVisited({ a: T1 }, "a", T0);
  assert.deepEqual(after, { a: T1 });
  assert.deepEqual(markThreadVisited({ a: T0 }, "a", T1), { a: T1 });
});

test("an unparseable visit stamp is ignored and the map keeps its identity", () => {
  const visits = { a: T0 };
  assert.equal(markThreadVisited(visits, "a", "nope"), visits);
  assert.equal(markThreadVisited(visits, "a", T0), visits);
});

test("mark-unread stamps one millisecond before the completion", () => {
  const visits = markThreadUnread({ a: T1 }, "a", T1);
  assert.equal(visits.a, "2026-09-21T10:04:59.999Z");
  // …which is exactly what makes it unread again.
  assert.equal(hasUnseenCompletion(T1, visits.a), true);
});

test("mark-unread is a no-op without a completed turn, and is idempotent", () => {
  const visits = { a: T0 };
  assert.equal(markThreadUnread(visits, "a", null), visits);
  assert.equal(markThreadUnread(visits, "a", undefined), visits);
  assert.equal(markThreadUnread(visits, "a", "nope"), visits);
  const once = markThreadUnread(visits, "a", T1);
  assert.equal(markThreadUnread(once, "a", T1), once);
});

test("unread is exactly completedAt newer than the last visit", () => {
  assert.equal(hasUnseenCompletion(T1, T0), true);
  assert.equal(hasUnseenCompletion(T0, T1), false);
  // Equal is read: visiting at the instant it completed means you saw it.
  assert.equal(hasUnseenCompletion(T0, T0), false);
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
