import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { WORKFLOW_NODE_TYPES } from "@orquester/config";
import {
  workflowRoutes,
  type CreateWorkflowRequest,
  type RunWorkflowRequest,
  type Workflow,
  type WorkflowWriteResponse
} from "@orquester/api";
import type { PersistedRun, WorkflowEngine } from "./contracts.ts";
import { FileRunStore } from "./run-store.ts";
import { deleteWorkflowCascade, registerWorkflowRoutes, type WorkflowRouteDeps } from "./routes.ts";
import { WorkflowEngineError } from "./run-context.ts";
import { WorkflowSecretsService } from "./secrets.ts";
import { WorkflowService } from "./service.ts";
import { buildWorkflowSummary } from "./summary.ts";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const quiet = { warn: () => undefined, error: () => undefined };

interface Harness {
  app: FastifyInstance;
  dir: string;
  service: WorkflowService;
  secrets: WorkflowSecretsService;
  runStore: FileRunStore;
  setEngine(engine: WorkflowEngine | null): void;
}

async function harness(options: { engine?: WorkflowEngine | null } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-routes-"));
  roots.push(dir);
  const secrets = new WorkflowSecretsService({ file: join(dir, "workflow-secrets.json"), logger: quiet });
  await secrets.load();
  const service = new WorkflowService({
    file: join(dir, "workflows.json"),
    logger: quiet,
    secretNames: (id) => secrets.names(id),
    savedPromptIds: () => ["prompt-1"]
  });
  await service.load();
  const runStore = new FileRunStore({ dir: join(dir, "workflow-runs"), logger: quiet });
  await runStore.init();
  let engine: WorkflowEngine | null = options.engine ?? null;
  const app = Fastify({ logger: false });
  const deps: WorkflowRouteDeps = {
    service,
    secrets,
    runStore,
    engine: () => engine,
    savedPromptIds: () => ["prompt-1"],
    logPollMs: 5
  };
  registerWorkflowRoutes(app, deps);
  await app.ready();
  apps.push(app);
  return { app, dir, service, secrets, runStore, setEngine: (next) => void (engine = next) };
}

function createBody(overrides: Partial<CreateWorkflowRequest> = {}): CreateWorkflowRequest {
  return {
    name: "Nightly",
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start" },
      { id: "c", type: "code", name: "Run" }
    ],
    edges: [{ source: "t", target: "c" }],
    ...overrides
  };
}

async function createWorkflow(h: Harness, overrides: Partial<CreateWorkflowRequest> = {}): Promise<Workflow> {
  const response = await h.app.inject({ method: "POST", url: workflowRoutes.create, payload: createBody(overrides) });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as WorkflowWriteResponse).workflow;
}

function persistedRun(workflow: Workflow, id: string, overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    version: 1,
    id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: "succeeded",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: "2026-09-28T10:00:00.000Z",
    definition: workflow,
    triggerPayload: { kind: "manual", input: null },
    blocks: {},
    takenEdges: [],
    deadEdges: [],
    depth: 0,
    ...overrides
  };
}

interface FakeEngine extends WorkflowEngine {
  calls: string[];
  live: boolean;
  logPath: string | null;
  cancelResult: boolean;
}

function fakeEngine(h: () => Harness): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    live: false,
    logPath: null,
    cancelResult: true,
    async run(workflowId: string, request: RunWorkflowRequest) {
      engine.calls.push(`run:${workflowId}:${JSON.stringify(request)}`);
      return { runId: "run-new" };
    },
    async testNode(workflowId: string, nodeId: string) {
      engine.calls.push(`test:${workflowId}:${nodeId}`);
      return { runId: "run-test" };
    },
    async cancel(runId: string) {
      engine.calls.push(`cancel:${runId}`);
      return engine.cancelResult;
    },
    async getRun() {
      return null;
    },
    async listRuns(workflowId, opts) {
      engine.calls.push(`listRuns:${workflowId}`);
      return h().runStore.listForWorkflow(workflowId, opts);
    },
    async nodeOutput(_runId, nodeId) {
      return nodeId === "c" ? { found: true, output: { from: "engine" } } : { found: false };
    },
    async nodeLogPath() {
      return engine.logPath;
    },
    isNodeLogLive() {
      return engine.live;
    },
    async deleteTempProject(runId) {
      engine.calls.push(`deleteTemp:${runId}`);
      return true;
    },
    async accountPreview(chain) {
      engine.calls.push(`preview:${chain.length}`);
      return { chosen: null, reason: "none", skipped: [] };
    },
    summarize(workflow) {
      return { ...buildWorkflowSummary(workflow, { runStore: h().runStore }), description: "from-engine" };
    },
    async resume() {},
    start() {},
    async stop() {}
  };
  return engine;
}

