import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions, type LightMyRequestResponse } from "fastify";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  knowledgeRoutes,
  type KnowledgeCollectionView,
  type KnowledgeCollectionsResponse,
  type KnowledgeEntriesResponse,
  type KnowledgeEntryDetail,
  type KnowledgeGraphResponse,
  type KnowledgeItemResponse,
  type KnowledgeLinkingState,
  type KnowledgeSaveResponse,
  type KnowledgeSearchResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import { knowledgeIndexDir } from "@orquester/config";
import type { KnowledgeEntryChange } from "./ports.ts";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { FakeEmbedder, FakeEmbedderSource, edge, node, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeStore } from "./store/store.ts";

// Route-level coverage: shapes, `{ code, message }` refusals, the plugin gate, visibility per
// session (and from an agent principal), events, and the save → linking handshake. Inject only.

async function harness(t: TestContext) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-routes-"));
  const logger = silentLogger();
  const store = await KnowledgeStore.open({ appdir, logger });
  const graph = new KnowledgeGraph({ entries: store, logger });
  const embedder = new FakeEmbedder();
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(embedder), indexDir: knowledgeIndexDir(appdir), logger });
  await search.start();
  const state = {
    enabled: true,
    visibilities: new Map<string, KnowledgeVisibility>(),
    linking: { state: "idle" } as KnowledgeLinkingState,
    profiles: new Map<string, { id: string; name: string }[]>()
  };
  const events: { channel: string; type: string; payload: unknown }[] = [];
  const linkingSaw: KnowledgeEntryChange[] = [];
  // What the service does: forward store changes to linking, which then reports itself queued.
  store.onChange((change) => {
    linkingSaw.push(change);
    if (change.kind === "added" || change.kind === "edited" || change.kind === "deleted") {
      state.linking = { state: "queued", pendingEntries: 1, startsAt: "2026-10-23T10:00:20.000Z" };
    }
  });
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
    linking: { status: () => state.linking },
    publisher: { publish: (channel, type, payload) => events.push({ channel, type, payload }) },
    profilesForCollection: async () => state.profiles,
    logger
  });
  t.after(async () => {
    await app.close();
    await search.stop();
    await store.idle();
    await rm(appdir, { recursive: true, force: true });
  });
  return {
    store,
    graph,
    search,
    state,
    events,
    linkingSaw,
    inject: (request: InjectOptions) => app.inject(request)
  };
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

async function seed(h: Awaited<ReturnType<typeof harness>>) {
  const save = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: {
        entries: [
          { body: "Alternatives pages: one per competitor, [competitor] vs [you].", title: "Alternatives pages", handle: "hridoy", collections: ["SEO"] },
          { body: "Annual billing lifts cash flow; Stripe handles proration.", title: "Annual billing", collections: ["SaaS"] }
        ],
        newCollections: [
          { name: "SEO", description: "Search engines" },
          { name: "SaaS", description: "Running SaaS" }
        ],
        sessionId: "chat-1"
      }
    })
  );
  const [seo, saas] = save.createdCollections;
  return { save, seo: seo!, saas: saas!, alt: save.results[0]!.entryId, billing: save.results[1]!.entryId };
}

test("save answers results, created collections and the linking state read after the change", async (t) => {
  const h = await harness(t);
  const { save, seo, alt } = await seed(h);
  assert.deepEqual(save.results.map((r) => r.status), ["saved", "saved"]);
  assert.deepEqual(save.results[0]!.collections, [seo.id]);
  assert.match(save.results[0]!.citation, /^\[Alternatives pages · @hridoy\]\(orquester-knowledge:entry\/ke_/);
  assert.equal(save.linking, "queued");
  assert.equal(h.linkingSaw[0]!.kind, "added");
  assert.deepEqual(h.store.getMeta(alt)!.savedFrom, { by: "agent", sessionId: "chat-1" });
  assert.deepEqual(h.events.at(-1), {
    channel: KNOWLEDGE_CHANNEL,
    type: KNOWLEDGE_CHANGED_EVENT,
    payload: { entryIds: save.results.map((r) => r.entryId), collections: true }
  });

  // Searchable at once, before any linking.
  const found = ok<KnowledgeSearchResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.search, payload: { query: "competitor pages" } }));
  assert.equal(found.hits[0]!.kind === "entry" && found.hits[0]!.entry.id, alt);

  // A duplicate keeps the entry, adds the collection, and needs no linking.
  h.state.linking = { state: "idle" };
  const dup = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: { entries: [{ body: "Alternatives pages: one per competitor,   [competitor] vs [you].", collections: ["SaaS"] }] }
    })
  );
  assert.equal(dup.results[0]!.status, "duplicate");
  assert.equal(dup.results[0]!.entryId, alt);
  assert.equal(dup.linking, "not-needed");
  assert.equal(h.linkingSaw.at(-1)!.kind, "relabelled");
});

