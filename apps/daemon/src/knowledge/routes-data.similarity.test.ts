import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions, type LightMyRequestResponse } from "fastify";
import {
  KNOWLEDGE_FILTER_MAX_VALUES,
  knowledgeRoutes,
  type KnowledgeEntryDetail,
  type KnowledgeFacetsResponse,
  type KnowledgeItemResponse,
  type KnowledgeSaveResponse,
  type KnowledgeSimilarityGraphResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import { knowledgeIndexDir } from "@orquester/config";
import type { KnowledgeVectorIndex } from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { FakeVectorIndex, around, axis } from "./search/fake-vector-index.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { FakeEmbedder, FakeEmbedderSource, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeStore } from "./store/store.ts";

// The retrieval routes of the D2 stream: POST /facets, GET /similarity-graph, `similar` and
// `possibleDuplicates` on entry details, and `similar` on save results. Vectors come from a fake
// index (thresholds: good 0.5, duplicate 0.9) that embeds each saved entry by its title.

const DIMS = 16;
/** Title → vector of every entry the tests save. */
const VECTORS: Record<string, number[]> = {
  "Alternatives pages": axis(DIMS, 0),
  "Annual billing": around(DIMS, 0, 1, 0.95),
  "Comparison pages": around(DIMS, 0, 2, 0.92),
  Unrelated: axis(DIMS, 3),
  "New alternatives": around(DIMS, 0, 4, 0.99),
  "New alternatives twin": around(DIMS, 0, 5, 0.995)
};

async function harness(t: TestContext, options: { index?: boolean } = {}) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-routes-similarity-"));
  const logger = silentLogger();
  const store = await KnowledgeStore.open({ appdir, logger });
  const graph = new KnowledgeGraph({ entries: store, logger });
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(new FakeEmbedder()), indexDir: knowledgeIndexDir(appdir), logger });
  const index = new FakeVectorIndex();
  if (options.index !== false) {
    (search as unknown as { similarityIndex: () => KnowledgeVectorIndex }).similarityIndex = () => index;
    // Embedded as soon as the store adds them (before the save route reads similarity).
    store.onChange((change) => {
      if (change.kind !== "added") return;
      for (const id of change.entryIds) {
        const vector = VECTORS[store.getMeta(id)!.title];
        if (vector) index.set(id, vector);
      }
    });
  }
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
  return { store, search, index, state, inject: (request: InjectOptions) => app.inject(request) };
}

function ok<T>(response: LightMyRequestResponse, status = 200): T {
  assert.equal(response.statusCode, status, response.body);
  return response.json() as T;
}

function refused(response: LightMyRequestResponse, status: number, code: string): string {
  assert.equal(response.statusCode, status, response.body);
  const body = response.json() as { code: string; message: string };
  assert.equal(body.code, code);
  assert.ok(typeof body.message === "string" && body.message.length > 0);
  return body.message;
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Alternatives (SEO), Annual billing (SaaS, hidden from "seo-chat"), Comparison (SEO + SaaS), Unrelated (SEO). */
async function seed(h: Harness) {
  const save = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: {
        entries: [
          { body: "One page per competitor, [competitor] vs [you].", title: "Alternatives pages", kind: "thread", handle: "hridoy", author: "Hridoy", postedAt: "2025-02-01", collections: ["SEO"] },
          { body: "Annual plans lift cash flow; Stripe handles proration.", title: "Annual billing", kind: "article", author: "Jane", collections: ["SaaS"] },
          { body: "Comparison tables convert visitors who are already deciding.", title: "Comparison pages", kind: "Thread", handle: "hridoy", collections: ["SEO", "SaaS"] },
          { body: "A recipe for sourdough bread with a long cold proof.", title: "Unrelated", kind: "note", collections: ["SEO"] }
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
  const [alt, billing, comparison, unrelated] = save.results.map((r) => r.entryId);
  return { save, seo: seo!, saas: saas!, alt: alt!, billing: billing!, comparison: comparison!, unrelated: unrelated! };
}

test("POST /facets counts what the caller sees, narrowed by collections and filters", async (t) => {
  const h = await harness(t);
  const { seo, saas } = await seed(h);
  const all = ok<KnowledgeFacetsResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: {} }));
  assert.equal(all.total, 4);
  assert.deepEqual(all.facets.kinds, [
    { value: "thread", label: "thread", count: 2 },
    { value: "article", label: "article", count: 1 },
    { value: "note", label: "note", count: 1 }
  ]);
  assert.deepEqual(all.facets.authors, [
    { value: "hridoy", label: "Hridoy (@hridoy)", count: 2 },
    { value: "Jane", label: "Jane", count: 1 }
  ]);
  assert.deepEqual(all.facets.collections, [
    { value: seo.id, label: "SEO", count: 3 },
    { value: saas.id, label: "SaaS", count: 2 }
  ]);
  assert.equal(all.facets.years[0]!.count + (all.facets.years[1]?.count ?? 0), 4);

  // A profile chat, by sessionId or as an agent principal: SaaS-only entries and labels are gone.
  for (const request of [
    { method: "POST" as const, url: knowledgeRoutes.facets, payload: { sessionId: "seo-chat" } },
    { method: "POST" as const, url: knowledgeRoutes.facets, payload: {}, headers: { "x-test-agent": "seo-chat" } }
  ]) {
    const scoped = ok<KnowledgeFacetsResponse>(await h.inject(request));
    assert.equal(scoped.total, 3);
    assert.deepEqual(scoped.facets.collections, [{ value: seo.id, label: "SEO", count: 3 }]);
    assert.ok(!scoped.facets.authors.some((a) => a.value === "Jane"));
  }

  const articles = ok<KnowledgeFacetsResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: { filters: { kinds: ["Article"] } } }));
  assert.equal(articles.total, 1);
  const byAuthor = ok<KnowledgeFacetsResponse>(
    await h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: { filters: { authors: ["@Hridoy"], postedAfter: "2025-01-01" } } })
  );
  assert.equal(byAuthor.total, 1);
  const saasOnly = ok<KnowledgeFacetsResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: { collections: ["SaaS"], filters: null } }));
  assert.equal(saasOnly.total, 2);
  const unfiled = ok<KnowledgeFacetsResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: { collections: ["unfiled"] } }));
  assert.equal(unfiled.total, 0);
});