test("without the engine: acting routes answer 503 ENGINE_UNAVAILABLE", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h);
  await h.runStore.create(persistedRun(workflow, "run-1", { status: "running" }));
  const cases: [string, string, unknown?][] = [
    [workflowRoutes.run(workflow.id), "POST", {}],
    [workflowRoutes.testNode(workflow.id, "c"), "POST"],
    [workflowRoutes.runCancel("run-1"), "POST"],
    [workflowRoutes.runDeleteTempProject("run-1"), "POST"],
    [workflowRoutes.accountPreview, "POST", { chain: [] }]
  ];
  for (const [url, method, payload] of cases) {
    const response = await h.app.inject({ method: method as "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    assert.equal(response.statusCode, 503, url);
    assert.equal(response.json().error.code, "ENGINE_UNAVAILABLE", url);
  }
});

test("without the engine: history, run detail and outputs are read from the run store", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h);
  const whole = { text: "w".repeat(80 * 1024) };
  const outputFile = await h.runStore.writeOutputFile("run-1", "c", 1, whole);
  await h.runStore.create(
    persistedRun(workflow, "run-1", {
      blocks: {
        c: { nodeId: "c", name: "Run", type: "code", status: "succeeded", attempt: 1, output: { preview: true }, outputFile },
        t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "succeeded", attempt: 1, output: { kind: "manual", input: 1 } }
      }
    })
  );
  await h.runStore.create(persistedRun(workflow, "run-2", { queuedAt: "2026-09-28T11:00:00.000Z" }));

  const list = await h.app.inject({ url: `${workflowRoutes.runs(workflow.id)}?limit=1` });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().runs.map((r: { id: string }) => r.id), ["run-2"]);
  assert.equal(list.json().before, "run-2");
  const next = await h.app.inject({ url: `${workflowRoutes.runs(workflow.id)}?limit=1&before=run-2` });
  assert.deepEqual(next.json().runs.map((r: { id: string }) => r.id), ["run-1"]);

  const detail = await h.app.inject({ url: workflowRoutes.runDetail("run-1") });
  assert.equal(detail.statusCode, 200);
  const run = detail.json().run;
  assert.equal(run.blocks.c.outputTruncated, true);
  assert.equal(run.blocks.c.outputFile, undefined);
  assert.equal(run.version, undefined);

  const output = await h.app.inject({ url: workflowRoutes.nodeOutput("run-1", "c") });
  assert.deepEqual(output.json(), { output: whole });
  const trigger = await h.app.inject({ url: workflowRoutes.nodeOutput("run-1", "t") });
  assert.deepEqual(trigger.json(), { output: { kind: "manual", input: 1 } });
  assert.equal((await h.app.inject({ url: workflowRoutes.nodeOutput("run-1", "zz") })).json().error.code, "NODE_NOT_FOUND");
  assert.equal((await h.app.inject({ url: workflowRoutes.runDetail("nope") })).json().error.code, "RUN_NOT_FOUND");
  assert.equal((await h.app.inject({ url: workflowRoutes.runs("nope") })).statusCode, 404);
});

