import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Workflow, WorkflowRun } from "@orquester/api";
import { ToolError } from "../errors.ts";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { workflowTools } from "./workflows.ts";

type Result = Record<string, unknown>;
const stamp = "2026-09-28T12:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeDaemonApi> {
  const root = await mkdtemp(join(tmpdir(), "mcp-wf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  await mkdir(join(root, "acme", "web"), { recursive: true });
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = root;
  return api;
}

/** Stored transport data, independent of the workflow creator/validator/patch implementation. */
function definition(api: FakeDaemonApi): Workflow {
  return {
    id: "wf-1", name: "Demo", revision: 7, enabled: false,
    project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "api") },
    settings: { overlap: "skip", maxConcurrent: 2, timezone: "UTC", notify: { onFailure: true, onSuccess: false }, keepFailedTempDays: 3 },
    nodes: [
      { id: "t", name: "Start", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      { id: "a", name: "Work", type: "code", position: { x: 0, y: 0 }, config: { source: "export default async function () { return 1; }" } },
      { id: "b", name: "Finish", type: "code", position: { x: 0, y: 0 }, config: { source: "export default async function () { return 2; }" } }
    ],
    edges: [{ id: "ta", source: "t", sourceHandle: "success", target: "a" }, { id: "ab", source: "a", sourceHandle: "error", target: "b" }],
    createdAt: stamp, updatedAt: stamp
  } as Workflow;
}

function serveDefinition(api: FakeDaemonApi, workflow = definition(api)): Workflow {
  const answer = { status: 200, body: { workflow, problems: [] } };
  api.on("GET", "/api/workflows/wf-1", answer).on("POST", "/api/workflows", answer);
  return workflow;
}

const draft = () => ({ name: "Demo", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Start" }, { type: "code", name: "Work" }], edges: [{ source: "Start", target: "Work" }] });
const runRecord = (workflow: Workflow, status: WorkflowRun["status"] = "running"): WorkflowRun => ({
  id: "run-1", workflowId: "wf-1", workflowName: "Demo", status, trigger: { kind: "manual" }, test: false,
  queuedAt: stamp, definition: workflow, triggerPayload: { kind: "manual", input: null }, blocks: {}, takenEdges: [], deadEdges: []
});

/** Actual tool schema and handler; the transport supplies only canned daemon responses. */
async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<Result> {
  const tool = workflowTools.find((candidate) => candidate.name === name)!;
  const parsed = z.object(tool.input).strict().safeParse(args);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", parsed.error.issues.map((issue) => issue.path.join(".")).join("; "));
  const context: ToolContext = { api, todos: {} as never, files: {} as never, signal, now: () => Date.parse(stamp) };
  const result = await tool.run(parsed.data as never, context);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 60_000, `${name} result exceeds the documented byte cap`);
  return result;
}

async function rejects(promise: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (error) => { caught = error; });
  assert.ok(caught instanceof ToolError);
  assert.equal(caught.code, code);
  if (match) assert.match(caught.message, match);
  return caught;
}

const failure = (status: number, code: string, message: string, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });

test("list_workflow_block_types filters the requested block type", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/workflows/block-types", { status: 200, body: { types: [
    { type: "agent", handles: ["success", "error"], configSchema: { type: "object" }, example: { agent: "claude" } },
    { type: "code", handles: ["success", "error"], configSchema: { type: "object" }, example: { source: "return 1" } }
  ], expressionGuide: "guide" } });
  const one = await call(api, "list_workflow_block_types", { type: "agent" });
  assert.deepEqual((one.types as { type: string }[]).map((row) => row.type), ["agent"]);
  assert.equal(one.authoringGuide, undefined);
  assert.ok(!("guide" in (one.types as Result[])[0]!), "an older daemon sends no guide: none is invented");
});

