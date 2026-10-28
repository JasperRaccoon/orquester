import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeCitation, type KnowledgeEntryMeta, type KnowledgeInsightsResponse, type KnowledgeVisibility } from "@orquester/api";
import type { KnowledgePairCheck } from "../ports.ts";
import { FakeVectorIndex, around } from "./fake-vector-index.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeInsights, conceptCentrality, samePoint, statesNoClaim } from "./insights.ts";
import { namesTopic } from "./same-question.ts";
import { KnowledgeSimilarity } from "./similarity.ts";
import { FakeStore, edge, loadGraph, node, silentLogger } from "./test-fakes.ts";
import { type KnowledgeScope, knowledgeScope, visibleCollections } from "./visibility.ts";

// Insights (phase 2 spec, "Cross-graph derivations and insights") over three topic clusters in
// the fake index (minimum 0.3, good 0.5, strong 0.7): P1..P4, Q1..Q4 and R1..R3, each group 0.9
// apart and orthogonal to the others; H is in the Ads collection (hidden from an SEO chat) beside R.

const DIMS = 16;
const ke = (name: string): string => `ke_${name.padStart(12, "0")}`;
const files = (...names: string[]) => names.map((name) => `${ke(name)}.md`);

async function setup() {
  const store = new FakeStore();
  store.collection("kc_seo", "SEO");
  store.collection("kc_ads", "Ads");
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  const index = new FakeVectorIndex();
  const pairChecks: KnowledgePairCheck[] = [];
  let checksRevision = 0;
  const queued = new Set<string>();
  /** Claim name → the entries whose text states its figure (`stating`). */
  const stated = new Map<string, string[]>();
  const summary = (meta: KnowledgeEntryMeta, scope: KnowledgeScope) => ({
    ...meta,
    collections: visibleCollections(meta, scope),
    snippet: "",
    linkCount: graph.linkCount(meta.id),
    citation: knowledgeCitation(meta)
  });
  const port = () => ({ all: () => pairChecks, get: () => null, onChange: () => () => undefined });
  const similarity = new KnowledgeSimilarity({
    store,
    graph,
    index: () => index,
    summary,
    body: (id) => store.entries.get(id)?.body ?? null,
    pairChecks: port,
    pairChecksRevision: () => checksRevision
  });
  const insights = new KnowledgeInsights({
    store,
    graph,
    similarity,
    index: () => index,
    summary,
    pairChecks: port,
    pairChecksRevision: () => checksRevision,
    linkGapQueued: (a, b) => queued.has(`${a} ${b}`),
    stating: (claim) => stated.get(claim) ?? []
  });
  const groups: [string, number, number][] = [
    ["p", 0, 3],
    ["q", 1, 7],
    ["r", 2, 11]
  ];
  for (const [prefix, base, side] of groups) {
    const size = prefix === "r" ? 3 : 4;
    for (let i = 1; i <= size; i += 1) {
      store.put(ke(`${prefix}${i}`), `body ${prefix}${i}`, ["kc_seo"], { title: `${prefix.toUpperCase()} note ${i}` }, true);
      index.set(ke(`${prefix}${i}`), around(DIMS, base, side + i - 1, 0.95));
    }
  }
  store.put(ke("h"), "body h", ["kc_ads"], { title: "Hidden note" }, true);
  index.set(ke("h"), around(DIMS, 2, 14, 0.95));
  const marketing = files("p1", "p2", "p3", "p4", "q1", "q2", "r1", "r2", "r3");
  await loadGraph(
    graph,
    [
      node("topic-marketing", "Marketing", marketing),
      // Q1, Q2 share each of these with Q3 or Q4; Q3 and Q4 share nothing: a link gap.
      node("topic-qa", "Queues", files("q1", "q2", "q3")),
      node("topic-qb", "Queue tooling", files("q1", "q2", "q4")),
      // P1 ties its cluster to Q and to R through concepts only it and one other entry have.
      node("tactic-bq", "Bridge to Q", files("p1", "q1")),
      node("tactic-br", "Bridge to R", files("p1", "r1")),
      // P2 reaches Q only; P3 reaches Q through a person (never a bridge) and R through a tactic.
      node("tactic-pq", "P2 and Q2", files("p2", "q2")),
      node("person-x", "Someone", files("p3", "q3"), { type: "Person" }),
      node("tactic-p3r", "P3 and R2", files("p3", "r2")),
      // P4 reaches Q, and R only through the hidden entry.
      node("tactic-p4q", "P4 and Q4", files("p4", "q4")),
      node("tactic-p4h", "P4 and H", files("p4", "h")),
      // Single-source claims, a topic that is not a claim, a hidden entry's own claim, one shared with it.
      // Solo tactic and Solo metric are about topics two of their cluster's other entries discuss.
      node("topic-pa", "Pricing tables", files("p2", "p3")),
      node("topic-ra", "Retention", files("r2", "r3")),
      node("tactic-solo1", "Solo tactic", files("p1")),
      node("rule-solo2", "Solo rule", files("p1"), { type: "rule" }),
      node("metric-solo3", "Solo metric up 20%", files("r1"), { type: "metric" }),
      node("topic-solo", "Solo topic", files("q1")),
      node("tactic-secret", "Secret claim", files("h")),
      node("tactic-hidshare", "Shared with H", files("p2", "h")),
      // Contradictions.
      node("tactic-c1", "Daily posting", files("q2")),
      node("tactic-c2", "Weekly posting", files("r3")),
      node("tactic-cs", "Hidden disagreement", files("h"))
    ],
    [
      edge("x1", "tactic-c1", "tactic-c2", null, "contradicts"),
      edge("x2", "tactic-cs", "tactic-c1", null, "contradicts"),
      edge("t1", "tactic-solo1", "topic-pa", null, "about"),
      edge("t2", "metric-solo3", "topic-ra", null, "measures")
    ]
  );
  const scope = (visibility: KnowledgeVisibility, narrow?: string[]) => knowledgeScope(visibility, store.collections.map((c) => c.id), narrow);
  return {
    store,
    graph,
    index,
    similarity,
    insights,
    pairChecks,
    queued,
    stated,
    checksChanged: () => {
      checksRevision += 1;
    },
    all: scope({ kind: "all" }),
    seoOnly: scope({ kind: "collections", ids: ["kc_seo"] }),
    scope
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Entry id → its cluster as insights name it, from the similarity graph insights read. */
async function clusters(s: Setup, scope: KnowledgeScope) {
  const g = await s.similarity.graph({ limit: 2_000 }, scope);
  return (name: string) => {
    const cluster = g.clusters[g.nodes.find((n) => n.id === ke(name))!.cluster]!;
    return { label: cluster.label, size: cluster.size };
  };
}

const pairOf = (item: { a: { id: string }; b: { id: string } }) => [item.a.id, item.b.id];

test("bridges: an entry whose distinctive topic concepts reach two other clusters; people and hidden entries never count", async () => {
  const s = await setup();
  const seo = await s.insights.list({}, s.seoOnly);
  const clusterOf = await clusters(s, s.seoOnly);
  assert.deepEqual(seo.bridges, [
    {
      entry: seo.bridges[0]!.entry,
      clusters: [clusterOf("p1"), clusterOf("q1"), clusterOf("r1")],
      concepts: [
        { id: "tactic-bq", name: "Bridge to Q", type: "tactic" },
        { id: "tactic-br", name: "Bridge to R", type: "tactic" }
      ]
    }
  ]);
  assert.equal(seo.bridges[0]!.entry.id, ke("p1"));
  assert.equal(seo.totals.bridges, 1);
  // The whole base: P4 and P2 reach R through H too (as many clusters and concepts as P1: newest first).
  const all = await s.insights.list({}, s.all);
  assert.deepEqual(all.bridges.map((b) => b.entry.id), [ke("p4"), ke("p2"), ke("p1")]);
  assert.ok(!JSON.stringify(seo.bridges).includes("P4 and H"), "a concept that only reaches a hidden entry ties nothing");
  assert.ok(!JSON.stringify(seo).includes(ke("h")) && !JSON.stringify(seo).includes("Hidden note"));
});

test("bridges: never a survey, nor a cluster reached through one common concept alone (a one-word name, a metric, a name other entries use)", async () => {
  const s = await setup();
  const bridges = async () => (await s.insights.list({}, s.seoOnly)).bridges.map((b) => [b.entry.id, b.concepts.map((c) => c.id)]);
  const reload = (extra: Record<string, unknown>[]) =>
    loadGraph(s.graph, [
      node("topic-marketing", "Marketing", files("p1", "p2", "p3", "p4", "q1", "q2", "r1", "r2", "r3")),
      node("tactic-bq", "Bridge to Q", files("p1", "q1")),
      ...extra
    ]);
  await reload([node("tactic-br", "Bridge to R", files("p1", "r1"))]);
  assert.deepEqual(await bridges(), [[ke("p1"), ["tactic-bq", "tactic-br"]]]);

  // P1, a synthesis, restates its sources.
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "P note 1", kind: "synthesis" }, true);
  assert.deepEqual(await bridges(), []);
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "P note 1", kind: "post" }, true);

  // R through a one-word tool, a metric, or a name a third entry uses as another type: no bridge.
  for (const weak of [
    [node("tool-ios", "iOS", files("p1", "r1"), { type: "Tool" })],
    [node("metric-cac", "CAC payback", files("p1", "r1"), { type: "Metric" })],
    [node("channel-ads", "Paid ads", files("p1", "r1"), { type: "Channel" }), node("platform-ads", "Paid ads", files("q2", "q3", "q4"), { type: "Platform" })]
  ]) {
    await reload(weak);
    assert.deepEqual(await bridges(), [], JSON.stringify(weak[0]!.id));
  }
  // Two weak concepts together tie it.
  await reload([node("tool-ios", "iOS", files("p1", "r1"), { type: "Tool" }), node("metric-cac", "CAC payback", files("p1", "r1"), { type: "Metric" })]);
  assert.deepEqual(await bridges(), [[ke("p1"), ["tactic-bq", "tool-ios", "metric-cac"]]]);
});