test("definitions: create, read, replace (409 on a stale revision), patch, duplicate, validate", async () => {
  const h = await harness();
  const created = await createWorkflow(h);
  const read = await h.app.inject({ url: workflowRoutes.workflow(created.id) });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().workflow.id, created.id);
  assert.ok(Array.isArray(read.json().problems));

  const { id: _i, revision: _r, createdAt: _c, updatedAt: _u, ...body } = created;
  const replaced = await h.app.inject({
    method: "PUT",
    url: workflowRoutes.workflow(created.id),
    payload: { revision: 0, workflow: { ...body, name: "Renamed" } }
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().workflow.revision, 1);
  const stale = await h.app.inject({ method: "PUT", url: workflowRoutes.workflow(created.id), payload: { revision: 0, workflow: body } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "REVISION_CONFLICT");
  assert.match(stale.json().error.message, /current revision is 1/);

  const enable = await h.app.inject({
    method: "POST",
    url: workflowRoutes.patch(created.id),
    payload: { revision: 1, ops: [{ op: "add_node", node: { type: "workflow", name: "Child" } }, { op: "set_enabled", enabled: true }] }
  });
  assert.equal(enable.statusCode, 400);
  assert.equal(enable.json().error.code, "INVALID_WORKFLOW");
  assert.ok(enable.json().error.problems.some((p: { code: string }) => p.code === "subworkflow_unset"));

  const patched = await h.app.inject({
    method: "POST",
    url: workflowRoutes.patch(created.id),
    payload: { revision: 1, ops: [{ op: "set_enabled", enabled: true }] }
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().workflow.enabled, true);

  const duplicate = await h.app.inject({ method: "POST", url: workflowRoutes.duplicate(created.id) });
  assert.equal(duplicate.statusCode, 201);
  assert.equal(duplicate.json().workflow.name, "Renamed (copy)");
  assert.equal(duplicate.json().workflow.enabled, false);

  const validate = await h.app.inject({
    method: "POST",
    url: workflowRoutes.validate,
    payload: { workflow: { ...created, nodes: [...created.nodes, { id: "a", type: "agent", name: "Agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "saved", promptId: "missing" }, chain: [{ agent: "claude", model: "opus" }] } }] } }
  });
  assert.equal(validate.statusCode, 200);
  assert.ok(validate.json().problems.some((p: { code: string }) => p.code === "unknown_saved_prompt"));
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.validate, payload: {} })).statusCode, 400);

  assert.equal((await h.app.inject({ url: workflowRoutes.workflow("nope") })).json().error.code, "WORKFLOW_NOT_FOUND");
});

test("the list filters by project: the existing project, plus temp workflows of its workspace", async () => {
  const h = await harness();
  const mine = await createWorkflow(h, { name: "Mine" });
  const temp = await createWorkflow(h, { name: "Temp", project: { kind: "temp", workspace: "ws", source: { kind: "empty" } } });
  await createWorkflow(h, { name: "Other", project: { kind: "existing", projectPath: "/w/ws/other" } });
  await createWorkflow(h, { name: "Elsewhere", project: { kind: "temp", workspace: "ws2", source: { kind: "empty" } } });

  const all = await h.app.inject({ url: workflowRoutes.list });
  assert.equal(all.json().workflows.length, 4);
  const filtered = await h.app.inject({ url: `${workflowRoutes.list}?projectPath=${encodeURIComponent("/w/ws/app")}` });
  assert.deepEqual(filtered.json().workflows.map((w: { id: string }) => w.id).sort(), [mine.id, temp.id].sort());
  const row = filtered.json().workflows.find((w: { id: string }) => w.id === mine.id);
  assert.deepEqual(row.triggers.map((t: { text: string }) => t.text), ["Run manually"]);
  assert.equal(row.nodeCount, 2);
  assert.equal(row.errorCount, 0);
});

test("block types and the schedule preview", async () => {
  const h = await harness();
  const types = await h.app.inject({ url: workflowRoutes.blockTypes });
  assert.equal(types.statusCode, 200);
  const body = types.json();
  assert.deepEqual(body.types.map((t: { type: string }) => t.type), [...WORKFLOW_NODE_TYPES]);
  for (const type of body.types) {
    const schema = type.configSchema as { type?: string; anyOf?: unknown[] };
    assert.ok(schema.type === "object" || Array.isArray(schema.anyOf), type.type);
  }
  assert.deepEqual(body.types.find((t: { type: string }) => t.type === "if").handles, ["true", "false", "error"]);
  assert.match(body.expressionGuide, /Expressions/);

  const preview = await h.app.inject({ url: `${workflowRoutes.schedulePreview}?cron=${encodeURIComponent("*/15 * * * *")}&tz=UTC&count=3` });
  assert.equal(preview.json().valid, true);
  assert.equal(preview.json().next.length, 3);
  const capped = await h.app.inject({ url: `${workflowRoutes.schedulePreview}?cron=${encodeURIComponent("0 * * * *")}&count=500` });
  assert.equal(capped.json().next.length, 20);
  const invalid = await h.app.inject({ url: `${workflowRoutes.schedulePreview}?cron=nope` });
  assert.equal(invalid.json().valid, false);
  assert.equal(typeof invalid.json().error, "string");
  assert.deepEqual(invalid.json().next, []);
});

test("secrets: names only, write-only values, scoped to an existing workflow", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h);
  const put = await h.app.inject({ method: "PUT", url: workflowRoutes.secret("API_KEY"), payload: { value: "sekret-value" } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().secrets.map((s: { name: string }) => s.name), ["API_KEY"]);
  const own = await h.app.inject({
    method: "PUT",
    url: `${workflowRoutes.secret("API_KEY")}?workflowId=${workflow.id}`,
    payload: { value: "own-value" }
  });
  assert.equal(own.statusCode, 200);
  const list = await h.app.inject({ url: `${workflowRoutes.secrets}?workflowId=${workflow.id}` });
  assert.deepEqual(list.json().secrets.map((s: { scope: string }) => s.scope), ["global", "workflow"]);
  assert.ok(!list.body.includes("sekret") && !list.body.includes("own-value"));

  assert.equal((await h.app.inject({ method: "PUT", url: `${workflowRoutes.secret("X_Y")}?workflowId=nope`, payload: { value: "v" } })).statusCode, 404);
  const bad = await h.app.inject({ method: "PUT", url: workflowRoutes.secret("bad-name"), payload: { value: "v" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, "SECRET_INVALID");
  assert.equal((await h.app.inject({ method: "PUT", url: workflowRoutes.secret("NO_VALUE"), payload: {} })).json().error.code, "SECRET_INVALID");
  assert.equal((await h.app.inject({ method: "DELETE", url: workflowRoutes.secret("API_KEY") })).statusCode, 204);
  assert.deepEqual(h.secrets.resolve(workflow.id), { API_KEY: "own-value" });
});

test("delete cascades: active runs cancelled through the engine, runs and secrets removed", async () => {
  let h!: Harness;
  const engine = fakeEngine(() => h);
  h = await harness({ engine });
  const workflow = await createWorkflow(h);
  const keep = await createWorkflow(h, { name: "Keep" });
  await h.runStore.create(persistedRun(workflow, "run-active", { status: "running" }));
  await h.runStore.create(persistedRun(workflow, "run-done"));
  await h.runStore.create(persistedRun(keep, "run-keep"));
  await h.secrets.set("OWN", "value-1", workflow.id);
  await h.secrets.set("GLOBAL", "value-2");

  const stale = await h.app.inject({ method: "DELETE", url: `${workflowRoutes.workflow(workflow.id)}?revision=7` });
  assert.equal(stale.statusCode, 409);
  const response = await h.app.inject({ method: "DELETE", url: workflowRoutes.workflow(workflow.id) });
  assert.equal(response.statusCode, 204);
  assert.deepEqual(engine.calls, ["cancel:run-active"]);
  assert.equal(h.service.get(workflow.id), null);
  assert.deepEqual((await readdir(join(h.dir, "workflow-runs"))).filter((n) => n.startsWith("run-")), ["run-keep"]);
  assert.deepEqual(h.secrets.resolve(workflow.id), { GLOBAL: "value-2" });
});

test("with the engine: runs, tests, cancels and summaries go through it", async () => {
  let h!: Harness;
  const engine = fakeEngine(() => h);
  h = await harness({ engine });
  const workflow = await createWorkflow(h);
  await h.runStore.create(persistedRun(workflow, "run-1", { status: "running" }));

  const run = await h.app.inject({ method: "POST", url: workflowRoutes.run(workflow.id), payload: { input: { a: 1 }, force: true } });
  assert.deepEqual(run.json(), { runId: "run-new" });
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.run("nope"), payload: {} })).statusCode, 404);
  assert.deepEqual((await h.app.inject({ method: "POST", url: workflowRoutes.testNode(workflow.id, "c") })).json(), { runId: "run-test" });
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.testNode(workflow.id, "zz") })).json().error.code, "NODE_NOT_FOUND");
  assert.deepEqual((await h.app.inject({ method: "POST", url: workflowRoutes.runCancel("run-1") })).json(), { cancelled: true });
  engine.cancelResult = false;
  const notActive = await h.app.inject({ method: "POST", url: workflowRoutes.runCancel("run-1") });
  assert.equal(notActive.statusCode, 409);
  assert.equal(notActive.json().error.code, "RUN_NOT_ACTIVE");
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.runCancel("nope") })).statusCode, 404);
  assert.deepEqual((await h.app.inject({ method: "POST", url: workflowRoutes.runDeleteTempProject("run-1") })).json(), { deleted: true });
  const preview = await h.app.inject({ method: "POST", url: workflowRoutes.accountPreview, payload: { chain: [{ agent: "claude", model: "opus" }] } });
  assert.equal(preview.json().decision.reason, "none");
  assert.deepEqual((await h.app.inject({ url: workflowRoutes.nodeOutput("run-1", "c") })).json(), { output: { from: "engine" } });

  const list = await h.app.inject({ url: workflowRoutes.list });
  assert.equal(list.json().workflows[0].description, "from-engine");
  assert.equal(list.json().workflows[0].activeRuns.length, 1);
  assert.ok(engine.calls.includes(`run:${workflow.id}:${JSON.stringify({ input: { a: 1 }, force: true })}`));
});

