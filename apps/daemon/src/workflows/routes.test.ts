import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  workflowRoutes,
  type CreateWorkflowRequest,
  type Workflow,
  type WorkflowWriteResponse
} from "@orquester/api";
import type { PersistedRun, WorkflowEngine } from "./contracts.ts";
import { FileRunStore } from "./run-store.ts";
import { registerWorkflowRoutes, type WorkflowRouteDeps } from "./routes.ts";
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

async function harness(options: { engine?: WorkflowEngine | null; projects?: WorkflowRouteDeps["projects"] } = {}): Promise<Harness> {
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
    ...(options.projects ? { projects: options.projects } : {})
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
    async run() {
      return { runId: "run-new" };
    },
    async testNode() {
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
    async deleteTempProject() {
      return true;
    },
    async accountPreview() {
      return { chosen: null, reason: "none", skipped: [] };
    },
    summarize(workflow) {
      return buildWorkflowSummary(workflow, { runStore: h().runStore });
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

test("validate uses the daemon's saved-prompt catalog and reports malformed or missing resources", async () => {
  const h = await harness();
  const created = await createWorkflow(h);
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
  assert.equal(row.nodeCount, 2);
  assert.equal(row.errorCount, 0);
});

test("block types and the schedule preview", async () => {
  const h = await harness();
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
  // Listing the deleted workflow's secrets is a 404, never the global list.
  const listed = await h.app.inject({ url: `${workflowRoutes.secrets}?workflowId=${workflow.id}` });
  assert.equal(listed.statusCode, 404);
  assert.equal(listed.json().error.code, "WORKFLOW_NOT_FOUND");
  assert.ok(!listed.body.includes("GLOBAL"));
  assert.equal((await h.app.inject({ url: `${workflowRoutes.secrets}?workflowId=never-was` })).json().error.code, "WORKFLOW_NOT_FOUND");
  assert.equal((await h.app.inject({ url: workflowRoutes.secrets })).statusCode, 200, "no workflowId: the global list");
});

test("with the engine: runs, tests, cancels and summaries go through it", async () => {
  let h!: Harness;
  const engine = fakeEngine(() => h);
  h = await harness({ engine });
  const workflow = await createWorkflow(h);
  await h.runStore.create(persistedRun(workflow, "run-1", { status: "running" }));

  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.run("nope"), payload: {} })).statusCode, 404);
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.testNode(workflow.id, "zz") })).json().error.code, "NODE_NOT_FOUND");
  engine.cancelResult = false;
  const notActive = await h.app.inject({ method: "POST", url: workflowRoutes.runCancel("run-1") });
  assert.equal(notActive.statusCode, 409);
  assert.equal(notActive.json().error.code, "RUN_NOT_ACTIVE");
  assert.equal((await h.app.inject({ method: "POST", url: workflowRoutes.runCancel("nope") })).statusCode, 404);

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

test("DELETE of a secret refuses prototype names and unknown workflows", async () => {
  const h = await harness();
  const polluted = await h.app.inject({ method: "DELETE", url: "/api/workflow-secrets/hasOwnProperty?workflowId=__proto__" });
  assert.equal(polluted.statusCode, 404);
  assert.equal(polluted.json().error.code, "WORKFLOW_NOT_FOUND");
  const badName = await h.app.inject({ method: "DELETE", url: "/api/workflow-secrets/hasOwnProperty" });
  assert.equal(badName.statusCode, 400);
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
});