test("save refusals: unknown collection lists the valid names; bad shapes are KNOWLEDGE_INVALID", async (t) => {
  const h = await harness(t);
  await seed(h);
  const message = refused(
    await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: "x", collections: ["Marketing"] }] } }),
    400,
    "KNOWLEDGE_UNKNOWN_COLLECTION"
  );
  assert.match(message, /"SEO", "SaaS"/);
  refused(await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: 5, collections: [] }] } }), 400, "KNOWLEDGE_INVALID");
  refused(await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: {} }), 400, "KNOWLEDGE_INVALID");
  refused(
    await h.inject({ method: "POST", url: knowledgeRoutes.save, payload: { entries: [{ body: "x".repeat(200_001), collections: ["SEO"] }] } }),
    413,
    "KNOWLEDGE_TOO_LARGE"
  );
  // Agents may send nulls for absent optional fields.
  const saved = ok<KnowledgeSaveResponse>(
    await h.inject({
      method: "POST",
      url: knowledgeRoutes.save,
      payload: { entries: [{ body: "With nulls", title: null, url: null, collections: ["SEO"] }], newCollections: null }
    })
  );
  assert.equal(saved.results[0]!.status, "saved");
});

test("every route refuses while the plugin is off", async (t) => {
  const h = await harness(t);
  h.state.enabled = false;
  const requests: InjectOptions[] = [
    { method: "GET", url: knowledgeRoutes.collections },
    { method: "POST", url: knowledgeRoutes.collections, payload: { name: "X" } },
    { method: "GET", url: knowledgeRoutes.collection("kc_aaaaaaaaaa") },
    { method: "PATCH", url: knowledgeRoutes.collection("kc_aaaaaaaaaa"), payload: {} },
    { method: "DELETE", url: knowledgeRoutes.collection("kc_aaaaaaaaaa") },
    { method: "GET", url: knowledgeRoutes.entries },
    { method: "GET", url: knowledgeRoutes.entry("ke_aaaaaaaaaaaa") },
    { method: "PATCH", url: knowledgeRoutes.entry("ke_aaaaaaaaaaaa"), payload: {} },
    { method: "DELETE", url: knowledgeRoutes.entry("ke_aaaaaaaaaaaa") },
    { method: "GET", url: knowledgeRoutes.item("ke_aaaaaaaaaaaa") },
    { method: "GET", url: knowledgeRoutes.graph },
    { method: "POST", url: knowledgeRoutes.search, payload: { query: "x" } },
    { method: "POST", url: knowledgeRoutes.save, payload: { entries: [] } }
  ];
  for (const request of requests) refused(await h.inject(request), 409, "KNOWLEDGE_DISABLED");
});