test("an LLM cluster name added after insights were computed shows in them: the labels' revision is part of the cache key", async () => {
  const s = await setup();
  let label: string | null = null;
  let revision = 0;
  s.similarity.connectClusterLabels({
    labelFor: (members) => (label !== null && members.includes(ke("p1")) ? { label, sources: members } : null),
    request: () => undefined,
    revision: () => revision
  });
  const before = await s.insights.list({}, s.seoOnly);
  const p1 = (response: typeof before) => response.singleSource.find((item) => item.entry.id === ke("p1"))!.cluster;
  assert.notEqual(p1(before)?.label, "Pricing pages");
  label = "Pricing pages";
  revision += 1;
  assert.equal(p1(await s.insights.list({}, s.seoOnly))?.label, "Pricing pages");
});

test("single-source: claims on exactly one visible entry in a cluster of 3 or more whose topic its peers discuss, most discussed first", async () => {
  const s = await setup();
  const seo = await s.insights.list({}, s.seoOnly);
  const clusterOf = await clusters(s, s.seoOnly);
  // Solo metric: both of R1's peers link to Retention, which it measures (2 of 2); Solo tactic: two
  // of P1's three peers link to Pricing tables (2 of 3). Every other claim on one entry is about
  // nothing its cluster discusses: Solo rule and the claims shared with the hidden entry have no
  // topic, Daily and Weekly posting only each other (in other clusters).
  assert.deepEqual(
    seo.singleSource.map((item) => [item.concept.id, item.entry.id]),
    [
      ["metric-solo3", ke("r1")],
      ["tactic-solo1", ke("p1")]
    ]
  );
  assert.deepEqual(seo.singleSource[0]!.cluster, clusterOf("r1"));
  assert.deepEqual(seo.singleSource[1]!.cluster, clusterOf("p1"));
  assert.equal(seo.totals.singleSource, 2);
  assert.deepEqual((await s.insights.list({ limit: 1 }, s.seoOnly)).singleSource.map((item) => item.concept.id), ["metric-solo3"]);
  assert.ok(!JSON.stringify(seo).includes("Secret claim"), "a hidden entry's own claim is never listed");

  // A survey entry (a synthesis) restates its sources: never the single source of a claim.
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "P note 1", kind: "synthesis" }, true);
  assert.deepEqual((await s.insights.list({}, s.seoOnly)).singleSource.map((item) => item.concept.id), ["metric-solo3"]);
});

