import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeColor, KnowledgeSimilarityGraphResponse, KnowledgeSimilarityNode } from "@orquester/api";

import { node, summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import {
  collectionLegend,
  focusFor,
  graphQueryOf,
  graphScopeKey,
  isMissingRoute,
  legendMemberIds,
  nodeColors,
  searchSummary,
  similarityCanvasEdges,
  similarityCanvasNodes,
  similarityEmptyState,
  similarityLegend,
  similarityQueryOf,
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

const simNode = (id: string, overrides: Partial<KnowledgeSimilarityNode> = {}): KnowledgeSimilarityNode => ({
  id,
  title: `Title ${id}`,
  kind: "post",
  author: null,
  handle: null,
  savedAt: "2026-10-20T10:00:00.000Z",
  collections: ["kc_seo"],
  cluster: 0,
  degree: 1,
  ...overrides
});

/** Clusters: 0 = {a, b, c} "Paywalls", 1 = {d, e} unlabelled, 2 = {f} singleton. */
const SIM: KnowledgeSimilarityGraphResponse = {
  nodes: [
    simNode("a", { degree: 4 }),
    simNode("b", { collections: ["kc_ads", "kc_seo"] }),
    simNode("c", { title: "  " }),
    simNode("d", { cluster: 1, collections: [] }),
    simNode("e", { cluster: 1, collections: ["kc_gone"] }),
    simNode("f", { cluster: 2, degree: 0 })
  ],
  edges: [
    { from: "a", to: "b", similarity: 0.92, tree: true },
    { from: "a", to: "c", similarity: 0.81, tree: false },
    { from: "d", to: "e", similarity: 0.88, tree: true }
  ],
  clusters: [
    { id: 0, size: 3, label: "Paywalls" },
    { id: 1, size: 2, label: null },
    { id: 2, size: 1, label: null }
  ],
  truncated: false,
  totals: { entries: 6, embedded: 6 }
};

describe("the similarity layer", () => {
  const collectionViews = [
    { id: "kc_seo", name: "SEO", color: "chart-1" as const },
    { id: "kc_ads", name: "Ads", color: "chart-2" as const }
  ];

  it("asks for the collections filtered to, sorted, or for everything", () => {
    assert.deepEqual(similarityQueryOf([]), {});
    assert.deepEqual(similarityQueryOf(["kc_b", "kc_a"]), { collections: "kc_a,kc_b" });
  });

  it("knows a daemon without the route from a refusal of its own", () => {
    assert.equal(isMissingRoute({ status: 404, body: { message: "Route GET:/api/knowledge/similarity-graph not found", error: "Not Found", statusCode: 404 } }), true);
    assert.equal(isMissingRoute({ status: 404 }), true);
    assert.equal(isMissingRoute({ status: 404, body: { code: "KNOWLEDGE_NOT_FOUND", message: "x" } }), false);
    assert.equal(isMissingRoute({ status: 404, body: { error: { code: "KNOWLEDGE_UNKNOWN_COLLECTION" } } }), false);
    assert.equal(isMissingRoute({ status: 500, body: {} }), false);
    assert.equal(isMissingRoute(new Error("offline")), false);
    assert.equal(isMissingRoute(null), false);
  });

  it("projects entry identities, titles and cluster membership to the canvas", () => {
    const nodes = similarityCanvasNodes(SIM, "cluster", colorOf, []);
    assert.deepEqual(nodes.map((n) => n.id), ["a", "b", "c", "d", "e", "f"]);
    assert.equal(nodes[0]!.label, "Title a");
    assert.equal(nodes[2]!.label, "Untitled");
    assert.ok(nodes[0]!.colors.length > 0);
    assert.deepEqual(nodes[1]!.colors, nodes[0]!.colors);
    assert.deepEqual(nodes[2]!.colors, nodes[0]!.colors);
    assert.deepEqual(nodes[4]!.colors, nodes[3]!.colors);
    assert.notDeepEqual(nodes[3]!.colors, nodes[0]!.colors);
    assert.deepEqual(nodes[5]!.colors, []);
  });

  it("colours by collection like concepts, within the filter", () => {
    const nodes = similarityCanvasNodes(SIM, "collection", colorOf, []);
    assert.deepEqual(nodes.find((n) => n.id === "b")!.colors, ["chart-2", "chart-1"]);
    assert.deepEqual(nodes.find((n) => n.id === "d")!.colors, [], "Unfiled: neutral");
    assert.deepEqual(similarityCanvasNodes(SIM, "collection", colorOf, ["kc_ads"]).find((n) => n.id === "b")!.colors, ["chart-2"]);
  });

  it("preserves endpoints and distinguishes tree from nearest-neighbour edges", () => {
    assert.deepEqual(similarityCanvasEdges(SIM).map(({ from, to, variant }) => [from, to, variant]), [
      ["a", "b", "tree"], ["a", "c", "knn"], ["d", "e", "tree"]
    ]);
  });

  it("lists cluster labels and member counts, including entries in no cluster", () => {
    assert.deepEqual(similarityLegend(SIM).items.map(({ label, size, members }) => ({ label, size, members })), [
      { label: "Paywalls", size: 3, members: { kind: "cluster", index: 0 } },
      { label: "Untitled", size: 2, members: { kind: "cluster", index: 1 } },
      { label: "In no cluster", size: 1, members: { kind: "singletons" } }
    ]);
  });

  it("lists collections with their entry counts, within the filter, then Unfiled", () => {
    assert.deepEqual(
      collectionLegend(SIM, collectionViews, []).items.map((i) => [i.label, i.size]),
      [
        ["SEO", 4],
        ["Ads", 1],
        ["Unfiled", 2]
      ]
    );
    assert.deepEqual(
      collectionLegend(SIM, collectionViews, ["kc_ads"]).items.map((i) => i.label),
      ["Ads", "Unfiled"]
    );
  });

  it("marks the entries a legend line stands for", () => {
    const known = new Set(["kc_seo", "kc_ads"]);
    assert.deepEqual([...legendMemberIds(SIM, { kind: "cluster", index: 1 }, known)], ["d", "e"]);
    assert.deepEqual([...legendMemberIds(SIM, { kind: "singletons" }, known)], ["f"]);
    assert.deepEqual([...legendMemberIds(SIM, { kind: "collection", id: "kc_ads" }, known)], ["b"]);
    assert.deepEqual([...legendMemberIds(SIM, { kind: "unfiled" }, known)], ["d", "e"]);
  });

  it("distinguishes an empty library and an older daemon with pending embeddings", () => {
    const none = { nodes: [], totals: { entries: 0, embedded: 0 } };
    assert.equal(similarityEmptyState(none, true), "no-entries");
    assert.equal(similarityEmptyState(none, false), "no-entries");
    assert.equal(similarityEmptyState({ nodes: [], totals: { entries: 4, embedded: 0 } }, undefined), "computing");
  });
});