test("collections: list with counts and profiles, create, rename, delete (relabelling entries)", async (t) => {
  const h = await harness(t);
  const { seo, saas, alt } = await seed(h);
  h.state.profiles = new Map([[seo.id, [{ id: "p1", name: "SEO expert" }]]]);
  await h.store.save({ entries: [{ body: "unfiled later", collections: ["SaaS"] }] });
  const list = ok<KnowledgeCollectionsResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.collections }));
  assert.deepEqual(
    list.collections.map((c) => [c.name, c.entryCount, c.profiles.map((p) => p.name)]),
    [
      ["SEO", 1, ["SEO expert"]],
      ["SaaS", 2, []]
    ]
  );
  assert.equal(list.unfiledCount, 0);
  assert.equal(list.totalEntries, 3);

  h.state.visibilities.set("seo-chat", { kind: "collections", ids: [seo.id] });
  const scoped = ok<KnowledgeCollectionsResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.collections}?sessionId=seo-chat` }));
  assert.deepEqual(scoped.collections.map((c) => c.name), ["SEO"]);
  assert.equal(scoped.totalEntries, 1);
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.collection(saas.id)}?sessionId=seo-chat` }), 404, "KNOWLEDGE_NOT_FOUND");

  const created = ok<KnowledgeCollectionView>(
    await h.inject({ method: "POST", url: knowledgeRoutes.collections, payload: { name: "Ads", description: "Paid", color: "chart-5" } }),
    201
  );
  assert.equal(created.color, "chart-5");
  assert.equal(created.entryCount, 0);
  refused(await h.inject({ method: "POST", url: knowledgeRoutes.collections, payload: { name: "ads" } }), 409, "KNOWLEDGE_COLLECTION_EXISTS");
  refused(await h.inject({ method: "POST", url: knowledgeRoutes.collections, payload: { name: "Bad", color: "red" } }), 400, "KNOWLEDGE_INVALID");

  const renamed = ok<KnowledgeCollectionView>(
    await h.inject({ method: "PATCH", url: knowledgeRoutes.collection(created.id), payload: { name: "Paid ads" } })
  );
  assert.equal(renamed.name, "Paid ads");
  assert.deepEqual(h.events.at(-1)!.payload, { collections: true });

  const deleted = await h.inject({ method: "DELETE", url: knowledgeRoutes.collection(seo.id) });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual(h.events.at(-1)!.payload, { collections: true, entryIds: [alt] });
  const after = ok<KnowledgeCollectionsResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.collections }));
  assert.equal(after.unfiledCount, 1);
  refused(await h.inject({ method: "DELETE", url: knowledgeRoutes.collection(seo.id) }), 404, "KNOWLEDGE_NOT_FOUND");
});

