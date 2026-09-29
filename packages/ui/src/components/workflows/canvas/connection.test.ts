import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import { connectBlocks, connectionRefusal } from "./connection.ts";
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

describe("workflow connections", () => {
  it("accepts an output into a block that takes input", () => {
    assert.equal(connectionRefusal(def(), { source: "b", sourceHandle: "success", target: "i" }), null);
    assert.equal(connectionRefusal(def(), { source: "i", sourceHandle: "false", target: "s" }), null);
    assert.equal(connectionRefusal(def(), { source: "a", sourceHandle: "error", target: "s" }), null);
  });

  it("refuses cycles, self-loops and duplicates", () => {
    assert.notEqual(connectionRefusal(def(), { source: "b", sourceHandle: "success", target: "a" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "a" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "b" }), null);
    assert.equal(connectionRefusal(def(), { source: "a", sourceHandle: "error", target: "b" }), null, "another handle is another edge");
  });

  it("refuses a handle the source does not have, a trigger or a note as target, and notes as a source", () => {
    assert.notEqual(connectionRefusal(def(), { source: "a", sourceHandle: "true", target: "s" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "t" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "n" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "n", sourceHandle: "success", target: "s" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "s", sourceHandle: "success", target: "b" }), null, "Stop has no outputs");
    assert.notEqual(connectionRefusal(def(), { source: "zz", sourceHandle: "success", target: "b" }), null);
  });

  it("connectBlocks adds the edge, or returns the workflow untouched", () => {
    const base = def();
    const next = connectBlocks(base, { source: "i", sourceHandle: "true", target: "s" }, sequentialIds("e"));
    assert.deepEqual(next.edges.at(-1), { id: "e-1", source: "i", sourceHandle: "true", target: "s" });
    assert.deepEqual(connectBlocks(base, { source: "b", sourceHandle: "success", target: "a" }, sequentialIds()), base);
  });
});

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
