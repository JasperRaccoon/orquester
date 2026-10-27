/**
 * `KnowledgeService` wiring of concept merges (phase 2 spec, "Concept merges"): the overlay file is
 * applied before linking loads the graph, the status counts the merges in effect, and undoing one
 * through the routes announces the graph change once.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import Fastify from "fastify";
import { KNOWLEDGE_CHANGED_EVENT, KNOWLEDGE_CHANNEL, knowledgeRoutes, type KnowledgeConceptMergesResponse, type KnowledgeStatus } from "@orquester/api";
import { knowledgeConceptMergesPath, knowledgeGraphPluginDir } from "@orquester/config";

import { FAKE_RUNTIME } from "./linking/testing.ts";
import { loadGraph, node, silentLogger } from "./search/test-fakes.ts";
import { KnowledgeService, type KnowledgeLinking, type KnowledgeLinkingFactory } from "./service.ts";
import { FakeKnowledgePlugins, FakeRuntime, fakeEmbedders } from "./test-fakes.ts";

/** Linking whose start saves two entries and loads a graph over them, as a run's graph load would. */
function graphLinking(): KnowledgeLinkingFactory {
  return ({ store, graph }) => {
    const linking: KnowledgeLinking = {
      events: new EventEmitter<{ status: [] }>(),
      start: async () => {
        const outcome = await store.save({
          entries: [
            { body: "Warm up the account for a week.", collections: ["SEO"] },
            { body: "Warm up TikTok accounts first.", collections: ["SEO"] }
          ],
          newCollections: [{ name: "SEO", description: "Search engines" }]
        });
        const [a, b] = outcome.results.map((r) => r.entryId);
        await loadGraph(graph, [node("tactic-warm-up", "Warm up TikTok account", [`${a}.md`]), node("tactic-warm-up-the", "Warm up the TikTok account", [`${b}.md`])]);
      },
      stop: async () => undefined,
      status: () => ({ state: "idle" }),
      entriesChanged: () => undefined,
      pairChecks: { all: () => [], get: () => null, onChange: () => () => {} },
      gapQueued: () => new Set(),
      snapshot: () => ({ linking: { state: "idle" }, lastRun: null, recentRuns: [], workers: [], tokens: { week: { in: 0, out: 0 }, total: { in: 0, out: 0 } }, lastError: null }),
      rebuild: async () => ({ queued: false, running: false }),
      rebuildEstimate: async () => ({ entries: 0, tasks: 0 }),
      isActiveWorker: () => false,
      workerNext: async () => ({ kind: "done", reason: "run-finished" }),
      workerSubmit: async () => ({ accepted: false, error: "x" })
    };
    return linking;
  };
}

async function harness(t: TestContext) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-service-concepts-"));
  await mkdir(knowledgeGraphPluginDir(appdir), { recursive: true });
  await writeFile(
    knowledgeConceptMergesPath(appdir),
    JSON.stringify({
      version: 1,
      merges: [{ id: "cm_warmup", type: "tactic", into: "tactic-warm-up", merged: ["tactic-warm-up-the"], similarity: 0.95, createdAt: "2026-10-27T10:00:00.000Z" }],
      rejected: []
    })
  );
  const runtime = new FakeRuntime();
  runtime.set(FAKE_RUNTIME);
  const events: { channel: string; type: string; payload: unknown }[] = [];
  const knowledge = new KnowledgeService({
    appdir,
    plugins: new FakeKnowledgePlugins(true),
    accounts: { list: () => ({ accounts: [] }) },
    session: () => null,
    profiles: { list: async () => ({ profiles: [], errors: [] }), read: async () => Promise.reject(new Error("no profiles")) },
    publisher: { publish: (channel: string, type: string, payload: unknown) => void events.push({ channel, type, payload }) },
    runtime,
    embedders: fakeEmbedders().factory,
    linking: graphLinking(),
    logger: silentLogger()
  });
  const app = Fastify();
  knowledge.registerRoutes(app);
  t.after(async () => {
    await app.close();
    await knowledge.stop();
    await rm(appdir, { recursive: true, force: true });
  });
  await knowledge.start();
  await knowledge.settled();
  return { knowledge, app, events };
}

const graphChanges = (events: { channel: string; type: string; payload: unknown }[]) =>
  events.filter((e) => e.channel === KNOWLEDGE_CHANNEL && e.type === KNOWLEDGE_CHANGED_EVENT && (e.payload as { graph?: boolean }).graph === true).length;

test("the merges file applies to the graph linking loads; the status counts the merges in effect", async (t) => {
  const h = await harness(t);
  assert.equal(h.knowledge.status().conceptMerges, 1);
  assert.equal(h.knowledge.status().concepts, 1);
  const status = (await h.app.inject({ method: "GET", url: knowledgeRoutes.status })).json() as KnowledgeStatus;
  assert.equal(status.conceptMerges, 1);
});

test("undoing a merge through the routes announces the graph change once and the status follows", async (t) => {
  const h = await harness(t);
  const list = (await h.app.inject({ method: "GET", url: knowledgeRoutes.conceptMerges })).json() as KnowledgeConceptMergesResponse;
  assert.deepEqual(
    list.merges.map((m) => m.id),
    ["cm_warmup"]
  );
  const before = graphChanges(h.events);
  const response = await h.app.inject({ method: "DELETE", url: knowledgeRoutes.conceptMerge("cm_warmup") });
  assert.equal(response.statusCode, 204, response.body);
  await h.knowledge.settled();
  assert.equal(graphChanges(h.events) - before, 1);
  assert.equal(h.knowledge.status().conceptMerges, 0);
  assert.equal(h.knowledge.status().concepts, 2);
});
