import assert from "node:assert/strict";
import { test } from "node:test";

import { kindTabKeyTarget } from "./KindTabs";

test("tab navigation wraps, supports Home/End, and leaves unrelated keys to their owners", () => {
  assert.equal(kindTabKeyTarget("ArrowRight", 5, 6), 0);
  assert.equal(kindTabKeyTarget("ArrowLeft", 0, 6), 5);
  assert.equal(kindTabKeyTarget("ArrowRight", 2, 6), 3);
  assert.equal(kindTabKeyTarget("Home", 4, 6), 0);
  assert.equal(kindTabKeyTarget("End", 1, 6), 5);
  for (const key of ["Escape", "Enter", " ", "ArrowUp", "ArrowDown", "Tab", "a"]) {
    assert.equal(kindTabKeyTarget(key, 2, 6), null, key);
  }
});
