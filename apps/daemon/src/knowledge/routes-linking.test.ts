import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, knowledgeRoutes, type SessionOwner } from "@orquester/api";
import type { KnowledgeLinkingSnapshot } from "./linking/service.ts";
import {
  KNOWLEDGE_WORKER_ANSWER_MAX,
  publishKnowledgeStatus,
  registerKnowledgeLinkingRoutes,
  type KnowledgeLinkingRouteService,
  type KnowledgeStatusCounts
} from "./routes-linking.ts";

const SNAPSHOT: KnowledgeLinkingSnapshot = {
  linking: { state: "idle" },
  lastRun: null,
  recentRuns: [],
  workers: [],
  tokens: { week: { in: 1, out: 2 }, total: { in: 3, out: 4 } },
  lastError: null
};

function setup(options: { counts?: Partial<KnowledgeStatusCounts>; owners?: Record<string, SessionOwner> } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const linking: KnowledgeLinkingRouteService = {
    snapshot: () => SNAPSHOT,
    rebuild: async () => {
      calls.push({ method: "rebuild", args: [] });
      return { queued: false, running: true };
    },
    rebuildEstimate: async () => ({ entries: 2, tasks: 7 }),
    isActiveWorker: (owner) => owner?.kind === "knowledge-indexer" && owner.runId === "kr_live",
    workerNext: async (sessionId) => {
      calls.push({ method: "next", args: [sessionId] });
      return { kind: "done", reason: "run-finished" };
    },
    workerSubmit: async (sessionId, taskId, answer) => {
      calls.push({ method: "submit", args: [sessionId, taskId, answer] });
      return { accepted: false, error: "nope" };
    }
  };
  const counts: KnowledgeStatusCounts = { enabled: true, installed: true, entries: 5, concepts: 9, edges: 4, collections: 2, ...options.counts };
  const app: FastifyInstance = Fastify();
  // The daemon stamps `request.principal` server-side; the test reads it off a header.
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request) => {
    const thread = request.headers["x-test-agent"];
    (request as { principal?: unknown }).principal = typeof thread === "string" ? { kind: "agent", threadId: thread, projectPath: "" } : { kind: "user" };
  });
  registerKnowledgeLinkingRoutes(app, { linking, counts: () => counts, sessionOwner: (id) => options.owners?.[id] });
  return { app, calls };
}

const WORKER: SessionOwner = { kind: "knowledge-indexer", runId: "kr_live" };

