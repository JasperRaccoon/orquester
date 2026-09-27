import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planListFocus } from "./list-focus.ts";
import { menuFocusIndex } from "./SavedPromptItem.tsx";

describe("focus across list changes", () => {
  it("nothing to do when focus was not on a card", () => {
    assert.deepEqual(planListFocus(["a", "b"], ["b"], null), { kind: "none" });
  });

  it("a card still listed keeps focus; a move asks to keep it in view", () => {
    assert.deepEqual(planListFocus(["a", "b", "c"], ["a", "b", "c"], "b"), { kind: "keep", id: "b", moved: false });
    // Send re-sorted it to the top (its last use is now).
    assert.deepEqual(planListFocus(["a", "b", "c"], ["b", "a", "c"], "b"), { kind: "keep", id: "b", moved: true });
    // Unpinned: from the Pinned section to the end.
    assert.deepEqual(planListFocus(["a", "b", "c"], ["b", "c", "a"], "a"), { kind: "keep", id: "a", moved: true });
  });

  it("a card that went away hands focus to the next one, else the previous one", () => {
    assert.deepEqual(planListFocus(["a", "b", "c"], ["a", "c"], "b"), { kind: "neighbour", id: "c" });
    assert.deepEqual(planListFocus(["a", "b", "c"], ["a", "b"], "c"), { kind: "neighbour", id: "b" });
    // The next one went too (another client): the one after it.
    assert.deepEqual(planListFocus(["a", "b", "c", "d"], ["a", "d"], "b"), { kind: "neighbour", id: "d" });
  });

  it("the last card gone: the list itself", () => {
    assert.deepEqual(planListFocus(["a"], [], "a"), { kind: "list" });
    assert.deepEqual(planListFocus([], [], "x"), { kind: "list" }, "a card never listed before");
  });
});

describe("the actions menu's arrow keys", () => {
  it("wrap around, and Home / End jump", () => {
    assert.equal(menuFocusIndex("ArrowDown", 4, 0), 1);
    assert.equal(menuFocusIndex("ArrowDown", 4, 3), 0);
    assert.equal(menuFocusIndex("ArrowUp", 4, 1), 0);
    assert.equal(menuFocusIndex("ArrowUp", 4, 0), 3);
    assert.equal(menuFocusIndex("Home", 4, 2), 0);
    assert.equal(menuFocusIndex("End", 4, 0), 3);
  });

  it("from the panel itself: down to the first, up to the last", () => {
    assert.equal(menuFocusIndex("ArrowDown", 4, -1), 0);
    assert.equal(menuFocusIndex("ArrowUp", 4, -1), 3);
  });

  it("other keys, or no items, are left alone", () => {
    assert.equal(menuFocusIndex("Enter", 4, 0), null);
    assert.equal(menuFocusIndex("Tab", 4, 0), null);
    assert.equal(menuFocusIndex("ArrowDown", 0, -1), null);
  });
});
