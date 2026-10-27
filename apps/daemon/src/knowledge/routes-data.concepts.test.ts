import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type LightMyRequestResponse } from "fastify";
import {
  KNOWLEDGE_CHANGED_EVENT,
  KNOWLEDGE_CHANNEL,
  knowledgeRoutes,
  type KnowledgeConceptMergesResponse,
  type KnowledgeItemResponse,
  type KnowledgeSaveResponse,
  type KnowledgeVisibility
} from "@orquester/api";
import { knowledgeConceptMergesPath, knowledgeIndexDir } from "@orquester/config";
import { registerKnowledgeDataRoutes } from "./routes-data.ts";
import { KnowledgeConceptMerges } from "./search/concept-merges.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { KnowledgeSearch } from "./search/search.ts";
import { FakeEmbedder, FakeEmbedderSource, loadGraph, node, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeStore } from "./store/store.ts";

// The concept merge routes (phase 2 spec, "Concept merges"): GET list scoped to what the caller
// sees, DELETE undoes (KNOWLEDGE_NOT_FOUND for unknown or hidden ones) and publishes
// `knowledge.changed {graph: true}`; concept details carry `mergedFrom` and `similarConcepts`.

async function harness(t: TestContext) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-routes-concepts-"));
  const logger = silentLogger();
  const store = await KnowledgeStore.open({ appdir, logger });
  const graph = new KnowledgeGraph({ entries: store, logger });
  const source = new FakeEmbedderSource(new FakeEmbedder({ dimensions: 64, groups: [] }));
  const search = new KnowledgeSearch({ store, graph, embedders: source, indexDir: knowledgeIndexDir(appdir), logger });
  await search.start();
  const merges = new KnowledgeConceptMerges({
    graph,
    embedders: source,
    path: knowledgeConceptMergesPath(appdir),
    vectorsDir: join(knowledgeIndexDir(appdir), "concepts"),
    logger,
    thresholds: () => ({ merge: 0.85, similar: 0.3 }),
    pause: async () => undefined
  });
  const visibilities = new Map<string, KnowledgeVisibility>();
  const events: { channel: string; type: string; payload: unknown }[] = [];
  const app = Fastify();
  registerKnowledgeDataRoutes(app, {
    store,
    search,
    settings: { enabled: () => true },
    visibility: { forSession: async (id) => (id && visibilities.get(id)) || { kind: "all" } },
    linking: { status: () => ({ state: "idle" }) },
    publisher: { publish: (channel, type, payload) => events.push({ channel, type, payload }) },
    profilesForCollection: async () => new Map(),
    logger,
    conceptMerges: merges
  });
  t.after(async () => {
    await app.close();
    await merges.stop();
    await search.stop();
    await store.idle();
    await rm(appdir, { recursive: true, force: true });
  });
  const save = (await app.inject({
    method: "POST",
    url: knowledgeRoutes.save,
    payload: {
      entries: [
        { body: "Warm up the account for a week.", title: "Warm-up", collections: ["SEO"] },
        { body: "Warm up TikTok accounts before posting.", title: "TikTok", collections: ["SaaS"] }
      ],
      newCollections: [
        { name: "SEO", description: "Search engines" },
        { name: "SaaS", description: "Running SaaS" }
      ]
    }
  })).json() as KnowledgeSaveResponse;
  const [seo] = save.createdCollections;
  const [a, b] = save.results.map((r) => r.entryId);
  visibilities.set("seo-chat", { kind: "collections", ids: [seo!.id] });
  await merges.start();
  await loadGraph(graph, [
    node("tactic-warm-up", "Warm up TikTok account", [`${a}.md`, `${b}.md`]),
    node("tactic-warm-up-the", "Warm up the TikTok account", [`${b}.md`]),
    node("tactic-pages", "Alternatives pages", [`${a}.md`]),
    node("tactic-pages-the", "The alternatives pages", [`${a}.md`]),
    node("tactic-account", "Warm up account on TikTok daily", [`${a}.md`])
  ]);
  await merges.idle();
  events.length = 0;
  return { app, appdir, graph, events, merges };
}

function ok<T>(response: LightMyRequestResponse, status = 200): T {
  assert.equal(response.statusCode, status, response.body);
  return (response.body ? response.json() : undefined) as T;
}

test("GET lists the merges in effect, scoped to the concepts the caller can see", async (t) => {
  const h = await harness(t);
  const all = ok<KnowledgeConceptMergesResponse>(await h.app.inject({ method: "GET", url: knowledgeRoutes.conceptMerges }));
  assert.deepEqual(
    all.merges.map((m) => [m.into.id, m.merged.map((c) => c.id)]).sort(),
    [
      ["tactic-pages", ["tactic-pages-the"]],
      ["tactic-warm-up", ["tactic-warm-up-the"]]
    ]
  );
  const merge = all.merges[0]!;
  assert.match(merge.id, /^cm_[0-9a-f]{12}$/);
  assert.ok(merge.similarity >= 0.85 && merge.similarity <= 1);
  assert.ok(!Number.isNaN(Date.parse(merge.createdAt)));
  assert.deepEqual(Object.keys(merge.into).sort(), ["id", "name", "type"]);
  // The SEO chat sees entry a only: the warm-up merge folded a concept only b backs.
  const scoped = ok<KnowledgeConceptMergesResponse>(await h.app.inject({ method: "GET", url: `${knowledgeRoutes.conceptMerges}?sessionId=seo-chat` }));
  assert.deepEqual(
    scoped.merges.map((m) => m.into.id),
    ["tactic-pages"]
  );
});

