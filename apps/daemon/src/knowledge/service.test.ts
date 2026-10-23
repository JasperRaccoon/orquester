/**
 * `KnowledgeService` lifecycle and seams: nothing opens while the plugin is off, switching it opens
 * and closes everything (linking first, the embedder released), a knowledge base that cannot open
 * answers cleanly and is retried, the linking slot (placeholder states, the factory's context, a
 * late attach), the profile cache behind the collection views, and which routes each transport has.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import Fastify from "fastify";
import { KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, knowledgeRoutes, type KnowledgeStatus } from "@orquester/api";
import { knowledgeEntriesDir, knowledgeGraphPluginDir } from "@orquester/config";

import type { KnowledgeEntryChange, KnowledgeLinkingContext, KnowledgeLinkingModule } from "./ports.ts";
import { silentLogger } from "./search/test-fakes.ts";
import { KnowledgeService, type KnowledgeServiceOptions } from "./service.ts";
import { FakeKnowledgePlugins, FakeRuntime, fakeEmbedders } from "./test-fakes.ts";

const RUNTIME = {
  mykgVersion: "0.4.10",
  mykgBin: "/x/mykg",
  pythonBin: "/x/python",
  embeddingModelDir: "/x/models",
  embeddingModelId: "Xenova/all-MiniLM-L6-v2",
  embeddingDimensions: 384
};

async function harness(t: TestContext, options: { enabled?: boolean; over?: Partial<KnowledgeServiceOptions> } = {}) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-service-"));
  const plugins = new FakeKnowledgePlugins(options.enabled ?? false);
  const runtime = new FakeRuntime();
  const embedders = fakeEmbedders();
  const events: { channel: string; type: string; payload: unknown }[] = [];
  const profileReads = { list: 0 };
  let pushes = 0;
  const knowledge = new KnowledgeService({
    appdir,
    plugins,
    accounts: { getRecord: () => undefined },
    session: () => null,
    profiles: {
      list: async () => {
        profileReads.list += 1;
        return { profiles: [], errors: [] };
      },
      read: async () => {
        throw new Error("no profiles");
      }
    },
    publisher: { publish: (channel, type, payload) => events.push({ channel, type, payload }) },
    toolsChanged: () => {
      pushes += 1;
    },
    runtime,
    embedders: embedders.factory,
    logger: silentLogger(),
    ...options.over
  });
  const app = Fastify();
  knowledge.registerRoutes(app, { socket: true });
  t.after(async () => {
    await app.close();
    await knowledge.stop();
    await rm(appdir, { recursive: true, force: true });
  });
  const inject = async (method: "GET" | "POST", url: string, payload?: object) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null };
  };
  const statuses = () => events.filter((e) => e.channel === KNOWLEDGE_CHANNEL && e.type === KNOWLEDGE_STATUS_EVENT).map((e) => e.payload as KnowledgeStatus);
  return { appdir, plugins, runtime, embedders, knowledge, inject, events, statuses, profileReads, pushes: () => pushes };
}

/** A linking module that records what the service does with it. */
function recordingLinking() {
  const log: string[] = [];
  const contexts: KnowledgeLinkingContext[] = [];
  const changes: KnowledgeEntryChange[] = [];
  const factory = (context: KnowledgeLinkingContext): KnowledgeLinkingModule => {
    const n = contexts.push(context);
    log.push(`build ${n}`);
    return {
      status: () => ({ state: "idle" }),
      entriesChanged: (change) => changes.push(change),
      start: async () => void log.push(`start ${n}`),
      stop: async () => void log.push(`stop ${n}`),
      report: () => ({ lastRun: null, recentRuns: [], workers: [], tokens: { week: { in: 1, out: 2 }, total: { in: 3, out: 4 } }, lastError: null }),
      workerNext: async (sessionId) => {
        log.push(`next ${sessionId}`);
        return { kind: "done", reason: "run-finished" };
      }
    };
  };
  return { log, contexts, changes, factory };
}

