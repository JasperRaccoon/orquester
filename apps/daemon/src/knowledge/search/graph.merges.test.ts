import assert from "node:assert/strict";
import test from "node:test";
import { type ConceptMergeOverlay, KnowledgeGraph } from "./graph.ts";
import { FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope } from "./visibility.ts";

// The concept-merge overlay (phase 2 spec, "Concept merges"): applied at every load and re-applied
// by `setConceptMerges`. Entries: eA in A (visible to the profile), eB in B (hidden from it), eC in A.
const eA = "ke_aaaaaaaaaaaa";
const eB = "ke_bbbbbbbbbbbb";
const eC = "ke_cccccccccccc";
const A = "kc_aaaaaaaaaa";
const B = "kc_bbbbbbbbbb";

const NODES = [
  node("tactic-warm-up", "Warm up TikTok account", [`${eA}.md`, `${eC}.md`], { aliases: ["TikTok warm-up"] }),
  node("tactic-warm-up-the", "Warm up the TikTok account", [`${eB}.md`], { aliases: ["account warm up"], attributes: { description: { value: "Days of normal use first", confidence: 1 }, period: { value: "7 days", confidence: 0.8 } } }),
  node("tactic-warm-up-proper", "Proper warm-up of TikTok accounts", [`${eC}.md`]),
  node("tool-tiktok", "TikTok", [`${eA}.md`, `${eB}.md`]),
  node("tactic-skip", "Skip the warm-up", [`${eA}.md`])
];
const EDGES = [
  edge("e1", "tactic-warm-up", "tool-tiktok", [`${eA}.md`], "uses"),
  edge("e2", "tactic-warm-up-the", "tool-tiktok", [`${eB}.md`], "uses"),
  edge("e3", "tactic-warm-up", "tactic-warm-up-the", [`${eA}.md`]),
  edge("e4", "tactic-warm-up-proper", "tool-tiktok", null, "mentions"),
  { ...edge("e5", "tactic-skip", "tactic-warm-up-the", [`${eB}.md`], "contradicts"), attributes: { context: { value: "One says skip it, the other insists", confidence: 0.8 } } }
];

const MERGE: ConceptMergeOverlay = {
  id: "cm_warmup",
  type: "tactic",
  into: "tactic-warm-up",
  merged: ["tactic-warm-up-the", "tactic-warm-up-proper"],
  similarity: 0.95,
  createdAt: "2026-10-27T10:00:00.000Z"
};

