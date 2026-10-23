import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeGraph, entryIdOfSourceFile } from "./graph.ts";
import { FakeStore, edge, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope } from "./visibility.ts";

// Collections: A (visible to the profile), B (hidden from it). Entries:
//   eA  in A            eB  in B            eAB in A and B        eU  Unfiled
// Concepts:
//   tactic-alt   ← eA, eB     (visible: eA)
//   tool-hidden  ← eB         (only hidden)
//   person-om    ← eA
//   tool-shared  ← eAB
//   metric-unf   ← eU         (only Unfiled)
// Edges:
//   alt—om       provenance eA         → visible
//   alt—hidden   provenance eB         → hidden (an end is hidden)
//   hidden—shared provenance eB        → hidden
//   alt—shared   provenance eB only    → hidden although both ends are visible
//   om—shared    no provenance         → visible (both ends visible)
//   alt—unf      provenance eU         → hidden for the profile, visible for `all`
const eA = "ke_aaaaaaaaaaaa";
const eB = "ke_bbbbbbbbbbbb";
const eAB = "ke_abababababab";
const eU = "ke_uuuuuuuuuuuu";
const A = "kc_aaaaaaaaaa";
const B = "kc_bbbbbbbbbb";

function fixture() {
  const store = new FakeStore();
  store.collection(A, "SEO");
  store.collection(B, "SaaS");
  store.put(eA, "alternatives pages", [A], {}, true);
  store.put(eB, "billing", [B], {}, true);
  store.put(eAB, "both", [A, B], {}, true);
  store.put(eU, "unfiled note", [], {}, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  graph.replace(
    [
      node("tactic-alt", "Alternatives pages", [`${eA}.md`, `${eB}.md`], { aliases: ["vs pages"] }),
      node("tool-hidden", "Stripe", [`${eB}.md`]),
      node("person-om", "Om Patel", [`input/${eA}.md`]),
      node("tool-shared", "Ahrefs", [`${eAB}.md`]),
      node("metric-unf", "Churn", [`${eU}.md`])
    ],
    [
      edge("e1", "tactic-alt", "person-om", [`${eA}.md`]),
      edge("e2", "tactic-alt", "tool-hidden", [`${eB}.md`]),
      edge("e3", "tool-hidden", "tool-shared", [`${eB}.md`]),
      edge("e4", "tactic-alt", "tool-shared", [`${eB}.md`]),
      edge("e5", "person-om", "tool-shared", null),
      edge("e6", "tactic-alt", "metric-unf", [`${eU}.md`]),
      edge("e7", "tactic-alt", "nowhere-x", [`${eA}.md`])
    ]
  );
  const known = [A, B];
  return {
    store,
    graph,
    profile: knowledgeScope({ kind: "collections", ids: [A] }, known),
    all: knowledgeScope({ kind: "all" }, known)
  };
}

test("source files map to entry ids", () => {
  assert.equal(entryIdOfSourceFile("ke_aaaaaaaaaaaa.md"), "ke_aaaaaaaaaaaa");
  assert.equal(entryIdOfSourceFile("session_a/input/ke_aaaaaaaaaaaa.md::3"), "ke_aaaaaaaaaaaa");
  assert.equal(entryIdOfSourceFile("team.md"), null);
});

test("the whole graph for a profile holds only visible concepts and edges, counted on the visible subgraph", () => {
  const { graph, profile, all } = fixture();
  const result = graph.graph(profile)!;
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ["person-om", "tactic-alt", "tool-shared"]);
  assert.deepEqual(result.edges.map((e) => e.id).sort(), ["e1", "e5"]);
  assert.deepEqual(result.totals, { nodes: 3, edges: 2 });
  const alt = result.nodes.find((n) => n.id === "tactic-alt")!;
  assert.equal(alt.name, "Alternatives pages");
  assert.equal(alt.entryCount, 1);
  assert.equal(alt.degree, 1);
  assert.deepEqual(alt.collections, [A]);
  const shared = result.nodes.find((n) => n.id === "tool-shared")!;
  assert.deepEqual(shared.collections, [A], "the hidden collection is not shown");

  const everything = graph.graph(all)!;
  assert.equal(everything.nodes.length, 5);
  assert.deepEqual(everything.edges.map((e) => e.id).sort(), ["e1", "e2", "e3", "e4", "e5", "e6"]);
  assert.equal(everything.nodes.find((n) => n.id === "tactic-alt")!.entryCount, 2);
  assert.equal(graph.counts().edges, 6, "an edge to an unknown concept is dropped");
});