test("list_workflow_block_types returns a type's guide sections only when that type is asked for", async (t) => {
  const api = await sandbox(t);
  const guide = [{ title: "Arguments", items: [{ term: "input", text: "The upstream output." }] }];
  api.on("GET", "/api/workflows/block-types", { status: 200, body: { types: [
    { type: "code", handles: ["success", "error"], configSchema: { type: "object" }, example: { source: "return 1" }, guide }
  ], expressionGuide: "guide" } });
  const one = await call(api, "list_workflow_block_types", { type: "code" });
  assert.deepEqual((one.types as Result[])[0]!.guide, guide);
  const all = await call(api, "list_workflow_block_types", {});
  assert.ok(!("guide" in (all.types as Result[])[0]!));
});

test("list_workflow_block_types omits the largest schemas and identifies them", async (t) => {
  const api = await sandbox(t);
  const types = ["agent", "code", "http", "shell"].map((type, i) => ({ type, configSchema: { blob: "s".repeat(i < 3 ? 20_000 : 500) } }));
  api.on("GET", "/api/workflows/block-types", { status: 200, body: { types, expressionGuide: "guide" } });
  const result = await call(api, "list_workflow_block_types", {});
  const omitted = result.configSchemasOmitted as string[];
  assert.ok(omitted.length >= 1 && omitted.length <= 3);
  assert.ok(omitted.every((type) => ["agent", "code", "http"].includes(type)));
  assert.ok((result.types as { type: string; configSchema?: unknown }[]).find((type) => type.type === "shell")?.configSchema);
});

test("create_workflow maps named edges and project, requests layout, and defaults disabled in the host timezone", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  t.mock.method(Intl, "DateTimeFormat", (() => ({ resolvedOptions: () => ({ timeZone: "Europe/Berlin" }) })) as typeof Intl.DateTimeFormat);
  const result = await call(api, "create_workflow", draft());
  assert.deepEqual(api.calls.at(-1)?.body, {
    name: "Demo", project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "api") },
    nodes: [{ type: "trigger.manual", name: "Start" }, { type: "code", name: "Work" }],
    edges: [{ source: "Start", target: "Work" }], settings: { timezone: "Europe/Berlin" }, enabled: false, autoLayout: true
  });
  assert.equal(result.created, true);
  assert.equal(result.revision, 7);
  assert.equal(result.project, "acme/api");
  assert.equal(result.errorCount, 0);
});

test("create_workflow passes temp targets through and refuses unknown projects or malformed arguments", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const project = { kind: "temp", workspace: "acme", source: { kind: "clone", url: "git@github.com:a/b.git" } };
  await call(api, "create_workflow", { ...draft(), project });
  assert.deepEqual((api.calls.at(-1)!.body as { project: unknown }).project, project);
  await rejects(call(api, "create_workflow", { ...draft(), project: { kind: "existing", project: "acme/nope" } }), "PROJECT_NOT_FOUND");
  for (const args of [{ ...draft(), bogus: 1 }, { ...draft(), nodes: [{ type: "code", nme: "Typo" }] }, { ...draft(), nodes: [{ type: "code", name: "1bad" }] }, { ...draft(), nodes: [{ type: "teleport" }] }]) {
    await rejects(call(api, "create_workflow", args), "INVALID_ARGUMENT");
  }
});

test("create_workflow identifies refused edges and exposes daemon validation problems", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows", failure(400, "INVALID_WORKFLOW", "Item 3: Unknown node Nobody", { opIndex: 3 }));
  const edge = await rejects(call(api, "create_workflow", { ...draft(), edges: [{ source: "Start", target: "Work" }, { source: "Work", target: "Nobody" }] }), "INVALID_WORKFLOW", /edges\[1\]/);
  assert.deepEqual(edge.detail, { opIndex: 3, entry: "edges[1]" });
  api.on("POST", "/api/workflows", failure(400, "INVALID_WORKFLOW", "Invalid definition", { problems: [{ severity: "error", code: "shell_template", message: "Shell templates are forbidden" }] }));
  const invalid = await rejects(call(api, "create_workflow", { ...draft(), enabled: true }), "INVALID_WORKFLOW", /shell_template/);
  assert.equal((invalid.detail as { errorCount: number }).errorCount, 1);
  assert.deepEqual((invalid.detail as { problems: { code: string }[] }).problems.map((problem) => problem.code), ["shell_template"]);
});

