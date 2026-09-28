import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import { connectBlocks, connectionRefusal, isValidWorkflowConnection } from "./connection.ts";
import { addBlock, moveNodes, nudgeNodes, removeElements } from "./ops.ts";

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

describe("isValidConnection", () => {
  it("accepts an output into a block that takes input", () => {
    assert.equal(isValidWorkflowConnection(def(), { source: "b", sourceHandle: "success", target: "i" }), true);
    assert.equal(isValidWorkflowConnection(def(), { source: "i", sourceHandle: "false", target: "s" }), true);
    assert.equal(isValidWorkflowConnection(def(), { source: "a", sourceHandle: "error", target: "s" }), true);
  });

  it("refuses cycles, self-loops and duplicates", () => {
    assert.match(connectionRefusal(def(), { source: "b", sourceHandle: "success", target: "a" }) ?? "", /loop/);
    assert.match(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "a" }) ?? "", /itself/);
    assert.match(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "b" }) ?? "", /already/);
    assert.equal(connectionRefusal(def(), { source: "a", sourceHandle: "error", target: "b" }), null, "another handle is another edge");
  });

  it("refuses a handle the source does not have, a trigger or a note as target, and notes as a source", () => {
    assert.match(connectionRefusal(def(), { source: "a", sourceHandle: "true", target: "s" }) ?? "", /no “true” output/);
    assert.match(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "t" }) ?? "", /trigger/);
    assert.match(connectionRefusal(def(), { source: "a", sourceHandle: "success", target: "n" }) ?? "", /Notes/);
    assert.notEqual(connectionRefusal(def(), { source: "n", sourceHandle: "success", target: "s" }), null);
    assert.notEqual(connectionRefusal(def(), { source: "s", sourceHandle: "success", target: "b" }), null, "Stop has no outputs");
    assert.notEqual(connectionRefusal(def(), { source: "zz", sourceHandle: "success", target: "b" }), null);
  });

  it("connectBlocks adds the edge, or returns the workflow untouched", () => {
    const base = def();
    const next = connectBlocks(base, { source: "i", sourceHandle: "true", target: "s" }, sequentialIds("e"));
    assert.deepEqual(next.edges.at(-1), { id: "e-1", source: "i", sourceHandle: "true", target: "s" });
    assert.equal(connectBlocks(base, { source: "b", sourceHandle: "success", target: "a" }, sequentialIds()), base);
  });
});

describe("canvas edits", () => {
  it("adds a block wired from an output, with its default config and a free name", () => {
    const { workflow: next, nodeId } = addBlock(def(), "code", { x: 5, y: 9 }, sequentialIds("x"), { from: { nodeId: "b", handle: "success" } });
    const added = next.nodes.find((n) => n.id === nodeId)!;
    assert.equal(added.name, "Code");
    assert.deepEqual(added.position, { x: 0, y: 16 });
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
    assert.equal(removeElements(base, [], []), base);
  });

  it("moves snap to the grid; a nudge moves by grid steps; no move is the same object", () => {
    const base = def();
    const moved = moveNodes(base, { a: { x: 37, y: 41 } });
    assert.deepEqual(moved.nodes.find((n) => n.id === "a")?.position, { x: 32, y: 48 });
    const nudged = nudgeNodes(moved, ["a"], 10, -1);
    assert.deepEqual(nudged.nodes.find((n) => n.id === "a")?.position, { x: 192, y: 32 });
    assert.equal(moveNodes(base, { a: { x: 0, y: 0 } }), base);
  });
});