test("a path through a hidden concept is not a path", () => {
  const { graph, profile, all } = fixture();
  // From person-om at depth 3: om—alt (e1) and om—shared (e5); never tool-hidden, never via e3/e4.
  const result = graph.graph(profile, { focus: "person-om", depth: 3 })!;
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ["person-om", "tactic-alt", "tool-shared"]);
  assert.ok(!result.edges.some((e) => ["e2", "e3", "e4", "e6"].includes(e.id)));
  // The hidden concept itself cannot be a focus.
  assert.equal(graph.graph(profile, { focus: "tool-hidden" }), null);
  assert.equal(graph.graph(profile, { focus: eB }), null);
  assert.ok(graph.graph(all, { focus: "tool-hidden", depth: 1 })!.nodes.some((n) => n.id === "tactic-alt"));
});

test("focus on an entry starts from its concepts; depth bounds the hops", () => {
  const { graph, all } = fixture();
  const one = graph.graph(all, { focus: eA, depth: 1 })!;
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ["person-om", "tactic-alt"]);
  const two = graph.graph(all, { focus: eA, depth: 2 })!;
  assert.deepEqual(two.nodes.map((n) => n.id).sort(), ["metric-unf", "person-om", "tactic-alt", "tool-hidden", "tool-shared"]);
});

test("concept detail, entries, related entries and concept search are all visibility-scoped", () => {
  const { graph, profile, all } = fixture();
  const alt = graph.concept("tactic-alt", profile)!;
  assert.deepEqual(alt.entryIds, [eA]);
  assert.deepEqual(alt.collections, [A]);
  assert.deepEqual(alt.neighbors.map((n) => n.concept.id), ["person-om"]);
  assert.deepEqual(alt.concept.aliases, ["vs pages"]);
  assert.equal(graph.concept("tool-hidden", profile), null);
  assert.equal(graph.concept("metric-unf", profile), null);
  assert.ok(graph.concept("metric-unf", all));

  assert.deepEqual(graph.relatedEntries(eA, all, 5).map((r) => r.id), [eB], "shared concepts, not edges");
  assert.deepEqual(graph.relatedEntries(eA, profile, 5), []);
  assert.deepEqual(graph.relatedEntries(eB, profile, 5), [], "a hidden entry has no related entries");

  assert.deepEqual(graph.searchConcepts(["stripe"], profile, 5), []);
  assert.deepEqual(graph.searchConcepts(["stripe"], all, 5).map((h) => h.id), ["tool-hidden"]);
  assert.deepEqual(graph.searchConcepts(["vs"], profile, 5).map((h) => h.id), ["tactic-alt"]);
  assert.deepEqual(graph.visibleEntriesOf("tactic-alt", profile), [eA]);
});

test("deleted entries stop making concepts visible before the graph is rebuilt", () => {
  const { store, graph, all } = fixture();
  store.entries.delete(eU);
  assert.equal(graph.concept("metric-unf", all), null);
  assert.ok(!graph.graph(all)!.edges.some((e) => e.id === "e6"));
});

test("truncation keeps the most connected nodes and says so", () => {
  const store = new FakeStore();
  store.collection(A, "SEO");
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 30; i += 1) {
    const id = `ke_${String(i).padStart(12, "a").replace(/\d/g, (d) => "abcdefghij"[Number(d)]!)}`;
    store.put(id, `entry ${i}`, [A], {}, true);
    nodes.push(node(`c-${i}`, `Concept ${i}`, [`${id}.md`]));
    if (i > 0) edges.push(edge(`hub-${i}`, "c-0", `c-${i}`, [`${id}.md`]));
    if (i > 1) edges.push(edge(`pair-${i}`, "c-1", `c-${i}`, null));
  }
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  graph.replace(nodes, edges);
  const result = graph.graph(knowledgeScope({ kind: "all" }, [A]), { limit: 2 })!;
  assert.equal(result.truncated, true);
  assert.deepEqual(result.nodes.map((n) => n.id), ["c-0", "c-1"]);
  assert.deepEqual(result.edges.map((e) => e.id), ["hub-1"]);
  assert.equal(result.totals.nodes, 30);
});

