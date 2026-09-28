import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowNodeType } from "./types.ts";
import {
  autoLayout,
  LAYOUT_GRID,
  LAYOUT_NODE_HEIGHT,
  LAYOUT_NODE_SEP,
  LAYOUT_NODE_WIDTH,
  placeNewNodes,
  type LayoutPoint
} from "./layout.ts";

function node(id: string, type: WorkflowNodeType = "code", position = { x: 0, y: 0 }) {
  return { id, type, position, config: {} };
}
function edge(source: string, target: string, sourceHandle = "success") {
  return { source, target, sourceHandle };
}

function assertNoOverlap(points: LayoutPoint[]): void {
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i]!;
      const b = points[j]!;
      const apart = Math.abs(a.x - b.x) >= LAYOUT_NODE_WIDTH || Math.abs(a.y - b.y) >= LAYOUT_NODE_HEIGHT;
      assert.ok(apart, `boxes ${i} and ${j} overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
  }
}

describe("autoLayout", () => {
  it("lays a chain out left to right, from the origin, on the grid", () => {
    const layout = autoLayout({
      nodes: [node("t", "trigger.manual"), node("a"), node("b")],
      edges: [edge("t", "a"), edge("a", "b")]
    });
    assert.ok(layout.t!.x < layout.a!.x && layout.a!.x < layout.b!.x);
    assert.equal(layout.t!.y, layout.a!.y);
    assert.equal(Math.min(...Object.values(layout).map((point) => point.x)), 0);
    assert.equal(Math.min(...Object.values(layout).map((point) => point.y)), 0);
    for (const point of Object.values(layout)) {
      assert.equal(point.x % LAYOUT_GRID, 0);
      assert.equal(point.y % LAYOUT_GRID, 0);
    }
    assert.ok(layout.a!.x - layout.t!.x >= LAYOUT_NODE_WIDTH + 64);
  });

  it("branches stack vertically without overlapping; notes are left alone", () => {
    const layout = autoLayout({
      nodes: [node("t", "trigger.manual"), node("if", "if"), node("yes"), node("no"), node("n", "note"), node("m", "merge")],
      edges: [edge("t", "if"), edge("if", "yes", "true"), edge("if", "no", "false"), edge("yes", "m"), edge("no", "m")]
    });
    assert.equal(layout.n, undefined);
    assert.equal(layout.yes!.x, layout.no!.x);
    assert.ok(Math.abs(layout.yes!.y - layout.no!.y) >= LAYOUT_NODE_HEIGHT + LAYOUT_NODE_SEP - LAYOUT_GRID);
    assertNoOverlap(Object.values(layout));
  });

  it("a selection keeps its corner", () => {
    const layout = autoLayout(
      {
        nodes: [node("a", "code", { x: 800, y: 400 }), node("b", "code", { x: 1000, y: 1000 }), node("c", "code", { x: 0, y: 0 })],
        edges: [edge("a", "b"), edge("c", "a")]
      },
      { onlyNodeIds: ["a", "b"] }
    );
    assert.deepEqual(Object.keys(layout).sort(), ["a", "b"]);
    assert.equal(Math.min(layout.a!.x, layout.b!.x), 800);
    assert.equal(Math.min(layout.a!.y, layout.b!.y), 400);
  });

  it("an empty or notes-only graph yields nothing", () => {
    assert.deepEqual(autoLayout({ nodes: [], edges: [] }), {});
    assert.deepEqual(autoLayout({ nodes: [node("n", "note")], edges: [] }), {});
  });
});

describe("placeNewNodes", () => {
  it("everything new: a full layout, notes stacked below", () => {
    const placed = placeNewNodes(
      { nodes: [node("t", "trigger.manual"), node("a"), node("n", "note")], edges: [edge("t", "a")] },
      ["t", "a", "n"]
    );
    assert.deepEqual(Object.keys(placed).sort(), ["a", "n", "t"]);
    assert.ok(placed.a!.x > placed.t!.x);
    assert.ok(placed.n!.y > placed.a!.y);
  });

  it("a new node goes right of its placed input, avoiding existing boxes", () => {
    const workflow = {
      nodes: [
        node("t", "trigger.manual", { x: 0, y: 0 }),
        node("a", "code", { x: 320, y: 0 }),
        node("new")
      ],
      edges: [edge("t", "a"), edge("t", "new")]
    };
    const placed = placeNewNodes(workflow, ["new"]);
    assert.deepEqual(Object.keys(placed), ["new"]);
    assert.equal(placed.new!.x, 320);
    assert.ok(placed.new!.y >= LAYOUT_NODE_HEIGHT, "moved below the existing box in that column");
    assertNoOverlap([{ x: 0, y: 0 }, { x: 320, y: 0 }, placed.new!]);
  });

  it("a chain of new nodes extends to the right; a node with only an output goes left of it", () => {
    const workflow = {
      nodes: [node("a", "code", { x: 400, y: 160 }), node("n1"), node("n2"), node("pre")],
      edges: [edge("a", "n1"), edge("n1", "n2"), edge("pre", "a")]
    };
    const placed = placeNewNodes(workflow, ["n1", "n2", "pre"]);
    assert.ok(placed.n1!.x > 400);
    assert.ok(placed.n2!.x > placed.n1!.x);
    assert.ok(placed.pre!.x < 400);
    assertNoOverlap([{ x: 400, y: 160 }, placed.n1!, placed.n2!, placed.pre!]);
  });

  it("an unconnected new node goes below everything", () => {
    const placed = placeNewNodes(
      { nodes: [node("a", "code", { x: 0, y: 0 }), node("b", "code", { x: 320, y: 480 }), node("loose")], edges: [] },
      ["loose"]
    );
    assert.equal(placed.loose!.x, 0);
    assert.ok(placed.loose!.y > 480);
  });
});
