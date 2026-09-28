import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SnapshotHistory } from "./history.ts";

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

  it("a burst with one key is one step; a pause or another key starts a new one", () => {
    const history = new SnapshotHistory<string>();
    history.record("a", "drag", 0);
    history.record("a1", "drag", 16);
    history.record("a2", "drag", 32);
    history.record("b", "drag", 10_000);
    history.record("c", "name", 10_001);
    assert.equal(history.undo("d"), "c", "another key is another edit");
    assert.equal(history.undo("c"), "b", "a pause separates edits");
    assert.equal(history.undo("b"), "a", "the whole drag undoes to where it started");
    assert.equal(history.undo("a"), null);
  });

  it("a null key never coalesces, and seal() ends a burst early", () => {
    const history = new SnapshotHistory<number>();
    history.record(1, null, 0);
    history.record(2, null, 1);
    history.record(3, "k", 2);
    history.seal();
    history.record(4, "k", 3);
    assert.equal(history.undo(5), 4);
    assert.equal(history.undo(4), 3);
    assert.equal(history.undo(3), 2);
    assert.equal(history.undo(2), 1);
  });

  it("a new change after an undo drops what could be redone", () => {
    const history = new SnapshotHistory<string>();
    history.record("a", null, 0);
    history.undo("b");
    assert.equal(history.canRedo, true);
    history.record("a", null, 5);
    assert.equal(history.canRedo, false);
  });

  it("keeps at most 100 steps, dropping the oldest", () => {
    const history = new SnapshotHistory<number>();
    for (let i = 0; i < 150; i += 1) history.record(i, null, i);
    let current = 150;
    let count = 0;
    for (;;) {
      const previous = history.undo(current);
      if (previous === null) break;
      count += 1;
      current = previous;
    }
    assert.equal(count, 100);
    assert.equal(current, 50);
  });
});