test("load reads myKG's jsonl from a session output dir, tolerating bad lines and null attributes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kg-graph-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "output"));
  const nodes = [
    JSON.stringify({
      id: "organization-acme-corp",
      type: "Organization",
      confidence: 1.0,
      attributes: {
        name: { value: "Acme Corp", confidence: 1.0 },
        industry: { value: null, confidence: 0.0 },
        founding_year: { value: "2015", confidence: 1.0 },
        description: { value: "Makes anvils", confidence: 0.8 }
      },
      source_files: [`${eA}.md`, "team.md"]
    }),
    "{not json",
    JSON.stringify({ id: "person-alice", type: "Person", confidence: "0.5", attributes: {}, source_files: [`${eA}.md`], aliases: ["Al"] })
  ];
  await writeFile(join(dir, "output", "nodes.jsonl"), `${nodes.join("\n")}\n`);
  await writeFile(
    join(dir, "output", "edges.jsonl"),
    `${JSON.stringify({ id: "edge-1", type: "works_at", from: "person-alice", to: "organization-acme-corp", confidence: 0.9, source_files: [`${eA}.md`] })}\n` +
      `${JSON.stringify({ id: "edge-2", type: "works_at", from: "person-bob", to: "organization-acme-corp", confidence: 0.9 })}\n`
  );
  const store = new FakeStore();
  store.collection(A, "SEO");
  store.put(eA, "x", [A], {}, true);
  const logger = silentLogger();
  const graph = new KnowledgeGraph({ entries: store, logger });
  assert.deepEqual(await graph.load(dir), { nodes: 2, edges: 1 });
  assert.ok(logger.lines.some((l) => l.includes("unreadable")));
  const acme = graph.concept("organization-acme-corp", knowledgeScope({ kind: "all" }, [A]))!;
  assert.equal(acme.concept.name, "Acme Corp");
  assert.equal(acme.concept.description, "Makes anvils");
  assert.deepEqual(acme.concept.attributes, { founding_year: { value: "2015", confidence: 1 } });
  assert.deepEqual(acme.entryIds, [eA]);
  assert.equal(graph.conceptRef("person-alice")!.name, "person-alice", "no name attribute: the id is the name");
  await assert.rejects(graph.load(join(dir, "missing")));
  assert.deepEqual(graph.counts(), { nodes: 2, edges: 1 }, "a failed load keeps the old graph");
});

test("an edge whose source_files list is empty has no visible support", () => {
  const { graph, profile } = fixture();
  graph.replace(
    [node("tactic-alt", "Alternatives pages", [`${eA}.md`, `${eB}.md`]), node("tool-shared", "Ahrefs", [`${eAB}.md`])],
    [{ ...edge("e-empty", "tactic-alt", "tool-shared", null), source_files: [] }]
  );
  assert.deepEqual(graph.graph(profile)!.edges, []);
  assert.deepEqual(graph.concept("tactic-alt", profile)!.neighbors, []);
});

test("overlapping loads: the graph ends up as the one loaded last, never an older one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kg-graph-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FakeStore();
  store.collection(A, "SEO");
  store.put(eA, "x", [A], {}, true);
  const big = join(dir, "big");
  const small = join(dir, "small");
  await mkdir(big);
  await mkdir(small);
  const lines = Array.from({ length: 40_000 }, (_, i) => JSON.stringify(node(`tool-n${i}`, `Tool ${i}`, [`${eA}.md`])));
  await writeFile(join(big, "nodes.jsonl"), `${lines.join("\n")}\n`);
  await writeFile(join(small, "nodes.jsonl"), `${JSON.stringify(node("tool-latest", "Latest", [`${eA}.md`]))}\n`);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const older = graph.load(big);
  const newer = graph.load(small);
  await Promise.all([older, newer]);
  assert.deepEqual(graph.counts(), { nodes: 1, edges: 0 });
  assert.ok(graph.hasConcept("tool-latest"));
});
