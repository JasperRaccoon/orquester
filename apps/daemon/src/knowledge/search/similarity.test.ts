import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeCitation, type KnowledgeEntryMeta, type KnowledgeSimilarEntry, type KnowledgeVisibility } from "@orquester/api";
import { FakeVectorIndex, around, axis } from "./fake-vector-index.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeSimilarity } from "./similarity.ts";
import type { KnowledgePairCheck } from "../ports.ts";
import { FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { knowledgeScope, visibleCollections } from "./visibility.ts";

// Thresholds of the fake index: minimum 0.3, good 0.5, strong 0.7, duplicate 0.9.
const DIMS = 16;
const ke = (name: string): string => `ke_${name.padStart(12, "0")}`;
/** The shared text of the fixtures' bodies. */
const COMMON_BODY = "Write one comparison page per competitor, with an honest table of prices and features, and link it from the pricing page.";

function setup() {
  /** The similarity's clock (background draws are spaced by it). */
  let nowMs = Date.parse("2026-10-27T12:00:00.000Z");
  const store = new FakeStore();
  store.collection("kc_seo", "SEO");
  store.collection("kc_ads", "Ads");
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const index = new FakeVectorIndex();
  let indexOn = true;
  /** Linking's pair checks; `checksChanged` moves their revision. */
  const pairChecks: KnowledgePairCheck[] = [];
  let checksRevision = 0;
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
    }),
    body: (id) => store.entries.get(id)?.body ?? null,
    pairChecks: () => ({ all: () => pairChecks, get: (a, b) => pairChecks.find((c) => c.a === a && c.b === b) ?? null, onChange: () => () => undefined }),
    pairChecksRevision: () => checksRevision,
    now: () => nowMs
  });
  const scope = (visibility: KnowledgeVisibility, narrow?: string[]) => knowledgeScope(visibility, store.collections.map((c) => c.id), narrow);
  // Every body is a near-copy of the others (only the name differs): meaning decides what is a duplicate, unless a test writes its own body.
  const put = (name: string, collections: string[], extra: Partial<KnowledgeEntryMeta> = {}, body = `${COMMON_BODY} ${name}`) =>
    store.put(ke(name), body, collections, { title: name, ...extra }, true);
  return {
    store,
    graph,
    index,
    similarity,
    put,
    all: scope({ kind: "all" }),
    seoOnly: scope({ kind: "collections", ids: ["kc_seo"] }),
    scope,
    pairChecks,
    checksChanged: () => {
      checksRevision += 1;
    },
    noIndex: () => {
      indexOn = false;
    },
    advance: (ms: number) => {
      nowMs += ms;
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
  // Here by concepts: a similarity below `good` orders it but gives no meaning reason; four shared
  // concepts, three named (the distinctive ones first); three of them on no other entry
  // (distinctive: ≤ max(2, 3% of 9) entries).
  assert.equal(by.get(ke("e"))!.similarity, 0.2);
  assert.deepEqual(by.get(ke("e"))!.reasons, [
    {
      kind: "concepts",
      concepts: [
        { id: "tactic-comparison", name: "Comparison pages", type: "tactic" },
        { id: "tool-stripe", name: "Stripe", type: "tool" },
        { id: "topic-seo", name: "SEO", type: "topic" }
      ],
      shared: 4,
      distinctive: [
        { id: "tactic-comparison", name: "Comparison pages", type: "tactic" },
        { id: "tool-stripe", name: "Stripe", type: "tool" },
        { id: "topic-seo", name: "SEO", type: "topic" }
      ]
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

test("possible duplicates and near-duplicates on save are near-copies: close in meaning is not enough", () => {
  const s = setup();
  const guide = "Buy a used iPhone, factory reset it, set the region to the United States, then warm the account up for two days before you post anything.";
  s.put("a", [], {}, guide);
  // A repost with light edits; another guide on the same topic, as close in meaning.
  s.put("repost", [], {}, `${guide.replace("two days", "48 hours")} Credit to the original author.`);
  s.put("other", [], {}, "Get a free Visible eSIM, spoof the location during setup and keep location services off: TikTok then shows US content from day one.");
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("repost"), around(DIMS, 0, 1, 0.96));
  s.index.set(ke("other"), around(DIMS, 0, 2, 0.97));
  const { similar, possibleDuplicates } = s.similarity.forEntry(ke("a"), s.all);
  assert.deepEqual(ids(possibleDuplicates), [ke("repost")]);
  assert.deepEqual(ids(similar), [ke("other"), ke("repost")], "both stay similar by meaning");
  const saved = s.similarity.similarForSaved([ke("a")], s.all);
  assert.deepEqual(saved.get(ke("a"))!.map((x) => x.entryId), [ke("repost")]);
});

test("every similar entry sharing a visible concept has the concepts reason, however it was found; distinctive concepts named first", async () => {
  const s = setup();
  // The oldest entry is close in meaning and shares the common concept only; eight newer ones share
  // it too (N1 also a distinctive one), so it is not among the eight most related by concepts.
  s.put("old", []);
  s.put("a", []);
  for (let i = 1; i <= 8; i += 1) s.put(`n${i}`, []);
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("old"), around(DIMS, 0, 1, 0.9));
  await loadGraph(s.graph, [
    node("channel-tiktok", "TikTok", [ke("a"), ke("old"), ...Array.from({ length: 8 }, (_, i) => ke(`n${i + 1}`))].map((id) => `${id}.md`), { type: "Channel" }),
    node("platform-app-store", "App Store", [`${ke("a")}.md`, `${ke("n1")}.md`], { type: "Platform" })
  ]);
  const { similar } = s.similarity.forEntry(ke("a"), s.all);
  const by = new Map(similar.map((item) => [item.entry.id, item]));
  assert.deepEqual(by.get(ke("old"))!.reasons, [
    { kind: "meaning", similarity: 0.9 },
    { kind: "concepts", concepts: [{ id: "channel-tiktok", name: "TikTok", type: "Channel" }], shared: 1 }
  ]);
  assert.deepEqual(by.get(ke("n1"))!.reasons, [
    {
      kind: "concepts",
      concepts: [
        { id: "platform-app-store", name: "App Store", type: "Platform" },
        { id: "channel-tiktok", name: "TikTok", type: "Channel" }
      ],
      shared: 2,
      distinctive: [{ id: "platform-app-store", name: "App Store", type: "Platform" }]
    }
  ]);
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
  assert.deepEqual(s.similarity.forEntry(ke("zzz"), s.all), { similar: [], possibleDuplicates: [], disagreements: [], disagreementsTotal: 0 }, "unknown entry");
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
  assert.equal(all.get(ke("s1"))![0]!.title, "X");
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

test("graph: the most recent embedded entries respect the limit and report truncation", async () => {
  const s = graphFixture();
  const g = await s.similarity.graph({ limit: 3 }, s.seoOnly);
  assert.deepEqual(g.nodes.map((n) => n.id), ["p1", "p2", "p3"].map(ke));
  assert.equal(g.truncated, true);
  assert.deepEqual(g.totals, { entries: 7, embedded: 6 });
  assert.equal((await s.similarity.graph({ limit: 0 }, s.seoOnly)).nodes.length, 1);
});

test("graph: changed vectors, graph concepts and entry metadata replace stale results", async () => {
  const s = graphFixture();
  const first = await s.similarity.graph({ k: 1 }, s.seoOnly);
  // New vectors (generation): R moves next to Q2.
  s.index.set(ke("r"), around(DIMS, 1, 7, 0.95));
  const moved = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.notDeepEqual(moved.edges, first.edges);
  assert.ok(moved.edges.some((e) => e.to === ke("r")));

  // A graph load (revision) re-labels.
  await loadGraph(s.graph, [node("topic-ads", "Ad budgets", [`${ke("q1")}.md`, `${ke("q2")}.md`])]);
  const relabelled = await s.similarity.graph({ k: 1 }, s.seoOnly);
  assert.ok(relabelled.clusters.some((c) => c.label === "Ad budgets"));

  // A title edit (the drawn entries) re-labels too.
  for (const name of ["p1", "p2", "p3"]) {
    s.store.put(ke(name), `body ${name}`, ["kc_seo"], { title: "Pricing research", savedAt: s.store.getMeta(ke(name))!.savedAt }, true);
  }
  const renamed = await s.similarity.graph({ k: 1 }, s.seoOnly);
  const p1 = renamed.nodes.find((n) => n.id === ke("p1"))!;
  assert.equal(p1.title, "Pricing research");
  assert.equal(renamed.clusters.find((c) => c.id === p1.cluster)!.label, "pricing research");
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

// ---------------------------------------------------------------------------
// Crossed with the concept graph (phase 2 spec, "Cross-graph derivations")
// ---------------------------------------------------------------------------

/** A pair check of two entries, ids sorted as the port gives them. */
function pairCheck(x: string, y: string, verdict: KnowledgePairCheck["verdict"], note: string | null = null): KnowledgePairCheck {
  const [a, b] = x < y ? [x, y] : [y, x];
  return { a, b, verdict, note, checkedAt: "2026-10-27T00:00:00.000Z" };
}

const contradicts = (id: string, from: string, to: string) => edge(id, from, to, null, "contradicts");

test("similar: each distinctive shared concept adds a small capped bonus; meaning still dominates; a common concept adds none", async () => {
  const s = setup();
  for (const name of ["a", "b", "c", "d", "e", "f", "x", "y"]) s.put(name, ["kc_seo"]);
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("d"), around(DIMS, 0, 1, 0.95));
  s.index.set(ke("b"), around(DIMS, 0, 2, 0.8));
  s.index.set(ke("e"), around(DIMS, 0, 3, 0.79));
  s.index.set(ke("c"), around(DIMS, 0, 4, 0.78));
  s.index.set(ke("f"), around(DIMS, 0, 5, 0.7));
  await loadGraph(s.graph, [
    node("tactic-c1", "Annual plans", files([ke("a"), ke("c")])),
    node("tactic-c2", "Price anchoring", files([ke("a"), ke("c")])),
    ...[1, 2, 3, 4, 5].map((i) => node(`tactic-f${i}`, `Tactic ${i}`, files([ke("a"), ke("f")]))),
    // On half of the entries: shared, never distinctive (at most max(2, 3% of 8) entries are).
    node("topic-seo", "SEO", files([ke("a"), ke("e"), ke("x"), ke("y")]))
  ]);
  const { similar } = s.similarity.forEntry(ke("a"), s.all);
  // By meaning alone: d .95, b .80, e .79, c .78, f .70. With the fake model's band (good .5,
  // strong .7) a distinctive concept adds .05, at most three of them: c .88, f .85 pass b; d stays first.
  assert.deepEqual(ids(similar), ["d", "c", "f", "b", "e", "y", "x"].map(ke));
  const reason = (name: string) => similar.find((item) => item.entry.id === ke(name))!.reasons.find((r) => r.kind === "concepts");
  assert.deepEqual(reason("c"), {
    kind: "concepts",
    concepts: [
      { id: "tactic-c1", name: "Annual plans", type: "tactic" },
      { id: "tactic-c2", name: "Price anchoring", type: "tactic" }
    ],
    shared: 2,
    distinctive: [
      { id: "tactic-c1", name: "Annual plans", type: "tactic" },
      { id: "tactic-c2", name: "Price anchoring", type: "tactic" }
    ]
  });
  assert.equal((reason("f") as { distinctive?: unknown[] }).distinctive?.length, 3, "named up to three");
  assert.deepEqual(reason("e"), { kind: "concepts", concepts: [{ id: "topic-seo", name: "SEO", type: "topic" }], shared: 1 }, "no `distinctive` when none is");
  assert.equal(similar[0]!.similarity, 0.95, "the bonus orders; `similarity` stays the cosine");
});

/** A (SEO) with tactic-short; Z (SEO) and H (Ads) hold the concepts that contradict it; N1..N10 close in meaning. */
async function contradictionFixture() {
  const s = setup();
  s.put("a", ["kc_seo"]);
  s.put("z", ["kc_seo"]);
  s.put("h", ["kc_ads"]);
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("z"), around(DIMS, 0, 1, 0.1));
  s.index.set(ke("h"), around(DIMS, 0, 2, 0.2));
  for (let i = 1; i <= 10; i += 1) {
    s.put(`n${i}`, ["kc_seo"]);
    s.index.set(ke(`n${i}`), around(DIMS, 0, 2 + i, 0.99 - i * 0.01));
  }
  await loadGraph(
    s.graph,
    [
      node("tactic-short", "3-day trials", files([ke("a")])),
      node("tactic-long", "14-day trials", files([ke("z")])),
      node("tactic-secret", "Hidden pricing claim", files([ke("h")]))
    ],
    [contradicts("c1", "tactic-short", "tactic-long"), contradicts("c2", "tactic-secret", "tactic-short")]
  );
  return s;
}

const shortRef = { id: "tactic-short", name: "3-day trials", type: "tactic" };
const longRef = { id: "tactic-long", name: "14-day trials", type: "tactic" };

test("possible duplicates compare the body read now: shingles are cached by that text, not by the entry's content hash", () => {
  const s = setup();
  const guide = "Buy a used iPhone, factory reset it, set the region to the United States, then warm the account up for two days before you post anything.";
  s.put("a", [], {}, guide);
  s.put("repost", [], {}, `${guide} Credit to the original author.`);
  s.index.set(ke("a"), axis(DIMS, 0));
  s.index.set(ke("repost"), around(DIMS, 0, 1, 0.96));
  assert.deepEqual(ids(s.similarity.forEntry(ke("a"), s.all).possibleDuplicates), [ke("repost")]);
  // The indexed body changed while the entry's content hash did not (yet): the cache must not answer
  // for a text it was not made from.
  s.store.entries.get(ke("repost"))!.body = "Get a free Visible eSIM, spoof the location during setup and keep location services off from day one.";
  assert.deepEqual(ids(s.similarity.forEntry(ke("a"), s.all).possibleDuplicates), []);
});

test("background draws for more scopes than the latest graphs kept are bounded: a scope drawn lately waits until the vectors, the graph or a few minutes move", async () => {
  const s = graphFixture();
  await loadGraph(s.graph, [node("topic-shared", "Comparison pages", files([ke("p1"), ke("p2"), ke("p3")]))]);
  for (let i = 0; i < 40; i += 1) s.store.collection(`kc_x${String(i).padStart(8, "0")}`, `X ${i}`);
  const scopes = Array.from({ length: 40 }, (_, i) => s.scope({ kind: "collections", ids: ["kc_seo", `kc_x${String(i).padStart(8, "0")}`] }));
  const draw = s.similarity.graph.bind(s.similarity);
  let draws = 0;
  s.similarity.graph = async (...args) => {
    draws += 1;
    return draw(...args);
  };
  const pass = async (): Promise<number> => {
    let found = 0;
    for (const scope of scopes) if (s.similarity.novelty(ke("p1"), scope)?.cluster) found += 1;
    await s.similarity.idle();
    return found;
  };
  assert.equal(await pass(), 0, "nothing drawn yet");
  assert.equal(draws, 40);
  // More scopes than the latest graphs kept: the evicted ones are not drawn again right away.
  const found = await pass();
  assert.ok(found >= 30, `${found} scopes read their latest graph`);
  assert.equal(draws, 40, "no scope drawn twice within minutes");
  await pass();
  assert.equal(draws, 40);
  // A few minutes later, an evicted scope is drawn again, at most once each: the reads settle.
  s.advance(6 * 60_000);
  let passes = 0;
  for (let before = -1; before !== draws && passes < 10; passes += 1) {
    before = draws;
    await pass();
  }
  const later = draws;
  assert.ok(later > 40 && later <= 80, `${later - 40} drawn again`);
  assert.ok(passes < 10, "the background draws stop");
  // New vectors: drawn again at once.
  s.index.set(ke("p3"), around(DIMS, 0, 4, 0.81));
  await pass();
  assert.ok(draws > later);
});

test("similar: entries that contradict it (graph, either direction) are listed even below the meaning bar, among the 8", async () => {
  const s = await contradictionFixture();
  const { similar } = s.similarity.forEntry(ke("a"), s.all);
  assert.equal(similar.length, 8);
  assert.deepEqual(ids(similar), [...["n1", "n2", "n3", "n4", "n5", "n6"].map(ke), ke("h"), ke("z")], "the closest six, then the two that disagree");
  const z = similar.find((item) => item.entry.id === ke("z"))!;
  assert.equal(z.similarity, 0.1);
  assert.deepEqual(z.reasons, [{ kind: "contradicts", source: "graph", pairs: [{ from: shortRef, to: longRef }], note: null }]);
  const h = similar.find((item) => item.entry.id === ke("h"))!;
  assert.deepEqual(h.reasons, [
    { kind: "contradicts", source: "graph", pairs: [{ from: { id: "tactic-secret", name: "Hidden pricing claim", type: "tactic" }, to: shortRef }], note: null }
  ]);
});

test("disagreements: every contradicting entry, checked first then closest, past the 3 `similar` keeps; each side lists the other", async () => {
  const s = await contradictionFixture();
  for (const name of ["n1", "n4", "n7", "n9"]) s.pairChecks.push(pairCheck(ke("a"), ke(name), "contradicts", `${name} disagrees`));
  const { similar, disagreements, disagreementsTotal } = s.similarity.forEntry(ke("a"), s.all);
  assert.deepEqual(
    disagreements.map((item) => item.entry.id),
    ["n1", "n4", "n7", "n9", "h", "z"].map(ke)
  );
  assert.equal(disagreementsTotal, 6);
  assert.deepEqual(disagreements[0], { entry: disagreements[0]!.entry, similarity: 0.98, source: "checked", pairs: [], note: "n1 disagrees" });
  assert.deepEqual(disagreements[5], { entry: disagreements[5]!.entry, similarity: 0.1, source: "graph", pairs: [{ from: shortRef, to: longRef }], note: null });
  assert.equal(similar.filter((item) => item.reasons.some((r) => r.kind === "contradicts")).length, 3, "similar keeps its 3, as older clients read them");
  for (const other of disagreements) {
    assert.ok(
      s.similarity.forEntry(other.entry.id, s.all).disagreements.some((item) => item.entry.id === ke("a")),
      `${other.entry.id} lists a back`
    );
  }
  // Only the hidden-aware view: H (Ads) is neither listed nor counted.
  const seo = s.similarity.forEntry(ke("a"), s.seoOnly);
  assert.ok(!seo.disagreements.some((item) => item.entry.id === ke("h")));
  assert.equal(seo.disagreementsTotal, 5);
});

test("disagreements: at most 20 listed, every one counted", async () => {
  const s = await contradictionFixture();
  for (let i = 1; i <= 21; i += 1) {
    if (i > 10) {
      s.put(`m${i}`, ["kc_seo"]);
      s.index.set(ke(`m${i}`), around(DIMS, 0, 1, 0.3));
    }
    s.pairChecks.push(pairCheck(ke("a"), ke(i > 10 ? `m${i}` : `n${i}`), "contradicts"));
  }
  const { disagreements, disagreementsTotal } = s.similarity.forEntry(ke("a"), s.all);
  assert.equal(disagreements.length, 20);
  assert.equal(disagreementsTotal, 23);
  assert.ok(disagreements.every((item) => item.source === "checked"), "checked ones first");
});

test("similar: a hidden entry or its concepts never show through a contradiction", async () => {
  const s = await contradictionFixture();
  s.pairChecks.push(pairCheck(ke("a"), ke("h"), "contradicts", "the hidden one disagrees"));
  const { similar } = s.similarity.forEntry(ke("a"), s.seoOnly);
  assert.ok(!ids(similar).includes(ke("h")));
  assert.ok(!JSON.stringify(similar).includes("Hidden pricing claim"));
  assert.ok(!JSON.stringify(similar).includes("the hidden one disagrees"));
  assert.ok(ids(similar).includes(ke("z")));
});

test("similar: a contradiction only a hidden entry recorded (the edge's provenance) is not shown", async () => {
  const s = await contradictionFixture();
  await loadGraph(
    s.graph,
    [node("tactic-short", "3-day trials", files([ke("a")])), node("tactic-long", "14-day trials", files([ke("z")])), node("tactic-other", "Other", files([ke("h")]))],
    [edge("c1", "tactic-short", "tactic-long", files([ke("h")]), "contradicts")]
  );
  assert.ok(!s.similarity.forEntry(ke("a"), s.seoOnly).similar.some((item) => item.reasons.some((r) => r.kind === "contradicts")));
  assert.ok(s.similarity.forEntry(ke("a"), s.all).similar.some((item) => item.entry.id === ke("z") && item.reasons[0]!.kind === "contradicts"));
});

test("similar: a `contradicts` pair check confirms (its note first) or adds a pair; `consistent` overrides the graph", async () => {
  const s = await contradictionFixture();
  s.pairChecks.push(
    pairCheck(ke("a"), ke("z"), "contradicts", "Z recommends 14 days"),
    pairCheck(ke("a"), ke("n10"), "contradicts", "N10 says the opposite"),
    pairCheck(ke("a"), ke("h"), "consistent", "they agree")
  );
  const { similar } = s.similarity.forEntry(ke("a"), s.all);
  const by = new Map(similar.map((item) => [item.entry.id, item]));
  assert.deepEqual(by.get(ke("z"))!.reasons, [{ kind: "contradicts", source: "checked", pairs: [{ from: shortRef, to: longRef }], note: "Z recommends 14 days" }]);
  assert.deepEqual(by.get(ke("n10"))!.reasons, [
    { kind: "contradicts", source: "checked", pairs: [], note: "N10 says the opposite" },
    { kind: "meaning", similarity: 0.89 }
  ]);
  assert.ok(!by.has(ke("h")), "the checker found them consistent");
});

test("graph: edges carry shared concepts; contradicting drawn entries get an edge marked `contradicts`, added outside the forest when absent", async () => {
  const s = graphFixture();
  await loadGraph(
    s.graph,
    [
      node("tactic-x", "Comparison tables", files([ke("p1"), ke("p2")])),
      node("topic-y", "Pages", files([ke("p1"), ke("p2"), ke("p3")])),
      node("tactic-z", "Sourdough", files([ke("r")])),
      node("tactic-secret", "Ads claim", files([ke("hidden")]))
    ],
    [contradicts("c1", "tactic-x", "tactic-z"), contradicts("c2", "tactic-secret", "tactic-x")]
  );
  const g = await s.similarity.graph({ k: 1 }, s.seoOnly);
  const find = (x: string, y: string) => g.edges.find((e) => (e.from === ke(x) && e.to === ke(y)) || (e.from === ke(y) && e.to === ke(x)));
  assert.equal(find("p1", "p2")!.sharedConcepts, 2);
  assert.equal(find("p1", "p3")!.sharedConcepts, 1);
  assert.ok(!("sharedConcepts" in find("q1", "q2")!), "absent when they share none");
  for (const [x, y] of [
    ["p1", "r"],
    ["p2", "r"]
  ] as const) {
    assert.deepEqual({ ...find(x, y)!, from: "", to: "" }, { from: "", to: "", similarity: 0, tree: false, contradicts: true });
  }
  assert.equal(g.edges.filter((e) => e.contradicts).length, 2, "the hidden entry's contradiction is not drawn");
  assert.equal(g.nodes.find((n) => n.id === ke("r"))!.degree, 2);
  assert.ok(!find("p1", "p3")!.contradicts);

  // A new pair check (its revision moves) redraws: the existing p1–p3 edge is marked.
  s.pairChecks.push(pairCheck(ke("p1"), ke("p3"), "contradicts", "they disagree"));
  s.checksChanged();
  const redrawn = await s.similarity.graph({ k: 1 }, s.seoOnly);
  const p1p3 = redrawn.edges.find((e) => [e.from, e.to].sort().join() === [ke("p1"), ke("p3")].sort().join())!;
  assert.deepEqual({ tree: p1p3.tree, contradicts: p1p3.contradicts, similarity: p1p3.similarity }, { tree: true, contradicts: true, similarity: 0.8 });
});

test("graph: cluster concepts are the label's scoring, best first with the label's own concept leading; never a person or organization", async () => {
  const s = cone({ pricing: 5, tiktok: 5, seo: 5 });
  const all = Object.values(s.members).flat();
  await loadGraph(s.graph, [
    node("person-claude", "Claude (research)", files(all), { type: "Person" }),
    node("channel-tiktok", "TikTok", files(all), { type: "Channel" }),
    node("organization-apple", "Apple", files(s.members.pricing!), { type: "Organization" }),
    node("topic-paywalls", "Paywalls", files(s.members.pricing!.slice(0, 4)), { type: "Topic" }),
    node("tactic-us", "US accounts", files(s.members.tiktok!.slice(0, 4)), { type: "Tactic" }),
    node("tactic-alternatives", "Alternatives pages", files(s.members.seo!.slice(0, 3)), { type: "Tactic" }),
    node("tool-ahrefs", "Ahrefs", files(s.members.seo!.slice(0, 1)), { type: "Tool" })
  ]);
  const g = await s.similarity.graph({}, s.all);
  const byTopic = (topic: string) => g.clusters[g.nodes.find((n) => n.id === s.members[topic]![0])!.cluster]!;
  assert.deepEqual(byTopic("pricing").concepts, [
    { id: "topic-paywalls", name: "Paywalls", type: "Topic" },
    { id: "channel-tiktok", name: "TikTok", type: "Channel" }
  ]);
  assert.deepEqual(byTopic("tiktok").concepts!.map((c) => c.name), ["US accounts", "TikTok"]);
  assert.deepEqual(byTopic("seo").concepts!.map((c) => c.name), ["Alternatives pages", "TikTok"]);
  for (const cluster of g.clusters) assert.equal(cluster.concepts![0]!.name, cluster.label);
});

test("graph: a cluster labelled by its second-best concept or by title words still lists its concepts, the label's first when it is one", async () => {
  const s = cone({ pricing: 5, tiktok: 5, seo: 5 });
  await loadGraph(s.graph, [
    node("topic-growth", "Growth", files(Object.values(s.members).flat())),
    node("topic-budgets", "Budgets", files(s.members.pricing!.slice(0, 3)))
  ]);
  const g = await s.similarity.graph({}, s.all);
  const byTopic = (topic: string) => g.clusters[g.nodes.find((n) => n.id === s.members[topic]![0])!.cluster]!;
  assert.deepEqual(byTopic("pricing").concepts!.map((c) => c.name), ["Budgets", "Growth"]);
  assert.deepEqual(byTopic("seo").concepts!.map((c) => c.name), ["Growth"]);
  assert.equal(byTopic("tiktok").label, "tiktok note");
  assert.deepEqual(byTopic("tiktok").concepts!.map((c) => c.name), ["Growth"]);
});

test("novelty: concepts no other visible entry has (claims first, people last), and its cluster from the graph already drawn, else drawn in the background", async () => {
  const s = graphFixture();
  await loadGraph(s.graph, [
    node("person-om", "Om", files([ke("p1")]), { type: "Person" }),
    node("topic-shared", "Comparison pages", files([ke("p1"), ke("p2")])),
    node("tactic-hiddenshare", "Shared with a hidden entry", files([ke("p1"), ke("hidden")])),
    node("tactic-unique", "Only here", files([ke("p1")]))
  ]);
  const unique = { id: "tactic-unique", name: "Only here", type: "tactic" };
  const om = { id: "person-om", name: "Om", type: "Person" };
  const hiddenShare = { id: "tactic-hiddenshare", name: "Shared with a hidden entry", type: "tactic" };
  // Nothing drawn yet: no cluster (it never waits for a graph), and one is drawn in the background.
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.all), { newConcepts: [unique, om], cluster: null });
  await s.similarity.idle();
  assert.equal(s.similarity.novelty(ke("p1"), s.all)!.cluster?.label, "Comparison pages", "the background graph is read next time");
  // Among what an SEO chat sees, the concept it shares with a hidden entry is new; the hidden entry is never named.
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.seoOnly)!.newConcepts, [hiddenShare, unique, om]);

  await s.similarity.graph({}, s.seoOnly);
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.seoOnly)!.cluster, { label: "Comparison pages", size: 3 });
  assert.equal(s.similarity.novelty(ke("r"), s.seoOnly)!.cluster, null, "a singleton");
  assert.equal(s.similarity.novelty(ke("p1"), s.scope({ kind: "all" }, ["kc_seo", "kc_ads"]))!.cluster, null, "no graph drawn for this scope yet");
  assert.equal(s.similarity.novelty(ke("plain"), s.seoOnly), null, "no vectors yet");
  // An entry embedded after the graph was drawn: the cluster of its nearest drawn neighbours.
  s.put("late", ["kc_seo"]);
  s.index.set(ke("late"), around(DIMS, 0, 9, 0.97));
  assert.deepEqual(s.similarity.novelty(ke("late"), s.seoOnly), { newConcepts: [], cluster: { label: "Comparison pages", size: 3 } });
  // A drawn entry moved out of the caller's view: the old graph is not used; a new one is drawn.
  s.store.put(ke("p2"), "body p2", ["kc_ads"], { title: "Comparison pages that convert", savedAt: s.store.getMeta(ke("p2"))!.savedAt }, true);
  assert.equal(s.similarity.novelty(ke("p1"), s.seoOnly)!.cluster, null);
  await s.similarity.idle();
  assert.equal(s.similarity.novelty(ke("p1"), s.seoOnly)!.cluster?.size, 3, "P1, P3 and the late entry");
});