test("get_workflow selects a named block and incident edges and preserves missing-identity diagnostics", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const result = await call(api, "get_workflow", { workflowId: "wf-1" });
  assert.equal(result.revision, 7);
  assert.equal((result.workflow as Workflow).id, "wf-1");
  const one = await call(api, "get_workflow", { workflowId: "wf-1", node: "Finish" });
  assert.equal((one.node as { id: string }).id, "b");
  assert.deepEqual((one.connections as { edgeId: string }[]).map((edge) => edge.edgeId), ["ab"]);
  await rejects(call(api, "get_workflow", { workflowId: "wf-1", node: "Ghost" }), "NODE_NOT_FOUND", /Work/);
  api.on("GET", "/api/workflows/nope", failure(404, "WORKFLOW_NOT_FOUND", "Missing"));
  await rejects(call(api, "get_workflow", { workflowId: "nope" }), "WORKFLOW_NOT_FOUND", /list_workflows/);
});

test("workflow reads and writes identify truncated long text while keeping short text whole", async (t) => {
  const api = await sandbox(t);
  const workflow = definition(api);
  (workflow.nodes[1]!.config as { source: string }).source = "padding\n".repeat(30_000);
  serveDefinition(api, workflow);
  for (const result of [await call(api, "create_workflow", draft()), await call(api, "get_workflow", { workflowId: "wf-1" })]) {
    assert.deepEqual(result.truncatedFields, ["workflow.nodes[1].config.source"]);
    const nodes = (result.workflow as Workflow).nodes;
    const preview = (nodes[1]!.config as { source: string }).source;
    assert.ok(preview.startsWith("padding\n") && preview.length < 30_000 * "padding\n".length);
    assert.equal((nodes[2]!.config as { source: string }).source, "export default async function () { return 2; }");
  }
});

test("update_workflow preserves conflict hints and recovers a legacy failing-op index", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/patch", failure(409, "REVISION_CONFLICT", "Stale"));
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 6, ops: [{ op: "set_enabled", enabled: false }] }), "REVISION_CONFLICT", /get_workflow/);
  api.on("POST", "/api/workflows/wf-1/patch", failure(400, "INVALID_WORKFLOW", "Unknown node Ghost"));
  const failed = await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_name", name: "Renamed" }, { op: "connect", source: "Work", target: "Ghost" }] }), "INVALID_WORKFLOW");
  assert.deepEqual(failed.detail, { opIndex: 1, op: "connect" });
  api.on("POST", "/api/workflows/wf-1/patch", failure(400, "INVALID_REQUEST", "bad op", { opIndex: 0 }));
  const indexed = await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "remove_node", node: "Work" }] }), "INVALID_REQUEST");
  assert.deepEqual(indexed.detail, { opIndex: 0, op: "remove_node" });
});

test("update_workflow validates op shapes and resolves project fields before sending the batch", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/wf-1/patch", { status: 200, body: { workflow: definition(api), problems: [] } });
  for (const ops of [[{ op: "rename_node", from: "Work", to: "X" }], [{ op: "explode" }], [], [{ op: "disconnect", source: "Work" }]]) {
    await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops }), "INVALID_ARGUMENT");
  }
  await call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_project", project: { kind: "existing", project: "acme/web" } }, { op: "disconnect", source: "Work", target: "Finish" }] });
  assert.deepEqual(api.calls.at(-1)!.body, { revision: 7, ops: [{ op: "set_project", project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "web") } }, { op: "disconnect", source: "Work", target: "Finish" }] });
});

test("validate_workflow reports invalid drafts with errors before warnings", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [
    { severity: "warning", code: "unreachable", message: "Unreachable block" },
    { severity: "error", code: "cycle", message: "Cycle detected" }
  ] } });
  const result = await call(api, "validate_workflow", { workflow: { name: "Draft", nodes: [], edges: [] } });
  assert.equal(result.valid, false);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
  assert.deepEqual((result.problems as { code: string }[]).map((problem) => problem.code), ["cycle", "unreachable"]);
});