test("single-source: never a claim another visible entry backs in other words, nor a rule; saved posts before notes", async () => {
  const s = await setup();
  // Solo rule is about Pricing tables too now: a claim of its cluster's topic, yet a rule.
  await loadGraph(
    s.graph,
    [
      node("topic-marketing", "Marketing", files("p1", "p2", "p3", "p4", "q1", "q2", "r1", "r2", "r3")),
      node("topic-pa", "Pricing tables", files("p2", "p3")),
      node("topic-ra", "Retention", files("r2", "r3")),
      node("tactic-solo1", "Solo tactic", files("p1")),
      node("rule-solo2", "Solo rule", files("p1"), { type: "rule" }),
      node("metric-solo3", "Solo metric up 20%", files("r1"), { type: "metric" }),
      node("tactic-solo1-reworded", "Solo tactic, reworded", files("q1")),
      node("metric-solo3-hidden", "Solo metric, as H says it", files("h"))
    ],
    [
      edge("t1", "tactic-solo1", "topic-pa", null, "about"),
      edge("t1r", "rule-solo2", "topic-pa", null, "about"),
      edge("t2", "metric-solo3", "topic-ra", null, "measures")
    ]
  );
  const listed = async (scope: KnowledgeScope) => (await s.insights.list({}, scope)).singleSource.map((item) => item.concept.id);
  assert.deepEqual(await listed(s.all), ["metric-solo3", "tactic-solo1"], "a rule restates a policy: never listed");

  // Q1 says Solo tactic in other words; only H (hidden from SEO) says Solo metric in other words.
  s.graph.setBackingConcepts((id) => (id === "tactic-solo1" ? ["tactic-solo1-reworded"] : id === "metric-solo3" ? ["metric-solo3-hidden"] : []));
  assert.deepEqual(await listed(s.all), [], "backed elsewhere");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3"], "a hidden entry backs nothing");

  // A saved post's claim comes before a research note's, however central the note's is.
  s.graph.setBackingConcepts(null);
  s.store.put(ke("r1"), "body r1", ["kc_seo"], { title: "R note 1", kind: "research note" }, true);
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "P note 1", kind: "post" }, true);
  assert.deepEqual(await listed(s.seoOnly), ["tactic-solo1", "metric-solo3"]);
});