test("log windows are redacted and report their position", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h);
  await h.secrets.set("KEY", "hunter22", workflow.id);
  await h.runStore.create(
    persistedRun(workflow, "run-1", { blocks: { c: { nodeId: "c", name: "Run", type: "code", status: "succeeded", attempt: 1 } } })
  );
  const attempt = await h.runStore.attemptDir("run-1", "c", 1);
  await writeFile(join(attempt, "stdout.log"), "token hunter22 done\n");
  const window = await h.app.inject({ url: `${workflowRoutes.nodeLog("run-1", "c")}?stream=stdout` });
  assert.equal(window.statusCode, 200);
  assert.equal(window.body, "token «secret:KEY» done\n");
  assert.equal(window.headers["x-log-eof"], "1");
  assert.equal(window.headers["x-log-next-offset"], String(Buffer.byteLength("token hunter22 done\n")));
  assert.equal(window.headers["x-log-live"], "0");
  const empty = await h.app.inject({ url: `${workflowRoutes.nodeLog("run-1", "c")}?stream=stderr` });
  assert.equal(empty.body, "");
  assert.equal((await h.app.inject({ url: `${workflowRoutes.nodeLog("run-1", "c")}?stream=both` })).statusCode, 400);
  assert.equal((await h.app.inject({ url: workflowRoutes.nodeLog("nope", "c") })).statusCode, 404);
});