test("list_workflows resolves the project filter and maps the daemon's summaries", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/workflows", { status: 200, body: { workflows: [{
    id: "wf-1", name: "Demo", enabled: false, revision: 7, project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "api") },
    triggers: [{ text: "On demand" }], nodeCount: 3, errorCount: 0, activeRuns: [{ id: "run-1" }], updatedAt: stamp
  }] } });
  const result = await call(api, "list_workflows", { project: "acme/api" });
  assert.deepEqual(result.workflows, [{ workflowId: "wf-1", name: "Demo", enabled: false, revision: 7, project: "acme/api", projectPath: join(api.workspacesDir, "acme", "api"), triggers: ["On demand"], nodeCount: 3, errorCount: 0, activeRuns: 1, updatedAt: stamp }]);
  assert.deepEqual(api.calls.at(-1)!.query, { projectPath: join(api.workspacesDir, "acme", "api") });
});

test("run_workflow maps run/overlap answers and sends input or force to the daemon", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  assert.equal((await call(api, "run_workflow", { workflowId: "wf-1", input: { ticket: "PROJ-1" } })).runId, "run-1");
  assert.deepEqual(api.calls.at(-1)!.body, { input: { ticket: "PROJ-1" } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: null, skipped: "overlap" } });
  const skipped = await call(api, "run_workflow", { workflowId: "wf-1" });
  assert.equal(skipped.runId, null);
  assert.equal(skipped.skipped, "overlap");
  await call(api, "run_workflow", { workflowId: "wf-1", force: true });
  assert.deepEqual(api.calls.at(-1)!.body, { force: true });
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", timeoutSeconds: 601 }), "INVALID_ARGUMENT");
});

test("run_workflow wait finishes on its event and returns block data in definition order", async (t) => {
  const api = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = runRecord(definition(api), "succeeded");
  run.blocks = {
    b: { nodeId: "b", name: "Finish", type: "code", status: "skipped", attempt: 1 },
    a: { nodeId: "a", name: "Work", type: "agent", status: "succeeded", attempt: 1, handle: "success", output: { fixed: "PROJ-1" }, sessionId: "s1", hops: [{ agent: "claude", model: "opus", accountId: "account-1", sessionId: "s1", startedAt: stamp, via: "initial" }] },
    t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "succeeded", attempt: 1 }
  };
  run.finalOutput = { fixed: "PROJ-1" };
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", wait: true });
  await tick();
  api.emit(busEvent("workflowRun.finished", { run: { id: "run-1", status: "succeeded" } }, "workflows"));
  const result = await pending;
  assert.equal(result.finished, true);
  const blocks = result.blocks as { nodeId: string; status: string; output?: unknown; sessionId?: string; hops?: { accountId: string }[]; handle?: string }[];
  assert.deepEqual(blocks.map((block) => block.nodeId), ["t", "a", "b"]);
  assert.equal(blocks[2]!.status, "skipped");
  assert.equal(blocks[1]!.handle, "success");
  assert.equal(blocks[1]!.sessionId, "s1");
  assert.equal(blocks[1]!.hops?.[0]?.accountId, "account-1");
  assert.deepEqual(blocks[1]!.output, { fixed: "PROJ-1" });
  assert.deepEqual((result.run as { finalOutput: unknown }).finalOutput, { fixed: "PROJ-1" });
  assert.equal(api.listenerCount(), 0);
});

test("run_workflow timeout returns the current run and releases its subscription", async (t) => {
  const api = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api)) } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", wait: true, timeoutSeconds: 1 });
  await tick();
  clock = 1_000;
  t.mock.timers.tick(1_000);
  const result = await pending;
  assert.equal(result.finished, false);
  assert.equal(result.timedOut, true);
  assert.equal((result.run as { status: string }).status, "running");
  assert.equal(api.listenerCount(), 0);
});