test("single-source: never a claim another visible entry answers the same question of, a compound whose main step another names, or one naming its cluster's topic", async () => {
  const s = await setup();
  const load = (solo: string, extra: Record<string, unknown>[] = []) =>
    loadGraph(
      s.graph,
      [
        node("topic-marketing", "Marketing", files("p1", "p2", "p3", "p4", "q1", "q2", "r1", "r2", "r3")),
        node("topic-pa", "Pricing tables", files("p2", "p3")),
        node("topic-ra", "Retention", files("r2", "r3")),
        node("tactic-solo1", solo, files("p1")),
        node("metric-solo3", "Solo metric up 20%", files("r1"), { type: "metric" }),
        node("tactic-warm-q3", "3-5 days of warming up", files("q3")),
        node("tactic-warm-h", "Two days of warming up", files("h")),
        node("tactic-nosim-q3", "No SIM card in the phone", files("q3")),
        ...extra
      ],
      [edge("t1", "tactic-solo1", "topic-pa", null, "about"), edge("t2", "metric-solo3", "topic-ra", null, "measures")]
    );
  const listed = async (scope: KnowledgeScope) => (await s.insights.list({}, scope)).singleSource.map((item) => item.concept.id);
  await load("Warm up for 48 hours");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3", "tactic-solo1"]);
  // Concept families (or the fallback) say the 48 hours and the 3-5 days answer one question.
  s.graph.setSameQuestion((a, b) => a.id === b.id || [a.id, b.id].sort().join() === "tactic-solo1,tactic-warm-q3");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3"], "Q3 answers the same question");
  s.graph.setSameQuestion((a, b) => a.id === b.id || [a.id, b.id].sort().join() === "tactic-solo1,tactic-warm-h");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3", "tactic-solo1"], "only the hidden entry does");
  assert.deepEqual(await listed(s.all), ["metric-solo3"]);
  s.graph.setSameQuestion(null);

  // A compound: its main step said elsewhere is enough; a detail only it adds is not worth checking.
  await load("Remove the SIM card and stay on VPN 24/7");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3"], "Q3 has no SIM card either");
  await load("Stay on VPN 24/7 and remove the SIM card");
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3", "tactic-solo1"], "its main step, staying on a VPN, is its own");

  // The cluster's topic: what most of P1's cluster links to is no claim P1 makes alone.
  await load("Pricing tables for every plan", [node("topic-pricing", "Pricing tables for plans", files("p2", "p3", "p4"))]);
  assert.deepEqual(await listed(s.seoOnly), ["metric-solo3"]);
});

