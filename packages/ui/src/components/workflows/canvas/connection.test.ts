import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { edge, loopEdge, node, sequentialIds, workflow } from "../../../lib/workflows/testing.ts";
import { classifyConnection, connectBlocks, connectionRefusal } from "./connection.ts";
import { addBlock, removeElements } from "./ops.ts";

/** Trigger → Fix → Review (if: true/false) → Deploy; Review.false feeds nothing yet. */
const base = workflow(
  [node("t", "trigger.manual"), node("fix", "agent", {}, { name: "Fix" }), node("rev", "if", {}, { name: "Review" }), node("dep", "shell", {}, { name: "Deploy" })],
  [edge("t", "fix"), edge("fix", "rev"), edge("rev", "dep", "true")]
);

describe("canvas edits", () => {
  it("removes blocks with their edges and pinned outputs", () => {
    const wf = workflow(
      [node("t", "trigger.manual"), node("a", "agent"), node("b", "code")],
      [edge("t", "a"), edge("a", "b")],
      { pinned: { a: { text: "x" } } }
    );
    const next = removeElements(wf, ["a"], []);
    assert.equal(next.nodes.some((n) => n.id === "a"), false);
    assert.equal(next.edges.length, 0);
    assert.deepEqual(next.pinned, {});
  });

  it("inserting a block into a loop edge keeps the loop, from the new block", () => {
    const wf = workflow(base.nodes, [...base.edges, loopEdge("rev", "fix", "false", { maxLoops: 5, session: "new" })]);
    const { workflow: next, nodeId } = addBlock(wf, "code", { x: 0, y: 0 }, sequentialIds("n"), { intoEdgeId: "rev-false-loop-fix" });
    const into = next.edges.find((candidate) => candidate.target === nodeId)!;
    const out = next.edges.find((candidate) => candidate.source === nodeId)!;
    assert.equal(into.source, "rev");
    assert.equal(into.sourceHandle, "false");
    assert.equal(into.loop, undefined, "the edge into the new block is ordinary");
    assert.equal(out.target, "fix");
    assert.deepEqual(out.loop, { maxLoops: 5, session: "new" });
  });
});

describe("classifyConnection", () => {
  it("a forward connection is an ordinary edge", () => {
    assert.deepEqual(classifyConnection(base, { source: "rev", sourceHandle: "false", target: "dep" }), { kind: "edge" });
  });

  it("onto an ancestor through ordinary edges is a loop edge", () => {
    assert.deepEqual(classifyConnection(base, { source: "rev", sourceHandle: "false", target: "fix" }), { kind: "loop", targetName: "Fix" });
    assert.equal(connectionRefusal(base, { source: "rev", sourceHandle: "false", target: "fix" }), null);
  });

  it("refuses a loop from a failure output", () => {
    const verdict = classifyConnection(base, { source: "rev", sourceHandle: "error", target: "fix" });
    assert.equal(verdict.kind, "refused");
    assert.match((verdict as { reason: string }).reason, /failure output cannot loop back/);
  });

  it("refuses a loop onto a trigger, saying so", () => {
    assert.match(connectionRefusal(base, { source: "rev", sourceHandle: "false", target: "t" })!, /cannot go back to a trigger/);
    assert.match(connectionRefusal(base, { source: "dep", sourceHandle: "success", target: "t" })!, /cannot go back to a trigger/);
  });

  it("refuses a loop from an output that already leads somewhere", () => {
    assert.match(connectionRefusal(base, { source: "rev", sourceHandle: "true", target: "fix" })!, /Review · true already leads to Deploy/);
  });

  it("refuses any second edge on an output that loops", () => {
    const wf = workflow(base.nodes, [...base.edges, loopEdge("rev", "fix", "false")]);
    assert.match(connectionRefusal(wf, { source: "rev", sourceHandle: "false", target: "dep" })!, /loops back to Fix — an output with a loop leads nowhere else/);
  });

  it("refuses loops when asked to (moving a step)", () => {
    assert.match(connectionRefusal(base, { source: "rev", sourceHandle: "false", target: "fix" }, { loops: false })!, /one direction/);
  });

  it("an existing loop edge does not make its target's descendants ancestors", () => {
    // Review loops back to Fix; Fix → Review is still forward, Deploy → Fix still a (new) loop.
    const wf = workflow(base.nodes, [...base.edges, loopEdge("rev", "fix", "false")]);
    assert.equal(classifyConnection(wf, { source: "dep", sourceHandle: "success", target: "fix" }).kind, "loop");
    const wide = workflow([...base.nodes, node("x", "code", {}, { name: "X" })], [...wf.edges]);
    assert.deepEqual(classifyConnection(wide, { source: "fix", sourceHandle: "error", target: "x" }), { kind: "edge" });
  });

  it("keeps the existing refusals", () => {
    assert.equal(connectionRefusal(base, { source: "fix", sourceHandle: "success", target: "fix" }), "A block cannot feed itself.");
    assert.match(connectionRefusal(base, { source: "fix", sourceHandle: "nope", target: "dep" })!, /no “nope” output/);
    assert.equal(connectionRefusal(base, { source: "t", sourceHandle: "success", target: "fix" }), "Those blocks are already connected that way.");
  });
});

describe("connectBlocks", () => {
  it("adds a loop edge with the default limit", () => {
    const next = connectBlocks(base, { source: "rev", sourceHandle: "false", target: "fix" }, () => "e1");
    const added = next.edges.find((candidate) => candidate.id === "e1")!;
    assert.deepEqual(added.loop, { maxLoops: 2, session: "continue" });
  });

  it("an ordinary edge carries no loop", () => {
    const next = connectBlocks(base, { source: "rev", sourceHandle: "false", target: "dep" }, () => "e1");
    assert.equal(next.edges.find((candidate) => candidate.id === "e1")!.loop, undefined);
  });

  it("returns the same workflow when refused", () => {
    assert.equal(connectBlocks(base, { source: "rev", sourceHandle: "error", target: "fix" }, () => "e1"), base);
    assert.equal(connectBlocks(base, { source: "rev", sourceHandle: "false", target: "fix" }, () => "e1", { loops: false }), base);
  });
});