test("POST /facets refusals: bad shapes and filters are KNOWLEDGE_INVALID; hidden collections are unknown; the plugin gate", async (t) => {
  const h = await harness(t);
  await seed(h);
  const post = (payload: unknown, headers?: Record<string, string>) => h.inject({ method: "POST", url: knowledgeRoutes.facets, payload: payload as object, headers });
  refused(await post({ filters: { kinds: "thread" } }), 400, "KNOWLEDGE_INVALID");
  refused(await post({ collections: "SEO" }), 400, "KNOWLEDGE_INVALID");
  refused(await post({ filters: { years: ["20x6"] } }), 400, "KNOWLEDGE_INVALID");
  refused(await post({ filters: { postedAfter: "yesterday" } }), 400, "KNOWLEDGE_INVALID");
  refused(await post({ filters: { kinds: Array.from({ length: KNOWLEDGE_FILTER_MAX_VALUES + 1 }, (_, i) => `k${i}`) } }), 400, "KNOWLEDGE_INVALID");
  refused(await post({ collections: ["Marketing"] }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  const hidden = refused(await post({ collections: ["SaaS"] }, { "x-test-agent": "seo-chat" }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  assert.doesNotMatch(hidden, /Collections:.*SaaS/, "the refusal lists only visible collections");
  refused(await post({ collections: ["unfiled"], sessionId: "seo-chat" }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  h.state.enabled = false;
  refused(await post({}), 409, "KNOWLEDGE_DISABLED");
});

test("entry details carry similar entries and possible duplicates, scoped to the caller", async (t) => {
  const h = await harness(t);
  const { alt, billing, comparison, unrelated } = await seed(h);
  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.deepEqual(detail.similar!.map((s) => s.entry.id), [billing, comparison]);
  assert.deepEqual(detail.similar![0]!.reasons, [{ kind: "meaning", similarity: 0.95 }]);
  assert.deepEqual(detail.similar![1]!.reasons, [
    { kind: "meaning", similarity: 0.92 },
    { kind: "author", value: "hridoy" }
  ]);
  assert.deepEqual(detail.possibleDuplicates!.map((s) => [s.entry.id, s.similarity]), [
    [billing, 0.95],
    [comparison, 0.92]
  ]);
  assert.ok(!detail.similar!.some((s) => s.entry.id === unrelated || s.entry.id === alt));

  const scoped = ok<KnowledgeItemResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.item(alt), headers: { "x-test-agent": "seo-chat" } }));
  assert.equal(scoped.kind, "entry");
  if (scoped.kind === "entry") {
    assert.deepEqual(scoped.entry.similar!.map((s) => s.entry.id), [comparison]);
    assert.deepEqual(scoped.entry.possibleDuplicates!.map((s) => s.entry.id), [comparison]);
    assert.ok(!JSON.stringify(scoped.entry.similar).includes("Annual billing"));
  }
});

test("save: each saved entry lists visible near-duplicates outside the same save; duplicates of the request carry none", async (t) => {
  const h = await harness(t);
  const { alt, billing, comparison } = await seed(h);
  const batch = {
    entries: [
      { body: "Alternatives pages rank for competitor names with buyer intent.", title: "New alternatives", collections: ["SEO"] },
      { body: "Every competitor deserves its own alternatives page, honestly written.", title: "New alternatives twin", collections: ["SEO"] },
      { body: "One page per competitor, [competitor] vs [you].", collections: ["SEO"] }
    ]
  };
  const asProfile = ok<KnowledgeSaveResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: batch, headers: { "x-test-agent": "seo-chat" } }));
  const [first, second, dup] = asProfile.results;
  assert.deepEqual(first!.similar!.map((s) => [s.entryId, s.similarity]), [
    [alt, 0.99],
    [comparison, 0.9108]
  ], "the twin is in the same save; Annual billing is hidden from this chat");
  assert.equal(first!.similar![0]!.title, "Alternatives pages");
  assert.match(first!.similar![0]!.citation, new RegExp(`orquester-knowledge:entry/${alt}`));
  assert.deepEqual(second!.similar!.map((s) => s.entryId), [alt, comparison]);
  assert.equal(dup!.status, "duplicate");
  assert.equal(dup!.similar, undefined);

  // The user sees everything.
  const asUser = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: { entries: [{ body: "Yet another take on alternatives pages and their structure.", title: "New alternatives", collections: ["SEO"] }] }
    })
  );
  assert.deepEqual(asUser.results[0]!.similar!.map((s) => [s.entryId, s.similarity]), [
    [first!.entryId, 1],
    [alt, 0.99],
    [second!.entryId, 0.9851]
  ]);
  assert.ok(!asUser.results[0]!.similar!.some((s) => s.entryId === billing), "closest three only");
});