test("the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can", async () => {
  for (const withProjects of [false, true]) {
    const deleted: string[] = [];
    const h = await harness(withProjects ? { projects: { deleteProject: async (path) => void deleted.push(path) } } : {});
    const workflow = await createWorkflow(h);
    await h.runStore.create(persistedRun(workflow, "kept", { status: "failed", tempProject: { path: "/w/ws/wf-kept", deleted: false, deleteAfter: "2026-10-01T00:00:00.000Z" } }));
    await h.runStore.create(persistedRun(workflow, "plain", { status: "succeeded" }));
    const response = await h.app.inject({ method: "DELETE", url: workflowRoutes.workflow(workflow.id) });
    assert.equal(response.statusCode, 204);
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

// ---- Expression preview ----------------------------------------------------------------------------

const SECRET = "SuperSecret1";

/** Start → Claude, Start → Count; Claude + Count → Join → Final; one finished run of it on record. */
async function previewHarness(): Promise<{ h: Harness; workflow: Workflow; preview: (body: Record<string, unknown>, id?: string) => Promise<{ status: number; body: any; raw: string }> }> {
  const h = await harness();
  await h.secrets.set("API_TOKEN", SECRET);
  const workflow = await createWorkflow(h, {
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start" },
      { id: "a", type: "code", name: "Claude" },
      { id: "b", type: "code", name: "Count" },
      { id: "m", type: "merge", name: "Join" },
      { id: "f", type: "code", name: "Final" }
    ],
    edges: [
      { source: "t", target: "a" },
      { source: "t", target: "b" },
      { source: "a", target: "m" },
      { source: "b", target: "m" },
      { source: "m", target: "f" }
    ]
  });
  const block = (nodeId: string, name: string, type: string, output: unknown) =>
    ({ nodeId, name, type, status: "succeeded", attempt: 1, output }) as PersistedRun["blocks"][string];
  await h.runStore.create(
    persistedRun(workflow, "run-1", {
      triggerPayload: { kind: "manual", input: { n: 5 } },
      blocks: {
        t: block("t", "Start", "trigger.manual", { kind: "manual", input: { n: 5 } }),
        a: block("a", "Claude", "code", { text: `Hello token=${SECRET} end`, score: 3 }),
        b: block("b", "Count", "code", 42),
        m: block("m", "Join", "merge", { Claude: { score: 3 }, Count: 42 }),
        f: block("f", "Final", "code", "done")
      }
    })
  );
  const preview = async (body: Record<string, unknown>, id = workflow.id) => {
    const response = await h.app.inject({ method: "POST", url: workflowRoutes.expressionPreview(id), payload: body });
    return { status: response.statusCode, body: response.json(), raw: response.body };
  };
  return { h, workflow, preview };
}

test("expression preview: returns node-relative data, missing/error state and source metadata", async () => {
  const { preview } = await previewHarness();
  const res = await preview({
    node: "Final",
    templates: [
      "Score: {{ nodes.Claude.output.score }}",
      "{{ nodes.Claude.output.nope }}",
      "{{ nodes.Claude. }}"
    ]
  });
  assert.equal(res.status, 200, res.raw);
  const [ok, missing, broken] = res.body.results;
  assert.deepEqual(ok, { text: "Score: 3", bytes: 8, warnings: [], errors: [] });
  assert.equal(missing.text, "");
  assert.equal(missing.warnings.length, 1);
  assert.equal(broken.errors.length, 1);
  assert.equal(broken.text, "{{ nodes.Claude. }}");
  assert.deepEqual(broken.warnings, [], "a parse error is in errors, not repeated in warnings");
  assert.deepEqual(res.body.source, { run: "reached-node", runId: "run-1", runStatus: "succeeded", runTest: false, runQueuedAt: "2026-09-28T10:00:00.000Z", pinned: [] });
  assert.deepEqual(res.body.node, { id: "f", name: "Final", type: "code" });
  const available = res.body.available;
  assert.deepEqual(Object.keys(available.nodes).sort(), ["Claude", "Count", "Join", "Start"], "Final itself is not readable from its own point of view");
  assert.deepEqual(available.nodes.Claude, { status: "succeeded", output: { type: "object", keys: { text: "string", score: "number" } } });
  assert.deepEqual(available.nodes.Count.output, { type: "number" });
  assert.deepEqual(available.input, { type: "object", keys: { Claude: "object (1 keys)", Count: "number" } });
  assert.deepEqual(available.secrets, ["API_TOKEN"]);
  assert.equal(available.project.name, "app");
  assert.equal(available.project.workspace, "ws");
});

test("expression preview: secrets render as placeholders and a secret inside an output is redacted", async () => {
  const { preview } = await previewHarness();
  for (const mode of ["text", "value"]) {
    const res = await preview({
      node: "Join",
      mode,
      templates: [
        "{{ secrets.API_TOKEN }}",
        "{{ nodes.Claude.output.text }}",
        "{{ nodes.Claude.output | json }}",
        "{{ nodes.Claude.output.text | upper }}",
        "{{ nodes.Claude.output }}",
        `literal ${SECRET}`
      ]
    });
    assert.equal(res.status, 200, res.raw);
    assert.ok(!res.raw.includes(SECRET), `${mode}: the secret value never leaves`);
    assert.ok(!res.raw.includes(SECRET.toUpperCase()), `${mode}: a transformed secret value never leaves either`);
    const [secret, text] = res.body.results;
    if (mode === "text") {
      assert.equal(secret.text, "«secret:API_TOKEN»");
      assert.equal(text.text, "Hello token=«secret:API_TOKEN» end");
    } else {
      assert.equal(secret.value, "«secret:API_TOKEN»");
      assert.deepEqual(res.body.results[4].value, { text: "Hello token=«secret:API_TOKEN» end", score: 3 });
    }
  }
});

test("expression preview: the block's point of view decides input; several inputs are keyed by name", async () => {
  const { preview } = await previewHarness();
  const fromClaude = await preview({ node: "a", templates: ["{{ input.input.n }}", "{{ nodes.Final.output }}", "{{ nodes.Claude.output }}"] });
  assert.equal(fromClaude.body.results[0].text, "5");
  assert.equal(fromClaude.body.results[1].text, "");
  assert.ok(fromClaude.body.results[1].warnings.length > 0);
  assert.ok(fromClaude.body.results[2].warnings.length > 0);
  const fromJoin = await preview({ node: "Join", mode: "value", templates: ["{{ input }}", "{{ input.Count }}"] });
  assert.deepEqual(fromJoin.body.results[0].value, { Claude: { text: "Hello token=«secret:API_TOKEN» end", score: 3 }, Count: 42 });
  assert.equal(fromJoin.body.results[1].value, 42);
  const fromFinal = await preview({ node: "Final", templates: ["{{ input.Count }}"] });
  assert.equal(fromFinal.body.results[0].text, "42");
  const none = await preview({ templates: ["{{ input }}"] });
  assert.equal(none.body.node, null);
});

test("expression preview: value mode keeps a number a number and says when nothing was read", async () => {
  const { preview } = await previewHarness();
  const res = await preview({ node: "Final", mode: "value", templates: ["{{ nodes.Count.output }}", " {{ nodes.Count.nope }} ", "n={{ nodes.Count.output }}", "{{ nodes.Join.output.Count | json }}"] });
  const [number, missing, text, json] = res.body.results;
  assert.deepEqual(number, { value: 42, valueType: "number", bytes: 2, warnings: [], errors: [] });
  assert.equal(missing.missing, true);
  assert.equal(missing.value, undefined);
  assert.equal(missing.warnings.length, 1);
  assert.deepEqual([text.value, text.valueType], ["n=42", "string"]);
  assert.deepEqual([json.value, json.valueType], ["42", "string"]);
});

test("expression preview: pinned outputs replace recorded ones; with no run they are the only data", async () => {
  const { h, workflow, preview } = await previewHarness();
  await h.service.patch(workflow.id, { revision: workflow.revision, ops: [{ op: "set_pinned", node: "Count", output: 7 }, { op: "set_pinned", node: "Final", output: "pinned-final" }] });
  const res = await preview({ node: "Join", usePinned: true, templates: ["{{ nodes.Count.output }}", "{{ input.Count }}", "{{ nodes.Claude.output.score }}"] });
  assert.deepEqual(res.body.results.map((r: { text: string }) => r.text), ["7", "7", "3"]);
  assert.deepEqual(res.body.source.pinned, ["Count"], "Final is downstream of Join: its pin is never read");
  const recorded = await preview({ node: "Join", templates: ["{{ nodes.Count.output }}"] });
  assert.equal(recorded.body.results[0].text, "42");

  const bare = await h.app.inject({ method: "POST", url: workflowRoutes.create, payload: createBody({ name: "Bare" }) });
  const bareId = (bare.json() as WorkflowWriteResponse).workflow;
  await h.service.patch(bareId.id, { revision: bareId.revision, ops: [{ op: "set_pinned", node: "Run", output: { ok: true } }] });
  const none = await preview({ templates: ["{{ nodes.Run.output.ok }}"] }, bareId.id);
  assert.equal(none.body.source.run, "none");
  assert.equal(none.body.results[0].text, "");
  const pinnedOnly = await preview({ usePinned: true, templates: ["{{ nodes.Run.output.ok }}|{{ trigger.kind }}"] }, bareId.id);
  assert.equal(pinnedOnly.body.results[0].text, "true|manual");
  assert.deepEqual(pinnedOnly.body.source, { run: "none", runId: null, pinned: ["Run"] });
});

test("expression preview: the default run is the latest that reached the block; big outputs are read whole", async () => {
  const { h, workflow, preview } = await previewHarness();
  const whole = { text: "w".repeat(80 * 1024), tail: "end" };
  const outputFile = await h.runStore.writeOutputFile("run-2", "a", 1, whole);
  await h.runStore.create(
    persistedRun(workflow, "run-2", {
      queuedAt: "2026-09-28T11:00:00.000Z",
      status: "failed",
      blocks: {
        t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "succeeded", attempt: 1, output: { kind: "manual", input: null } },
        a: { nodeId: "a", name: "Claude", type: "code", status: "succeeded", attempt: 1, output: "preview…", outputTruncated: true, outputFile },
        b: { nodeId: "b", name: "Count", type: "code", status: "failed", attempt: 1, error: { kind: "exit_code", message: "exit 1" } },
        m: { nodeId: "m", name: "Join", type: "merge", status: "running", attempt: 1 },
        f: { nodeId: "f", name: "Final", type: "code", status: "pending", attempt: 0 }
      }
    })
  );
  await h.runStore.create(persistedRun(workflow, "run-3", { queuedAt: "2026-09-28T12:00:00.000Z", status: "skipped", blocks: {} }));
  const final = await preview({ node: "Final", templates: ["{{ nodes.Count.output }}"] });
  assert.equal(final.body.source.runId, "run-1");
  assert.equal(final.body.source.run, "reached-node");
  const claude = await preview({ node: "Join", templates: ["{{ nodes.Claude.output.tail }}", "{{ nodes.Count.status }}: {{ nodes.Count.error.message }}"] });
  assert.equal(claude.body.source.runId, "run-2");
  assert.deepEqual(claude.body.results.map((r: { text: string }) => r.text), ["end", "failed: exit 1"]);
  assert.equal(claude.body.available.nodes.Count.error, "exit_code: exit 1");
  const requested = await preview({ node: "Final", runId: "run-2", templates: ["{{ nodes.Claude.output.tail }}"] });
  assert.equal(requested.body.source.run, "requested");
  assert.equal(requested.body.results[0].text, "end");
  const big = await preview({ templates: ["{{ nodes.Claude.output | json }}"], runId: "run-2" });
  assert.equal(big.body.results[0].truncated, undefined);
  const huge = await preview({ templates: ["{{ nodes.Claude.output | json }}{{ nodes.Claude.output | json }}{{ nodes.Claude.output | json }}{{ nodes.Claude.output | json }}"], runId: "run-2" });
  assert.equal(huge.body.results[0].truncated, true);
  assert.ok(huge.body.results[0].bytes >= 256 * 1024, "a render stopped at the cap reports at least the cap");
});

test("expression preview: refusals use the workflow error codes", async () => {
  const { h, workflow, preview } = await previewHarness();
  const other = await createWorkflow(h, { name: "Other" });
  await h.runStore.create(persistedRun(other, "run-other"));
  const cases: [Record<string, unknown>, string, number, string?][] = [
    [{ templates: ["x"] }, "WORKFLOW_NOT_FOUND", 404, "nope"],
    [{ templates: ["x"], node: "Nobody" }, "NODE_NOT_FOUND", 404],
    [{ templates: ["x"], runId: "nope" }, "RUN_NOT_FOUND", 404],
    [{ templates: ["x"], runId: "run-other" }, "RUN_NOT_FOUND", 404],
    [{ templates: [] }, "INVALID_REQUEST", 400],
    [{ templates: ["x"], mode: "raw" }, "INVALID_REQUEST", 400]
  ];
  for (const [body, code, status, id] of cases) {
    const res = await preview(body, id ?? workflow.id);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
  }
});

test("expression preview: a block name containing a secret value stays readable (only values are redacted)", async () => {
  const h = await harness();
  await h.secrets.set("DEPLOY_WORD", "deploy");
  await h.secrets.set("PATH_WORD", "path");
  const workflow = await createWorkflow(h, {
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start" },
      { id: "d", type: "code", name: "deployStaging" },
      { id: "c", type: "code", name: "Count" },
      { id: "m", type: "merge", name: "Join" }
    ],
    edges: [{ source: "t", target: "d" }, { source: "t", target: "c" }, { source: "d", target: "m" }, { source: "c", target: "m" }]
  });
  const block = (nodeId: string, name: string, type: string, output: unknown) =>
    ({ nodeId, name, type, status: "succeeded", attempt: 1, output }) as PersistedRun["blocks"][string];
  await h.runStore.create(
    persistedRun(workflow, "run-1", {
      blocks: {
        t: block("t", "Start", "trigger.manual", { kind: "manual", input: null }),
        d: block("d", "deployStaging", "code", { url: "https://x/deploy/1", ok: true }),
        c: block("c", "Count", "code", 1)
      }
    })
  );
  const res = await h.app.inject({
    method: "POST",
    url: workflowRoutes.expressionPreview(workflow.id),
    payload: { node: "Join", mode: "value", templates: ["{{ nodes.deployStaging.output.ok }}", "{{ input.deployStaging.ok }}", "{{ nodes.deployStaging.output.url }}", "{{ project.path }}"] }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(body.results.map((r: { value: unknown }) => r.value), [true, true, "https://x/«secret:DEPLOY_WORD»/1", "/w/ws/app"]);
  assert.ok(body.available.nodes.deployStaging, "the outline lists the block by its name");
  assert.deepEqual(Object.keys(body.available.input.keys).sort(), ["Count", "deployStaging"]);
});

test("expression preview: a starting block of a workflow with no trigger reads the run's input (engine computeForced)", async () => {
  const h = await harness();
  const workflow = await createWorkflow(h, {
    nodes: [{ id: "a", type: "code", name: "First" }, { id: "b", type: "code", name: "Second" }],
    edges: [{ source: "a", target: "b" }]
  });
  const preview = async (body: Record<string, unknown>) =>
    (await h.app.inject({ method: "POST", url: workflowRoutes.expressionPreview(workflow.id), payload: body })).json();
  const none = await preview({ node: "First", mode: "value", templates: ["{{ input }}"] });
  assert.equal(none.results[0].value, null, "no run: a test run's manual input, null");
  await h.runStore.create(
    persistedRun(workflow, "run-1", {
      triggerPayload: { kind: "manual", input: { n: 9 } },
      blocks: { a: { nodeId: "a", name: "First", type: "code", status: "succeeded", attempt: 1, output: { doubled: 18 } } }
    })
  );
  const first = await preview({ node: "First", templates: ["{{ input.n }}"] });
  assert.equal(first.results[0].text, "9");
  const second = await preview({ node: "Second", templates: ["{{ input.doubled }}", "{{ input.n }}"] });
  assert.deepEqual(second.results.map((r: { text: string }) => r.text), ["18", ""]);

  // With a trigger, a block nothing is wired into receives nothing — and says so.
  const triggered = await createWorkflow(h, { name: "Triggered", nodes: [{ id: "t", type: "trigger.manual", name: "Start" }, { id: "a", type: "code", name: "Loose" }], edges: [] });
  await h.runStore.create(persistedRun(triggered, "run-t", { triggerPayload: { kind: "manual", input: { n: 9 } } }));
  const loose = (await h.app.inject({ method: "POST", url: workflowRoutes.expressionPreview(triggered.id), payload: { node: "Loose", templates: ["{{ input.n }}"] } })).json();
  assert.equal(loose.results[0].text, "");
});

test("expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped", async () => {
  const { preview } = await previewHarness();
  const template = "{{ nodes | json }}".repeat(50_000);
  const res = await preview({ node: "Final", templates: [template], mode: "text" });
  assert.equal(res.status, 200);
  const [result] = res.body.results;
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 256 * 1024);
  const valued = await preview({ node: "Final", templates: [`x${template}`], mode: "value" });
  assert.equal(valued.body.results[0].truncated, true);
  assert.equal(valued.body.results[0].value, undefined);

  const broken = Array.from({ length: 100 }, (_, i) => `{{ bad${i} }}`).join(" ") + " {{ bad0 }}".repeat(5);
  const errors = (await preview({ templates: [broken] })).body.results[0];
  assert.equal(errors.errors.length, 50);
  assert.equal(errors.errorsOmitted, 50);
  assert.equal(new Set(errors.errors).size, 50);
  assert.deepEqual(errors.warnings, []);
});

test("expression preview: without a block, a queued newest run gives way to the newest with finished blocks", async () => {
  const { h, workflow, preview } = await previewHarness();
  await h.runStore.create(
    persistedRun(workflow, "run-queued", {
      queuedAt: "2026-09-28T12:00:00.000Z",
      status: "queued",
      blocks: { t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "pending", attempt: 0 } }
    })
  );
  const res = await preview({ templates: ["{{ nodes.Count.output }}"] });
  assert.equal(res.body.source.runId, "run-1");
  assert.equal(res.body.source.run, "latest");
  assert.equal(res.body.results[0].text, "42");
});
