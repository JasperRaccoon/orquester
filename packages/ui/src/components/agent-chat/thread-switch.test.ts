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

test("an empty hold never engages, so the hold cannot outlive its content", () => {
  const out = resolveThreadSwitchTimeline({
    sessionId: "b",
    rows: [],
    loading: true,
    held: { sessionId: "a", rows: [] }
  });
  assert.equal(out.paintOnly, false);
  assert.deepEqual(out.rows, []);
});

test("nothing held yet and nothing to show is simply empty", () => {
  const out = resolveThreadSwitchTimeline({ sessionId: "a", rows: [], loading: true, held: null });
  assert.deepEqual(out, { rows: [], paintOnly: false, displaySessionId: "a" });
});

test("only a settled non-empty paint is remembered", () => {
  const previous = { sessionId: "a", rows: ["a1"] };
  // paint-only: the screen is showing someone else's rows — do not re-hold them.
  assert.equal(
    nextHeldTimeline(previous, { rows: ["a1"], paintOnly: true, displaySessionId: "a" }),
    previous
  );
  // empty: nothing worth holding.
  assert.equal(
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

test("an unchanged projection keeps its object identity", () => {
  const rows = ["a1"];
  const previous = { sessionId: "a", rows };
  assert.equal(
    nextHeldTimeline(previous, { rows, paintOnly: false, displaySessionId: "a" }),
    previous
  );
});
