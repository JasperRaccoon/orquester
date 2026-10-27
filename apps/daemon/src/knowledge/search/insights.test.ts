import assert from "node:assert/strict";
import { test } from "node:test";

import { knowledgeCitation, type KnowledgeEntryMeta, type KnowledgeInsightsResponse, type KnowledgeVisibility } from "@orquester/api";
import type { KnowledgePairCheck } from "../ports.ts";
import { FakeVectorIndex, around } from "./fake-vector-index.ts";
import { KnowledgeGraph } from "./graph.ts";
import { KnowledgeInsights } from "./insights.ts";
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
  const summary = (meta: KnowledgeEntryMeta, scope: KnowledgeScope) => ({
    ...meta,
    collections: visibleCollections(meta, scope),
    snippet: "",
    linkCount: graph.linkCount(meta.id),
    citation: knowledgeCitation(meta)
  });
  const port = () => ({ all: () => pairChecks, get: () => null, onChange: () => () => undefined });
  const similarity = new KnowledgeSimilarity({ store, graph, index: () => index, summary, pairChecks: port, pairChecksRevision: () => checksRevision });
  const insights = new KnowledgeInsights({
    store,
    graph,
    similarity,
    index: () => index,
    summary,
    pairChecks: port,
    pairChecksRevision: () => checksRevision,
    linkGapQueued: (a, b) => queued.has(`${a} ${b}`)
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
      node("tactic-solo1", "Solo tactic", files("p1")),
      node("rule-solo2", "Solo rule", files("p1"), { type: "rule" }),
      node("metric-solo3", "Solo metric", files("r1"), { type: "metric" }),
      node("topic-solo", "Solo topic", files("q1")),
      node("tactic-secret", "Secret claim", files("h")),
      node("tactic-hidshare", "Shared with H", files("p2", "h")),
      // Contradictions.
      node("tactic-c1", "Daily posting", files("q2")),
      node("tactic-c2", "Weekly posting", files("r3")),
      node("tactic-cs", "Hidden disagreement", files("h"))
    ],
    [edge("x1", "tactic-c1", "tactic-c2", null, "contradicts"), edge("x2", "tactic-cs", "tactic-c1", null, "contradicts")]
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

test("single-source: claims on exactly one visible entry in a cluster of 3 or more, one per entry in turn", async () => {
  const s = await setup();
  const seo = await s.insights.list({}, s.seoOnly);
  const clusterOf = await clusters(s, s.seoOnly);
  // Entries in the clusters of four (P, Q) before R's, newest first; P1's second claim on the next
  // turn. The claims shared with the hidden entry are unbacked as far as this chat sees.
  assert.deepEqual(
    seo.singleSource.map((item) => [item.concept.id, item.entry.id]),
    [
      ["tactic-c1", ke("q2")],
      ["tactic-p4h", ke("p4")],
      ["tactic-hidshare", ke("p2")],
      ["tactic-solo1", ke("p1")],
      ["tactic-c2", ke("r3")],
      ["metric-solo3", ke("r1")],
      ["rule-solo2", ke("p1")]
    ]
  );
  assert.deepEqual(seo.singleSource[0]!.cluster, clusterOf("q2"));
  assert.deepEqual(seo.singleSource[4]!.cluster, clusterOf("r3"));
  assert.equal(seo.totals.singleSource, 7);
  assert.deepEqual((await s.insights.list({ limit: 2 }, s.seoOnly)).singleSource.map((item) => item.concept.id), ["tactic-c1", "tactic-p4h"]);
  assert.ok(!JSON.stringify(seo).includes("Secret claim"), "a hidden entry's own claim is never listed");
  assert.ok(!seo.singleSource.some((item) => item.concept.id === "topic-solo"), "not a claim");

  const all = await s.insights.list({}, s.all);
  const ids = all.singleSource.map((item) => item.concept.id);
  assert.ok(ids.includes("tactic-secret") && !ids.includes("tactic-hidshare") && !ids.includes("tactic-p4h"));
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
