import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import { addBlock, removeElements } from "./ops.ts";

const def = () =>
  workflow(
    [
      node("t", "trigger.manual"),
      node("a", "agent", {}, { name: "A" }),
      node("b", "code", {}, { name: "B" }),
      node("i", "if", {}, { name: "I" }),
      node("n", "note", {}, { name: "Note" }),
      node("s", "stop", {}, { name: "S" })
    ],
    [edge("t", "a"), edge("a", "b")]
  );

describe("canvas edits", () => {
  it("adds a block wired from an output", () => {
    const { workflow: next, nodeId } = addBlock(def(), "code", { x: 5, y: 9 }, sequentialIds("x"), { from: { nodeId: "b", handle: "success" } });
    const added = next.nodes.find((n) => n.id === nodeId)!;
    assert.equal(added.type, "code");
    assert.ok(next.edges.some((e) => e.source === "b" && e.target === nodeId));
  });

  it("inserts a block into an edge: source → new → target", () => {
    const { workflow: next, nodeId } = addBlock(def(), "wait", { x: 0, y: 0 }, sequentialIds("x"), { intoEdgeId: "a-success-b" });
    assert.ok(!next.edges.some((e) => e.id === "a-success-b"));
    assert.ok(next.edges.some((e) => e.source === "a" && e.target === nodeId && e.sourceHandle === "success"));
    assert.ok(next.edges.some((e) => e.source === nodeId && e.target === "b"));
  });

  it("removes blocks with their edges and pinned outputs", () => {
    const base = { ...def(), pinned: { a: { text: "x" } } };
    const next = removeElements(base, ["a"], []);
    assert.equal(next.nodes.some((n) => n.id === "a"), false);
    assert.equal(next.edges.length, 0);
    assert.deepEqual(next.pinned, {});
  });
});