test("novelty: a concept another visible entry says in other words (a backing concept) is not new", async () => {
  const s = graphFixture();
  await loadGraph(s.graph, [
    node("tactic-unique", "Create a US Apple ID verified with a US number", files([ke("p1")])),
    node("tactic-reworded", "Create a US Apple ID using the US phone number", files([ke("p2")])),
    node("tactic-hidden-reworded", "Only here, as a hidden entry says it", files([ke("hidden")])),
    node("tactic-other", "Only here", files([ke("p1")]))
  ]);
  s.graph.setBackingConcepts((id) => (id === "tactic-unique" ? ["tactic-reworded"] : id === "tactic-other" ? ["tactic-hidden-reworded"] : []));
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.seoOnly)!.newConcepts.map((c) => c.id), ["tactic-other"], "a hidden entry backs nothing");
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.all)!.newConcepts, []);
});

test("novelty reads the latest graph drawn for the scope at any k and limit (insights' graph counts)", async () => {
  const s = graphFixture();
  await loadGraph(s.graph, [node("topic-shared", "Comparison pages", files([ke("p1"), ke("p2"), ke("p3")]))]);
  await s.similarity.graph({ k: 2, limit: 2_000 }, s.seoOnly);
  assert.deepEqual(s.similarity.novelty(ke("p1"), s.seoOnly)!.cluster, { label: "Comparison pages", size: 3 });
});