describe("knowledge linking routes", () => {
  it("status is the linking snapshot plus the injected counts", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: knowledgeRoutes.status });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { enabled: true, installed: true, entries: 5, concepts: 9, edges: 4, collections: 2, ...SNAPSHOT });
  });

  it("rebuild is refused while the plugin is off or not installed, else starts and answers the status", async () => {
    const off = setup({ counts: { enabled: false } });
    const refused = await off.app.inject({ method: "POST", url: knowledgeRoutes.rebuild });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "KNOWLEDGE_DISABLED");
    const missing = setup({ counts: { installed: false } });
    assert.equal((await missing.app.inject({ method: "POST", url: knowledgeRoutes.rebuild })).json().code, "KNOWLEDGE_NOT_INSTALLED");
    const on = setup();
    const res = await on.app.inject({ method: "POST", url: knowledgeRoutes.rebuild });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().entries, 5);
    assert.deepEqual(on.calls, [{ method: "rebuild", args: [] }]);
    assert.deepEqual((await on.app.inject({ method: "GET", url: knowledgeRoutes.rebuildEstimate })).json(), { entries: 2, tasks: 7 });
  });

  it("worker routes refuse any session that is not a worker chat of the run in flight", async () => {
    const { app, calls } = setup({
      owners: {
        old: { kind: "knowledge-indexer", runId: "kr_old" },
        wf: { kind: "workflow", workflowId: "w", runId: "kr_live", nodeId: "n" }
      }
    });
    for (const sessionId of ["plain", "old", "wf"]) {
      const res = await app.inject({ method: "POST", url: knowledgeRoutes.workerNext, headers: { "x-test-agent": sessionId }, payload: {} });
      assert.equal(res.statusCode, 403, sessionId);
      assert.equal(res.json().code, "KNOWLEDGE_NOT_A_WORKER");
    }
    const submit = await app.inject({ method: "POST", url: knowledgeRoutes.workerSubmit, headers: { "x-test-agent": "plain" }, payload: { taskId: "t", answer: "{}" } });
    assert.equal(submit.json().code, "KNOWLEDGE_NOT_A_WORKER");
    assert.deepEqual(calls, []);
  });

  it("the calling chat is the agent principal's, never a session id the body claims", async () => {
    const { app, calls } = setup({ owners: { worker: WORKER } });
    const spoof = await app.inject({ method: "POST", url: knowledgeRoutes.workerNext, headers: { "x-test-agent": "intruder" }, payload: { sessionId: "worker" } });
    assert.equal(spoof.statusCode, 403);
    const own = await app.inject({ method: "POST", url: knowledgeRoutes.workerNext, headers: { "x-test-agent": "worker" }, payload: {} });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.json(), { kind: "done", reason: "run-finished" });
    const bodyOnly = await app.inject({ method: "POST", url: knowledgeRoutes.workerNext, payload: { sessionId: "worker" } });
    assert.equal(bodyOnly.statusCode, 403, "a session id in the body alone never makes a worker");
    assert.deepEqual(calls.map((c) => c.args[0]), ["worker"]);
  });

  it("submit checks its body before the broker sees it", async () => {
    const { app, calls } = setup({ owners: { worker: WORKER } });
    const noTask = await app.inject({ method: "POST", url: knowledgeRoutes.workerSubmit, headers: { "x-test-agent": "worker" }, payload: { answer: "{}" } });
    assert.equal(noTask.statusCode, 400);
    const noAnswer = await app.inject({ method: "POST", url: knowledgeRoutes.workerSubmit, headers: { "x-test-agent": "worker" }, payload: { taskId: "t" } });
    assert.equal(noAnswer.statusCode, 400);
    const huge = await app.inject({
      method: "POST",
      url: knowledgeRoutes.workerSubmit,
      headers: { "x-test-agent": "worker" },
      payload: { taskId: "t", answer: "x".repeat(KNOWLEDGE_WORKER_ANSWER_MAX + 1) }
    });
    assert.equal(huge.statusCode, 413);
    assert.equal(huge.json().code, "KNOWLEDGE_TOO_LARGE");
    const ok = await app.inject({ method: "POST", url: knowledgeRoutes.workerSubmit, headers: { "x-test-agent": "worker" }, payload: { taskId: "t", answer: "{}" } });
    assert.deepEqual(ok.json(), { accepted: false, error: "nope" });
    assert.deepEqual(calls, [{ method: "submit", args: ["worker", "t", "{}"] }]);
  });

  it("publishes the whole status on every linking change", () => {
    const events = new EventEmitter<{ status: [] }>();
    const published: { channel: string; type: string; payload: unknown }[] = [];
    const off = publishKnowledgeStatus(
      { events, snapshot: () => SNAPSHOT },
      { publish: (channel, type, payload) => published.push({ channel, type, payload }) },
      () => ({ enabled: true, installed: false, entries: 0, concepts: 0, edges: 0, collections: 0 })
    );
    events.emit("status");
    assert.equal(published.length, 1);
    assert.equal(published[0]!.channel, KNOWLEDGE_CHANNEL);
    assert.equal(published[0]!.type, KNOWLEDGE_STATUS_EVENT);
    assert.equal((published[0]!.payload as { installed: boolean }).installed, false);
    off();
    events.emit("status");
    assert.equal(published.length, 1);
  });
});