test("run_workflow wait rereads a silently finished run and releases its subscription on abort", async (t) => {
  const api = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api), "failed") } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", wait: true, timeoutSeconds: 30 });
  await tick();
  clock = 10_000;
  t.mock.timers.tick(10_000);
  const result = await pending;
  assert.equal(result.finished, true);
  assert.equal((result.run as { status: string }).status, "failed");
  const controller = new AbortController();
  const aborted = call(api, "run_workflow", { workflowId: "wf-1", wait: true }, controller.signal);
  await tick();
  controller.abort();
  assert.equal((await aborted).finished, false);
  assert.equal(api.listenerCount(), 0);
});

test("get_workflow_run fits outputs and pages whole Unicode output without losing bytes", async (t) => {
  const api = await sandbox(t);
  const run = runRecord(definition(api), "succeeded");
  const huge = { text: '😀語é"\n'.repeat(15_000) };
  run.blocks = {
    a: { nodeId: "a", name: "Work", type: "code", status: "succeeded", attempt: 1, output: huge },
    b: { nodeId: "b", name: "Finish", type: "code", status: "succeeded", attempt: 1, output: { done: true }, outputTruncated: true }
  };
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run } });
  api.on("GET", "/api/workflow-runs/run-1/nodes/a/output", { status: 200, body: { output: huge } });
  api.on("GET", "/api/workflow-runs/run-1/nodes/b/output", { status: 200, body: { output: { done: true } } });
  const result = await call(api, "get_workflow_run", { runId: "run-1" });
  const blocks = result.blocks as { output?: unknown; outputText?: string; outputTruncated?: boolean }[];
  assert.equal(blocks[0]!.output, undefined);
  assert.equal(blocks[0]!.outputTruncated, true);
  assert.ok(blocks[0]!.outputText!.startsWith('{"text":"😀語é'));
  assert.deepEqual(blocks[1]!.output, { done: true });
  assert.equal(blocks[1]!.outputTruncated, true);
  const bare = await call(api, "get_workflow_run", { runId: "run-1", includeOutputs: false });
  assert.deepEqual((bare.blocks as { nodeId: string }[]).map((block) => block.nodeId), ["a", "b"]);
  assert.ok((bare.blocks as { output?: unknown }[]).every((block) => block.output === undefined));
  let text = "";
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const window = await call(api, "get_workflow_run", { runId: "run-1", nodeId: "Work", outputOffset: offset });
    text += window.outputText as string;
    if (window.nextOffset === undefined) break;
    offset = window.nextOffset as number;
  }
  assert.deepEqual(JSON.parse(text), huge);
  assert.deepEqual((await call(api, "get_workflow_run", { runId: "run-1", nodeId: "Finish" })).output, { done: true });
  await rejects(call(api, "get_workflow_run", { runId: "run-1", nodeId: "Ghost" }), "NODE_NOT_FOUND", /Work/);
  api.on("GET", "/api/workflow-runs/run-9", failure(404, "RUN_NOT_FOUND", "Missing"));
  await rejects(call(api, "get_workflow_run", { runId: "run-9" }), "RUN_NOT_FOUND", /list_workflow_runs/);
});

test("delete_workflow needs confirm: true", async (t) => {
  const api = await sandbox(t);
  api.on("DELETE", "/api/workflows/wf-1", { status: 200, body: { ok: true } });
  await rejects(call(api, "delete_workflow", { workflowId: "wf-1" }), "INVALID_ARGUMENT");
  await rejects(call(api, "delete_workflow", { workflowId: "wf-1", confirm: false }), "INVALID_ARGUMENT");
  assert.deepEqual(await call(api, "delete_workflow", { workflowId: "wf-1", confirm: true }), { deleted: true, workflowId: "wf-1" });
});