test("with the plugin off nothing opens: no store directory, no embedder; data routes 409, settings and status answer", async (t) => {
  const h = await harness(t);
  await h.knowledge.start();
  await h.knowledge.settled();
  await assert.rejects(stat(knowledgeGraphPluginDir(h.appdir)), { code: "ENOENT" });
  assert.equal(h.embedders.made.length, 0);
  const search = await h.inject("POST", knowledgeRoutes.search, { query: "x" });
  assert.equal(search.status, 409);
  assert.equal(search.body!.code, "KNOWLEDGE_DISABLED");
  assert.equal((await h.inject("GET", knowledgeRoutes.collections)).status, 409);
  assert.equal((await h.inject("GET", knowledgeRoutes.rebuildEstimate)).body!.code, "KNOWLEDGE_DISABLED");
  assert.equal((await h.inject("GET", knowledgeRoutes.settings)).status, 200);
  const status = (await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus;
  assert.equal(status.enabled, false);
  assert.equal(status.linking.state, "paused");
  assert.equal(status.entries, 0);
});

test("switching the plugin on opens it (linking built and started), off closes it (linking stopped first, embedder released); manifests pushed each time", async (t) => {
  const linking = recordingLinking();
  const h = await harness(t, { over: { linking: linking.factory } });
  await h.knowledge.start();
  h.plugins.set(true);
  await h.knowledge.settled();
  assert.deepEqual(linking.log, ["build 1", "start 1"]);
  assert.equal(h.pushes(), 1);
  assert.equal(h.embedders.made.length, 1);
  const context = linking.contexts[0]!;
  assert.equal(context.appdir, h.appdir);
  assert.equal(context.settings.enabled(), true);
  assert.equal(context.runtime, h.runtime);
  assert.equal(context.api(), null);

  // Store changes reach linking; the status follows.
  const saved = await h.inject("POST", knowledgeRoutes.save, { entries: [{ body: "Budget caps while a campaign learns.", collections: ["Ads"] }], newCollections: [{ name: "Ads", description: "Paid." }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body!.linking, "not-needed", "the module reports idle");
  assert.deepEqual(linking.changes.map((c) => c.kind), ["added"]);
  await h.knowledge.settled();
  assert.equal(h.pushes(), 2, "the new collection pushed the manifests");
  const status = h.statuses().at(-1)!;
  assert.equal(status.entries, 1);
  assert.equal(status.collections, 1);
  assert.deepEqual(status.tokens, { week: { in: 1, out: 2 }, total: { in: 3, out: 4 } }, "the run history is linking's report");

  // The graph signal publishes knowledge.changed {graph:true}.
  context.graphChanged();
  assert.ok(h.events.some((e) => e.type === "knowledge.changed" && (e.payload as { graph?: boolean }).graph === true));

  h.plugins.set(false);
  await h.knowledge.settled();
  assert.deepEqual(linking.log, ["build 1", "start 1", "stop 1"]);
  assert.equal(h.embedders.disposed, 1);
  assert.equal(h.pushes(), 3);
  assert.equal((await h.inject("POST", knowledgeRoutes.search, { query: "budget" })).body!.code, "KNOWLEDGE_DISABLED");

  // On again: a new opening with a new module, the entry read back from disk.
  h.plugins.set(true);
  await h.knowledge.settled();
  assert.deepEqual(linking.log, ["build 1", "start 1", "stop 1", "build 2", "start 2"]);
  const hits = await h.inject("POST", knowledgeRoutes.search, { query: "budget" });
  assert.equal((hits.body!.hits as unknown[]).length, 1);

  await h.knowledge.stop();
  await h.knowledge.stop();
  assert.deepEqual(linking.log.slice(-1), ["stop 2"], "stop is idempotent");
});

test("a request opens the knowledge base when it was not open yet (before start)", async (t) => {
  const h = await harness(t, { enabled: true });
  const res = await h.inject("GET", knowledgeRoutes.collections);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await stat(knowledgeEntriesDir(h.appdir));
});

test("a knowledge base that cannot open: routes answer 500 KNOWLEDGE_ERROR, the status names it, and the next request retries", async (t) => {
  const h = await harness(t, { enabled: true });
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
  assert.equal(status.linking.state, "paused");
  assert.equal(status.linking.state === "paused" && status.linking.reason, "error");
  assert.ok(status.lastError);
  // The manifest read treats it as "no collections", never a throw.
  assert.deepEqual((await h.knowledge.knowledgeForSession("unknown")).visibleCollectionNames, []);

  await rm(knowledgeEntriesDir(h.appdir));
  const retried = await h.inject("POST", knowledgeRoutes.search, { query: "x" });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(((await h.inject("GET", knowledgeRoutes.status)).body as unknown as KnowledgeStatus).lastError, null);
});

test("the linking placeholder: not installed until the runtime is, then idle; changes are ignored", async (t) => {
  const h = await harness(t, { enabled: true });
  await h.knowledge.start();
  await h.knowledge.settled();
  const saved = await h.inject("POST", knowledgeRoutes.save, { entries: [{ body: "Raise spend after 50 conversions.", collections: ["Ads"] }], newCollections: [{ name: "Ads", description: "Paid." }] });
  assert.equal(saved.body!.linking, "queued");
  assert.deepEqual(h.knowledge.linkingStatus(), {
    state: "paused",
    reason: "not-installed",
    message: "The Knowledge Graph runtime is not installed yet; entries are linked once it is.",
    resumesAt: null,
    pendingEntries: 1
  });
  h.runtime.set(RUNTIME);
  assert.deepEqual(h.knowledge.linkingStatus(), { state: "idle" });
  await h.knowledge.settled();
  assert.equal(h.statuses().at(-1)!.installed, true, "a runtime change republishes the status");
});

test("attachLinking: an open knowledge base swaps its placeholder for the module; a second attach is refused; a factory that throws leaves a paused placeholder", async (t) => {
  const h = await harness(t, { enabled: true });
  await h.knowledge.start();
  await h.knowledge.settled();
  const linking = recordingLinking();
  await h.knowledge.attachLinking(linking.factory);
  assert.deepEqual(linking.log, ["build 1", "start 1"]);
  assert.deepEqual(h.knowledge.linkingStatus(), { state: "idle" });
  assert.throws(() => h.knowledge.attachLinking(linking.factory), /already attached/);

  const broken = await harness(t, { enabled: true, over: { linking: () => { throw new Error("no python"); } } });
  await broken.knowledge.start();
  await broken.knowledge.settled();
  const status = broken.knowledge.linkingStatus();
  assert.equal(status.state === "paused" && status.reason, "error");
  assert.equal((await broken.inject("GET", knowledgeRoutes.collections)).status, 200, "the data routes still serve");
});

test("worker routes: a non-worker is refused; a worker is handed to linking; the rebuild routes refuse while linking has none", async (t) => {
  const linking = recordingLinking();
  const sessions = new Map([["w1", { ownerKind: "knowledge-indexer" }]]);
  const h = await harness(t, { enabled: true, over: { linking: linking.factory, session: (id) => sessions.get(id) ?? null } });
  await h.knowledge.start();
  await h.knowledge.settled();
  const refused = await h.inject("POST", knowledgeRoutes.workerNext, { sessionId: "chat-1" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body!.code, "KNOWLEDGE_NOT_A_WORKER");
  assert.deepEqual((await h.inject("POST", knowledgeRoutes.workerNext, { sessionId: "w1" })).body, { kind: "done", reason: "run-finished" });
  assert.deepEqual(linking.log.at(-1), "next w1");
  // No submit handler: the worker is told to stop.
  assert.deepEqual((await h.inject("POST", knowledgeRoutes.workerSubmit, { sessionId: "w1", taskId: "t1", answer: "{}" })).body, { accepted: true, next: { kind: "done", reason: "run-cancelled" } });
  assert.equal((await h.inject("POST", knowledgeRoutes.rebuild)).body!.code, "KNOWLEDGE_NOT_INSTALLED");
});

test("the worker routes exist on the socket transport only", async (t) => {
  const h = await harness(t);
  const remote = Fastify();
  h.knowledge.registerRoutes(remote, { socket: false });
  t.after(() => remote.close());
  assert.equal((await remote.inject({ method: "POST", url: knowledgeRoutes.workerNext, payload: {} })).statusCode, 404);
  assert.equal((await remote.inject({ method: "GET", url: knowledgeRoutes.status })).statusCode, 200);
});

test("the profiles behind the collection views are listed once and reused until a profile event", async (t) => {
  const listeners: ((profileId: string) => void)[] = [];
  const h = await harness(t, { enabled: true, over: { onProfileChange: (listener) => (listeners.push(listener), () => undefined) } });
  await h.knowledge.start();
  await h.knowledge.settled();
  const baseline = h.profileReads.list;
  for (let i = 0; i < 5; i += 1) assert.equal((await h.inject("GET", knowledgeRoutes.collections)).status, 200);
  assert.equal(h.profileReads.list, baseline, "no listing per request");
  listeners[0]!("p1");
  await h.knowledge.settled();
  assert.equal(h.profileReads.list, baseline + 1, "an event re-lists once");
  await h.inject("GET", knowledgeRoutes.collections);
  assert.equal(h.profileReads.list, baseline + 1);
});
