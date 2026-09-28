import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HISTORY_COALESCE_MS, SnapshotHistory } from "./history.ts";

describe("SnapshotHistory", () => {
  it("undo hands back the state before each change, redo walks forward again", () => {
    const history = new SnapshotHistory<string>();
    history.record("a", null, 0);
    history.record("b", null, 10);
    assert.equal(history.undo("c"), "b");
    assert.equal(history.undo("b"), "a");
    assert.equal(history.undo("a"), null);
    assert.equal(history.redo("a"), "b");
    assert.equal(history.redo("b"), "c");
    assert.equal(history.redo("c"), null);
  });

  it("a burst with one key inside the window is one step; a pause or another key starts a new one", () => {
    const history = new SnapshotHistory<string>();
    assert.equal(history.record("a", "drag", 0), true);
    assert.equal(history.record("a1", "drag", 16), false);
    assert.equal(history.record("a2", "drag", 32), false);
    assert.equal(history.undo("a3"), "a", "the drag undoes to where it started");
    history.redo("a");
    assert.equal(history.record("x", "drag", 32 + HISTORY_COALESCE_MS + 1), true, "a pause ends the burst");
    assert.equal(history.record("y", "name", 32 + HISTORY_COALESCE_MS + 2), true, "another key is another step");
    assert.equal(history.size.past, 3);
  });

  it("a null key never coalesces, and seal() ends a burst early", () => {
    const history = new SnapshotHistory<number>();
    history.record(1, null, 0);
    history.record(2, null, 1);
    assert.equal(history.size.past, 2);
    history.record(3, "k", 2);
    history.seal();
    history.record(4, "k", 3);
    assert.equal(history.size.past, 4);
  });

  it("a new change after an undo drops what could be redone", () => {
    const history = new SnapshotHistory<string>();
    history.record("a", null, 0);
    history.undo("b");
    assert.equal(history.canRedo, true);
    history.record("a", null, 5);
    assert.equal(history.canRedo, false);
  });

  it("keeps at most the limit of steps, dropping the oldest", () => {
    const history = new SnapshotHistory<number>({ limit: 100 });
    for (let i = 0; i < 150; i += 1) history.record(i, null, i);
    assert.equal(history.size.past, 100);
    let last: number | null = null;
    let current = 150;
    for (;;) {
      const previous = history.undo(current);
      if (previous === null) break;
      last = previous;
      current = previous;
    }
    assert.equal(last, 50);
  });
});
