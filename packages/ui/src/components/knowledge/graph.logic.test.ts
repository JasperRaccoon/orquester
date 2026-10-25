import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeColor } from "@orquester/api";

import { node, summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  focusFor,
  graphQueryOf,
  graphScopeKey,
  nodeColors,
  searchSummary,
  truncationNote
} from "./graph.logic.ts";

const colorOf = new Map<string, KnowledgeColor>([
  ["kc_seo", "chart-1"],
  ["kc_ads", "chart-2"],
  ["kc_saas", "chart-1"]
]);

describe("the graph request", () => {
  it("asks for the overview, filtered, or a neighbourhood", () => {
    assert.deepEqual(graphQueryOf({ collections: [], focus: null }), {});
    assert.deepEqual(graphQueryOf({ collections: ["kc_b", "kc_a"], focus: null }), { collections: "kc_a,kc_b" });
    assert.deepEqual(graphQueryOf({ collections: [], focus: "tactic-a" }), { focus: "tactic-a", depth: 2 });
    assert.equal(graphScopeKey({ collections: ["b", "a"], focus: null }), graphScopeKey({ collections: ["a", "b"], focus: null }));
  });
});

describe("where a selection takes the canvas", () => {
  const full = { truncated: false, nodes: [node({ id: "a" })] };
  const partial = { truncated: true, nodes: [node({ id: "a" })] };

  it("keeps the canvas when the concept is on it", () => {
    assert.equal(focusFor({ kind: "concept", id: "a" }, partial, null), null);
    assert.equal(focusFor({ kind: "concept", id: "a" }, partial, "x"), "x");
  });

  it("shows the neighbourhood of a concept that is not on it", () => {
    assert.equal(focusFor({ kind: "concept", id: "b" }, partial, null), "b");
    assert.equal(focusFor({ kind: "concept", id: "b" }, full, null), "b");
  });

  it("keeps a complete overview for an entry, and focuses it on a truncated one", () => {
    assert.equal(focusFor({ kind: "entry", id: "ke_1" }, full, null), null);
    assert.equal(focusFor({ kind: "entry", id: "ke_1" }, partial, null), "ke_1");
    assert.equal(focusFor({ kind: "entry", id: "ke_1" }, full, "a"), "ke_1");
  });

  it("changes nothing before the graph has loaded", () => {
    assert.equal(focusFor({ kind: "concept", id: "b" }, null, null), null);
  });

  it("says when the canvas holds part of the graph", () => {
    assert.equal(truncationNote({ truncated: false, nodes: [], totals: { nodes: 0, edges: 0 } }, false), null);
    assert.match(truncationNote({ truncated: true, nodes: [node()], totals: { nodes: 4000, edges: 1 } }, false) ?? "", /1 most connected of 4,000/);
    assert.match(truncationNote({ truncated: true, nodes: [node()], totals: { nodes: 4000, edges: 1 } }, true) ?? "", /neighbourhood: 1 of 4,000/);
  });
});

describe("concept colours, sizes and labels", () => {
  it("colours by the concept's collections, once per colour, within the filter", () => {
    assert.deepEqual(nodeColors(node({ collections: ["kc_ads", "kc_seo", "kc_saas"] }), colorOf, []), ["chart-2", "chart-1"]);
    assert.deepEqual(nodeColors(node({ collections: ["kc_ads", "kc_seo"] }), colorOf, ["kc_seo"]), ["chart-1"]);
    assert.deepEqual(nodeColors(node({ collections: ["kc_unknown"] }), colorOf, []), [], "unknown or Unfiled: neutral");
  });
});

describe("the search summary", () => {
  const entryHit = (id: string) => ({ kind: "entry" as const, score: 1, entry: summary({ id }) });
  const conceptHit = (id: string) => ({ kind: "concept" as const, score: 1, concept: { id, name: id, type: "Tactic", description: null }, entryIds: [] });

  it("names entry hits, which have no node to mark, and concept hits not on the canvas", () => {
    assert.equal(searchSummary([], new Set()), null);
    assert.equal(searchSummary([entryHit("ke_1")], new Set()), "Matches: 1 entry.");
    assert.equal(searchSummary([entryHit("ke_1"), entryHit("ke_2"), conceptHit("a")], new Set(["a"])), "Matches: 2 entries, 1 concept (marked).");
    assert.equal(searchSummary([conceptHit("a"), conceptHit("b")], new Set(["a"])), "Matches: 2 concepts (1 marked).");
    assert.equal(searchSummary([conceptHit("b")], new Set(["a"])), "Matches: 1 concept (not on the canvas).");
  });
});