test("DELETE undoes a merge, publishes knowledge.changed {graph: true}, and the pair is never merged again", async (t) => {
  const h = await harness(t);
  const { merges } = ok<KnowledgeConceptMergesResponse>(await h.app.inject({ method: "GET", url: knowledgeRoutes.conceptMerges }));
  const warmUp = merges.find((m) => m.into.id === "tactic-warm-up")!;
  // Unknown, or hidden from the caller: like an unknown one.
  const unknown = await h.app.inject({ method: "DELETE", url: knowledgeRoutes.conceptMerge("cm_000000000000") });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, "KNOWLEDGE_NOT_FOUND");
  const hidden = await h.app.inject({ method: "DELETE", url: `${knowledgeRoutes.conceptMerge(warmUp.id)}?sessionId=seo-chat` });
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json().code, "KNOWLEDGE_NOT_FOUND");
  assert.deepEqual(h.events, []);

  const before = h.graph.revision();
  ok(await h.app.inject({ method: "DELETE", url: knowledgeRoutes.conceptMerge(warmUp.id) }), 204);
  assert.ok(h.graph.revision() > before);
  assert.deepEqual(h.events, [{ channel: KNOWLEDGE_CHANNEL, type: KNOWLEDGE_CHANGED_EVENT, payload: { graph: true } }]);
  const after = ok<KnowledgeConceptMergesResponse>(await h.app.inject({ method: "GET", url: knowledgeRoutes.conceptMerges }));
  assert.deepEqual(
    after.merges.map((m) => m.into.id),
    ["tactic-pages"]
  );
  const file = JSON.parse(await readFile(knowledgeConceptMergesPath(h.appdir), "utf8")) as { rejected: { id: string }[] };
  assert.deepEqual(
    file.rejected.map((r) => r.id),
    [warmUp.id]
  );
  // A second undo of the same merge: gone.
  assert.equal((await h.app.inject({ method: "DELETE", url: knowledgeRoutes.conceptMerge(warmUp.id) })).statusCode, 404);
});

test("a concept detail lists what was merged into it and similar concepts", async (t) => {
  const h = await harness(t);
  const item = ok<KnowledgeItemResponse>(await h.app.inject({ method: "GET", url: knowledgeRoutes.item("tactic-warm-up") }));
  assert.equal(item.kind, "concept");
  if (item.kind !== "concept") return;
  assert.deepEqual(item.concept.mergedFrom, [{ id: "tactic-warm-up-the", name: "Warm up the TikTok account", type: "tactic" }]);
  assert.ok(item.concept.concept.aliases.includes("Warm up the TikTok account"));
  const similar = item.concept.similarConcepts!;
  assert.ok(similar.length > 0 && similar.length <= 5);
  assert.equal(similar[0]!.concept.id, "tactic-account");
  assert.ok(similar.every((s) => s.concept.id !== "tactic-warm-up-the" && s.concept.id !== "tactic-warm-up"));
  assert.ok(similar.every((s, i) => i === 0 || similar[i - 1]!.similarity >= s.similarity));
  // The folded id answers the kept concept; a scoped caller sees no folded concept it cannot back.
  const folded = ok<KnowledgeItemResponse>(await h.app.inject({ method: "GET", url: knowledgeRoutes.item("tactic-warm-up-the") }));
  assert.equal(folded.kind === "concept" && folded.concept.concept.id, "tactic-warm-up");
  const scoped = ok<KnowledgeItemResponse>(await h.app.inject({ method: "GET", url: `${knowledgeRoutes.item("tactic-warm-up")}?sessionId=seo-chat` }));
  assert.equal(scoped.kind, "concept");
  if (scoped.kind === "concept") {
    assert.deepEqual(scoped.concept.mergedFrom, []);
    assert.equal(scoped.concept.concept.aliases.includes("Warm up the TikTok account"), false);
  }
});

test("without concept merges wired the list is empty and DELETE answers KNOWLEDGE_NOT_FOUND", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "kg-routes-concepts-none-"));
  const logger = silentLogger();
  const store = await KnowledgeStore.open({ appdir, logger });
  const graph = new KnowledgeGraph({ entries: store, logger });
  const search = new KnowledgeSearch({ store, graph, embedders: new FakeEmbedderSource(null), indexDir: knowledgeIndexDir(appdir), logger });
  await search.start();
  const app = Fastify();
  registerKnowledgeDataRoutes(app, {
    store,
    search,
    settings: { enabled: () => true },
    visibility: { forSession: async () => ({ kind: "all" }) },
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
  assert.deepEqual(ok<KnowledgeConceptMergesResponse>(await app.inject({ method: "GET", url: knowledgeRoutes.conceptMerges })), { merges: [] });
  assert.equal((await app.inject({ method: "DELETE", url: knowledgeRoutes.conceptMerge("cm_x") })).statusCode, 404);
});