test("log follow streams as the file grows and redacts a secret split across writes", async () => {
  let h!: Harness;
  const engine = fakeEngine(() => h);
  h = await harness({ engine });
  const workflow = await createWorkflow(h);
  await h.secrets.set("KEY", "hunter22", workflow.id);
  await h.runStore.create(persistedRun(workflow, "run-1", { status: "running" }));
  const logDir = join(h.dir, "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, "stdout.log");
  await writeFile(logPath, "first line\n");
  engine.logPath = logPath;
  engine.live = true;

  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = h.app.server.address() as AddressInfo;
  const chunks: string[] = [];
  const body = await new Promise<string>((resolveBody, reject) => {
    const request = httpGet({ host: "127.0.0.1", port, agent: false, path: `${workflowRoutes.nodeLog("run-1", "c")}?follow=1` }, (response) => {
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["content-type"]), /text\/plain/);
      response.setEncoding("utf8");
      let wrote = false;
      response.on("data", (chunk: string) => {
        chunks.push(chunk);
        // The first chunk is the file's head: a live log's last bytes (a possible secret prefix)
        // are held back until more arrives or the log stops growing.
        if (!wrote) {
          wrote = true;
          // The writer continues while the client follows, splitting the secret across two writes.
          void (async () => {
            await appendFile(logPath, "token=hun");
            await appendFile(logPath, "ter22 end\n");
            engine.live = false;
          })().catch(reject);
        }
      });
      response.on("end", () => resolveBody(chunks.join("")));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  assert.equal(body, "first line\ntoken=«secret:KEY» end\n");
  assert.ok(chunks.length >= 2, "streamed in more than one chunk");
  assert.ok(!chunks.some((chunk) => chunk.includes("hun") && !chunk.includes("«secret")), "no half of the secret leaked");
});

// ---- Review fixes -------------------------------------------------------------------------------

test("an engine refusal keeps its status, code and problems (never a generic 500)", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h);
  const engine = fakeEngine(() => h);
  engine.run = async () => {
    throw new WorkflowEngineError(400, "INVALID_WORKFLOW", "The workflow has errors: x", [{ severity: "error", code: "schema", message: "x" }]);
  };
  engine.testNode = async () => {
    throw new WorkflowEngineError(503, "ENGINE_UNAVAILABLE", "stopping");
  };
  h.setEngine(engine);
  const run = await h.app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/run`, payload: {} });
  assert.equal(run.statusCode, 400);
  assert.deepEqual(run.json(), { error: { code: "INVALID_WORKFLOW", message: "The workflow has errors: x", problems: [{ severity: "error", code: "schema", message: "x" }] } });
  const tested = await h.app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/nodes/c/test` });
  assert.equal(tested.statusCode, 503);
  assert.equal(tested.json().error.code, "ENGINE_UNAVAILABLE");
});

