import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeCitation, type KnowledgeEntryMeta, type KnowledgeSimilarEntry, type KnowledgeVisibility } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "./fake-vector-index.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSimilarity } from "./similarity.ts";
import { FakeStore, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope, visibleCollections } from "./visibility.ts";

// Thresholds of the fake index: minimum 0.3, good 0.5, strong 0.7, duplicate 0.9.
const DIMS = 16;
const ke = (name: string): string => `ke_${name.padStart(12, "0")}`;

function setup() {
  const store = new FakeStore();
  store.collection("kc_seo", "SEO");
  store.collection("kc_ads", "Ads");
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const index = new FakeVectorIndex();
  let indexOn = true;
  const similarity = new KnowledgeSimilarity({
    store,
    graph,
    index: () => (indexOn ? index : null),
    summary: (meta, scope) => ({
      ...meta,
      collections: visibleCollections(meta, scope),
      snippet: "",
      linkCount: graph.linkCount(meta.id),
      citation: knowledgeCitation(meta)
    })
  });
  const scope = (visibility: KnowledgeVisibility, narrow?: string[]) => knowledgeScope(visibility, store.collections.map((c) => c.id), narrow);
  const put = (name: string, collections: string[], extra: Partial<KnowledgeEntryMeta> = {}) => store.put(ke(name), `body ${name}`, collections, { title: name, ...extra }, true);
  return {
    store,
    graph,
    index,
    similarity,
    put,
    all: scope({ kind: "all" }),
    seoOnly: scope({ kind: "collections", ids: ["kc_seo"] }),
    scope,
    noIndex: () => {
      indexOn = false;
    }
  };
}

const ids = (list: KnowledgeSimilarEntry[]) => list.map((s) => s.entry.id);

/** A: the entry. B, C by meaning; D hidden from SEO but a duplicate; E, F by concepts; F, G, H by author. */
async function fixture() {
  const s = setup();
  s.put("a", ["kc_seo"], { handle: "om" });
  s.put("b", ["kc_seo"]);
  s.put("c", ["kc_seo"]);
  s.put("d", ["kc_ads"]);
  s.put("e", ["kc_seo"]);
  s.put("h", ["kc_seo"], { handle: "om" });
  s.put("f", ["kc_seo"], { handle: "om", author: "Om" });
  s.put("g", ["kc_seo"], { handle: "@OM" });
  s.put("x", ["kc_seo"], { author: "Someone" });
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("b"), around(DIMS, 0, 1, 0.95));
  s.index.set(ke("c"), around(DIMS, 0, 2, 0.6));
  s.index.set(ke("d"), around(DIMS, 0, 3, 0.97));
  s.index.set(ke("e"), around(DIMS, 0, 4, 0.2));
  s.index.set(ke("x"), around(DIMS, 0, 5, 0.45));
  await loadGraph(s.graph, [
    node("tactic-comparison", "Comparison pages", [`${ke("a")}.md`, `${ke("e")}.md`]),
    node("tool-stripe", "Stripe", [`${ke("a")}.md`, `${ke("e")}.md`]),
    node("topic-pricing", "Pricing", [`${ke("a")}.md`, `${ke("e")}.md`, `${ke("f")}.md`]),
    node("topic-seo", "SEO", [`${ke("a")}.md`, `${ke("e")}.md`])
  ]);
  return s;
}

