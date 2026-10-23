import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeLayout, spread } from "./graph-layout.ts";

describe("the graph layout", () => {
  it("places every concept, at distinct points, ignoring edges it cannot draw", () => {
    const positions = computeLayout({
      nodes: [
        { id: "a", size: 20 },
        { id: "b", size: 10 },
        { id: "c", size: 10 }
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "a", target: "a" },
        { source: "a", target: "missing" }
      ]
    });
    assert.deepEqual(Object.keys(positions).sort(), ["a", "b", "c"]);
    for (const { x, y } of Object.values(positions)) assert.ok(Number.isFinite(x) && Number.isFinite(y));
    const points = new Set(Object.values(positions).map(({ x, y }) => `${Math.round(x)},${Math.round(y)}`));
    assert.equal(points.size, 3);
  });

  it("lays out an empty graph", () => {
    assert.deepEqual(computeLayout({ nodes: [], edges: [] }), {});
  });
});

describe("spreading a packed layout", () => {
  it("scales a crowded layout about its centre and leaves a roomy one alone", () => {
    const crowded = { a: { x: 0, y: 0 }, b: { x: 2, y: 0 }, c: { x: 0, y: 2 }, d: { x: 2, y: 2 } };
    const sizes = [{ size: 20 }, { size: 20 }, { size: 20 }, { size: 20 }];
    const out = spread(crowded, sizes);
    assert.ok(out.b!.x - out.a!.x > 40, "room for 20 px concepts");
    assert.equal((out.a!.x + out.b!.x) / 2, 1, "about the centre");
    const roomy = { a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 } };
    assert.equal(spread(roomy, sizes.slice(0, 2)), roomy);
  });
});
