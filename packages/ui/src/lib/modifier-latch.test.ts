import test from "node:test";
import assert from "node:assert/strict";

import { consumeLatchSet, latchSet, latchedNames, tapLatchIn } from "./modifier-latch.ts";

const NAMES = ["shift", "ctrl", "alt"] as const;

test("one tap arms a modifier for the next key only", () => {
  let set = tapLatchIn(latchSet(NAMES), "ctrl", 0);
  assert.deepEqual(latchedNames(set), ["ctrl"]);
  set = consumeLatchSet(set);
  assert.deepEqual(latchedNames(set), []);
});

test("a quick double tap locks until tapped again; slow taps disarm instead", () => {
  let set = tapLatchIn(tapLatchIn(latchSet(NAMES), "shift", 0), "shift", 200);
  assert.equal(set.shift.state, "locked");
  set = consumeLatchSet(consumeLatchSet(set));
  assert.deepEqual(latchedNames(set), ["shift"], "a locked modifier outlives keys");
  set = tapLatchIn(set, "shift", 5_000);
  assert.deepEqual(latchedNames(set), []);
  set = tapLatchIn(tapLatchIn(set, "alt", 0), "alt", 1_000);
  assert.equal(set.alt.state, "off");
});

test("consuming spends armed latches and keeps locked ones, in key order", () => {
  let set = latchSet(NAMES);
  set = tapLatchIn(set, "alt", 0);
  set = tapLatchIn(tapLatchIn(set, "shift", 10), "shift", 20);
  assert.deepEqual(latchedNames(set), ["shift", "alt"]);
  const spent = consumeLatchSet(set);
  assert.deepEqual(latchedNames(spent), ["shift"]);
  assert.equal(consumeLatchSet(spent), spent, "nothing to spend returns the same set");
});