test("similar: meaning, concepts and author reasons together, ordered by similarity, shared concepts, then newest", async () => {
  const s = await fixture();
  const { similar, possibleDuplicates } = s.similarity.forEntry(ke("a"), s.all);
  assert.deepEqual(ids(similar), [ke("d"), ke("b"), ke("c"), ke("e"), ke("f"), ke("g")]);
  const by = new Map(similar.map((item) => [item.entry.id, item]));
  assert.deepEqual(by.get(ke("b"))!.reasons, [{ kind: "meaning", similarity: 0.95 }]);
  assert.equal(by.get(ke("b"))!.similarity, 0.95);
  assert.ok(!by.has(ke("x")), "below `good` with no other reason");
  // Here by concepts: a similarity below `good` orders it but gives no meaning reason; four shared concepts, three named.
  assert.equal(by.get(ke("e"))!.similarity, 0.2);
  assert.deepEqual(by.get(ke("e"))!.reasons, [
    {
      kind: "concepts",
      concepts: [
        { id: "tactic-comparison", name: "Comparison pages", type: "tactic" },
        { id: "tool-stripe", name: "Stripe", type: "tool" },
        { id: "topic-pricing", name: "Pricing", type: "topic" }
      ],
      shared: 4
    }
  ]);
  // No vectors: similarity null, after every entry that has one; more shared concepts first.
  assert.equal(by.get(ke("f"))!.similarity, null);
  assert.deepEqual(by.get(ke("f"))!.reasons, [
    { kind: "concepts", concepts: [{ id: "topic-pricing", name: "Pricing", type: "topic" }], shared: 1 },
    { kind: "author", value: "om" }
  ]);
  assert.deepEqual(by.get(ke("g"))!.reasons, [{ kind: "author", value: "OM" }], "handles compare without case or '@'");
  assert.ok(!by.has(ke("h")), "only the two most recent same-author entries");
  assert.ok(!by.has(ke("a")), "never the entry itself");
  assert.deepEqual(ids(possibleDuplicates), [ke("d"), ke("b")]);
  assert.deepEqual(possibleDuplicates[0]!.reasons, [{ kind: "meaning", similarity: 0.97 }]);
});

test("similar and duplicates never include an entry the caller cannot see", async () => {
  const s = await fixture();
  const { similar, possibleDuplicates } = s.similarity.forEntry(ke("a"), s.seoOnly);
  assert.ok(!ids(similar).includes(ke("d")));
  assert.deepEqual(ids(possibleDuplicates), [ke("b")]);
  for (const item of similar) assert.deepEqual(item.entry.collections, ["kc_seo"]);
});

test("the author reason matches a display name when there is no handle", async () => {
  const s = setup();
  s.put("a", [], { author: "Om  Patel" });
  s.put("b", [], { author: "om patel" });
  s.put("c", [], { author: "Someone Else" });
  const { similar } = s.similarity.forEntry(ke("a"), s.all);
  assert.deepEqual(similar.map((item) => [item.entry.id, item.reasons]), [[ke("b"), [{ kind: "author", value: "om patel" }]]]);
});

test("at most 8 similar entries, best first; at most 3 duplicates", () => {
  const s = setup();
  s.put("a", []);
  s.index.set(ke("a"), axis(DIMS, 0));
  for (let i = 1; i <= 12; i += 1) {
    s.put(`n${i}`, []);
    s.index.set(ke(`n${i}`), around(DIMS, 0, i, 1 - i * 0.02));
  }
  const { similar, possibleDuplicates } = s.similarity.forEntry(ke("a"), s.all);
  assert.equal(similar.length, 8);
  assert.deepEqual(ids(similar), Array.from({ length: 8 }, (_, i) => ke(`n${i + 1}`)));
  assert.deepEqual(ids(possibleDuplicates), [ke("n1"), ke("n2"), ke("n3")]);
});

test("without an index or a model: concepts and author only, similarity null, no duplicates", async () => {
  const s = await fixture();
  s.index.model = null;
  const noModel = s.similarity.forEntry(ke("a"), s.all);
  assert.deepEqual(ids(noModel.similar), [ke("e"), ke("f"), ke("g")]);
  assert.ok(noModel.similar.every((item) => item.similarity === null && item.reasons.every((r) => r.kind !== "meaning")));
  assert.deepEqual(noModel.possibleDuplicates, []);
  s.noIndex();
  assert.deepEqual(ids(s.similarity.forEntry(ke("a"), s.all).similar), [ke("e"), ke("f"), ke("g")]);
  assert.deepEqual(s.similarity.forEntry(ke("zzz"), s.all), { similar: [], possibleDuplicates: [] }, "unknown entry");
});