test("secrets are write-only and scoped; malformed or oversized secret inputs are refused", async (t) => {
  const api = await sandbox(t);
  api.on("PUT", "/api/workflow-secrets/*", { status: 200, body: { ok: true } });
  assert.deepEqual(await call(api, "set_workflow_secret", { name: "TOKEN", value: "must-stay-private" }), { set: true, name: "TOKEN", scope: "global" });
  const short = await call(api, "set_workflow_secret", { name: "PIN", value: "12", workflowId: "wf-1" });
  assert.ok(short.warning);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-1" });
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [{ name: "TOKEN", scope: "global", updatedAt: stamp, value: "must-stay-private" }] } });
  const listed = await call(api, "list_workflow_secrets", { workflowId: "wf-1" });
  assert.deepEqual(listed.secrets, [{ name: "TOKEN", scope: "global", updatedAt: stamp }]);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-1" });
  await rejects(call(api, "set_workflow_secret", { name: "lower", value: "x" }), "INVALID_ARGUMENT");
  await rejects(call(api, "set_workflow_secret", { name: "BIG", value: "x".repeat(64 * 1024 + 1) }), "INVALID_ARGUMENT");
});

test("get_workflow maps workflow errors, bounds problem detail and hides internal failures", async (t) => {
  const api = await sandbox(t);
  const fail = (status: number, body: unknown) => {
    api.on("GET", "/api/workflows/nope", { status, body });
    return call(api, "get_workflow", { workflowId: "nope" });
  };
  await rejects(fail(409, { error: { code: "REVISION_CONFLICT", message: "stale" } }), "REVISION_CONFLICT");
  const many = await rejects(fail(400, { error: { code: "INVALID_WORKFLOW", message: "bad", problems: Array.from({ length: 150 }, (_, i) => ({ severity: i === 149 ? "error" : "warning", code: "c" + i, message: "m" + i })) } }), "INVALID_WORKFLOW");
  const detail = many.detail as { problems: { code: string }[]; problemsOmitted: number; errorCount: number };
  assert.equal(detail.problems.length, 100);
  assert.equal(detail.problems[0]!.code, "c149");
  assert.equal(detail.problemsOmitted, 50);
  assert.equal(detail.errorCount, 1);
  for (const [status, code] of [[503, "HOST_UNAVAILABLE"], [500, "INTERNAL"]] as const) {
    const error = await rejects(fail(status, { message: "/secret/path failed" }), code);
    assert.ok(!JSON.stringify(error).includes("/secret/path"));
  }
});

test("wide definitions retain every block identity in an outline and allow full per-block reads", async (t) => {
  const api = await sandbox(t);
  const workflow = definition(api);
  workflow.nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, type: "code", name: `Block${i}`, position: { x: 0, y: 0 }, config: { source: `${"padding ".repeat(100)}\nreturn ${i};` } })) as Workflow["nodes"];
  workflow.edges = [];
  serveDefinition(api, workflow);
  for (const result of [await call(api, "create_workflow", draft()), await call(api, "get_workflow", { workflowId: "wf-1" })]) {
    assert.equal(result.blocksOutlined, true);
    const nodes = (result.workflow as { nodes: Record<string, unknown>[] }).nodes;
    assert.deepEqual(nodes.map((node) => node.id), Array.from({ length: 200 }, (_, i) => `n${i}`));
    assert.equal(nodes[0]!.type, "code");
    assert.equal(nodes[0]!.config, undefined);
  }
  const one = await call(api, "get_workflow", { workflowId: "wf-1", node: "Block7" });
  assert.equal((one.node as { config: { source: string } }).config.source, `${"padding ".repeat(100)}\nreturn 7;`);
});