test("entries: list, detail, edit and delete, scoped by the caller's session or agent principal", async (t) => {
  const h = await harness(t);
  const { seo, saas, alt, billing } = await seed(h);
  h.state.visibilities.set("seo-chat", { kind: "collections", ids: [seo.id] });

  const all = ok<KnowledgeEntriesResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.entries}?limit=1` }));
  assert.equal(all.entries.length, 1);
  assert.ok(all.nextCursor);
  const next = ok<KnowledgeEntriesResponse>(
    await h.inject({ method: "GET", url: `${knowledgeRoutes.entries}?limit=1&cursor=${encodeURIComponent(all.nextCursor!)}` })
  );
  assert.equal(next.entries.length, 1);
  assert.notEqual(next.entries[0]!.id, all.entries[0]!.id);
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.entries}?limit=abc` }), 400, "KNOWLEDGE_INVALID");

  const scoped = ok<KnowledgeEntriesResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.entries}?sessionId=seo-chat` }));
  assert.deepEqual(scoped.entries.map((e) => e.id), [alt]);
  // The agent principal wins over a query parameter.
  const asAgent = ok<KnowledgeEntriesResponse>(
    await h.inject({ method: "GET", url: `${knowledgeRoutes.entries}?sessionId=nobody`, headers: { "x-test-agent": "seo-chat" } })
  );
  assert.deepEqual(asAgent.entries.map((e) => e.id), [alt]);
  refused(await h.inject({ method: "GET", url: knowledgeRoutes.entry(billing), headers: { "x-test-agent": "seo-chat" } }), 404, "KNOWLEDGE_NOT_FOUND");

  const detail = ok<KnowledgeEntryDetail>(await h.inject({ method: "GET", url: knowledgeRoutes.entry(alt) }));
  assert.equal(detail.entry.title, "Alternatives pages");
  assert.equal(detail.citation, detail.entry && `[Alternatives pages · @hridoy](orquester-knowledge:entry/${alt})`);

  // Collection-only edit: relabelled, no linking; text edit: edited.
  h.state.linking = { state: "idle" };
  h.linkingSaw.length = 0;
  const relabelled = ok<KnowledgeEntryDetail>(
    await h.inject({ method: "PATCH", url: knowledgeRoutes.entry(alt), payload: { collections: [seo.id, saas.id] } })
  );
  assert.deepEqual(relabelled.entry.collections, [seo.id, saas.id]);
  assert.deepEqual(h.linkingSaw, [{ kind: "relabelled", entryIds: [alt] }]);
  assert.deepEqual(h.events.at(-1)!.payload, { entryIds: [alt], collections: true });
  const edited = ok<KnowledgeEntryDetail>(
    await h.inject({ method: "PATCH", url: knowledgeRoutes.entry(alt), payload: { body: "Alternatives pages rank for comparison searches." } })
  );
  assert.equal(edited.entry.linkState, "pending");
  assert.equal(h.linkingSaw.at(-1)!.kind, "edited");
  const searched = ok<KnowledgeSearchResponse>(await h.inject({ method: "POST", url: knowledgeRoutes.search, payload: { query: "comparison searches" } }));
  assert.equal(searched.hits[0]!.kind === "entry" && searched.hits[0]!.entry.id, alt);
  refused(await h.inject({ method: "PATCH", url: knowledgeRoutes.entry(alt), payload: { collections: ["nope"] } }), 400, "KNOWLEDGE_UNKNOWN_COLLECTION");
  refused(await h.inject({ method: "PATCH", url: knowledgeRoutes.entry(alt), payload: { title: 7 } }), 400, "KNOWLEDGE_INVALID");

  const gone = await h.inject({ method: "DELETE", url: knowledgeRoutes.entry(billing) });
  assert.equal(gone.statusCode, 204);
  assert.deepEqual(h.events.at(-1)!.payload, { entryIds: [billing], collections: true });
  refused(await h.inject({ method: "GET", url: knowledgeRoutes.entry(billing) }), 404, "KNOWLEDGE_NOT_FOUND");
  refused(await h.inject({ method: "DELETE", url: knowledgeRoutes.entry(billing) }), 404, "KNOWLEDGE_NOT_FOUND");
});

test("items, graph and search never show a profile chat what it cannot see", async (t) => {
  const h = await harness(t);
  const { seo, saas, alt, billing } = await seed(h);
  h.state.visibilities.set("seo-chat", { kind: "collections", ids: [seo.id] });
  h.graph.replace(
    [
      node("tactic-comparison", "Comparison pages", [`${alt}.md`, `${billing}.md`]),
      node("tool-stripe", "Stripe", [`${billing}.md`])
    ],
    [edge("e1", "tactic-comparison", "tool-stripe", [`${billing}.md`])]
  );
  const graph = ok<KnowledgeGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.graph}?sessionId=seo-chat` }));
  assert.deepEqual(graph.nodes.map((n) => n.id), ["tactic-comparison"]);
  assert.deepEqual(graph.edges, []);
  const full = ok<KnowledgeGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.graph}?focus=tool-stripe&depth=1` }));
  assert.equal(full.nodes.length, 2);
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.graph}?focus=tool-stripe&sessionId=seo-chat` }), 404, "KNOWLEDGE_NOT_FOUND");
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.graph}?depth=9` }), 400, "KNOWLEDGE_INVALID");
  const bySaas = ok<KnowledgeGraphResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.graph}?collections=${saas.id}` }));
  assert.equal(bySaas.nodes.length, 2);

  const concept = ok<KnowledgeItemResponse>(await h.inject({ method: "GET", url: `${knowledgeRoutes.item("tactic-comparison")}?sessionId=seo-chat` }));
  assert.equal(concept.kind, "concept");
  if (concept.kind === "concept") {
    assert.deepEqual(concept.concept.entries.map((e) => e.id), [alt]);
    assert.deepEqual(concept.concept.neighbors, []);
  }
  refused(await h.inject({ method: "GET", url: `${knowledgeRoutes.item("tool-stripe")}?sessionId=seo-chat` }), 404, "KNOWLEDGE_NOT_FOUND");
  const entry = ok<KnowledgeItemResponse>(await h.inject({ method: "GET", url: knowledgeRoutes.item(alt) }));
  assert.equal(entry.kind === "entry" && entry.entry.related[0]!.id, billing);

  const hits = ok<KnowledgeSearchResponse>(
    await h.inject({ method: "POST", url: knowledgeRoutes.search, payload: { query: "stripe billing comparison", limit: 25, sessionId: "seo-chat" } })
  );
  for (const hit of hits.hits) {
    if (hit.kind === "entry") assert.equal(hit.entry.id, alt);
    else assert.notEqual(hit.concept.id, "tool-stripe");
  }
  assert.deepEqual(hits.searched, [seo.id]);
  refused(
    await h.inject({ method: "POST", url: knowledgeRoutes.search, payload: { query: "x", collections: ["SaaS"], sessionId: "seo-chat" } }),
    400,
    "KNOWLEDGE_UNKNOWN_COLLECTION"
  );
  refused(await h.inject({ method: "POST", url: knowledgeRoutes.search, payload: { query: "" } }), 400, "KNOWLEDGE_INVALID");
});