test("similarForSaved: visible near-duplicates outside the save, closest first, at most 3", () => {
  const s = setup();
  s.put("s1", ["kc_seo"]);
  s.put("s2", ["kc_seo"]);
  s.put("s3", ["kc_seo"]);
  s.put("x", ["kc_seo"], { title: "X", handle: "xx" });
  s.put("y", ["kc_ads"]);
  s.put("w", ["kc_seo"]);
  s.put("v", ["kc_seo"]);
  s.put("z", ["kc_seo"]);
  s.index.set(ke("s1"), axis(DIMS, 0));
  s.index.set(ke("s2"), around(DIMS, 0, 1, 0.99));
  s.index.set(ke("x"), around(DIMS, 0, 2, 0.95));
  s.index.set(ke("y"), around(DIMS, 0, 3, 0.93));
  s.index.set(ke("w"), around(DIMS, 0, 4, 0.92));
  s.index.set(ke("v"), around(DIMS, 0, 5, 0.91));
  s.index.set(ke("z"), around(DIMS, 0, 6, 0.8));
  const saved = [ke("s1"), ke("s2"), ke("s3")];
  const all = s.similarity.similarForSaved(saved, s.all);
  assert.deepEqual(
    all.get(ke("s1"))!.map((x) => [x.entryId, x.similarity]),
    [
      [ke("x"), 0.95],
      [ke("y"), 0.93],
      [ke("w"), 0.92]
    ],
    "s2 is in the same save; z is below the duplicate threshold"
  );
  assert.deepEqual(all.get(ke("s1"))![0], { entryId: ke("x"), title: "X", similarity: 0.95, citation: knowledgeCitation(s.store.getMeta(ke("x"))!) });
  assert.deepEqual(all.get(ke("s3")), [], "not embedded yet");
  const seo = s.similarity.similarForSaved(saved, s.seoOnly);
  assert.deepEqual(seo.get(ke("s1"))!.map((x) => x.entryId), [ke("x"), ke("w"), ke("v")]);
  s.noIndex();
  assert.deepEqual([...s.similarity.similarForSaved(saved, s.all)], saved.map((id) => [id, []]));
});

// ---------------------------------------------------------------------------
// The similarity graph
// ---------------------------------------------------------------------------

/**
 * P1..P3 close together (0.9, 0.8, 0.72), Q1–Q2 close (0.825), P1–Q1 a weak link (0.4) that only the
 * spanning forest keeps, R related to nothing. Q1 is also 0.36 / 0.32 from P2 / P3.
 */
function graphFixture() {
  const s = setup();
  const q1 = new Array<number>(DIMS).fill(0);
  q1[0] = 0.4;
  q1[1] = Math.sqrt(1 - 0.16);
  s.put("r", ["kc_seo"], { title: "Random note" });
  s.put("q2", ["kc_seo"], { title: "Ads budget pacing" });
  s.put("q1", ["kc_seo"], { title: "Ads budget tips" });
  s.put("p3", ["kc_seo"], { title: "Writing comparison pages" });
  s.put("p2", ["kc_seo"], { title: "Comparison pages that convert" });
  s.put("p1", ["kc_seo"], { title: "Comparison page for SaaS" });
  s.put("hidden", ["kc_ads"], { title: "Hidden" });
  s.put("plain", ["kc_seo"], { title: "Not embedded" });
  s.index.set(ke("p1"), axis(DIMS, 0));
  s.index.set(ke("p2"), around(DIMS, 0, 3, 0.9));
  s.index.set(ke("p3"), around(DIMS, 0, 4, 0.8));
  s.index.set(ke("q1"), q1);
  s.index.set(ke("q2"), around(DIMS, 1, 5, 0.9));
  s.index.set(ke("r"), axis(DIMS, 2));
  s.index.set(ke("hidden"), around(DIMS, 0, 6, 0.99));
  return s;
}

const edgeList = (edges: { from: string; to: string; similarity: number; tree: boolean }[]) =>
  edges.map((e) => `${e.from.slice(-2).replace(/^0/, "")}-${e.to.slice(-2).replace(/^0/, "")} ${e.similarity} ${e.tree ? "tree" : "knn"}`);