test("before the vector index is wired: no meaning or duplicates (concepts and author still apply); save similar is []", async (t) => {
  const h = await harness(t, { index: false });
  const { alt } = await seed(h);
  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.deepEqual(detail.similar, [{ entry: detail.similar![0]!.entry, similarity: null, reasons: [{ kind: "author", value: "hridoy" }] }]);
  assert.deepEqual(detail.possibleDuplicates, []);
  const save = ok<KnowledgeSaveResponse>(
    await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: "Something new entirely.", collections: ["SEO"] }] } })
  );
  assert.deepEqual(save.results[0]!.similar, []);
  const graph = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.similarityGraph }));
  assert.deepEqual(graph, { nodes: [], edges: [], clusters: [], truncated: false, totals: { entries: 5, embedded: 0 } });
});

test("GET /similarity-graph: visible nodes only, narrowing, and query validation", async (t) => {
  const h = await harness(t);
  const { seo, saas, alt, billing, comparison, unrelated } = await seed(h);
  const all = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?k=2` }));
  assert.deepEqual(new Set(all.nodes.map((n) => n.id)), new Set([alt, billing, comparison, unrelated]));
  assert.deepEqual(all.totals, { entries: 4, embedded: 4 });
  assert.ok(all.edges.some((e) => [e.from, e.to].includes(billing)));
  assert.equal(all.clusters[0]!.size, 3);

  for (const request of [
    { method: "GET" as const, url: `${knowledgeRoutes.similarityGraph}?sessionId=seo-chat` },
    { method: "GET" as const, url: knowledgeRoutes.similarityGraph, headers: { "x-test-agent": "seo-chat" } }
  ]) {
    const scoped = ok<KnowledgeSimilarityGraphResponse>(await h.inject(request));
    assert.deepEqual(new Set(scoped.nodes.map((n) => n.id)), new Set([alt, comparison, unrelated]));
    for (const edge of scoped.edges) assert.ok(edge.from !== billing && edge.to !== billing);
    assert.deepEqual(scoped.nodes.find((n) => n.id === comparison)!.collections, [seo.id], "hidden collections are not named");
  }

  const narrowed = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?collections=${saas.id}&limit=1` }));
  assert.equal(narrowed.nodes.length, 1);
  assert.equal(narrowed.truncated, true);
  assert.deepEqual(narrowed.totals, { entries: 2, embedded: 2 });
  const unfiled = ok<KnowledgeSimilarityGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?collections=unfiled` }));
  assert.deepEqual(unfiled.nodes, []);

  for (const bad of ["k=0", "k=9", "k=abc", "limit=0", "limit=2001", "limit=1.5"]) {
    refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?${bad}` }), 400, "KNOWLEDGE_INVALID");
  }
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?collections=nope` }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  refused(
    await h.inject({ method: "GET", url: `${knowledgeRoutes.similarityGraph}?collections=${saas.id}&sessionId=seo-chat` }),
    400,
    "KNOWLEDGE_UNKNOWN_COLLECTION"
  );
  h.state.enabled = false;
  refused(await h.inject({ method: "GET", url: knowledgeRoutes.similarityGraph }), 409, "KNOWLEDGE_DISABLED");
});
