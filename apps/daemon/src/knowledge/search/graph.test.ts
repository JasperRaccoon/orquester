import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { KnowledgeGraph } from "./graph.ts";
import { FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";
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

async function fixture() {
  const store = new FakeStore();
  store.collection(A, "SEO");
  store.collection(B, "SaaS");
  store.put(eA, "alternatives pages", [A], {}, true);
  store.put(eB, "billing", [B], {}, true);
  store.put(eAB, "both", [A, B], {}, true);
  store.put(eU, "unfiled note", [], {}, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
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

test("the whole graph for a profile holds only visible concepts and edges, counted on the visible subgraph", async () => {
  const { graph, profile, all } = await fixture();
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

test("a path through a hidden concept is not a path", async () => {
  const { graph, profile, all } = await fixture();
  // From person-om at depth 3: om—alt (e1) and om—shared (e5); never tool-hidden, never via e3/e4.
  const result = graph.graph(profile, { focus: "person-om", depth: 3 })!;
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ["person-om", "tactic-alt", "tool-shared"]);
  assert.ok(!result.edges.some((e) => ["e2", "e3", "e4", "e6"].includes(e.id)));
  // The hidden concept itself cannot be a focus.
  assert.equal(graph.graph(profile, { focus: "tool-hidden" }), null);
  assert.equal(graph.graph(profile, { focus: eB }), null);
  assert.ok(graph.graph(all, { focus: "tool-hidden", depth: 1 })!.nodes.some((n) => n.id === "tactic-alt"));
});

test("focus on an entry starts from its concepts; depth bounds the hops", async () => {
  const { graph, all } = await fixture();
  const one = graph.graph(all, { focus: eA, depth: 1 })!;
  assert.deepEqual(one.nodes.map((n) => n.id).sort(), ["person-om", "tactic-alt"]);
  const two = graph.graph(all, { focus: eA, depth: 2 })!;
  assert.deepEqual(two.nodes.map((n) => n.id).sort(), ["metric-unf", "person-om", "tactic-alt", "tool-hidden", "tool-shared"]);
});

test("concept detail, entries, related entries and concept search are all visibility-scoped", async () => {
  const { graph, profile, all } = await fixture();
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

test("deleted entries stop making concepts visible before the graph is rebuilt", async () => {
  const { store, graph, all } = await fixture();
  store.entries.delete(eU);
  assert.equal(graph.concept("metric-unf", all), null);
  assert.ok(!graph.graph(all)!.edges.some((e) => e.id === "e6"));
});

test("truncation keeps the most connected nodes and says so", async () => {
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
  await loadGraph(graph, nodes, edges);
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
      source_files: [`session_a/input/${eA}.md::3`, "team.md"]
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
  assert.equal(graph.conceptRef("person-alice", knowledgeScope({ kind: "all" }, [A]))!.name, "person-alice", "no name attribute: the id is the name");
  await assert.rejects(graph.load(join(dir, "missing")));
  assert.deepEqual(graph.counts(), { nodes: 2, edges: 1 }, "a failed load keeps the old graph");
});

test("an edge whose source_files list is empty has no visible support", async () => {
  const { graph, profile } = await fixture();
  await loadGraph(
    graph,
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
  await writeFile(join(small, "nodes.jsonl"), `${JSON.stringify(node("tool-latest", "Latest", [`${eA}.md`]))}\n`);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  if (process.platform === "win32") {
    // Windows has no POSIX FIFO; retain the regular-file race there.
    const lines = Array.from({ length: 40_000 }, (_, i) => JSON.stringify(node(`tool-n${i}`, `Tool ${i}`, [`${eA}.md`])));
    await writeFile(join(big, "nodes.jsonl"), `${lines.join("\n")}\n`);
    await Promise.all([graph.load(big), graph.load(small)]);
  } else {
    const output = join(big, "output");
    await mkdir(output);
    const pipe = join(output, "nodes.jsonl");
    await promisify(execFile)("mkfifo", [pipe]);
    const older = graph.load(big);
    // Opening the writer waits until the older reader opens its end. Keep it open without
    // bytes so the newer load necessarily publishes first, even on a busy host.
    const writer = await open(pipe, "w");
    try {
      await graph.load(small);
      await writer.writeFile(`${JSON.stringify(node("tool-older", "Older", [`${eA}.md`]))}\n`);
    } finally {
      await writer.close();
    }
    await older;
  }
  assert.deepEqual(graph.counts(), { nodes: 1, edges: 0 });
  assert.ok(graph.hasConcept("tool-latest"), "a late older load must not overwrite the newest graph");
});

test("conceptTypes counts the concepts of each type in the whole graph", async () => {
  const { graph } = await fixture();
  // tactic, tool ×2, person, metric
  assert.deepEqual(Object.fromEntries(graph.conceptTypes()), { tactic: 1, tool: 2, person: 1, metric: 1 });
  await loadGraph(graph, [], []);
  assert.equal(graph.conceptTypes().size, 0);
});

test("a person's links that only surveys make are not its own position: left out of both concepts' neighbours", async () => {
  const store = new FakeStore();
  store.collection(A, "TikTok");
  store.collection(B, "SEO");
  const post = "ke_pppppppppppp";
  const synthesis = "ke_ssssssssssss";
  const audit = "ke_tttttttttttt";
  store.put(post, "jason's guide", [A], { title: "Make any phone hit a US audience", kind: "post" }, true);
  store.put(synthesis, "blend", [A, B], { title: "US TikTok setup across guides", kind: "synthesis" }, true);
  store.put(audit, "claims", [A], { title: "Claims audit", kind: "research note" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    [
      node("person-jason", "jason", [`${post}.md`, `${synthesis}.md`], { type: "Person" }),
      node("tactic-setup", "US TikTok account setup (organic)", [`${synthesis}.md`]),
      node("tactic-proxy", "ISP proxy", [`${post}.md`, `${synthesis}.md`]),
      node("tactic-gmail", "Gmail only", [`${audit}.md`])
    ],
    [
      edge("e1", "person-jason", "tactic-setup", [`${synthesis}.md`], "recommends"), // a synthesis only: left out
      edge("e2", "person-jason", "tactic-proxy", [`${post}.md`, `${synthesis}.md`], "recommends"), // his own post too: kept
      edge("e3", "person-jason", "tactic-gmail", [`${audit}.md`], "recommends"), // an audit note only: left out
      edge("e4", "tactic-setup", "tactic-proxy", [`${synthesis}.md`]), // no person: kept
      edge("e5", "person-jason", "tactic-gmail", null, "mentions") // no provenance: kept
    ]
  );
  const all = knowledgeScope({ kind: "all" }, [A, B]);
  const ids = (id: string) => graph.concept(id, all)!.neighbors.map((n) => n.edge.id).sort();
  assert.deepEqual(ids("person-jason"), ["e2", "e5"]);
  assert.deepEqual(ids("tactic-setup"), ["e4"]);
  assert.deepEqual(ids("tactic-gmail"), ["e5"]);
  // Only the visible provenance counts: without his post, the proxy link is a survey's too.
  const seoOnly = knowledgeScope({ kind: "collections", ids: [B] }, [A, B]);
  assert.deepEqual(graph.concept("person-jason", seoOnly)!.neighbors.map((n) => n.edge.id), []);
});

test("a survey-only link stays when the person's own saved post backs it (behind its other end); a survey the person wrote never counts", async () => {
  const store = new FakeStore();
  store.collection(A, "TikTok");
  store.collection(B, "SEO");
  const post = "ke_pppppppppppp";
  const other = "ke_oooooooooooo";
  const synthesis = "ke_ssssssssssss";
  store.put(post, "warm up for 48 hours", [A], { title: "Make any phone hit a US audience", kind: "post", author: "jason", handle: "jasonugc" }, true);
  // Another account under the same display name is someone else.
  store.put(other, "warm up for a week", [A], { title: "Another jason", kind: "post", author: "jason", handle: "otherjason" }, true);
  store.put(synthesis, "blend", [B], { title: "US TikTok setup across guides", kind: "synthesis", author: "Claude (research)" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const handle = (value: string) => ({ attributes: { handle: { value, confidence: 1 } } });
  await loadGraph(
    graph,
    [
      node("person-jason", "jason", [`${post}.md`, `${synthesis}.md`], { type: "Person", ...handle("jasonugc") }),
      node("person-claude", "Claude (research)", [`${synthesis}.md`], { type: "Person" }),
      node("tactic-warm-48", "Warm up the account for 48 hours before posting", [`${post}.md`, `${synthesis}.md`]),
      node("tactic-warm-week", "Warm up for a week", [`${other}.md`, `${synthesis}.md`]),
      node("tactic-setup", "US TikTok account setup (organic)", [`${synthesis}.md`])
    ],
    [
      edge("e1", "person-jason", "tactic-warm-48", [`${synthesis}.md`], "recommends"), // his own post is behind it: kept
      edge("e2", "person-jason", "tactic-setup", [`${synthesis}.md`], "recommends"), // a synthesis only: left out
      edge("e3", "person-jason", "tactic-warm-week", [`${synthesis}.md`], "recommends"), // another jason's post: left out
      edge("e4", "person-claude", "tactic-setup", [`${synthesis}.md`], "recommends") // Claude wrote the synthesis, but a survey is no saved post: left out
    ]
  );
  const all = knowledgeScope({ kind: "all" }, [A, B]);
  const ids = (id: string, scope = all) => graph.concept(id, scope)!.neighbors.map((n) => n.edge.id).sort();
  assert.deepEqual(ids("person-jason"), ["e1"]);
  assert.deepEqual(ids("tactic-warm-48"), ["e1"], "both ends");
  assert.deepEqual(ids("person-claude"), [], "its own synthesis restates others: not its own position");
  assert.deepEqual(ids("tactic-setup"), []);
  // Only visible entries count: a caller who cannot see his post sees the synthesis's word alone.
  assert.deepEqual(ids("person-jason", knowledgeScope({ kind: "collections", ids: [B] }, [A, B])), []);
  // Authorship: by handle, or by name when the entry has no other handle.
  const jason = graph.personAuthorship("person-jason")!;
  assert.equal(jason({ author: "someone", handle: "@JasonUGC" }), true);
  assert.equal(jason({ author: "Jason", handle: null }), true);
  assert.equal(jason({ author: "jason", handle: "otherjason" }), false);
  assert.equal(graph.personAuthorship("tactic-setup"), null, "not a Person");
});

test("a concept's collections leave out surveys when another entry has it: an all-collection synthesis does not tag it everywhere", async () => {
  const store = new FakeStore();
  store.collection(A, "TikTok");
  store.collection(B, "SEO");
  const C = "kc_cccccccccc";
  store.collection(C, "Agents");
  const post = "ke_pppppppppppp";
  const synthesis = "ke_ssssssssssss";
  const map = "ke_mmmmmmmmmmmm";
  store.put(post, "proxy check", [A], { kind: "post" }, true);
  store.put(synthesis, "everything", [A, B, C], { kind: "synthesis" }, true);
  store.put(map, "a map", [C], { kind: "note", title: "Knowledge map of the base" }, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(graph, [
    node("tool-ipqs", "IPQualityScore", [`${post}.md`, `${synthesis}.md`, `${map}.md`]),
    node("term-everything", "Cross-domain patterns", [`${synthesis}.md`, `${map}.md`])
  ]);
  const all = knowledgeScope({ kind: "all" }, [A, B, C]);
  assert.deepEqual(graph.concept("tool-ipqs", all)!.collections, [A], "its own entry's collections only");
  assert.deepEqual(graph.graph(all)!.nodes.find((n) => n.id === "tool-ipqs")!.collections, [A], "the graph's colouring too");
  assert.deepEqual(graph.concept("term-everything", all)!.collections.sort(), [A, B, C].sort(), "only surveys have it: theirs");
  // A caller who cannot see the post sees the surveys' collections (as visible to it).
  const seo = knowledgeScope({ kind: "collections", ids: [B] }, [A, B, C]);
  assert.deepEqual(graph.concept("tool-ipqs", seo)!.collections, [B]);
  assert.equal(graph.concept("tool-ipqs", all)!.entryIds.length, 3, "its entries are all still behind it");
});