test("graph: k-NN edges, the spanning forest marked tree (one edge per pair), clusters and labels", async () => {
  const s = graphFixture();
  const g = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.deepEqual(g.nodes.map((n) => n.id), ["p1", "p2", "p3", "q1", "q2", "r"].map(ke), "most recent first; hidden and unembedded entries are not drawn");
  assert.deepEqual(edgeList(g.edges), ["p1-p2 0.9 tree", "q1-q2 0.8249 tree", "p1-p3 0.8 tree", "p1-q1 0.4 tree"]);
  assert.deepEqual(g.clusters, [
    { id: 0, size: 3, label: "comparison pages" },
    { id: 1, size: 2, label: "ads budget" },
    { id: 2, size: 1, label: null }
  ]);
  assert.deepEqual(g.nodes.map((n) => [n.cluster, n.degree]), [
    [0, 3],
    [0, 1],
    [0, 1],
    [1, 2],
    [1, 1],
    [2, 0]
  ]);
  assert.deepEqual(g.totals, { entries: 7, embedded: 6 });
  assert.equal(g.truncated, false);
  assert.deepEqual(g.nodes[0], {
    id: ke("p1"),
    title: "Comparison page for SaaS",
    kind: "note",
    author: null,
    handle: null,
    savedAt: s.store.getMeta(ke("p1"))!.savedAt,
    collections: ["kc_seo"],
    cluster: 0,
    degree: 3
  });

  const k2 = await s.similarity.graph({ k: 2 }, s.seoOnly);
  assert.deepEqual(edgeList(k2.edges), ["p1-p2 0.9 tree", "q1-q2 0.8249 tree", "p1-p3 0.8 tree", "p2-p3 0.72 knn", "p1-q1 0.4 tree"]);
});

test("graph: an entry hidden from the caller is never a node or an edge end", async () => {
  const s = graphFixture();
  const all = await s.similarity.graph({ k: 2 }, s.all);
  assert.ok(all.nodes.some((n) => n.id === ke("hidden")));
  const seo = await s.similarity.graph({ k: 2 }, s.seoOnly);
  const drawn = new Set(seo.nodes.map((n) => n.id));
  assert.ok(!drawn.has(ke("hidden")));
  for (const edge of seo.edges) assert.ok(drawn.has(edge.from) && drawn.has(edge.to));
  const narrowed = await s.similarity.graph({}, s.scope({ kind: "all" }, ["kc_ads"]));
  assert.deepEqual(narrowed.nodes.map((n) => n.id), [ke("hidden")]);
  assert.deepEqual(narrowed.totals, { entries: 1, embedded: 1 });
});

test("graph: a cluster is named by a concept two or more of its entries link to", async () => {
  const s = graphFixture();
  await loadGraph(s.graph, [
    node("topic-alternatives", "Alternatives pages", [`${ke("p1")}.md`, `${ke("p2")}.md`]),
    node("topic-writing", "Writing", [`${ke("p3")}.md`]),
    node("topic-noise", "Noise", [`${ke("r")}.md`])
  ]);
  const g = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.deepEqual(g.clusters.map((c) => c.label), ["Alternatives pages", "ads budget", null]);
});

test("graph: the most recent `limit` embedded entries; truncated; k and limit are clamped", async () => {
  const s = graphFixture();
  const g = await s.similarity.graph({ limit: 3, k: 99 }, s.seoOnly);
  assert.deepEqual(g.nodes.map((n) => n.id), ["p1", "p2", "p3"].map(ke));
  assert.equal(g.truncated, true);
  assert.deepEqual(g.totals, { entries: 7, embedded: 6 });
  assert.equal(g.edges.length, 3, "k clamped to 8: every pair of the three");
  assert.equal((await s.similarity.graph({ limit: 0 }, s.seoOnly)).nodes.length, 1);
});

test("graph: cached until the index generation, the graph revision or the drawn entries change", async () => {
  const s = graphFixture();
  const first = await s.similarity.graph({ k: 1 }, s.seoOnly);
  const calls = s.index.entryVectorCalls;
  assert.deepEqual(await s.similarity.graph({ k: 1 }, s.seoOnly), first);
  assert.equal(s.index.entryVectorCalls, calls, "served from the cache");
  await s.similarity.graph({ k: 2 }, s.seoOnly);
  assert.ok(s.index.entryVectorCalls > calls, "another k is another graph");

  // New vectors (generation): R moves next to Q2.
  s.index.set(ke("r"), around(DIMS, 1, 7, 0.95));
  const moved = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.notDeepEqual(moved.edges, first.edges);
  assert.ok(moved.edges.some((e) => e.to === ke("r")));

  // A graph load (revision) re-labels.
  let at = s.index.entryVectorCalls;
  await loadGraph(s.graph, [node("topic-ads", "Ad budgets", [`${ke("q1")}.md`, `${ke("q2")}.md`])]);
  const relabelled = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.ok(s.index.entryVectorCalls > at);
  assert.ok(relabelled.clusters.some((c) => c.label === "Ad budgets"));

  // A title edit (the drawn entries) re-labels too.
  at = s.index.entryVectorCalls;
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "Renamed", savedAt: s.store.getMeta(ke("p1"))!.savedAt }, true);
  const renamed = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.ok(s.index.entryVectorCalls > at);
  assert.equal(renamed.nodes.find((n) => n.id === ke("p1"))!.title, "Renamed");
});