async function fixture() {
  const store = new FakeStore();
  store.collection(A, "A");
  store.collection(B, "B");
  store.put(eA, "a", [A], {}, true);
  store.put(eB, "b", [B], {}, true);
  store.put(eC, "c", [A], {}, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(graph, NODES, EDGES);
  return {
    graph,
    all: knowledgeScope({ kind: "all" }, [A, B]),
    profile: knowledgeScope({ kind: "collections", ids: [A] }, [A, B])
  };
}

test("a merge folds concepts: edges re-pointed, self-loops and repeated edges dropped, entries and aliases unioned", async () => {
  const { graph, all } = await fixture();
  const before = graph.revision();
  graph.setConceptMerges([MERGE]);
  assert.ok(graph.revision() > before, "the revision moves");
  assert.deepEqual(graph.counts(), { nodes: 3, edges: 3 });
  const view = graph.concept("tactic-warm-up", all)!;
  assert.deepEqual(view.entryIds.sort(), [eA, eB, eC].sort());
  assert.deepEqual(view.concept.aliases, ["TikTok warm-up", "Warm up the TikTok account", "account warm up", "Proper warm-up of TikTok accounts"]);
  assert.equal(view.concept.description, "Days of normal use first", "the kept concept had none: the first folded one's");
  assert.equal(view.concept.attributes.period?.value, "7 days");
  assert.deepEqual(
    view.mergedFrom.map((c) => c.id),
    ["tactic-warm-up-the", "tactic-warm-up-proper"]
  );
  const result = graph.graph(all)!;
  // e1 and e2 are now the same (uses, warm-up → tiktok): one edge, both sources; e3 became a self-loop.
  const uses = result.edges.filter((e) => e.type === "uses");
  assert.deepEqual(
    uses.map((e) => [e.id, e.from, e.to]),
    [["e1", "tactic-warm-up", "tool-tiktok"]]
  );
  assert.equal(
    result.edges.some((e) => e.id === "e3"),
    false
  );
  assert.deepEqual(
    result.edges.find((e) => e.id === "e4")!.from,
    "tactic-warm-up"
  );
  assert.deepEqual(
    result.edges.find((e) => e.id === "e5")!.to,
    "tactic-warm-up"
  );
  // The folded concepts are gone; their ids answer the kept concept.
  assert.equal(graph.hasConcept("tactic-warm-up-the"), false);
  assert.equal(graph.concept("tactic-warm-up-the", all)?.concept.id, "tactic-warm-up");
  assert.equal(graph.canonicalConceptId("tactic-warm-up-proper"), "tactic-warm-up");
  assert.deepEqual(
    graph.conceptMerges().map((m) => [m.id, m.into.id, m.merged.map((c) => c.id)]),
    [["cm_warmup", "tactic-warm-up", ["tactic-warm-up-the", "tactic-warm-up-proper"]]]
  );
  assert.deepEqual(graph.conceptsOfEntry(eB, all).map((c) => c.id).sort(), ["tactic-warm-up", "tool-tiktok"]);
});

test("a repeated edge keeps the union of its sources, so it shows wherever either did", async () => {
  const { graph, profile } = await fixture();
  graph.setConceptMerges([MERGE]);
  const uses = graph.concept("tactic-warm-up", profile)!.neighbors.filter((n) => n.edge.type === "uses");
  assert.equal(uses.length, 1, "visible through eA although the other copy came from hidden eB");
});

test("a scoped caller sees only folded concepts a visible entry backs, as merged-from and aliases", async () => {
  const { graph, profile } = await fixture();
  graph.setConceptMerges([MERGE]);
  const view = graph.concept("tactic-warm-up", profile)!;
  assert.deepEqual(
    view.mergedFrom.map((c) => c.id),
    ["tactic-warm-up-proper"]
  );
  assert.deepEqual(view.concept.aliases, ["TikTok warm-up", "Proper warm-up of TikTok accounts"]);
  assert.deepEqual(view.entryIds.sort(), [eA, eC].sort());
  assert.deepEqual(
    graph.visibleConceptMerges(profile).map((m) => m.merged.map((c) => c.id)),
    [["tactic-warm-up-proper"]]
  );
});

test("merges survive a reload of myKG's graph; a merge whose concepts are gone is ignored", async () => {
  const { graph, all } = await fixture();
  graph.setConceptMerges([MERGE, { ...MERGE, id: "cm_gone", into: "tactic-nowhere", merged: ["tactic-skip"] }]);
  const loads = graph.loadRevision();
  let loaded = 0;
  graph.onLoad(() => (loaded += 1));
  await loadGraph(
    graph,
    NODES.filter((n) => n.id !== "tactic-warm-up-proper"),
    EDGES
  );
  assert.equal(loaded, 1);
  assert.equal(graph.loadRevision(), loads + 1);
  assert.deepEqual(
    graph.conceptMerges().map((m) => [m.id, m.merged.map((c) => c.id)]),
    [["cm_warmup", ["tactic-warm-up-the"]]]
  );
  assert.equal(graph.concept("tactic-skip", all)?.concept.id, "tactic-skip");
  assert.equal(graph.baseConcepts().length, 4, "the base graph is myKG's, before merges");
  // Nothing left to fold: no merge in effect.
  graph.setConceptMerges([{ ...MERGE, merged: ["tactic-warm-up-proper"] }]);
  assert.deepEqual(graph.conceptMerges(), []);
  assert.equal(graph.counts().nodes, 4);
});

test("the content revision moves when the files loaded or the merges in effect change, not on a reload of the same files", async () => {
  const { graph } = await fixture();
  const first = graph.contentRevision();
  const loads = graph.loadRevision();
  await loadGraph(graph, NODES, EDGES);
  assert.equal(graph.loadRevision(), loads + 1);
  assert.equal(graph.contentRevision(), first, "the same files");
  await loadGraph(graph, [...NODES, node("tool-extra", "Extra", [`${eA}.md`])], EDGES);
  assert.equal(graph.contentRevision(), first + 1);
  graph.setConceptMerges([MERGE]);
  assert.equal(graph.contentRevision(), first + 2, "a merge took effect");
  graph.setConceptMerges([MERGE]);
  assert.equal(graph.contentRevision(), first + 2, "the same merges");
  graph.setConceptMerges([{ ...MERGE, into: "tactic-nowhere" }]);
  assert.equal(graph.contentRevision(), first + 3, "none in effect any more");
});

test("merges apply in order: a concept claimed by an earlier merge stays there; types never mix", async () => {
  const { graph } = await fixture();
  graph.setConceptMerges([
    { ...MERGE, id: "cm_1", merged: ["tactic-warm-up-the"] },
    { ...MERGE, id: "cm_2", into: "tactic-warm-up-proper", merged: ["tactic-warm-up-the", "tactic-skip"] },
    { ...MERGE, id: "cm_3", into: "tactic-warm-up-proper", merged: ["tool-tiktok"] }
  ]);
  assert.deepEqual(
    graph.conceptMerges().map((m) => [m.id, m.into.id, m.merged.map((c) => c.id)]),
    [
      ["cm_1", "tactic-warm-up", ["tactic-warm-up-the"]],
      ["cm_2", "tactic-warm-up-proper", ["tactic-skip"]]
    ]
  );
});

test("a contradicts edge keeps its context (internal), re-pointed with the merge", async () => {
  const { graph } = await fixture();
  graph.setConceptMerges([MERGE]);
  const internal = (graph as unknown as { snapshot: { edges: { id: string; context?: string; to: string }[] } }).snapshot.edges.find((e) => e.id === "e5")!;
  assert.equal(internal.context, "One says skip it, the other insists");
  assert.equal(internal.to, "tactic-warm-up");
  const wire = graph.graph(knowledgeScope({ kind: "all" }, [A, B]))!.edges.find((e) => e.id === "e5")!;
  assert.equal("context" in wire, false, "the wire edge is the contract's");
});

test("similar concepts come from the provider, visible and in the current graph only, up to 5", async () => {
  const { graph, profile, all } = await fixture();
  graph.setConceptMerges([{ ...MERGE, merged: ["tactic-warm-up-the"] }]);
  graph.setSimilarConcepts(() => [
    { id: "tactic-warm-up-the", similarity: 0.99 },
    { id: "tactic-warm-up-proper", similarity: 0.95 },
    { id: "tactic-skip", similarity: 0.94 }
  ]);
  assert.deepEqual(
    graph.concept("tactic-warm-up", all)!.similarConcepts.map((s) => [s.concept.id, s.similarity]),
    [
      ["tactic-warm-up-proper", 0.95],
      ["tactic-skip", 0.94]
    ]
  );
  graph.setSimilarConcepts(() => [{ id: "tool-tiktok", similarity: 0.97 }]);
  assert.equal(graph.concept("tactic-warm-up", profile)!.similarConcepts.length, 1);
  graph.setSimilarConcepts(null);
  assert.deepEqual(graph.concept("tactic-warm-up", all)!.similarConcepts, []);
});

// A merge must never show a scope what only hidden entries say (the review's reproduction): the
// kept concept `tactic-secret` comes from eB and eD (collection B, hidden from the profile), with a
// description, an attribute and a `contradicts` edge whose context only eB backs; `tactic-public`
// (eA, collection A) is folded into it.
const eD = "ke_dddddddddddd";

async function secretFixture() {
  const store = new FakeStore();
  store.collection(A, "A");
  store.collection(B, "B");
  store.put(eA, "a", [A], {}, true);
  store.put(eB, "b", [B], {}, true);
  store.put(eC, "c", [A], {}, true);
  store.put(eD, "d", [B], {}, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    [
      node("tactic-secret", "Secret launch plan", [`${eB}.md`, `${eD}.md`], {
        aliases: ["codename falcon"],
        attributes: { description: { value: "The confidential roadmap", confidence: 1 }, budget: { value: "two million", confidence: 0.9 } }
      }),
      node("tactic-public", "Public launch plan", [`${eA}.md`], { aliases: ["launch plan"] }),
      node("rule-x", "Launch only on Tuesdays", [`${eC}.md`])
    ],
    [
      { ...edge("c1", "rule-x", "tactic-secret", [`${eB}.md`], "contradicts"), confidence: 0.99, attributes: { context: { value: "the secret note", confidence: 1 } } },
      { ...edge("c2", "rule-x", "tactic-public", [`${eC}.md`], "contradicts"), confidence: 0.5 }
    ]
  );
  graph.setConceptMerges([{ id: "cm_secret", type: "tactic", into: "tactic-secret", merged: ["tactic-public"], similarity: 0.93, createdAt: "2026-10-27T10:00:00.000Z" }]);
  return {
    graph,
    all: knowledgeScope({ kind: "all" }, [A, B]),
    profile: knowledgeScope({ kind: "collections", ids: [A] }, [A, B])
  };
}

const LEAKS = /secret|falcon|confidential|two million/i;

test("a merge into a hidden concept: the scope sees the visible folded concept, under its own id and name, and nothing hidden", async () => {
  const { graph, profile, all } = await secretFixture();
  const view = graph.concept("tactic-public", profile)!;
  assert.deepEqual(view.concept, { id: "tactic-public", name: "Public launch plan", type: "tactic", confidence: 0.9, description: null, aliases: ["launch plan"], attributes: {} });
  assert.deepEqual(view.mergedFrom, []);
  assert.deepEqual(view.entryIds, [eA]);
  assert.deepEqual(
    view.neighbors.map((n) => [n.edge.id, n.edge.from, n.edge.to, n.edge.confidence, n.concept.id]),
    [["c2", "rule-x", "tactic-public", 0.5, "rule-x"]],
    "the folded edge shows as its visible source"
  );
  assert.doesNotMatch(JSON.stringify(view), LEAKS);
  assert.equal(graph.concept("tactic-secret", profile), null, "a hidden source's id names nothing");
  assert.deepEqual(graph.visibleConceptMerges(profile), [], "one visible concept is no merge");
  assert.deepEqual(graph.conceptsOfEntry(eA, profile), [{ id: "tactic-public", name: "Public launch plan", type: "tactic" }]);
  assert.deepEqual(graph.conceptRef("tactic-secret", profile), { id: "tactic-public", name: "Public launch plan", type: "tactic", description: null });
  assert.deepEqual(graph.searchConcepts(["secret"], profile, 10), []);
  assert.deepEqual(graph.searchConcepts(["falcon"], profile, 10), []);
  assert.deepEqual(graph.searchConcepts(["confidential"], profile, 10), []);
  assert.deepEqual(
    graph.searchConcepts(["public"], profile, 10).map((hit) => hit.id),
    ["tactic-secret"],
    "the visible source matches (the graph's own id; callers present it)"
  );
  const drawn = graph.graph(profile)!;
  assert.doesNotMatch(JSON.stringify(drawn), LEAKS);
  assert.deepEqual(drawn.nodes.map((n) => n.id).sort(), ["rule-x", "tactic-public"]);
  assert.equal(graph.graph(profile, { focus: "tactic-secret" }), null);
  assert.deepEqual(graph.graph(profile, { focus: "tactic-public" })!.nodes.map((n) => n.id).sort(), ["rule-x", "tactic-public"]);
  assert.deepEqual(
    graph.visibleEdgesOfType("contradicts", profile).map((e) => [e.id, e.context, e.confidence]),
    [["c2", undefined, 0.5]],
    "a context only a hidden source backs is not shown"
  );

  // Everything visible: the kept concept as before, with what every source says.
  const whole = graph.concept("tactic-public", all)!;
  assert.equal(whole.concept.id, "tactic-secret");
  assert.equal(whole.concept.description, "The confidential roadmap");
  assert.deepEqual(
    whole.mergedFrom.map((c) => c.id),
    ["tactic-public"]
  );
  assert.equal(graph.visibleEdgesOfType("contradicts", all)[0]!.context, "the secret note");
  assert.deepEqual(
    graph.visibleConceptMerges(all).map((m) => [m.into.id, m.merged.map((c) => c.id)]),
    [["tactic-secret", ["tactic-public"]]]
  );
});

test("a merge into a visible concept: a hidden folded concept's names, attributes and description never show", async () => {
  const { graph, profile } = await secretFixture();
  // The other way round: the public concept is kept, the secret one folded into it.
  graph.setConceptMerges([{ id: "cm_public", type: "tactic", into: "tactic-public", merged: ["tactic-secret"], similarity: 0.93, createdAt: "2026-10-27T10:00:00.000Z" }]);
  const view = graph.concept("tactic-public", profile)!;
  assert.equal(view.concept.description, null);
  assert.deepEqual(view.concept.attributes, {});
  assert.deepEqual(view.concept.aliases, ["launch plan"]);
  assert.equal(view.concept.confidence, 0.9);
  assert.doesNotMatch(JSON.stringify(view), LEAKS);
  assert.deepEqual(graph.searchConcepts(["secret"], profile, 10), []);
  assert.deepEqual(graph.searchConcepts(["budget", "two", "million"], profile, 10), []);
  assert.equal(graph.concept("tactic-secret", profile), null);
});