test("clustersForSaved: the cluster of the saved entry's nearest drawn neighbours, from the graph already drawn, never other entries of the save", async () => {
  const s = graphFixture();
  s.put("s1", ["kc_seo"]);
  s.put("s2", ["kc_seo"]);
  s.put("s3", ["kc_seo"]);
  const saved = [ke("s1"), ke("s2"), ke("s3")];
  const before = s.similarity.clustersForSaved(saved, s.seoOnly);
  assert.ok(before instanceof Map, "answered at once");
  assert.deepEqual([...before.values()], [null, null, null], "no graph drawn yet");

  // The graph drawn before the save's entries were embedded (they are not among its nodes).
  await s.similarity.graph({}, s.seoOnly);
  s.index.set(ke("s1"), around(DIMS, 0, 10, 0.97)); // beside P1..P3
  s.index.set(ke("s2"), around(DIMS, 10, 11, 0.99)); // beside S1 only
  const after = s.similarity.clustersForSaved(saved, s.seoOnly);
  assert.deepEqual(after.get(ke("s1")), { label: "comparison pages", size: 3 });
  assert.equal(after.get(ke("s2")), null, "its only close neighbour is in the same save");
  assert.equal(after.get(ke("s3")), null, "not embedded");
  s.noIndex();
  assert.deepEqual([...s.similarity.clustersForSaved(saved, s.seoOnly).values()], [null, null, null]);
});