test("graph: an entry deleted while the graph is computed is left out with its edges", async () => {
  const s = graphFixture();
  const pending = s.similarity.graph({ k: 2 }, s.seoOnly);
  s.store.remove(ke("p1"));
  const g = await pending;
  assert.ok(!g.nodes.some((n) => n.id === ke("p1")));
  assert.ok(g.edges.length > 0);
  for (const edge of g.edges) assert.ok(edge.from !== ke("p1") && edge.to !== ke("p1"));
});

test("graph: no index or no model answers the visible total and nothing drawn", async () => {
  const s = graphFixture();
  s.index.model = null;
  assert.deepEqual(await s.similarity.graph({}, s.seoOnly), { nodes: [], edges: [], clusters: [], truncated: false, totals: { entries: 7, embedded: 0 } });
  s.noIndex();
  assert.deepEqual((await s.similarity.graph({}, s.all)).totals, { entries: 8, embedded: 0 });
});

// ---------------------------------------------------------------------------
// Clusters in a narrow cone (multilingual-e5-small puts any two entries at 0.73–0.99)
// ---------------------------------------------------------------------------

/** The pinned e5 model's thresholds (install/pins.ts). */
const CONE_THRESHOLDS = { minimum: 0.78, good: 0.83, strong: 0.87, duplicate: 0.95 };

/**
 * Topic groups in a narrow cone, saved group by group: two entries of one group are 0.93 apart,
 * of two groups 0.84 — every pair above `good`. Entry ids are `<topic><i>`, titles "<Topic> note <i>".
 */
function cone(topics: Record<string, number>) {
  const s = setup();
  s.index.limits = CONE_THRESHOLDS;
  const names = Object.keys(topics);
  const total = Object.values(topics).reduce((sum, size) => sum + size, 0);
  const dims = 1 + names.length + total + 1; // the last one free for an unrelated entry
  let own = 1 + names.length;
  const members: Record<string, string[]> = {};
  names.forEach((topic, t) => {
    members[topic] = [];
    for (let i = 0; i < topics[topic]!; i += 1) {
      const v = new Array<number>(dims).fill(0);
      v[0] = Math.sqrt(0.84);
      v[1 + t] = Math.sqrt(0.09);
      v[own++] = Math.sqrt(0.07);
      s.put(`${topic}${i}`, [], { title: `${topic[0]!.toUpperCase()}${topic.slice(1)} note ${i}` });
      s.index.set(ke(`${topic}${i}`), v);
      members[topic]!.push(ke(`${topic}${i}`));
    }
  });
  return { ...s, members, dims };
}

/** Topic → its cluster's label, asserting every topic is exactly one cluster. */
function labelsByTopic(g: Awaited<ReturnType<KnowledgeSimilarity["graph"]>>, members: Record<string, string[]>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [topic, list] of Object.entries(members)) {
    const clusters = new Set(list.map((id) => g.nodes.find((n) => n.id === id)!.cluster));
    assert.equal(clusters.size, 1, `${topic} is split`);
    const cluster = g.clusters[[...clusters][0]!]!;
    assert.equal(cluster.size, list.length, `${topic} shares its cluster`);
    out[topic] = cluster.label;
  }
  return out;
}

const files = (list: readonly string[]) => list.map((id) => `${id}.md`);

