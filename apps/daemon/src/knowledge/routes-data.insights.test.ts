import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions, type LightMyRequestResponse } from "fastify";
import {
  knowledgeRoutes,
  type KnowledgeEntryDetail,
  type KnowledgeInsightsResponse,
  type KnowledgeSaveResponse,
  type KnowledgeSimilarityGraphResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import { knowledgeIndexDir } from "@orquester/config";
import type { KnowledgePairCheck, KnowledgePairChecksPort } from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import type { KnowledgeEmbedder } from "./search/embedder.ts";
import { around, axis } from "./search/fake-vector-index.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { FakeEmbedderSource, edge, loadGraph, node, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeStore } from "./store/store.ts";

// The phase 2 W3 routes: GET /insights (scoped like the similarity graph), `novelty` on entry
// details and `cluster` on save results, over the real store, index and graph with controlled
// embeddings (minimum 0.3, good 0.5, strong 0.7, duplicate 0.9).

const DIMS = 16;
/** Title → vector of every entry the tests save. */
const VECTORS: Record<string, number[]> = {
  "Alternatives pages": axis(DIMS, 0),
  "Annual billing": around(DIMS, 0, 1, 0.95),
  "Comparison pages": around(DIMS, 0, 2, 0.92),
  Unrelated: axis(DIMS, 3),
  "New alternatives": around(DIMS, 0, 4, 0.99)
};

async function harness(t: TestContext, options: { index?: boolean } = {}) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-routes-insights-"));
  const logger = silentLogger();
  const store = await KnowledgeStore.open({ appdir, logger });
  const graph = new KnowledgeGraph({ entries: store, logger });
  const embedder: KnowledgeEmbedder | null =
    options.index === false
      ? null
      : {
          modelId: "insights-route-fixture",
          dimensions: DIMS,
          thresholds: { minimum: 0.3, good: 0.5, strong: 0.7, duplicate: 0.9 },
          async embed(texts) {
            const titles = Object.keys(VECTORS).sort((a, b) => b.length - a.length);
            return texts.map((text) => {
              const title = titles.find((candidate) => text.startsWith(candidate));
              assert.ok(title, `Unexpected fixture passage: ${text}`);
              return new Float32Array(VECTORS[title]!);
            });
          }
        };
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir: knowledgeIndexDir(appdir), logger });
  await search.start();
  const state = { enabled: true, visibilities: new Map<string, KnowledgeVisibility>() };
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    const agent = request.headers["x-test-agent"];
    if (typeof agent === "string") (request as unknown as { principal: unknown }).principal = { kind: "agent", threadId: agent, projectPath: "" };
  });
  registerKnowledgeDataRoutes(app, {
    store,
    search,
    settings: { enabled: () => state.enabled },
    visibility: { forSession: async (id) => (id && state.visibilities.get(id)) || { kind: "all" } },
    linking: { status: () => ({ state: "idle" }) },
    publisher: { publish: () => undefined },
    profilesForCollection: async () => new Map(),
    logger
  });
  t.after(async () => {
    await app.close();
    await search.stop();
    await store.idle();
    await rm(appdir, { recursive: true, force: true });
  });
  return { store, graph, search, state, inject: (request: InjectOptions) => app.inject(request) };
}

function ok<T>(response: LightMyRequestResponse, status = 200): T {
  assert.equal(response.statusCode, status, response.body);
  return response.json() as T;
}

function refused(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, response.body);
  assert.equal((response.json() as { code: string }).code, code);
}

type Harness = Awaited<ReturnType<typeof harness>>;

/**
 * Alternatives (SEO), Annual billing (SaaS, hidden from "seo-chat"), Comparison (SEO + SaaS),
 * Unrelated (SEO); each with a claim of its own, Annual billing's contradicting Comparison's.
 * Alternatives' claim is about pricing, which both other entries of its cluster discuss.
 */