test("contradictions: graph and checked, checked first; a hidden entry is never on either side", async () => {
  const s = await setup();
  s.pairChecks.push({ a: ke("p1"), b: ke("p2"), verdict: "contradicts", note: "P1 says annual, P2 monthly", checkedAt: "2026-10-27T00:00:00.000Z" });
  s.pairChecks.push({ a: ke("h"), b: ke("p1"), verdict: "contradicts", note: "hidden note", checkedAt: "2026-10-27T00:00:00.000Z" });
  const seo = await s.insights.list({}, s.seoOnly);
  assert.deepEqual(seo.contradictions.map(pairOf), [
    [ke("p1"), ke("p2")],
    [ke("q2"), ke("r3")]
  ]);
  assert.deepEqual(
    seo.contradictions.map(({ similarity, source, pairs, note }) => ({ similarity, source, pairs, note })),
    [
      { similarity: 0.9025, source: "checked", pairs: [], note: "P1 says annual, P2 monthly" },
      {
        similarity: 0,
        source: "graph",
        pairs: [{ from: { id: "tactic-c1", name: "Daily posting", type: "tactic" }, to: { id: "tactic-c2", name: "Weekly posting", type: "tactic" } }],
        note: null
      }
    ]
  );
  assert.ok(!JSON.stringify(seo).includes("hidden note") && !JSON.stringify(seo).includes("Hidden disagreement"));
  const all = await s.insights.list({}, s.all);
  assert.equal(all.totals.contradictions, 4);
});

test("link gaps: very close linked entries that share no concept, `queued` from the re-linker; hidden entries never", async () => {
  const s = await setup();
  s.queued.add(`${ke("q3")} ${ke("q4")}`);
  const seo = await s.insights.list({}, s.seoOnly);
  assert.deepEqual(
    seo.gaps.map((gap) => ({ pair: pairOf(gap), similarity: gap.similarity, queued: gap.queued })),
    [{ pair: [ke("q3"), ke("q4")], similarity: 0.9025, queued: true }]
  );
  const all = await s.insights.list({}, s.all);
  assert.ok(all.gaps.some((gap) => gap.a.id === ke("h") || gap.b.id === ke("h")));
  assert.ok(!seo.gaps.some((gap) => gap.a.id === ke("h") || gap.b.id === ke("h")));
  // `queued` is read per response, not cached.
  s.queued.clear();
  assert.equal((await s.insights.list({}, s.seoOnly)).gaps[0]!.queued, false);
});

test("link gaps: once concept vectors are ready, only pairs where a claim of one is close to a claim of the other; never a survey", async () => {
  const s = await setup();
  await loadGraph(s.graph, [
    node("topic-qa", "Queues", files("q1", "q2", "q3")),
    node("topic-qb", "Queue tooling", files("q1", "q2", "q4")),
    node("tactic-retry", "Retry with backoff", files("q3")),
    node("tactic-backoff", "Back off, then retry", files("q4")),
    node("tool-redis", "Redis", files("q4"), { type: "Tool" })
  ]);
  const gaps = async () => (await s.insights.list({}, s.seoOnly)).gaps.map(pairOf);
  const close = new Map<string, string[]>();
  s.graph.setSimilarConcepts((id) => (close.get(id) ?? []).map((other) => ({ id: other, similarity: 0.95 })));
  s.graph.setBackingConcepts(() => [], () => true);
  assert.deepEqual(await gaps(), [], "close in meaning, no claim of theirs close: no gap");
  close.set("tool-redis", ["tactic-retry"]);
  s.graph.backingMoved(); // as a complete vector computation announces
  assert.deepEqual(await gaps(), [], "only claims count");
  close.set("tactic-retry", ["tactic-backoff"]);
  s.graph.backingMoved();
  assert.deepEqual(await gaps(), [[ke("q3"), ke("q4")]]);
  s.store.put(ke("q3"), "body q3", ["kc_seo"], { title: "Q note 3", kind: "synthesis" }, true);
  assert.deepEqual(await gaps(), [], "a survey is never a side");
});

