/**
 * `KnowledgeService` lifecycle and seams: nothing opens while the plugin is off; the first switch-on
 * opens the knowledge base and builds and starts linking with its store and graph; switching off
 * releases the embedder and gates the routes (linking pauses itself); a knowledge base that cannot
 * open answers cleanly and is retried; a linking module that cannot be built or started leaves
 * linking paused; the worker routes take the worker from the stamped principal only; the profile
 * cache behind the collection views. Stop is idempotent and stops linking first.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import Fastify from "fastify";
import { KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, knowledgeRoutes, type KnowledgeLinkingState, type KnowledgeStatus, type SessionOwner } from "@orquester/api";
import { knowledgeEntriesDir, knowledgeGraphPluginDir } from "@orquester/config";

import { FAKE_RUNTIME } from "./linking/testing.ts";
import type { KnowledgeEntryChange } from "./ports.ts";
import { FakeVectorIndex } from "./search/fake-vector-index.ts";
import { KnowledgeGraph } from "./search/graph.ts";
import { FakeStore as SearchFakeStore, edge, loadGraph, node, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeService, linkGraphView, type KnowledgeLinking, type KnowledgeLinkingFactory, type KnowledgeServiceOptions } from "./service.ts";
import { FakeKnowledgePlugins, FakeRuntime, fakeEmbedders } from "./test-fakes.ts";

async function harness(t: TestContext, options: { enabled?: boolean; over?: Partial<KnowledgeServiceOptions>; mode?: "local" | "remote" } = {}) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-service-"));
  const plugins = new FakeKnowledgePlugins(options.enabled ?? false);
  const runtime = new FakeRuntime();
  runtime.set(FAKE_RUNTIME);
  const embedders = fakeEmbedders();
  const events: { channel: string; type: string; payload: unknown }[] = [];
  let pushes = 0;
  const knowledge = new KnowledgeService({
    appdir,
    plugins,
    accounts: { list: () => ({ accounts: [] }) },
    session: () => null,
    profiles: {
      list: async () => ({ profiles: [], errors: [] }),
      read: async () => {
        throw new Error("no profiles");
      }
    },
    publisher: { publish: (channel: string, type: string, payload: unknown) => void events.push({ channel, type, payload }) },
    toolsChanged: () => {
      pushes += 1;
    },
    runtime,
    embedders: embedders.factory,
    logger: silentLogger(),
    ...options.over
  });
  const app = Fastify();
  // The principal hook's part: an in-chat call is stamped with its chat (here from a test header).
  app.addHook("onRequest", async (request) => {
    const agent = request.headers["x-test-agent"];
    if (typeof agent === "string") (request as unknown as { principal: unknown }).principal = { kind: "agent", threadId: agent, projectPath: "" };
  });
  knowledge.registerRoutes(app, options.mode);
  t.after(async () => {
    await app.close();
    await knowledge.stop();
    await rm(appdir, { recursive: true, force: true });
  });
  const inject = async (method: "GET" | "POST", url: string, payload?: object, agent?: string) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}), ...(agent ? { headers: { "x-test-agent": agent } } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null };
  };
  const statuses = () => events.filter((e) => e.channel === KNOWLEDGE_CHANNEL && e.type === KNOWLEDGE_STATUS_EVENT).map((e) => e.payload as KnowledgeStatus);
  return { appdir, plugins, runtime, embedders, knowledge, inject, events, statuses, pushes: () => pushes };
}

/** A linking module that records what the service does with it. */
function recordingLinking(options: { failStart?: boolean } = {}) {
  const log: string[] = [];
  const ports: Parameters<KnowledgeLinkingFactory>[0][] = [];
  const changes: KnowledgeEntryChange[] = [];
  const factory: KnowledgeLinkingFactory = (given) => {
    const n = ports.push(given);
    log.push(`build ${n}`);
    const linking: KnowledgeLinking = {
      events: new EventEmitter<{ status: [] }>(),
      start: async () => {
        log.push(`start ${n}`);
        if (options.failStart) throw new Error("state.json is unreadable");
      },
      stop: async () => void log.push(`stop ${n}`),
      status: (): KnowledgeLinkingState => ({ state: "idle" }),
      entriesChanged: (change) => void changes.push(change),
      snapshot: () => ({ linking: { state: "idle" }, lastRun: null, recentRuns: [], workers: [], tokens: { week: { in: 1, out: 2 }, total: { in: 3, out: 4 } }, lastError: null }),
      rebuild: async () => ({ queued: true, running: false }),
      rebuildEstimate: async () => ({ entries: 7, tasks: 12 }),
      isActiveWorker: (owner: SessionOwner | undefined) => owner?.kind === "knowledge-indexer" && owner.runId === "kr_1",
      workerNext: async (sessionId) => {
        log.push(`next ${sessionId}`);
        return { kind: "done", reason: "run-finished" };
      },
      workerSubmit: async () => ({ accepted: false, error: "x" })
    };
    return linking;
  };
  return { log, ports, changes, factory };
}