async function seed(h: Harness) {
  const save = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: {
        entries: [
          { body: "One page per competitor.", title: "Alternatives pages", collections: ["SEO"] },
          { body: "Annual plans lift cash flow.", title: "Annual billing", collections: ["SaaS"] },
          { body: "Comparison tables convert.", title: "Comparison pages", collections: ["SEO", "SaaS"] },
          { body: "A recipe for sourdough bread.", title: "Unrelated", collections: ["SEO"] }
        ],
        newCollections: [
          { name: "SEO", description: "Search engines" },
          { name: "SaaS", description: "Running SaaS" }
        ]
      }
    })
  );
  const [seo, saas] = save.createdCollections;
  h.state.visibilities.set("seo-chat", { kind: "collections", ids: [seo!.id] });
  const [alt, billing, comparison, unrelated] = save.results.map((r) => r.entryId) as [string, string, string, string];
  await loadGraph(
    h.graph,
    [
      node("tactic-solo", "One page per competitor", [`${alt}.md`]),
      node("tactic-annual", "Bill annually", [`${billing}.md`]),
      node("tactic-monthly", "Bill monthly", [`${comparison}.md`]),
      node("topic-pricing", "Pricing", [`${billing}.md`, `${comparison}.md`])
    ],
    [edge("x1", "tactic-annual", "tactic-monthly", null, "contradicts"), edge("t1", "tactic-solo", "topic-pricing", null, "about")]
  );
  return { save, seo: seo!, saas: saas!, alt, billing, comparison, unrelated };
}

const pair = (item: { a: { id: string }; b: { id: string } }) => [item.a.id, item.b.id].sort();