test("limit applies to every list after totals are counted; a pair-check change or a narrower scope is computed anew", async () => {
  const s = await setup();
  const full = await s.insights.list({}, s.all);
  const one = await s.insights.list({ limit: 1 }, s.all);
  assert.deepEqual(one.totals, full.totals);
  for (const list of ["contradictions", "bridges", "singleSource", "gaps"] as const) assert.equal(one[list].length, Math.min(1, full.totals[list]));
  assert.ok(full.totals.singleSource > 1 && full.totals.contradictions > 1);

  const before = await s.insights.list({}, s.seoOnly);
  s.pairChecks.push({ a: ke("q2"), b: ke("r3"), verdict: "consistent", note: null, checkedAt: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(await s.insights.list({}, s.seoOnly), before, "cached until the pair checks' revision moves");
  s.checksChanged();
  assert.equal((await s.insights.list({}, s.seoOnly)).totals.contradictions, before.totals.contradictions - 1);

  const narrowed = await s.insights.list({}, s.scope({ kind: "all" }, ["kc_ads"]));
  assert.deepEqual(narrowed, { contradictions: [], bridges: [], singleSource: [], gaps: [], totals: { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 } });
});

test("without vectors or concepts: contradictions and checks still count, the rest is empty", async () => {
  const s = await setup();
  s.index.model = null;
  const result: KnowledgeInsightsResponse = await s.insights.list({}, s.seoOnly);
  assert.deepEqual(result.contradictions.map(pairOf), [[ke("q2"), ke("r3")]]);
  assert.equal(result.contradictions[0]!.similarity, null);
  assert.deepEqual([result.bridges, result.singleSource, result.gaps], [[], [], []]);
  await loadGraph(s.graph, []);
  s.index.model = "fake/model";
  assert.deepEqual((await s.insights.list({}, s.seoOnly)).totals, { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 });
});

test("concept merges into a hidden concept never name it: insights, clusters, similar entries and novelty", async () => {
  const s = await setup();
  // Both kept concepts come from the hidden entry only; the visible ones are folded into them.
  s.graph.setConceptMerges([
    { id: "cm_solo", type: "tactic", into: "tactic-secret", merged: ["tactic-solo1"], similarity: 0.95, createdAt: "2026-10-27T10:00:00.000Z" },
    { id: "cm_weekly", type: "tactic", into: "tactic-cs", merged: ["tactic-c2"], similarity: 0.95, createdAt: "2026-10-27T10:00:00.000Z" }
  ]);
  const leaks = /Secret claim|Hidden disagreement|tactic-secret|tactic-cs/;
  const seo = await s.insights.list({}, s.seoOnly);
  assert.doesNotMatch(JSON.stringify(seo), leaks);
  // x2 (no provenance) is visible now that both its ends are; it shows the visible concept's name.
  assert.deepEqual(seo.contradictions.find((c) => c.a.id === ke("q2"))?.pairs, [
    { from: { id: "tactic-c1", name: "Daily posting", type: "tactic" }, to: { id: "tactic-c2", name: "Weekly posting", type: "tactic" } },
    { from: { id: "tactic-c2", name: "Weekly posting", type: "tactic" }, to: { id: "tactic-c1", name: "Daily posting", type: "tactic" } }
  ]);
  assert.ok(JSON.stringify(seo.singleSource).includes("Solo tactic"));
  assert.doesNotMatch(JSON.stringify(await s.similarity.graph({ limit: 2_000 }, s.seoOnly)), leaks);
  assert.doesNotMatch(JSON.stringify(s.similarity.forEntry(ke("p1"), s.seoOnly)), leaks);
  const novelty = s.similarity.novelty(ke("p1"), s.seoOnly);
  assert.doesNotMatch(JSON.stringify(novelty), leaks);
  assert.ok(novelty?.newConcepts.some((c) => c.id === "tactic-solo1" && c.name === "Solo tactic"));
  // Everything visible: the kept concepts as they are.
  assert.match(JSON.stringify(await s.insights.list({}, s.all)), /Hidden disagreement/);
});

test("conceptCentrality: the share of an entry's concepts that are the concept or its neighbours", () => {
  const neighbours = (id: string) => (id === "tactic-warm-up" ? ["tool-proxy", "channel-tiktok", "tool-elsewhere"] : []);
  const post = new Set(["tactic-warm-up", "tool-proxy", "channel-tiktok", "topic-other"]);
  assert.equal(conceptCentrality("tactic-warm-up", post, neighbours), 3 / 4);
  const guide = new Set(["tactic-warm-up", ...Array.from({ length: 99 }, (_, i) => `topic-${i}`)]);
  assert.equal(conceptCentrality("tactic-warm-up", guide, neighbours), 1 / 100, "a side remark of a long guide");
  assert.equal(conceptCentrality("tactic-warm-up", new Set(), neighbours), 0);
});

test("bridges: a named example (a product, an app) ties nothing, nor one rule or a figureless result; advice or a result with a figure does", async () => {
  const s = await setup();
  const bridges = async () => (await s.insights.list({}, s.seoOnly)).bridges.map((b) => [b.entry.id, b.concepts.map((c) => c.id)]);
  const reload = (extra: Record<string, unknown>[]) =>
    loadGraph(s.graph, [node("topic-marketing", "Marketing", files("p1", "p2", "p3", "p4", "q1", "q2", "r1", "r2", "r3")), node("tactic-bq", "Bridge to Q", files("p1", "q1")), ...extra]);
  for (const weak of [
    node("product-app", "Penelope's pregnancy app", files("p1", "r1"), { type: "Product" }),
    node("app-x", "Some tracker app", files("p1", "r1"), { type: "App" }),
    node("rule-gating", "Custom review prompts / review gating prohibited", files("p1", "r1"), { type: "Rule" }),
    node("result-views", "Views on a new IG account", files("p1", "r1"), { type: "Result" })
  ]) {
    await reload([weak]);
    assert.deepEqual(await bridges(), [], String(weak.id));
  }
  await reload([node("result-figure", "1.3M views on a new IG account", files("p1", "r1"), { type: "Result" })]);
  assert.deepEqual(await bridges(), [[ke("p1"), ["tactic-bq", "result-figure"]]]);
  // Two weak ones together still tie a cluster.
  await reload([node("rule-gating", "Review gating prohibited", files("p1", "r1"), { type: "Rule" }), node("tool-sdk", "Review SDK", files("p1", "r1"), { type: "Tool" })]);
  assert.deepEqual(await bridges(), [[ke("p1"), ["tactic-bq", "rule-gating", "tool-sdk"]]]);
});

test("contradictions that make the same point against one entry are shown once, the others as `also`", async () => {
  const s = await setup();
  const at = "2026-10-27T00:00:00.000Z";
  s.pairChecks.push({ a: ke("p1"), b: ke("q2"), verdict: "contradicts", note: "P1 claims a self-hosted Hetzner VPS makes TikTok see a normal home user. Q2 claims such an IP is labelled datacenter by IP vendors.", checkedAt: at });
  s.pairChecks.push({ a: ke("p1"), b: ke("r3"), verdict: "contradicts", note: "R3 says a residential IP beats a datacenter one. P1 says a self-hosted Hetzner VPS makes TikTok see a normal home user.", checkedAt: at });
  s.pairChecks.push({ a: ke("p1"), b: ke("q1"), verdict: "contradicts", note: "P1 says to post daily; Q1 says weekly is enough.", checkedAt: at });
  s.checksChanged();
  const seo = await s.insights.list({}, s.seoOnly);
  const p1s = seo.contradictions.filter((item) => item.a.id === ke("p1") || item.b.id === ke("p1"));
  assert.deepEqual(
    p1s.map((item) => [pairOf(item), (item.also ?? []).map((entry) => entry.id)]),
    [
      [[ke("p1"), ke("q1")], []],
      [[ke("p1"), ke("q2")], [ke("r3")]]
    ]
  );
  assert.deepEqual(
    p1s.map((item) => item.alsoJoins && [item.alsoJoins.a.map((e) => e.id), item.alsoJoins.b.map((e) => e.id)]),
    [undefined, [[], [ke("r3")]]],
    "R3 makes Q2's point against P1: it joins Q2's side"
  );
  assert.equal(seo.totals.contradictions, seo.contradictions.length, "counted once");
  // Unit: one side in common, and the same note words or a concept pair in common.
  const pair = { from: { id: "c1", name: "C1", type: "Tactic" }, to: { id: "c2", name: "C2", type: "Tactic" } };
  const none = () => null;
  assert.equal(samePoint({ a: "x", b: "y", pairs: [pair], note: null }, { a: "x", b: "z", pairs: [{ from: pair.to, to: pair.from }], note: null }, none), true, "the same concept pair, either way round");
  assert.equal(samePoint({ a: "x", b: "y", pairs: [pair], note: null }, { a: "w", b: "z", pairs: [pair], note: null }, none), false, "no side in common");
  assert.equal(samePoint({ a: "x", b: "y", pairs: [], note: "x says daily" }, { a: "x", b: "z", pairs: [], note: null }, none), false);
});

test("`also` lists an entry once per side it joins, though it makes the same point against the pair twice", async () => {
  const s = await setup();
  const at = "2026-10-27T00:00:00.000Z";
  const pair = (a: string, b: string) => [ke(a), ke(b)].sort() as [string, string];
  const check = (a: string, b: string, note: string) => {
    const [x, y] = pair(a, b);
    s.pairChecks.push({ a: x, b: y, verdict: "contradicts", note, checkedAt: at });
  };
  // P1, Q2 and Q3 each give their own accounts per device and warm-up length: every pair disagrees on
  // that one point, so each entry makes it against both others.
  const note = "Each gives its own number of accounts per device (2-3, one, five) and its own warm-up length (1-2 days, a few days, 3 days).";
  check("p1", "q2", note);
  check("q3", "p1", note);
  check("q3", "q2", note);
  s.checksChanged();
  const seo = await s.insights.list({}, s.seoOnly);
  const three = new Set([ke("p1"), ke("q2"), ke("q3")]);
  const ours = seo.contradictions.filter((item) => three.has(item.a.id) && three.has(item.b.id));
  assert.equal(ours.length, 1, "the three checks make one point: folded into the first");
  const [top] = ours;
  const third = [ke("p1"), ke("q2"), ke("q3")].find((id) => !pairOf(top!).includes(id))!;
  assert.deepEqual(top!.also!.map((e) => e.id), [third], "the third entry once");
  // It disagrees with each side of the pair: it joins each one, against the other.
  assert.deepEqual([top!.alsoJoins!.a.map((e) => e.id), top!.alsoJoins!.b.map((e) => e.id)], [[third], [third]]);
});

test("single-source: never the entry's own title restated, a metric that states nothing, or a figure another visible entry states", async () => {
  const s = await setup();
  const listed = async () => (await s.insights.list({}, s.seoOnly)).singleSource.map((item) => item.concept.id);
  assert.deepEqual(await listed(), ["metric-solo3", "tactic-solo1"]);
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "The solo tactic, explained" }, true);
  assert.deepEqual(await listed(), ["metric-solo3"], "Solo tactic restates P1's title");
  s.store.put(ke("p1"), "body p1", ["kc_seo"], { title: "P note 1" }, true);
  s.stated.set("Solo metric up 20%", [ke("r1"), ke("q3")]);
  assert.deepEqual(await listed(), ["tactic-solo1"], "Q3's text states the figure");
  s.stated.set("Solo metric up 20%", [ke("r1"), ke("h")]);
  s.checksChanged();
  assert.deepEqual(await listed(), ["metric-solo3", "tactic-solo1"], "a hidden entry states nothing");

  assert.equal(statesNoClaim({ name: "Payment conversion rate", type: "Metric" }), true);
  assert.equal(statesNoClaim({ name: "Payment conversion up 20%", type: "Metric" }), false);
  assert.equal(statesNoClaim({ name: "Churn lower on annual plans", type: "Metric" }), false);
  assert.equal(statesNoClaim({ name: "Payment conversion rate", type: "Result" }), false, "metrics only");
  assert.equal(namesTopic("Start an app from zero with $300 using used iPhones and TikTok accounts", "Starting an app from zero with $300: 3 used iPhones × 5 TikTok accounts"), true);
  assert.equal(namesTopic("Making a US-based TikTok account", "How to create a US TikTok account and target only the US (7 steps)"), true);
  assert.equal(namesTopic("Get keywords from 1-2 star reviews", "SEO playbook for mobile app founders"), false);
});