test("graph: topic groups inside a narrow cone, every pair above `good`, are separate clusters", async () => {
  const s = cone({ pricing: 5, tiktok: 4, seo: 4, ads: 3 });
  const g = await s.similarity.graph({ k: 8 }, s.all);
  assert.ok(g.edges.every((e) => e.similarity >= CONE_THRESHOLDS.good), "one component over edges ≥ good");
  assert.ok(g.edges.some((e) => e.similarity < 0.9), "edges across groups are drawn");
  assert.deepEqual(g.clusters.map((c) => c.size), [5, 4, 4, 3]);
  assert.deepEqual(labelsByTopic(g, s.members), { pricing: "pricing note", tiktok: "tiktok note", seo: "seo note", ads: "ads note" });
});

test("graph: the same entries always give the same clusters, whatever k is drawn", async () => {
  const topics = { pricing: 5, tiktok: 4, seo: 4, ads: 3 };
  const a = cone(topics);
  const first = await a.similarity.graph({ k: 3 }, a.all);
  const b = cone(topics);
  assert.deepEqual(await b.similarity.graph({ k: 3 }, b.all), first);
  const c = cone(topics);
  const wider = await c.similarity.graph({ k: 8 }, c.all);
  assert.deepEqual(wider.clusters, first.clusters);
  assert.deepEqual(wider.nodes.map((n) => n.cluster), first.nodes.map((n) => n.cluster));
});

test("graph: an entry related to nothing is a singleton without a label; the groups are unchanged", async () => {
  const s = cone({ pricing: 4, seo: 4 });
  s.put("odd", [], { title: "Sourdough starter" });
  s.index.set(ke("odd"), axis(s.dims, s.dims - 1)); // orthogonal to every other entry: no edge at all
  const g = await s.similarity.graph({}, s.all);
  assert.deepEqual(g.clusters, [
    { id: 0, size: 4, label: "seo note" },
    { id: 1, size: 4, label: "pricing note" },
    { id: 2, size: 1, label: null }
  ]);
  assert.equal(g.nodes.find((n) => n.id === ke("odd"))!.cluster, 2);
  assert.ok(!g.edges.some((e) => e.from === ke("odd") || e.to === ke("odd")));
});

test("graph: labels never name a person or organization, and prefer a concept distinctive of the cluster", async () => {
  const s = cone({ pricing: 5, tiktok: 5, seo: 5 });
  const all = Object.values(s.members).flat();
  await loadGraph(s.graph, [
    // On every entry: the author of research notes, and a channel everything mentions.
    node("person-claude", "Claude (research)", files(all), { type: "Person" }),
    node("channel-tiktok", "TikTok", files(all), { type: "Channel" }),
    // On every pricing entry and nowhere else: as distinctive as it gets, but publishers.
    node("organization-apple", "Apple", files(s.members.pricing!), { type: "Organization" }),
    node("company-revenuecat", "RevenueCat Inc", files(s.members.pricing!), { type: "Company" }),
    node("topic-paywalls", "Paywalls", files(s.members.pricing!.slice(0, 4)), { type: "Topic" }),
    node("tactic-us", "US accounts", files(s.members.tiktok!.slice(0, 4)), { type: "Tactic" }),
    node("tactic-alternatives", "Alternatives pages", files(s.members.seo!.slice(0, 3)), { type: "Tactic" }),
    // One entry's concept does not name its group.
    node("tool-ahrefs", "Ahrefs", files(s.members.seo!.slice(0, 1)), { type: "Tool" })
  ]);
  const g = await s.similarity.graph({}, s.all);
  // "TikTok" is on every entry of each cluster, but only a third of its entries are in any one.
  assert.deepEqual(labelsByTopic(g, s.members), { pricing: "Paywalls", tiktok: "US accounts", seo: "Alternatives pages" });
});

test("graph: two clusters never share a label when another one fits", async () => {
  const s = cone({ pricing: 5, tiktok: 5, seo: 5 });
  await loadGraph(s.graph, [
    // Every cluster's best concept alike.
    node("topic-growth", "Growth", files(Object.values(s.members).flat())),
    node("topic-budgets", "Budgets", files(s.members.pricing!.slice(0, 3)))
  ]);
  const g = await s.similarity.graph({}, s.all);
  // Pricing has a next-best concept; of the other two (tied, the newest cluster first) one gets
  // "Growth" and the other its title words.
  assert.deepEqual(labelsByTopic(g, s.members), { pricing: "Budgets", tiktok: "tiktok note", seo: "Growth" });
  const labels = g.clusters.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length);
});