test("with the plugin off nothing opens: no store directory, no embedder, no linking; data routes 409, settings and status answer", async (t) => {
  const linking = recordingLinking();
  const h = await harness(t, { over: { linking: linking.factory } });
  await h.knowledge.start();
  await h.knowledge.settled();
  await assert.rejects(stat(knowledgeGraphPluginDir(h.appdir)), { code: "ENOENT" });
  assert.equal(h.embedders.made.length, 0);
  assert.deepEqual(linking.log, []);
  const search = await h.inject("POST", knowledgeRoutes.search, { query: "x" });
  assert.equal(search.status, 409);
  assert.equal(search.body!.code, "KNOWLEDGE_DISABLED");
  assert.equal((await h.inject("GET", knowledgeRoutes.collections)).status, 409);
  assert.equal((await h.inject("GET", knowledgeRoutes.settings)).status, 200);
  const status = (await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus;
  assert.equal(status.enabled, false);
  assert.equal(status.installed, true);
  assert.equal(status.linking.state === "paused" && status.linking.reason, "plugin-off");
  assert.equal(status.entries, 0);
});

test("the first switch-on opens the knowledge base and builds and starts linking on its store and graph; switching off releases the embedder; on again serves without reopening", async (t) => {
  const linking = recordingLinking();
  const h = await harness(t, { over: { linking: linking.factory } });
  await h.knowledge.start();
  h.plugins.set(true);
  await h.knowledge.settled();
  assert.deepEqual(linking.log, ["build 1", "start 1"]);
  assert.equal(h.pushes(), 1, "switching on pushes the manifests");
  assert.equal(h.embedders.made.length, 1);
  const ports = linking.ports[0]!;
  assert.equal(ports.runtime, h.runtime);
  assert.equal(ports.settings, h.knowledge.settings);
  assert.equal(ports.store.mykgInputDir.startsWith(h.appdir), true);

  // Store changes reach linking; the status follows, with linking's run history.
  const saved = await h.inject("POST", knowledgeRoutes.save, { entries: [{ body: "Budget caps while a campaign learns.", collections: ["Ads"] }], newCollections: [{ name: "Ads", description: "Paid." }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(linking.changes.map((c) => c.kind), ["added"]);
  await h.knowledge.settled();
  assert.equal(h.pushes(), 2, "the new collection pushed the manifests");
  const status = h.statuses().at(-1)!;
  assert.equal(status.entries, 1);
  assert.equal(status.collections, 1);
  assert.deepEqual(status.tokens, { week: { in: 1, out: 2 }, total: { in: 3, out: 4 } }, "the run history is linking's");
  assert.deepEqual((await h.inject("GET", knowledgeRoutes.rebuildEstimate)).body, { entries: 7, tasks: 12 });

  // A graph load announced by linking (counts moved) → knowledge.changed {graph: true}.
  await loadGraph(ports.graph, [{ id: "tactic-x", name: "X", type: "Tactic", source_files: [] }], []);
  (h.knowledge.linking()!.events as EventEmitter).emit("status");
  await h.knowledge.settled();
  assert.ok(h.events.some((e) => e.type === "knowledge.changed" && (e.payload as { graph?: boolean }).graph === true));
  // A run that reloads a graph of the same size (an edited entry re-linked) still announces it.
  const graphEvents = () => h.events.filter((e) => e.type === "knowledge.changed" && (e.payload as { graph?: boolean }).graph === true).length;
  const before = graphEvents();
  await loadGraph(ports.graph, [{ id: "tactic-y", name: "Y", type: "Tactic", source_files: [] }], []);
  (h.knowledge.linking()!.events as EventEmitter).emit("status");
  await h.knowledge.settled();
  assert.equal(graphEvents(), before + 1, "a reload of the same size is announced");
  (h.knowledge.linking()!.events as EventEmitter).emit("status");
  await h.knowledge.settled();
  assert.equal(graphEvents(), before + 1, "a status move without a reload is not");
  // A run's verdict on its entries (linked / failed) reaches the UI's entry lists and panels.
  const entryId = (saved.body!.results as { entryId: string }[])[0]!.entryId;
  await ports.store.setLinkState([entryId], "linked");
  await h.knowledge.settled();
  assert.ok(
    h.events.some((e) => e.type === "knowledge.changed" && JSON.stringify((e.payload as { entryIds?: string[] }).entryIds) === JSON.stringify([entryId])),
    "link states moved → knowledge.changed {entryIds}"
  );
  // An entry a run could not link is counted in the status, which is published again.
  assert.equal(h.knowledge.status().failedEntries, 0);
  const statusEvents = () => h.statuses().length;
  const statusBefore = statusEvents();
  await ports.store.setLinkState([entryId], "failed");
  await h.knowledge.settled();
  assert.equal(h.knowledge.status().failedEntries, 1);
  assert.ok(statusEvents() > statusBefore, "a link-state move publishes knowledge.status");
  assert.equal(h.statuses().at(-1)!.failedEntries, 1);

  h.plugins.set(false);
  await h.knowledge.settled();
  assert.equal(h.embedders.released, 1, "the model is released at once");
  assert.equal(h.pushes(), 3);
  assert.deepEqual(linking.log, ["build 1", "start 1"], "linking follows the switch itself (it pauses); it is not rebuilt");
  assert.equal((await h.inject("POST", knowledgeRoutes.search, { query: "budget" })).body!.code, "KNOWLEDGE_DISABLED");

  h.plugins.set(true);
  await h.knowledge.settled();
  assert.equal(h.pushes(), 4);
  assert.deepEqual(linking.log, ["build 1", "start 1"]);
  assert.equal(h.embedders.made.length, 1, "the same knowledge base, not reopened");
  const hits = await h.inject("POST", knowledgeRoutes.search, { query: "budget" });
  assert.equal((hits.body!.hits as unknown[]).length, 1);

  await h.knowledge.stop();
  await h.knowledge.stop();
  assert.deepEqual(linking.log, ["build 1", "start 1", "stop 1"], "stop stops linking once");
  assert.equal(h.embedders.disposed, 1);
});

test("the status says whether the embedding model is installed and loadable", async (t) => {
  const h = await harness(t, { enabled: true });
  await h.knowledge.start();
  await h.knowledge.settled();
  assert.equal(h.knowledge.status().embeddingModelReady, true);
  assert.equal(((await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus).embeddingModelReady, true);

  // An install from before a model change: myKG links, the model still has to be fetched.
  h.runtime.set({ ...FAKE_RUNTIME, embeddingModelReady: false });
  await h.knowledge.settled();
  assert.equal(h.knowledge.status().installed, true);
  assert.equal(h.knowledge.status().embeddingModelReady, false);
  assert.equal(h.statuses().at(-1)?.embeddingModelReady, false, "a runtime change publishes it");

  h.runtime.set(null);
  assert.equal(h.knowledge.status().embeddingModelReady, false);

  // Installed, but the model fails to load: not ready.
  h.runtime.set(FAKE_RUNTIME);
  await h.knowledge.settled();
  assert.equal(h.knowledge.status().embeddingModelReady, true);
  h.embedders.made[0]!.failWith = new Error("the model file is corrupt");
  assert.equal((await h.inject("POST", knowledgeRoutes.search, { query: "anything" })).status, 200);
  assert.equal(h.knowledge.status().embeddingModelReady, false);
});

test("before start a request is told the plugin is starting; start opens it", async (t) => {
  const h = await harness(t, { enabled: true });
  const early = await h.inject("GET", knowledgeRoutes.collections);
  assert.equal(early.status, 409);
  assert.equal(early.body!.code, "KNOWLEDGE_BUSY");
  await h.knowledge.start();
  assert.equal((await h.inject("GET", knowledgeRoutes.collections)).status, 200);
  await stat(knowledgeEntriesDir(h.appdir));
});

test("a knowledge base that cannot open: routes answer 500 KNOWLEDGE_ERROR, the status names it, and the next request retries", async (t) => {
  const linking = recordingLinking();
  const h = await harness(t, { enabled: true, over: { linking: linking.factory } });
  // `entries` is a file: the store cannot make its directory.
  await mkdir(knowledgeGraphPluginDir(h.appdir), { recursive: true });
  await writeFile(knowledgeEntriesDir(h.appdir), "not a directory");
  await h.knowledge.start();
  await h.knowledge.settled();
  const res = await h.inject("POST", knowledgeRoutes.search, { query: "x" });
  assert.equal(res.status, 500);
  assert.equal(res.body!.code, "KNOWLEDGE_ERROR");
  assert.match(String(res.body!.message), /could not be opened/);
  const status = (await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus;
  assert.equal(status.linking.state === "paused" && status.linking.reason, "error");
  assert.ok(status.lastError);
  assert.deepEqual(linking.log, [], "no linking without a store");
  // The manifest read treats it as "no collections", never a throw.
  assert.deepEqual((await h.knowledge.knowledgeForSession("unknown")).visibleCollectionNames, []);

  await rm(knowledgeEntriesDir(h.appdir));
  const retried = await h.inject("POST", knowledgeRoutes.search, { query: "x" });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(linking.log, ["build 1", "start 1"]);
  assert.equal(((await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus).lastError, null);
});

test("a linking module that cannot be built, or cannot start, leaves linking paused with the error; the data routes still serve", async (t) => {
  const broken = await harness(t, { enabled: true, over: { linking: () => { throw new Error("no python"); } } });
  await broken.knowledge.start();
  const built = broken.knowledge.linkingStatus();
  assert.equal(built.state === "paused" && built.reason, "error");
  assert.match(built.state === "paused" ? built.message : "", /no python/);
  assert.equal((await broken.inject("GET", knowledgeRoutes.collections)).status, 200);
  const rebuild = await broken.inject("POST", knowledgeRoutes.rebuild);
  assert.equal(rebuild.status, 500);
  assert.equal(rebuild.body!.code, "KNOWLEDGE_ERROR");
  assert.match(String(rebuild.body!.message), /no python/);

  const failing = recordingLinking({ failStart: true });
  const h = await harness(t, { enabled: true, over: { linking: failing.factory } });
  await h.knowledge.start();
  const started = h.knowledge.linkingStatus();
  assert.equal(started.state === "paused" && started.reason, "error");
  assert.match(started.state === "paused" ? started.message : "", /state\.json is unreadable/);
});

test("worker routes: the worker is the stamped principal only, and must be a worker chat of the run in flight", async (t) => {
  const linking = recordingLinking();
  const owners = new Map<string, SessionOwner>([
    ["w1", { kind: "knowledge-indexer", runId: "kr_1" }],
    ["w-old", { kind: "knowledge-indexer", runId: "kr_0" }]
  ]);
  const h = await harness(t, { enabled: true, over: { linking: linking.factory, session: (id) => (owners.has(id) ? { owner: owners.get(id)! } : { profileId: null }) } });
  await h.knowledge.start();
  assert.deepEqual((await h.inject("POST", knowledgeRoutes.workerNext, {}, "w1")).body, { kind: "done", reason: "run-finished" });
  assert.equal(linking.log.at(-1), "next w1");
  for (const [payload, agent] of [[{ sessionId: "w1" }, undefined], [{}, "chat-1"], [{}, "w-old"]] as const) {
    const refused = await h.inject("POST", knowledgeRoutes.workerNext, payload, agent);
    assert.equal(refused.status, 403, JSON.stringify([payload, agent]));
    assert.equal(refused.body!.code, "KNOWLEDGE_NOT_A_WORKER");
  }
  // Visibility agrees: a worker sees no collection.
  assert.equal((await h.knowledge.knowledgeForSession("w1")).worker, true);
});

test("the worker routes are the unix-socket app's only: the remote app serves the rest without them", async (t) => {
  const linking = recordingLinking();
  const session = (id: string) => (id === "w1" ? { owner: { kind: "knowledge-indexer", runId: "kr_1" } as SessionOwner } : { profileId: null });
  const h = await harness(t, { enabled: true, mode: "remote", over: { linking: linking.factory, session } });
  await h.knowledge.start();
  assert.equal((await h.inject("GET", knowledgeRoutes.status)).status, 200);
  assert.equal((await h.inject("GET", knowledgeRoutes.collections)).status, 200);
  for (const url of [knowledgeRoutes.workerNext, knowledgeRoutes.workerSubmit]) {
    assert.equal((await h.inject("POST", url, { taskId: "t", answer: "{}" }, "w1")).status, 404, url);
  }
  assert.equal(linking.log.includes("next w1"), false);
});

test("a profile ticking or unticking a collection (or renamed while it ticks one) refreshes the collection views; an unrelated edit does not", async (t) => {
  const listeners: ((profileId: string) => void)[] = [];
  const profiles = [{ manifest: { id: "p1", name: "SEO expert", settings: { knowledgeCollections: [] as string[] } } }];
  const h = await harness(t, {
    enabled: true,
    over: {
      onProfileChange: (listener) => (listeners.push(listener), () => undefined),
      profiles: { list: async () => ({ profiles: structuredClone(profiles) as never, errors: [] }), read: async () => structuredClone(profiles[0]) as never }
    }
  });
  await h.knowledge.start();
  await h.knowledge.settled();
  const collectionEvents = () => h.events.filter((e) => e.type === "knowledge.changed" && (e.payload as { collections?: boolean }).collections === true).length;
  const pushesBefore = h.pushes();

  profiles[0]!.manifest.settings.knowledgeCollections = ["kc_aaaaaaaaaa"];
  listeners[0]!("p1");
  await h.knowledge.settled();
  assert.equal(collectionEvents(), 1, "ticking a collection moves its profile chips");
  assert.equal(h.pushes(), pushesBefore + 1, "and the chats' manifests");

  profiles[0]!.manifest.name = "SEO lead";
  listeners[0]!("p1");
  await h.knowledge.settled();
  assert.equal(collectionEvents(), 2, "a rename shows under the collections it ticks");
  assert.equal(h.pushes(), pushesBefore + 1, "a rename changes no manifest");

  listeners[0]!("p1");
  await h.knowledge.settled();
  assert.equal(collectionEvents(), 2, "an edit that moves nothing the views show");
});

test("linking's graph view: the vector index of the moment, an entry's concepts, and `contradicts` neighbours either way", async () => {
  const store = new SearchFakeStore();
  const filed = "kc_aaaaaaaaaa";
  store.collection(filed, "SEO");
  store.put("ke_aaaaaaaaaaaa", "wait 48 hours", [filed], {}, true);
  store.put("ke_bbbbbbbbbbbb", "wait 72 hours", [], {}, true);
  const graph = new KnowledgeGraph({ entries: store, logger: silentLogger() });
  await loadGraph(
    graph,
    [node("tactic-48h", "Wait 48 hours", ["ke_aaaaaaaaaaaa.md"]), node("tactic-72h", "Wait 72 hours", ["ke_bbbbbbbbbbbb.md"]), node("tool-x", "X", ["ke_bbbbbbbbbbbb.md"])],
    [edge("e1", "tactic-48h", "tactic-72h", null, "contradicts"), edge("e2", "tactic-72h", "tool-x", null, "uses")]
  );
  let index = new FakeVectorIndex();
  const view = linkGraphView({ listCollections: () => store.listCollections() }, graph, { vectorIndex: () => index });
  assert.equal(view.vectors(), index);
  index = new FakeVectorIndex();
  assert.equal(view.vectors(), index, "read per call: a model change swaps the index");
  assert.deepEqual(view.conceptsOf("ke_bbbbbbbbbbbb").map((c) => c.id).sort(), ["tactic-72h", "tool-x"]);
  assert.deepEqual(view.contradicting("tactic-48h"), ["tactic-72h"]);
  assert.deepEqual(view.contradicting("tactic-72h"), ["tactic-48h"], "an unfiled entry's concept counts too");
  assert.deepEqual(view.contradicting("tool-x"), []);
  assert.deepEqual(view.contradicting("nope"), []);
});
