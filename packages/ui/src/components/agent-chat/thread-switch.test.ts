import test from "node:test";
import assert from "node:assert/strict";

import { resolveThreadSwitchTimeline } from "./thread-switch.ts";

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
