import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildStepOutline } from "./outline.ts";
import type { WorkflowNodeType } from "./types.ts";

function wf(nodes: [string, WorkflowNodeType][], edges: [string, string, string?][]) {
  return {
    nodes: nodes.map(([id, type]) => ({ id, type, position: { x: 0, y: 0 }, config: {} })),
    edges: edges.map(([source, target, handle], index) => ({ id: `e${index}`, source, target, sourceHandle: handle ?? "success" }))
  };
}

describe("buildStepOutline", () => {
  it("a diamond exposes each step once and links both branches to the join", () => {
    const outline = buildStepOutline(
      wf(
        [["t", "trigger.manual"], ["if", "if"], ["a", "code"], ["b", "code"], ["m", "merge"], ["after", "code"]],
        [["t", "if"], ["if", "a", "true"], ["if", "b", "false"], ["a", "m"], ["b", "m"], ["m", "after"]]
      )
    );
    assert.deepEqual(outline.filter((item) => item.kind === "node").map((item) => item.nodeId), ["t", "if", "a", "b", "m", "after"]);
    assert.deepEqual(outline.filter((item) => item.kind === "join-ref").map((item) => [item.parentId, item.joinsNodeId]), [["a", "m"], ["b", "m"]]);
  });

  it("disconnected blocks are marked unreachable and notes are not actionable steps", () => {
    const outline = buildStepOutline(
      wf(
        [["lonely", "code"], ["t", "trigger.manual"], ["n", "note"], ["a", "code"], ["orphan", "code"], ["child", "code"]],
        [["t", "a"], ["orphan", "child"]]
      )
    );
    assert.deepEqual(outline.filter((item) => item.unreachable).map((item) => item.nodeId).sort(), ["child", "lonely", "orphan"]);
    assert.deepEqual(outline.filter((item) => !item.unreachable).map((item) => item.nodeId), ["t", "a"]);
  });

  it("a cycle does not loop forever", () => {
    const outline = buildStepOutline(
      wf([["t", "trigger.manual"], ["a", "code"], ["b", "code"]], [["t", "a"], ["a", "b"], ["b", "a"]])
    );
    assert.deepEqual(outline.filter((item) => item.kind === "node").map((item) => item.nodeId).sort(), ["a", "b", "t"]);
  });

  it("a loop edge is neither a child nor a join: the steps read straight through", () => {
    const graph = wf([["t", "trigger.manual"], ["fix", "agent"], ["check", "if"], ["done", "code"]], [["t", "fix"], ["fix", "check"], ["check", "done", "true"]]);
    graph.edges.push({ id: "back", source: "check", target: "fix", sourceHandle: "false", loop: { maxLoops: 2, session: "continue" } } as never);
    const outline = buildStepOutline(graph);
    assert.deepEqual(outline.map((item) => [item.kind, item.nodeId]), [["node", "t"], ["node", "fix"], ["node", "check"], ["node", "done"]]);
  });
});