test("preview_expression sends one request per call and names the templates it rendered", async (t) => {
  const api = await sandbox(t);
  const answer = {
    results: [{ text: "3", bytes: 1, warnings: [], errors: [] }, { missing: true, bytes: 0, warnings: ["{{ input.x }} is empty: nothing at input.x"], errors: [] }],
    node: { id: "b", name: "Finish", type: "code" },
    source: { run: "reached-node", runId: "run-1", runStatus: "succeeded", runTest: false, runQueuedAt: stamp, pinned: [] },
    available: { nodes: { Work: { status: "succeeded", output: { type: "object", keys: { score: "number" } } } }, run: {}, project: {}, workflow: { id: "wf-1", name: "Demo" }, secrets: ["TOKEN"] },
    notes: []
  };
  api.on("POST", "/api/workflows/wf-1/expression-preview", { status: 200, body: answer });
  const result = await call(api, "preview_expression", { workflowId: "wf-1", node: "Finish", templates: ["{{ nodes.Work.output.score }}", "{{ input.x }}"], mode: "value", usePinned: true, runId: "run-1" });
  assert.deepEqual(api.calls.at(-1), { method: "POST", path: "/api/workflows/wf-1/expression-preview", body: { templates: ["{{ nodes.Work.output.score }}", "{{ input.x }}"], mode: "value", usePinned: true, node: "Finish", runId: "run-1" } });
  assert.equal(result.node, "Finish");
  assert.deepEqual((result.results as Result[]).map((r) => r.template), ["{{ nodes.Work.output.score }}", "{{ input.x }}"]);
  assert.equal((result.results as Result[])[1]!.missing, true);
  assert.deepEqual(result.available, answer.available);

  await call(api, "preview_expression", { workflowId: "wf-1", template: "{{ trigger }}" });
  assert.deepEqual(api.calls.at(-1)!.body, { templates: ["{{ trigger }}"], mode: "text", usePinned: false });
  await rejects(call(api, "preview_expression", { workflowId: "wf-1" }), "INVALID_ARGUMENT", /template/);
  await rejects(call(api, "preview_expression", { workflowId: "wf-1", template: "a", templates: ["b"] }), "INVALID_ARGUMENT");
  await rejects(call(api, "preview_expression", { workflowId: "wf-1", templates: Array.from({ length: 21 }, () => "x") }), "INVALID_ARGUMENT");
  api.on("POST", "/api/workflows/wf-1/expression-preview", failure(404, "NODE_NOT_FOUND", "No block Nobody."));
  await rejects(call(api, "preview_expression", { workflowId: "wf-1", template: "x", node: "Nobody" }), "NODE_NOT_FOUND", /get_workflow lists/);
  api.on("POST", "/api/workflows/wf-1/expression-preview", failure(404, "RUN_NOT_FOUND", "No run."));
  await rejects(call(api, "preview_expression", { workflowId: "wf-1", template: "x", runId: "gone" }), "RUN_NOT_FOUND", /list_workflow_runs/);
});

test("preview_expression fits large renders, values and outlines under the result cap", async (t) => {
  const api = await sandbox(t);
  const big = "x".repeat(200 * 1024);
  const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
  const keys = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`key${i}`, "string"]));
  api.on("POST", "/api/workflows/wf-1/expression-preview", { status: 200, body: {
    results: [
      { text: big, bytes: big.length, warnings: [], errors: [] },
      { value: wide, valueType: "object", bytes: JSON.stringify(wide).length, warnings: [], errors: [] },
      { text: "short", bytes: 5, warnings: [], errors: [] }
    ],
    node: null,
    source: { run: "latest", runId: "run-1", pinned: [] },
    available: { nodes: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`Block${i}`, { status: "succeeded", output: { type: "object", keys } }])), run: {}, project: {}, workflow: { id: "wf-1", name: "Demo" }, secrets: [] },
    notes: []
  } });
  const result = await call(api, "preview_expression", { workflowId: "wf-1", templates: ["{{ a }}", "{{ b }}", "{{ c }}"] });
  const [text, value, short] = result.results as Result[];
  assert.match(text!.text as string, /\[truncated\]$/);
  assert.equal(value!.value, undefined);
  assert.equal(value!.truncated, true);
  assert.ok((value!.valueJson as string).startsWith("{\"k0\":0"));
  assert.equal(short!.text, "short");
  assert.equal((result.available as Result).keysOmitted, true);
  assert.deepEqual(((result.available as Result).nodes as Record<string, Result>).Block0, { status: "succeeded", output: { type: "object" } });
  assert.ok(Array.isArray(result.truncatedFields));
});