test("DELETE of a secret refuses prototype names and unknown workflows; Object.prototype is untouched", async () => {
  const h = await harness();
  const polluted = await h.app.inject({ method: "DELETE", url: "/api/workflow-secrets/hasOwnProperty?workflowId=__proto__" });
  assert.equal(polluted.statusCode, 404);
  assert.equal(polluted.json().error.code, "WORKFLOW_NOT_FOUND");
  const badName = await h.app.inject({ method: "DELETE", url: "/api/workflow-secrets/hasOwnProperty" });
  assert.equal(badName.statusCode, 400);
  assert.equal(typeof Object.prototype.hasOwnProperty, "function");
  assert.equal(await h.secrets.delete("hasOwnProperty", "__proto__"), false);
  assert.equal(typeof Object.prototype.hasOwnProperty, "function");
});

test("validate returns at once past the hard limits (5 000 blocks)", async () => {
  const h = await harness();
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, type: "code", name: `N${i}`, position: { x: 0, y: 0 }, config: { source: "" } }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: `n${i}`, sourceHandle: "success", target: n.id }));
  const started = Date.now();
  const res = await h.app.inject({ method: "POST", url: workflowRoutes.validate, payload: { workflow: { id: "w", name: "Big", project: { kind: "existing", projectPath: "/w/ws/app" }, nodes, edges } } });
  assert.equal(res.statusCode, 200);
  assert.ok(Date.now() - started < 3_000, `answered in ${Date.now() - started} ms`);
  const codes = (res.json().problems as { code: string }[]).map((p) => p.code);
  assert.ok(codes.includes("too_many_nodes") && codes.includes("too_many_edges"), codes.join(","));
});

test("write routes take a body past 1 MiB, and one past their limit answers LIMIT_EXCEEDED", async () => {
  const h = await harness();
  const big = "x".repeat(1_500_000);
  const accepted = await h.app.inject({ method: "POST", url: workflowRoutes.validate, payload: { workflow: { name: "W", description: big } } });
  assert.equal(accepted.statusCode, 200, "1.5 MiB reaches the handler");
  const huge = "x".repeat(3_200_000);
  const refused = await h.app.inject({ method: "POST", url: workflowRoutes.create, payload: { name: "W", description: huge } });
  assert.equal(refused.statusCode, 413);
  assert.equal(refused.json().error.code, "LIMIT_EXCEEDED");
});

test("account-preview refuses a chain entry it cannot read (400, never 500)", async () => {
  const h = await harness();
  h.setEngine(fakeEngine(() => h));
  const res = await h.app.inject({ method: "POST", url: workflowRoutes.accountPreview, payload: { chain: [null] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, "INVALID_REQUEST");
  assert.match(res.json().error.message, /^chain\[0\]/);
});

test("the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can", async () => {
  for (const withProjects of [false, true]) {
    const h = await harness();
    const workflow = await createWorkflow(h);
    await h.runStore.create(persistedRun(workflow, "kept", { status: "failed", tempProject: { path: "/w/ws/wf-kept", deleted: false, deleteAfter: "2026-10-01T00:00:00.000Z" } }));
    await h.runStore.create(persistedRun(workflow, "plain", { status: "succeeded" }));
    const deleted: string[] = [];
    await deleteWorkflowCascade(
      {
        service: h.service,
        secrets: h.secrets,
        runStore: h.runStore,
        engine: () => null,
        ...(withProjects ? { projects: { deleteProject: async (path: string) => void deleted.push(path) } } : {})
      },
      workflow.id
    );
    assert.equal(await h.runStore.load("plain"), null);
    if (withProjects) {
      assert.deepEqual(deleted, ["/w/ws/wf-kept"]);
      assert.equal(await h.runStore.load("kept"), null);
    } else {
      const kept = await h.runStore.load("kept");
      assert.ok(kept, "the only record naming the directory stays");
      assert.equal(kept.tempProject?.deleted, false);
      assert.ok(Date.parse(kept.tempProject!.deleteAfter!) <= Date.now(), "due for the sweeper now");
      assert.ok(h.runStore.workflowIds().includes(workflow.id), "the sweeper still finds it");
    }
  }
});
