import test from "node:test";
import assert from "node:assert/strict";

import { nextHeldTimeline, resolveThreadSwitchTimeline } from "./thread-switch.ts";

const held = { sessionId: "a", rows: ["a1", "a2"] };

test("rows for the named thread always win", () => {
  const out = resolveThreadSwitchTimeline({
    sessionId: "b",
    rows: ["b1"],
    loading: true,
    held
  });
  assert.deepEqual(out, { rows: ["b1"], paintOnly: false, displaySessionId: "b" });
});

test("a reconnect on the same thread repaints its own rows, still interactive", () => {
  const out = resolveThreadSwitchTimeline({ sessionId: "a", rows: [], loading: true, held });
  assert.deepEqual(out, { rows: held.rows, paintOnly: false, displaySessionId: "a" });
});

test("switching to a thread with no snapshot holds the previous one, inert", () => {
  const out = resolveThreadSwitchTimeline({ sessionId: "b", rows: [], loading: true, held });
  assert.equal(out.paintOnly, true);
  assert.equal(out.displaySessionId, "a");
  assert.deepEqual(out.rows, held.rows);
});

test("a settled empty thread renders empty rather than someone else's rows", () => {
  const out = resolveThreadSwitchTimeline({ sessionId: "b", rows: [], loading: false, held });
  assert.deepEqual(out, { rows: [], paintOnly: false, displaySessionId: "b" });
});

test("only a settled non-empty paint is remembered", () => {
  const previous = { sessionId: "a", rows: ["a1"] };
  // paint-only: the screen is showing someone else's rows — do not re-hold them.
  assert.deepEqual(
    nextHeldTimeline(previous, { rows: ["a1"], paintOnly: true, displaySessionId: "a" }),
    previous
  );
  // empty: nothing worth holding.
  assert.deepEqual(
    nextHeldTimeline(previous, { rows: [], paintOnly: false, displaySessionId: "b" }),
    previous
  );
  const fresh = nextHeldTimeline(previous, {
    rows: ["b1"],
    paintOnly: false,
    displaySessionId: "b"
  });
  assert.deepEqual(fresh, { sessionId: "b", rows: ["b1"] });
});
