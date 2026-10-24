import test from "node:test";
import assert from "node:assert/strict";

import { resolveThreadSwitchTimeline, threadSwitchDisplay } from "./thread-switch.ts";

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

test("the view's rows-free flags agree with the full hold in every case", () => {
  for (const sessionId of ["a", "b"]) {
    for (const rows of [[], ["x1"]]) {
      for (const loading of [true, false]) {
        for (const heldNow of [null, held, { sessionId: "a", rows: [] }]) {
          const full = resolveThreadSwitchTimeline({ sessionId, rows, loading, held: heldNow });
          const flags = threadSwitchDisplay({ sessionId, hasRows: rows.length > 0, loading, held: heldNow });
          assert.deepEqual(flags, { paintOnly: full.paintOnly, displaySessionId: full.displaySessionId });
        }
      }
    }
  }
});