test("GET /insights: every list with totals before the limit, scoped to the caller and narrowed by collections", async (t) => {
  const h = await harness(t);
  const { saas, alt, billing, comparison } = await seed(h);
  const all = ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.insights }));
  // Billing and Comparison share Pricing; Alternatives shares nothing with either (two gaps). The
  // claims about nothing their cluster discusses are not listed: only Alternatives' is.
  assert.deepEqual(all.totals, { contradictions: 1, bridges: 0, singleSource: 1, gaps: 2 });
  assert.deepEqual(all.contradictions.map(pair), [[billing, comparison].sort()]);
  assert.equal(all.contradictions[0]!.source, "graph");
  assert.deepEqual(all.singleSource.map((item) => item.concept.id), ["tactic-solo"]);
  assert.ok(all.singleSource.every((item) => item.cluster?.size === 3));
  assert.deepEqual(all.gaps.map((gap) => gap.queued), [false, false]);

  const one = ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?limit=1` }));
  assert.deepEqual(one.totals, all.totals);
  assert.deepEqual([one.contradictions.length, one.bridges.length, one.singleSource.length, one.gaps.length], [1, 0, 1, 1]);

  // A profile chat, by sessionId or as an agent principal: Annual billing and its claim are gone.
  for (const request of [
    { method: "GET" as const, url: `${knowledgeRoutes.insights}?sessionId=seo-chat` },
    { method: "GET" as const, url: knowledgeRoutes.insights, headers: { "x-test-agent": "seo-chat" } }
  ]) {
    const scoped = ok<KnowledgeInsightsResponse>(await h.inject(request));
    assert.deepEqual(scoped.totals, { contradictions: 0, bridges: 0, singleSource: 0, gaps: 1 }, "a cluster of two backs nothing alone");
    assert.deepEqual(scoped.gaps.map(pair), [[alt, comparison].sort()]);
    assert.ok(!JSON.stringify(scoped).includes(billing) && !JSON.stringify(scoped).includes("Bill annually"));
  }

  const narrowed = ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?collections=${saas.id}` }));
  assert.deepEqual(narrowed.contradictions.map(pair), [[billing, comparison].sort()]);
  const unfiled = ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?collections=unfiled` }));
  assert.deepEqual(unfiled.totals, { contradictions: 0, bridges: 0, singleSource: 0, gaps: 0 });
});

test("GET /insights refusals: bad limits are KNOWLEDGE_INVALID; unknown or hidden collections; the plugin gate", async (t) => {
  const h = await harness(t);
  const { saas } = await seed(h);
  for (const bad of ["limit=0", "limit=51", "limit=abc", "limit=1.5"]) {
    refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?${bad}` }), 400, "KNOWLEDGE_INVALID");
  }
  ok(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?limit=50` }));
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?collections=nope` }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.insights}?collections=${saas.id}&sessionId=seo-chat` }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  refused(await h.inject({ method: "GET", url: knowledgeRoutes.insights, headers: { "x-test-agent": "seo-chat" }, query: { collections: "unfiled" } }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  h.state.enabled = false;
  refused(await h.inject({ method: "GET", url: knowledgeRoutes.insights }), 409, "KNOWLEDGE_DISABLED");
});

test("GET /insights: linking's pair checks and re-link queue, connected through the search; a pair-check change recomputes", async (t) => {
  const h = await harness(t);
  const { alt, comparison } = await seed(h);
  const checks: KnowledgePairCheck[] = [];
  const listeners = new Set<() => void>();
  const port: KnowledgePairChecksPort = {
    all: () => checks,
    get: (a, b) => checks.find((c) => c.a === a && c.b === b) ?? null,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  const [a, b] = [alt, comparison].sort() as [string, string];
  h.search.connectLinking({ pairChecks: port, linkGapQueued: (x, y) => x === a && y === b });
  const get = async () => ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.insights }));
  const before = await get();
  assert.equal(before.totals.contradictions, 1);
  assert.deepEqual(before.gaps.filter((gap) => gap.queued).map(pair), [[a, b]]);

  checks.push({ a, b, verdict: "contradicts", note: "Alternatives say one page each; Comparison says one table", checkedAt: "2026-10-27T00:00:00.000Z" });
  assert.deepEqual(await get(), before, "cached until linking says the checks changed");
  for (const listener of listeners) listener();
  const after = await get();
  assert.equal(after.totals.contradictions, 2);
  assert.deepEqual(after.contradictions[0], { ...after.contradictions[0]!, source: "checked", pairs: [], note: "Alternatives say one page each; Comparison says one table" });
  assert.deepEqual(pair(after.contradictions[0]!), [a, b]);

  // The entry panel and the similarity graph read the same checks.
  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.equal(detail.similar!.find((s) => s.entry.id === comparison)!.reasons[0]!.kind, "contradicts");
  const graph = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.similarityGraph }));
  assert.ok(graph.edges.find((e) => [e.from, e.to].sort().join() === [a, b].join())!.contradicts);

  // Disconnected (as on stop): no checks, nothing queued.
  h.search.connectLinking({});
  const disconnected = await get();
  assert.equal(disconnected.totals.contradictions, 1);
  assert.ok(disconnected.gaps.every((gap) => !gap.queued));
});

test("entry details carry novelty; a save names the cluster it joins from a graph already drawn, else one is drawn in the background", async (t) => {
  const h = await harness(t);
  const { save, alt, unrelated } = await seed(h);
  assert.ok(save.results.every((result) => result.cluster === null), "no graph drawn yet: the save does not wait for one");
  // The save started drawing one: the next reads have it.
  await h.search.similarity.idle();
  const graph = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.similarityGraph }));
  const drawn = graph.clusters[graph.nodes.find((n) => n.id === alt)!.cluster]!;
  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.deepEqual(detail.novelty, { newConcepts: [{ id: "tactic-solo", name: "One page per competitor", type: "tactic" }], cluster: { label: drawn.label, size: drawn.size } });
  assert.equal(ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(unrelated) })).novelty!.cluster, null);

  const later = ok<KnowledgeSaveResponse>(
    await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: "Write one alternatives page per rival.", title: "New alternatives", collections: ["SEO"] }] } })
  );
  assert.equal(later.results[0]!.status, "saved");
  assert.deepEqual(later.results[0]!.cluster, { label: drawn.label, size: drawn.size });
});

test("without an embedding model: no novelty, save cluster null, insights from the concept graph only", async (t) => {
  const h = await harness(t, { index: false });
  const { alt, billing, comparison } = await seed(h);
  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.equal(detail.novelty, undefined);
  const save = ok<KnowledgeSaveResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: "Something new.", collections: ["SEO"] }] } }));
  assert.equal(save.results[0]!.cluster, null);
  const insights = ok<KnowledgeInsightsResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.insights }));
  assert.deepEqual(insights.totals, { contradictions: 1, bridges: 0, singleSource: 0, gaps: 0 });
  assert.deepEqual(insights.contradictions.map(pair), [[billing, comparison].sort()]);
  assert.equal(insights.contradictions[0]!.similarity, null);
});
