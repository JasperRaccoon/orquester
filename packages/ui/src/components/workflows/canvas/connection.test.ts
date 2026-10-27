import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, node, workflow } from "../../../lib/workflows/testing.ts";
import { removeElements } from "./ops.ts";

describe("canvas edits", () => {
  it("removes blocks with their edges and pinned outputs", () => {
    const base = workflow(
      [node("t", "trigger.manual"), node("a", "agent"), node("b", "code")],
      [edge("t", "a"), edge("a", "b")],
      { pinned: { a: { text: "x" } } }
    );
    const next = removeElements(base, ["a"], []);
    assert.equal(next.nodes.some((n) => n.id === "a"), false);
    assert.equal(next.edges.length, 0);
    assert.deepEqual(next.pinned, {});
  });
});
