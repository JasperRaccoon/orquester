/**
 * The workflows family (unified MCP design 2026-10-15 §4 rows 26–37, §4.1, §7, D-22, D-25), run
 * through THE executor as both audiences: the pre-catalog external tests ported (parity), then the
 * chat side — the project union, complete previews and PREVIEW_TOO_LARGE, the revision and prompt
 * pins (PREVIEW_STALE), the chat secret flow, reads' scope, and watch/debug. The chat-grant loop over
 * the real approval port is in `workflows-grants.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSETS, type ApprovalPreviewSection, type Workflow, type WorkflowRun } from "@orquester/api";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { ToolError } from "../errors.ts";
import { executeToolCall, type ExecutorDeps } from "../executor.ts";
import { busEvent, FakeDaemonApi, serveWorkflowReferences } from "../testing.ts";
import { blockUsesSecrets, changesSecretUse, graphDiff, unifiedDiff, workflowsReferencingPrompt, workflowUnion } from "./workflow-preview.ts";

type Result = Record<string, unknown>;
const stamp = "2026-09-28T12:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Sandbox extends FakeDaemonApi { own: string; same: string; other: string }

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-wf-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["acme/api", "acme/web", "beta/app"]) await mkdir(join(root, dir), { recursive: true });
  const api = new FakeDaemonApi() as Sandbox;
  api.fsRoot = api.workspacesDir = root;
  api.own = join(root, "acme", "api");
  api.same = join(root, "acme", "web");
  api.other = join(root, "beta", "app");
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [] } })
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: join(root, "acme"), projectCount: 2, gitAccountId: "acc1" }, { name: "beta", path: join(root, "beta"), projectCount: 1, gitAccount: { label: "beta-bot", login: "betabot", provider: "github" } }] })
    .on("GET", "/api/accounts", { status: 200, body: [{ id: "acc1", label: "acme-bot", login: "acmebot" }] })
    .on("GET", "/api/saved-prompts", { status: 200, body: { prompts: [] } })
    .on("GET", "/api/workflows", { status: 200, body: { workflows: [] } });
  // The reference index: no other workflow (none runs another as a sub-workflow) unless a test serves one.
  serveWorkflowReferences(api, () => []);
  return api;
}

/** Stored transport data, independent of the workflow creator/validator/patch implementation. */
function definition(api: FakeDaemonApi, over: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1", name: "Demo", revision: 7, enabled: false,
    project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "api") },
    settings: { overlap: "skip", maxConcurrent: 2, timezone: "UTC", notify: { onFailure: true, onSuccess: false }, keepFailedTempDays: 3 },
    nodes: [
      { id: "t", name: "Start", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      { id: "a", name: "Work", type: "code", position: { x: 0, y: 0 }, config: { source: "export default async function () { return 1; }" } },
      { id: "b", name: "Finish", type: "code", position: { x: 0, y: 0 }, config: { source: "export default async function () { return 2; }" } }
    ],
    edges: [{ id: "ta", source: "t", sourceHandle: "success", target: "a" }, { id: "ab", source: "a", sourceHandle: "success", target: "b" }],
    createdAt: stamp, updatedAt: stamp,
    ...over
  } as Workflow;
}

function serveDefinition(api: FakeDaemonApi, workflow = definition(api)): Workflow {
  const answer = { status: 200, body: { workflow, problems: [] } };
  api.on("GET", `/api/workflows/${workflow.id}`, answer).on("POST", "/api/workflows", answer);
  return workflow;
}

const draft = () => ({ name: "Demo", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Start" }, { type: "code", name: "Work" }], edges: [{ source: "Start", target: "Work" }] });
const runRecord = (workflow: Workflow, status: WorkflowRun["status"] = "running"): WorkflowRun => ({
  id: "run-1", workflowId: "wf-1", workflowName: "Demo", status, trigger: { kind: "manual" }, test: false,
  queuedAt: stamp, definition: workflow, triggerPayload: { kind: "manual", input: null }, blocks: {}, takenEdges: [], deadEdges: []
});

function chat(api: Sandbox, over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Automate", projectPath: api.own, workspace: "acme", cwd: api.own, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

const ALL_TOOLSETS = new Set(TOOLSETS.map((toolset) => toolset.id));

/** The tool through the executor: an external caller (parity) unless `who` is a chat. */
async function exec(api: FakeDaemonApi, name: string, args: Record<string, unknown>, opts: { who?: ThreadCaller; port?: FakeApprovalPort; signal?: AbortSignal } = {}): Promise<CallToolResult> {
  const deps: ExecutorDeps = { approvals: opts.port ?? null, enabledToolsets: async () => ALL_TOOLSETS, now: () => Date.parse(stamp) };
  return executeToolCall(deps, { name, arguments: args }, { caller: opts.who ?? { kind: "external" }, api, signal: opts.signal ?? new AbortController().signal });
}

/** A successful result's record; a failed one thrown as its ToolError. */
async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, opts: { who?: ThreadCaller; port?: FakeApprovalPort; signal?: AbortSignal } = {}): Promise<Result> {
  const result = await exec(api, name, args, opts);
  const record = result.structuredContent as Result;
  if (result.isError) throw new ToolError(String(record.code), String(record.message), record.detail);
  assert.ok(Buffer.byteLength(JSON.stringify(record), "utf8") <= 60_000, `${name} result exceeds the documented byte cap`);
  return record;
}

async function rejects(promise: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (error) => { caught = error; });
  assert.ok(caught instanceof ToolError);
  assert.equal(caught.code, code, caught.message);
  if (match) assert.match(caught.message, match);
  return caught;
}

const failure = (status: number, code: string, message: string, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });
const sectionText = (sections: readonly ApprovalPreviewSection[]): string => JSON.stringify(sections);

// ---------------------------------------------------------------------------
// Ported: the external tools' behaviour (parity)
// ---------------------------------------------------------------------------

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
  assert.match(String(all.authoringGuide), /get_workflow_runs/);
  assert.doesNotMatch(String(all.authoringGuide), /get_workflow_run\b|list_workflow_runs|validate_workflow/);
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
  for (const args of [{ ...draft(), bogus: 1 }, { ...draft(), nodes: [{ type: "code", nme: "Typo" }] }, { ...draft(), nodes: [{ type: "code", name: "1bad" }] }, { ...draft(), nodes: [{ type: "teleport" }] }, { ...draft(), reason: "chat only" }]) {
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

test("create_workflow {dryRun: true} validates the definition the create would save and saves nothing (was validate_workflow)", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [
    { severity: "warning", code: "unreachable", message: "Unreachable block" },
    { severity: "error", code: "cycle", message: "Cycle detected" }
  ] } });
  const result = await call(api, "create_workflow", { ...draft(), dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.saved, false);
  assert.equal(result.valid, false);
  assert.equal(result.errorCount, 1);
  assert.equal(result.warningCount, 1);
  assert.deepEqual((result.problems as { code: string }[]).map((problem) => problem.code), ["cycle", "unreachable"]);
  assert.equal(result.projects, "Project acme/api");
  const sent = api.calls.find((c) => c.path === "/api/workflows/validate")!.body as { workflow: Workflow };
  assert.deepEqual(sent.workflow.nodes.map((node) => node.name), ["Start", "Work"]);
  assert.equal(sent.workflow.edges[0]!.source, sent.workflow.nodes[0]!.id, "edges by id, as the save has them");
  assert.ok(!api.calls.some((c) => c.method === "POST" && c.path === "/api/workflows"), "nothing saved");
  const refused = await rejects(call(api, "create_workflow", { ...draft(), edges: [{ source: "Start", target: "Nobody" }], dryRun: true }), "INVALID_WORKFLOW", /edges\[0\]/);
  assert.equal((refused.detail as { entry: string }).entry, "edges[0]");
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

test("update_workflow validates op shapes and resolves project fields (set_project, an update_node's projectOverride) before sending the batch", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/wf-1/patch", { status: 200, body: { workflow: definition(api), problems: [] } });
  for (const ops of [[{ op: "rename_node", from: "Work", to: "X" }], [{ op: "explode" }], [], [{ op: "disconnect", source: "Work" }]]) {
    await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops }), "INVALID_ARGUMENT");
  }
  await call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_project", project: { kind: "existing", project: "acme/web" } }, { op: "disconnect", source: "Work", target: "Finish" }, { op: "update_node", node: "Work", set: { projectOverride: "beta/app" } }] });
  assert.deepEqual(api.calls.at(-1)!.body, { revision: 7, ops: [
    { op: "set_project", project: { kind: "existing", projectPath: join(api.workspacesDir, "acme", "web") } },
    { op: "disconnect", source: "Work", target: "Finish" },
    { op: "update_node", node: "Work", set: { projectOverride: join(api.workspacesDir, "beta", "app") } }
  ] });
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "update_node", node: "Work", set: { projectOverride: "beta/none" } }] }), "PROJECT_NOT_FOUND");
});

test("update_workflow {dryRun: true}: the local replay of the ops is validated, the changes listed, nothing saved", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const result = await call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "rename_node", node: "Finish", to: "Done" }, { op: "update_node", node: "Work", set: { config: { source: "return 3" } } }], dryRun: true });
  assert.equal(result.valid, true);
  assert.equal(result.revision, 7);
  assert.deepEqual(result.changes, [
    { label: "code · Work", change: "changed", detail: "config.source" },
    { label: "code · Finish → Done", change: "changed", detail: "name" }
  ]);
  assert.ok(!api.calls.some((c) => c.path.endsWith("/patch")), "nothing saved");
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 6, ops: [{ op: "set_enabled", enabled: true }], dryRun: true }), "REVISION_CONFLICT", /revision 7, not 6/);
  const bad = await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_name", name: "X" }, { op: "remove_node", node: "Ghost" }], dryRun: true }), "INVALID_WORKFLOW", /ops\[1\] \(remove_node\)/);
  assert.deepEqual(bad.detail, { opIndex: 1, op: "remove_node" });
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
  await call(api, "list_workflows", {});
  assert.equal(api.calls.at(-1)!.query, undefined, "external: every workflow");
});

test("run_workflow maps run/overlap answers, needs the revision, and sends input or force to the daemon", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api)) } });
  assert.equal((await call(api, "run_workflow", { workflowId: "wf-1", revision: 7, input: { ticket: "PROJ-1" } })).runId, "run-1");
  assert.deepEqual(api.calls.find((c) => c.path === "/api/workflows/wf-1/run")!.body, { expectedRevision: 7, input: { ticket: "PROJ-1" } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: null, skipped: "overlap" } });
  const skipped = await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 });
  assert.equal(skipped.runId, null);
  assert.equal(skipped.skipped, "overlap");
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7, force: true });
  assert.deepEqual(api.calls.filter((c) => c.path === "/api/workflows/wf-1/run").at(-1)!.body, { expectedRevision: 7, force: true });
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7, timeoutSeconds: 601 }), "INVALID_ARGUMENT");
  await rejects(call(api, "run_workflow", { workflowId: "wf-1" }), "INVALID_ARGUMENT", /revision/);
  const runsBefore = api.calls.filter((c) => c.path === "/api/workflows/wf-1/run").length;
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 6 }), "REVISION_CONFLICT", /revision 7, not 6/);
  assert.equal(api.calls.filter((c) => c.path === "/api/workflows/wf-1/run").length, runsBefore, "a stale revision never starts a run");
});

test("run_workflow wait finishes on its event and returns block data in definition order", async (t) => {
  const api = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  serveDefinition(api);
  const run = runRecord(definition(api), "succeeded");
  run.blocks = {
    b: { nodeId: "b", name: "Finish", type: "code", status: "skipped", attempt: 1 },
    a: { nodeId: "a", name: "Work", type: "agent", status: "succeeded", attempt: 1, handle: "success", output: { fixed: "PROJ-1" }, sessionId: "s1", hops: [{ agent: "claude", model: "opus", accountId: "account-1", sessionId: "s1", startedAt: stamp, via: "initial" }] },
    t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "succeeded", attempt: 1 }
  };
  run.finalOutput = { fixed: "PROJ-1" };
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", revision: 7, wait: true });
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
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api)) } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", revision: 7, wait: true, timeoutSeconds: 1 });
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
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api), "failed") } });
  const pending = call(api, "run_workflow", { workflowId: "wf-1", revision: 7, wait: true, timeoutSeconds: 30 });
  await tick();
  clock = 10_000;
  t.mock.timers.tick(10_000);
  const result = await pending;
  assert.equal(result.finished, true);
  assert.equal((result.run as { status: string }).status, "failed");
  const controller = new AbortController();
  const aborted = exec(api, "run_workflow", { workflowId: "wf-1", revision: 7, wait: true }, { signal: controller.signal });
  await tick();
  controller.abort();
  const answer = await aborted;
  assert.ok(answer.isError ? (answer.structuredContent as { code: string }).code === "CANCELLED" : (answer.structuredContent as Result).finished === false);
  assert.equal(api.listenerCount(), 0);
});

test("get_workflow_runs {runId} fits outputs and {runId, nodeId} pages whole Unicode output without losing bytes (was get_workflow_run)", async (t) => {
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
  const result = await call(api, "get_workflow_runs", { runId: "run-1" });
  const blocks = result.blocks as { output?: unknown; outputText?: string; outputTruncated?: boolean }[];
  assert.equal(blocks[0]!.output, undefined);
  assert.equal(blocks[0]!.outputTruncated, true);
  assert.ok(blocks[0]!.outputText!.startsWith('{"text":"😀語é'));
  assert.deepEqual(blocks[1]!.output, { done: true });
  assert.equal(blocks[1]!.outputTruncated, true);
  assert.match(String(result.outputNote), /get_workflow_runs \{runId, nodeId\}/);
  await rejects(call(api, "get_workflow_runs", { runId: "run-1", includeOutputs: false }), "INVALID_ARGUMENT", /includeOutputs/);
  let text = "";
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const window = await call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Work", outputOffset: offset });
    text += window.outputText as string;
    if (window.nextOffset === undefined) break;
    offset = window.nextOffset as number;
  }
  assert.deepEqual(JSON.parse(text), huge);
  assert.deepEqual((await call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Finish" })).output, { done: true });
  await rejects(call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Ghost" }), "NODE_NOT_FOUND", /Work/);
  api.on("GET", "/api/workflow-runs/run-9", failure(404, "RUN_NOT_FOUND", "Missing"));
  await rejects(call(api, "get_workflow_runs", { runId: "run-9" }), "RUN_NOT_FOUND", /get_workflow_runs \{workflowId\}/);
});

test("get_workflow_runs {workflowId} pages a workflow's runs (was list_workflow_runs); runId-only fields need a runId", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/workflows/wf-1/runs", { status: 200, body: { runs: [runRecord(definition(api), "succeeded")], before: "cursor-2" } });
  const page = await call(api, "get_workflow_runs", { workflowId: "wf-1", limit: 5, before: "cursor-1" });
  assert.deepEqual(api.calls.at(-1)!.query, { limit: "5", before: "cursor-1" });
  assert.deepEqual((page.runs as { runId: string; status: string }[]).map((r) => [r.runId, r.status]), [["run-1", "succeeded"]]);
  assert.equal(page.before, "cursor-2");
  await rejects(call(api, "get_workflow_runs", {}), "INVALID_ARGUMENT", /workflowId .* or runId/);
  await rejects(call(api, "get_workflow_runs", { workflowId: "wf-1", nodeId: "Work", waitSeconds: 5 }), "INVALID_ARGUMENT", /nodeId, waitSeconds need runId/);
  await rejects(call(api, "get_workflow_runs", { runId: "run-1", log: "stdout" }), "INVALID_ARGUMENT", /log needs nodeId/);
  await rejects(call(api, "get_workflow_runs", { runId: "run-1", waitSeconds: 601 }), "INVALID_ARGUMENT");
});

test("get_workflow_runs {runId, waitSeconds} waits on the bus for an active run to end (watch), and returns at once for an ended one", async (t) => {
  const api = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let run = runRecord(definition(api), "running");
  api.on("GET", "/api/workflow-runs/run-1", () => ({ status: 200, body: { run } }));
  const pending = call(api, "get_workflow_runs", { runId: "run-1", waitSeconds: 120 });
  await tick();
  run = runRecord(definition(api), "succeeded");
  api.emit(busEvent("workflowRun.finished", { run: { id: "run-1", status: "succeeded" } }, "workflows"));
  const result = await pending;
  assert.equal(result.finished, true);
  assert.equal((result.run as { status: string }).status, "succeeded");
  assert.equal(api.listenerCount(), 0);
  const again = await call(api, "get_workflow_runs", { runId: "run-1", waitSeconds: 120 });
  assert.equal(again.finished, true);
  assert.equal(api.listenerCount(), 0);
});

test("get_workflow_runs {runId, nodeId, log} reads a block's stdout/stderr (debug): the tail by default, then paged; secrets stay masked", async (t) => {
  const api = await sandbox(t);
  const run = runRecord(definition(api), "failed");
  run.blocks = { a: { nodeId: "a", name: "Work", type: "shell", status: "failed", attempt: 1, error: { kind: "exit_code", message: "exit 1" }, logs: { stdoutBytes: 100_000, stderrBytes: 12 } } };
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run } });
  api.on("GET", "/api/workflow-runs/run-1/nodes/a/log", ({ query }) => ({ status: 200, body: query?.stream === "stderr" ? "boom «secret:JIRA_AUTH»" : "o".repeat(Number(query?.maxBytes)) }));
  const tail = await call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Work", log: "stdout" });
  const query = api.calls.at(-1)!.query!;
  assert.equal(query.stream, "stdout");
  assert.equal(Number(query.offset) + Number(query.maxBytes), 100_000, "the default window ends at the log's end");
  assert.equal(tail.offset, Number(query.offset));
  assert.equal(tail.logBytes, 100_000);
  assert.equal(tail.nextOffset, undefined);
  const head = await call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Work", log: "stdout", outputOffset: 0 });
  assert.equal(head.offset, 0);
  assert.equal(head.nextOffset, (head.text as string).length, "an unredacted window's next offset is exact");
  const err = await call(api, "get_workflow_runs", { runId: "run-1", nodeId: "Work", log: "stderr" });
  assert.equal(err.text, "boom «secret:JIRA_AUTH»");
  assert.equal(err.offsetsApproximate, true);
  assert.equal((err.block as { error: { kind: string } }).error.kind, "exit_code");
});

test("delete_workflow needs confirm: true", async (t) => {
  const api = await sandbox(t);
  api.on("DELETE", "/api/workflows/wf-1", { status: 200, body: { ok: true } });
  await rejects(call(api, "delete_workflow", { workflowId: "wf-1" }), "INVALID_ARGUMENT");
  await rejects(call(api, "delete_workflow", { workflowId: "wf-1", confirm: false }), "INVALID_ARGUMENT");
  assert.deepEqual(await call(api, "delete_workflow", { workflowId: "wf-1", confirm: true }), { deleted: true, workflowId: "wf-1" });
});

test("secrets are write-only and scoped; external callers set with value or delete; malformed or oversized secret inputs are refused", async (t) => {
  const api = await sandbox(t);
  api.on("PUT", "/api/workflow-secrets/*", { status: 200, body: { ok: true } });
  api.on("DELETE", "/api/workflow-secrets/*", { status: 204, body: null });
  assert.deepEqual(await call(api, "set_workflow_secret", { name: "TOKEN", value: "must-stay-private" }), { set: true, name: "TOKEN", scope: "global" });
  const short = await call(api, "set_workflow_secret", { name: "PIN", value: "12", workflowId: "wf-1" });
  assert.ok(short.warning);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-1" });
  assert.deepEqual(await call(api, "set_workflow_secret", { name: "OLD", delete: true, workflowId: "wf-1" }), { deleted: true, name: "OLD", scope: "workflow", workflowId: "wf-1" });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/workflow-secrets/OLD", query: { workflowId: "wf-1" } });
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [{ name: "TOKEN", scope: "global", updatedAt: stamp, value: "must-stay-private" }] } });
  const listed = await call(api, "list_workflow_secrets", { workflowId: "wf-1" });
  assert.deepEqual(listed.secrets, [{ name: "TOKEN", scope: "global", updatedAt: stamp }]);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-1" });
  await rejects(call(api, "set_workflow_secret", { name: "lower", value: "x" }), "INVALID_ARGUMENT");
  await rejects(call(api, "set_workflow_secret", { name: "BIG", value: "x".repeat(64 * 1024 + 1) }), "INVALID_ARGUMENT");
  await rejects(call(api, "set_workflow_secret", { name: "NONE" }), "INVALID_ARGUMENT", /value is required/);
  await rejects(call(api, "set_workflow_secret", { name: "BOTH", value: "v", delete: true }), "INVALID_ARGUMENT", /not both/);
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
  await rejects(call(api, "preview_expression", { workflowId: "wf-1", template: "x", runId: "gone" }), "RUN_NOT_FOUND", /get_workflow_runs/);
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

// ---------------------------------------------------------------------------
// The project union (§4.1, D-25)
// ---------------------------------------------------------------------------

test("workflowUnion: the project, every projectOverride, a temp project's workspace and each sub-workflow's own (recursively); removed members are listed, not refused", async (t) => {
  const api = await sandbox(t);
  const child = definition(api, { id: "wf-child", name: "Child", project: { kind: "temp", workspace: "beta", source: { kind: "empty" } }, nodes: [
    { id: "x", name: "There", type: "code", position: { x: 0, y: 0 }, config: { source: "1" }, projectOverride: api.other },
    { id: "y", name: "Again", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-1" } }
  ] });
  api.on("GET", "/api/workflows/wf-child", { status: 200, body: { workflow: child, problems: [] } });
  api.on("GET", "/api/workflows/wf-ghost", failure(404, "WORKFLOW_NOT_FOUND", "gone"));
  const parent = definition(api, { nodes: [
    ...definition(api).nodes,
    { id: "o", name: "Web", type: "code", position: { x: 0, y: 0 }, config: { source: "2" }, projectOverride: join(api.workspacesDir, "acme", "web") },
    { id: "g", name: "Gone", type: "code", position: { x: 0, y: 0 }, config: { source: "3" }, projectOverride: join(api.workspacesDir, "acme", "removed") },
    { id: "s", name: "Sub", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-child" } },
    { id: "z", name: "Nowhere", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-ghost" } }
  ] as Workflow["nodes"] });
  const union = await workflowUnion(api, [parent]);
  assert.deepEqual(union.projects, [api.own, api.same, api.other]);
  assert.deepEqual(union.pendingWorkspaces, ["beta"]);
  assert.deepEqual(union.missing, [join(api.workspacesDir, "acme", "removed")]);
  assert.deepEqual(union.children.map((c) => [c.workflowId, c.name]), [["wf-child", "Child"], ["wf-ghost", null]]);
  assert.equal(api.calls.filter((c) => c.path === "/api/workflows/wf-1").length, 0, "the parent itself is never re-read (a cycle stops)");
});

test("a chat create's scope is the union: another project makes the Admin card ungrantable even in Full access, and the card names each workspace's git identity", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "" });
  const own = await call(api, "create_workflow", { ...draft(), reason: "nightly checks" }, { who: chat(api), port });
  assert.equal(own.created, true);
  assert.deepEqual(port.cards[0]!.grantOptions, ["chat"], "own project only: the workflows chat grant is offered");
  assert.equal(port.cards[0]!.reason, "nightly checks");
  const nodes = [...draft().nodes, { type: "code", name: "Elsewhere", projectOverride: "beta/app", config: { source: "1" } }];
  await call(api, "create_workflow", { ...draft(), nodes }, { who: chat(api), port });
  const card = port.cards[1]!;
  assert.deepEqual(card.grantOptions, [], "a union beyond the caller's project is never grantable");
  assert.deepEqual(card.scope.projects?.map((p) => [p.path, p.gitAccountLabel]), [[api.own, "acme-bot"], [api.other, "beta-bot"]]);
  const temp = { kind: "temp", workspace: "beta", source: { kind: "empty" } };
  await call(api, "create_workflow", { ...draft(), project: temp }, { who: chat(api), port });
  assert.deepEqual(port.cards[2]!.grantOptions, []);
  assert.deepEqual(port.cards[2]!.pendingProjects, [{ workspace: "beta" }]);
  assert.match(sectionText(port.cards[2]!.sections), /temporary project in workspace beta.*git: beta-bot/);
});

// ---------------------------------------------------------------------------
// Previews (§7.1) and PREVIEW_TOO_LARGE
// ---------------------------------------------------------------------------

test("a create card is complete: triggers, code and shell in full, the whole HTTP request, agent prompts in full incl. a saved prompt's body by title, the union, validation problems", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const body = "Review {project}.\n".repeat(400);
  api.on("GET", "/api/saved-prompts", ({ query }) => ({ status: 200, body: { prompts: query?.projectPath === api.own ? [{ id: "p1", title: "Review checklist", body, projectPath: api.own }] : [] } }));
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [{ severity: "warning", code: "unreachable", message: "Notes is unreachable" }] } });
  const source = `export default async function () {\n${"  step();\n".repeat(3_000)}}`;
  const port = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "not now" });
  const denied = await exec(api, "create_workflow", {
    name: "Nightly",
    project: { kind: "existing", project: "acme/api" },
    nodes: [
      { type: "trigger.schedule", name: "Nightly", config: { preset: { kind: "daily", time: "03:00" }, cron: "0 3 * * *" } },
      { type: "code", name: "Prepare", config: { source } },
      { type: "shell", name: "Build", config: { script: "make all\n./deploy.sh", env: [{ name: "TOKEN", value: "{{ secrets.DEPLOY_TOKEN }}" }] } },
      { type: "http", name: "Notify", config: { method: "POST", url: "https://hooks.example.com/x", headers: [{ name: "Authorization", value: "Bearer {{ secrets.HOOK }}" }], body: { kind: "json", value: "{\"ok\":true}" } } },
      { type: "agent", name: "Fix", config: { prompt: { kind: "text", text: "Fix every failing test.\nThen commit." }, chain: [{ agent: "claude", model: "opus", accounts: { strategy: "fixed", accounts: ["acct-1"] } }] } },
      { type: "agent", name: "Review", config: { prompt: { kind: "saved", promptId: "p1", append: "Be brief." }, chain: [{ agent: "codex", model: "gpt-5" }] } }
    ],
    edges: [{ source: "Nightly", target: "Prepare" }, { source: "Prepare", target: "Build" }]
  }, { who: chat(api), port });
  assert.equal((denied.structuredContent as { code: string }).code, "APPROVAL_DENIED");
  assert.match((denied.structuredContent as { message: string }).message, /not now/);
  assert.ok(!api.calls.some((c) => c.method === "POST" && c.path === "/api/workflows"), "denied: nothing created");
  const card = port.cards[0]!;
  assert.equal(card.kind, "admin");
  assert.equal(card.family, "workflows");
  assert.equal(card.title, "Claude wants to create the workflow \"Nightly\"");
  const find = (title: RegExp) => card.sections.find((s) => "title" in s && typeof s.title === "string" && title.test(s.title));
  assert.match((find(/^Triggers$/) as { text: string }).text, /Nightly: /);
  assert.equal((find(/^Code · Prepare/) as { text: string }).text, source, "code in full");
  assert.equal((find(/^Shell \(bash\) · Build/) as { text: string }).text, "make all\n./deploy.sh");
  assert.deepEqual((find(/^Shell environment · Build/) as { rows: unknown[] }).rows, [{ label: "env TOKEN", value: "{{ secrets.DEPLOY_TOKEN }}" }]);
  const http = find(/^HTTP · Notify/) as { rows: { label: string; value: string }[] };
  assert.deepEqual(http.rows.slice(0, 2), [{ label: "Request", value: "POST https://hooks.example.com/x" }, { label: "Header Authorization", value: "Bearer {{ secrets.HOOK }}" }]);
  assert.equal((find(/^HTTP body \(json\) · Notify/) as { text: string }).text, "{\"ok\":true}");
  assert.equal((find(/^Prompt · Fix/) as { text: string }).text, "Fix every failing test.\nThen commit.");
  assert.match(JSON.stringify(find(/^Agent · Fix/)), /claude · opus · fixed, accounts acct-1/);
  assert.match(JSON.stringify(find(/^Agent · Fix/)), /"Permission mode","value":"Full access, unattended","state":"flagged"/);
  const saved = find(/^Saved prompt "Review checklist" · Review/) as { text: string; sha256: string };
  assert.equal(saved.text, body, "a saved prompt's whole current body");
  assert.equal((find(/^Appended to the prompt · Review/) as { text: string }).text, "Be brief.");
  assert.match(sectionText([find(/^Runs in these projects/)!]), /acme\/api \(this chat's project\).*git: acme-bot \(acmebot\)/);
  assert.match(sectionText(card.sections), /Notes is unreachable/);
  assert.match(sectionText(card.sections), /Prepare → Build/);
});

test("PREVIEW_TOO_LARGE: a change whose whole preview passes 1 MiB is refused before any card", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const port = new FakeApprovalPort();
  // Each block within the daemon's 512 KiB source limit; together over the 1 MiB preview cap.
  const big = "x".repeat(400 * 1024);
  const nodes = ["A", "B", "C"].map((name) => ({ type: "code", name, config: { source: big } }));
  const result = await exec(api, "create_workflow", { ...draft(), nodes, edges: [] }, { who: chat(api), port });
  assert.equal((result.structuredContent as { code: string }).code, "PREVIEW_TOO_LARGE");
  assert.equal(port.cards.length, 0);
});

test("an update card shows the ops, the graph diff and the changed blocks in full (unchanged ones listed); enabling shows every block", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/patch", { status: 200, body: { workflow: definition(api, { revision: 8 }), problems: [] } });
  const port = new FakeApprovalPort();
  await call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "update_node", node: "Work", set: { config: { source: "return 42" } } }, { op: "add_node", node: { type: "code", name: "Extra", config: { source: "return 'new'" } } }, { op: "connect", source: "Finish", target: "Extra" }] }, { who: chat(api), port });
  const card = port.cards[0]!;
  assert.equal(card.title, "Claude wants to change the workflow \"Demo\"");
  assert.equal(card.workflowId, "wf-1");
  const changes = card.sections.find((s) => s.kind === "changes") as { items: { label: string; change: string; detail?: string }[] };
  assert.deepEqual(changes.items, [
    { label: "code · Work", change: "changed", detail: "config.source" },
    { label: "code · Extra", change: "added" },
    { label: "connection Finish → Extra", change: "added" }
  ]);
  const diff = card.sections.find((s) => s.kind === "diff" && s.title === "Block Work") as { unifiedDiff: string };
  assert.match(diff.unifiedDiff, /^-.*return 1; \}"$/m);
  assert.match(diff.unifiedDiff, /^\+ +"source": "return 42"$/m);
  assert.ok(card.sections.some((s) => s.kind === "code" && s.title === "Ops"));
  assert.ok(card.sections.some((s) => s.kind === "code" && s.title === "Code · Extra" && s.text === "return 'new'"));
  assert.ok(!card.sections.some((s) => s.kind === "code" && s.title === "Code · Finish"), "an unchanged block is listed, not shown");
  assert.match(sectionText(card.sections), /Unchanged blocks.*code · Finish/);
  assert.deepEqual(card.grantOptions, ["chat"]);
  await call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_enabled", enabled: true }] }, { who: chat(api), port });
  const enable = port.cards[1]!;
  assert.equal(enable.title, "Claude wants to enable the workflow \"Demo\"");
  assert.equal(enable.sections[0]!.kind, "warning");
  assert.ok(enable.sections.some((s) => s.kind === "code" && s.title === "Code · Finish"), "enabling arms every block: all shown");
});

test("an update or create the daemon would refuse is refused before any card: a stale revision, a failing op, enabling with errors", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const port = new FakeApprovalPort();
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 6, ops: [{ op: "set_name", name: "X" }] }, { who: chat(api), port }), "REVISION_CONFLICT");
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "remove_node", node: "Ghost" }] }, { who: chat(api), port }), "INVALID_WORKFLOW", /ops\[0\]/);
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [{ severity: "error", code: "cycle", message: "Cycle" }] } });
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_enabled", enabled: true }] }, { who: chat(api), port }), "INVALID_WORKFLOW", /enabled workflow cannot have errors/);
  await rejects(call(api, "create_workflow", { ...draft(), enabled: true }, { who: chat(api), port }), "INVALID_WORKFLOW", /cycle/);
  assert.equal(port.cards.length, 0);
});

test("delete and run cards: what is removed; the run's revision, enabled state and input", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api, definition(api, { enabled: true }));
  api.on("GET", "/api/workflows/wf-1/runs", ({ query }) => ({ status: 200, body: query?.before ? { runs: [runRecord(definition(api), "failed")], before: null } : { runs: [runRecord(definition(api)), runRecord(definition(api), "succeeded")], before: "c2" } }));
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [{ name: "GLOBAL", scope: "global", updatedAt: stamp }, { name: "OWN", scope: "workflow", workflowId: "wf-1", updatedAt: stamp }] } });
  api.on("DELETE", "/api/workflows/wf-1", { status: 200, body: { ok: true } });
  const port = new FakeApprovalPort();
  await call(api, "delete_workflow", { workflowId: "wf-1", confirm: true }, { who: chat(api), port });
  const del = port.cards[0]!;
  assert.match(sectionText(del.sections), /cancels its 1 active run\(s\) and removes its 3 recorded run\(s\) and 1 own secret/);
  assert.match(sectionText(del.sections), /"Its own secrets","value":"OWN"/);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api)) } });
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7, input: { ticket: "PROJ-9" }, force: true }, { who: chat(api), port });
  const run = port.cards[1]!;
  assert.equal(run.title, "Claude wants to run the workflow \"Demo\"");
  assert.equal(run.workflowId, "wf-1");
  assert.match(sectionText(run.sections), /"Revision","value":"7".*"Enabled","value":"yes".*force/);
  assert.ok(run.sections.some((s) => s.kind === "code" && s.text === JSON.stringify({ ticket: "PROJ-9" }, null, 2)));
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 5 }, { who: chat(api), port }), "REVISION_CONFLICT");
  assert.equal(port.cards.length, 2, "a stale revision never reaches the user");
});

// ---------------------------------------------------------------------------
// Pins (§7.2): what is approved is what runs
// ---------------------------------------------------------------------------

test("PREVIEW_STALE: the workflow edited while its update or run card waited — nothing written, no run", async (t) => {
  const api = await sandbox(t);
  let current = definition(api);
  api.on("GET", "/api/workflows/wf-1", () => ({ status: 200, body: { workflow: current, problems: [] } }));
  api.on("POST", "/api/workflows/wf-1/patch", { status: 200, body: { workflow: current, problems: [] } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  const port = new FakeApprovalPort(() => {
    current = definition(api, { revision: 8, name: "Edited by the user" });
    return { outcome: "approved", approvalId: "" };
  });
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_name", name: "Mine" }] }, { who: chat(api), port }), "PREVIEW_STALE", /revision 7 → 8/);
  assert.ok(!api.calls.some((c) => c.path === "/api/workflows/wf-1/patch"));
  current = definition(api);
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port }), "PREVIEW_STALE");
  assert.ok(!api.calls.some((c) => c.path === "/api/workflows/wf-1/run"));
  // The race past the check: the run froze another revision → cancelled at once, PREVIEW_STALE.
  current = definition(api);
  port.answerWith({ outcome: "approved", approvalId: "" });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(definition(api, { revision: 9 })) } });
  api.on("POST", "/api/workflow-runs/run-1/cancel", { status: 200, body: { cancelled: true } });
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port }), "PREVIEW_STALE", /run run-1 started, after the user approved the card; it was cancelled/);
  assert.ok(api.calls.some((c) => c.path === "/api/workflow-runs/run-1/cancel"));
  // A patch refused for its revision after the card is PREVIEW_STALE too.
  api.on("POST", "/api/workflows/wf-1/patch", failure(409, "REVISION_CONFLICT", "Stale"));
  await rejects(call(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_name", name: "Mine" }] }, { who: chat(api), port }), "PREVIEW_STALE");
});

test("PREVIEW_STALE: a saved prompt the card showed in full changed before the write", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  let body = "Original body";
  api.on("GET", "/api/saved-prompts", () => ({ status: 200, body: { prompts: [{ id: "p1", title: "Shared", body, projectPath: null }] } }));
  const port = new FakeApprovalPort(() => {
    body = "Swapped body";
    return { outcome: "approved", approvalId: "" };
  });
  const nodes = [{ type: "trigger.manual", name: "Go" }, { type: "agent", name: "Ask", config: { prompt: { kind: "saved", promptId: "p1" }, chain: [{ agent: "claude", model: "opus" }] } }];
  await rejects(call(api, "create_workflow", { ...draft(), nodes, edges: [] }, { who: chat(api), port }), "PREVIEW_STALE", /saved prompt "Shared"/);
  assert.ok(!api.calls.some((c) => c.method === "POST" && c.path === "/api/workflows"));
  assert.match(JSON.stringify(port.cards[0]!.sections), /Original body/);
});

// ---------------------------------------------------------------------------
// Workflow secrets for chat callers (D-11)
// ---------------------------------------------------------------------------

test("set_workflow_secret from a chat: no value argument; the user types it into the card; it reaches the store and nowhere else; never grantable", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [] } });
  api.on("PUT", "/api/workflow-secrets/*", { status: 200, body: { secrets: [] } });
  api.on("DELETE", "/api/workflow-secrets/*", { status: 204, body: null });
  const value = "s3cret-typed-by-the-user";
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "", secrets: { value } });
  // A chat agent can never send a value.
  const sent = await exec(api, "set_workflow_secret", { name: "JIRA_TOKEN", value: "from-the-agent" }, { who: chat(api), port });
  assert.equal((sent.structuredContent as { code: string }).code, "INVALID_ARGUMENT");
  assert.equal(port.cards.length, 0);
  const result = await call(api, "set_workflow_secret", { name: "JIRA_TOKEN", workflowId: "wf-1", reason: "the fixer needs Jira" }, { who: chat(api), port });
  const card = port.cards[0]!;
  assert.equal(card.family, "workflow-secrets");
  assert.deepEqual(card.secretFields, [{ key: "value", label: "Value of JIRA_TOKEN" }]);
  assert.deepEqual(card.grantOptions, [], "workflow secrets are never grantable, even in Full access");
  const put = api.calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put, { method: "PUT", path: "/api/workflow-secrets/JIRA_TOKEN", query: { workflowId: "wf-1" }, body: { value } });
  // The result carries the row's toolApproval reference (Task 6), never the value.
  const { toolApproval, ...stored } = result as Record<string, unknown>;
  assert.deepEqual(stored, { set: true, name: "JIRA_TOKEN", scope: "workflow", workflowId: "wf-1" });
  assert.deepEqual([(toolApproval as { outcome?: string }).outcome, (toolApproval as { family?: string }).family], ["approved", "workflow-secrets"]);
  assert.ok(!JSON.stringify(result).includes(value) && !JSON.stringify(card).includes(value), "never in the result or the card");
  // A global secret's card says so; a delete asks for no value.
  await call(api, "set_workflow_secret", { name: "OLD", delete: true }, { who: chat(api), port });
  assert.deepEqual(port.cards[1]!.secretFields, []);
  assert.match(sectionText(port.cards[1]!.sections), /Global — every workflow's blocks can read it/);
  // An approval that carries no value (an older client) writes nothing.
  port.answerWith({ outcome: "approved", approvalId: "" });
  await rejects(call(api, "set_workflow_secret", { name: "EMPTY" }, { who: chat(api), port }), "INVALID_ARGUMENT", /no value/);
  assert.equal(api.calls.filter((c) => c.method === "PUT").length, 1);
});

// ---------------------------------------------------------------------------
// The gate for chat callers: reads' scope, workflow-owned and planning callers
// ---------------------------------------------------------------------------

test("chat reads claim the workflow's home: list_workflows defaults to the caller's project; another workspace's workflow cards below Full access", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/workflows", { status: 200, body: { workflows: [] } });
  const port = new FakeApprovalPort();
  await call(api, "list_workflows", {}, { who: chat(api, { runtimeMode: "approval-required" }), port });
  assert.deepEqual(api.calls.at(-1)!.query, { projectPath: api.own });
  assert.equal(port.cards.length, 0);
  await rejects(call(api, "list_workflows", {}, { who: chat(api, { projectPath: "", workspace: "" }), port }), "INVALID_ARGUMENT", /no project/);
  serveDefinition(api, definition(api, { id: "wf-beta", project: { kind: "existing", projectPath: api.other } }));
  await call(api, "get_workflow", { workflowId: "wf-beta" }, { who: chat(api), port });
  assert.equal(port.cards.length, 0, "Full access reads another workspace's metadata");
  await call(api, "get_workflow", { workflowId: "wf-beta" }, { who: chat(api, { runtimeMode: "auto" }), port });
  assert.equal(port.cards[0]!.kind, "boundary");
  assert.equal(port.cards[0]!.family, "cross-workspace-read");
});

test("cancel_workflow_run is Act in the project the run runs in: own project free, another workspace cards below Full access, a workflow-owned caller never acts away", async (t) => {
  const api = await sandbox(t);
  const ownRun = { ...runRecord(definition(api)), projectPath: api.own };
  const awayRun = { ...runRecord(definition(api, { project: { kind: "existing", projectPath: api.other } })), id: "run-2", projectPath: api.other };
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: ownRun } });
  api.on("GET", "/api/workflow-runs/run-2", { status: 200, body: { run: awayRun } });
  api.on("POST", "/api/workflow-runs/*", { status: 200, body: { cancelled: true } });
  const port = new FakeApprovalPort();
  assert.equal((await call(api, "cancel_workflow_run", { runId: "run-1" }, { who: chat(api, { runtimeMode: "approval-required" }), port })).cancelRequested, true);
  assert.equal(port.cards.length, 0);
  await call(api, "cancel_workflow_run", { runId: "run-2" }, { who: chat(api, { runtimeMode: "auto" }), port });
  assert.equal(port.cards[0]!.kind, "boundary");
  assert.equal(port.cards[0]!.family, "cross-project");
  await rejects(call(api, "cancel_workflow_run", { runId: "run-2" }, { who: chat(api, { workflowOwned: true }), port }), "PERMISSION_DENIED", /automated workflow/);
  await rejects(call(api, "cancel_workflow_run", { runId: "run-1" }, { who: chat(api, { planning: true }), port }), "PERMISSION_DENIED", /planning/);
});

test("workflow-owned callers get no Admin (ADMIN_NOT_AVAILABLE, no card); planning callers are refused Admin; dry runs stay available", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const port = new FakeApprovalPort();
  for (const [name, args] of [["create_workflow", draft()], ["update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "set_enabled", enabled: false }] }], ["run_workflow", { workflowId: "wf-1", revision: 7 }], ["delete_workflow", { workflowId: "wf-1", confirm: true }], ["set_workflow_secret", { name: "X" }]] as const) {
    await rejects(call(api, name, args as Record<string, unknown>, { who: chat(api, { workflowOwned: true }), port }), "ADMIN_NOT_AVAILABLE");
    await rejects(call(api, name, args as Record<string, unknown>, { who: chat(api, { planning: true }), port }), "PERMISSION_DENIED", /planning/);
  }
  assert.equal(port.cards.length, 0);
  assert.equal((await call(api, "create_workflow", { ...draft(), dryRun: true }, { who: chat(api, { workflowOwned: true }), port })).dryRun, true);
});

test("run_workflow fails closed after the start: an unreadable run is cancelled, a failed cancel is reported truthfully, the engine's refusal after a card is PREVIEW_STALE", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 500, body: null });
  api.on("POST", "/api/workflow-runs/run-1/cancel", { status: 200, body: { cancelled: true } });
  const unread = await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }), "RUN_UNVERIFIED", /could not be checked against revision 7, so it was cancelled/);
  assert.deepEqual(unread.detail, { runId: "run-1", cancelled: true });
  api.on("POST", "/api/workflow-runs/run-1/cancel", { status: 503, body: null });
  const stuck = await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }), "RUN_UNVERIFIED", /could NOT be cancelled.*cancel_workflow_run/);
  assert.deepEqual(stuck.detail, { runId: "run-1", cancelled: false });
  // The engine's own atomic check (expectedRevision) after a card.
  api.on("POST", "/api/workflows/wf-1/run", failure(409, "REVISION_CONFLICT", "The workflow is at revision 8, not 7."));
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port: new FakeApprovalPort() }), "PREVIEW_STALE", /no run started/);
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }), "REVISION_CONFLICT");
});

test("a run card shows the definition that will run in full, and pins every sub-workflow's revision (PREVIEW_STALE when one changes)", async (t) => {
  const api = await sandbox(t);
  let child = definition(api, { id: "wf-child", name: "Child", enabled: false, revision: 3 });
  api.on("GET", "/api/workflows/wf-child", () => ({ status: 200, body: { workflow: child, problems: [] } }));
  const parent = definition(api, { nodes: [...definition(api).nodes, { id: "s", name: "Sub", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-child" } }] as Workflow["nodes"] });
  serveDefinition(api, parent);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(parent) } });
  const port = new FakeApprovalPort(() => {
    child = { ...child, revision: 4 };
    return { outcome: "approved", approvalId: "" };
  });
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port }), "PREVIEW_STALE", /sub-workflow wf-child \(revision 3 → 4\)/);
  assert.ok(!api.calls.some((c) => c.path === "/api/workflows/wf-1/run"), "no run started");
  const card = port.cards[0]!;
  assert.ok(card.sections.some((s) => s.kind === "code" && s.title === "Code · Work" && s.text.includes("return 1")), "block contents in full");
  assert.ok(card.sections.some((s) => s.kind === "warning" && s.level === "danger" && /DISABLED workflow "Child"/.test(s.text)));
  assert.equal(card.workflowId, "wf-1");
});

test("run_workflow: the run's frozen sub-workflows must be the pinned revisions, else it is cancelled (PREVIEW_STALE)", async (t) => {
  const api = await sandbox(t);
  const child = definition(api, { id: "wf-child", name: "Child", revision: 3 });
  api.on("GET", "/api/workflows/wf-child", { status: 200, body: { workflow: child, problems: [] } });
  const parent = definition(api, { nodes: [...definition(api).nodes, { id: "s", name: "Sub", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-child" } }] as Workflow["nodes"] });
  serveDefinition(api, parent);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("POST", "/api/workflow-runs/run-1/cancel", { status: 200, body: { cancelled: true } });
  const port = new FakeApprovalPort();
  // The child was edited between the card's check and the start: the run froze revision 4.
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: { ...runRecord(parent), subWorkflowRevisions: { "wf-child": 4 } } } });
  const error = await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port }), "PREVIEW_STALE", /sub-workflow wf-child \(revision 3 → 4\) changed as run run-1 started/);
  assert.deepEqual(error.detail, { runId: "run-1", cancelled: true });
  assert.ok(api.calls.some((c) => c.method === "POST" && c.path === "/api/workflow-runs/run-1/cancel"), "the run was cancelled");
  // Frozen as pinned: it runs.
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: { ...runRecord(parent), subWorkflowRevisions: { "wf-child": 3 } } } });
  const started = await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(started.status, "started");
  // Watching the run names what it froze.
  const watched = await call(api, "get_workflow_runs", { runId: "run-1" });
  assert.deepEqual((watched.run as Record<string, unknown>).subWorkflowRevisions, { "wf-child": 3 });
});

test("grants fail closed on a union member that no longer resolves, and cover a sub-workflow only when the same grant covers it", async (t) => {
  const api = await sandbox(t);
  const broken = definition(api, { nodes: [...definition(api).nodes, { id: "g", name: "Gone", type: "code", position: { x: 0, y: 0 }, config: { source: "1" }, projectOverride: join(api.workspacesDir, "acme", "removed") }] as Workflow["nodes"] });
  serveDefinition(api, broken);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(broken) } });
  const port = new FakeApprovalPort().grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1"] });
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(port.cards.length, 1, "a missing member: never covered by the grant");
  assert.deepEqual(port.cards[0]!.grantOptions, []);
  // A sub-workflow the grant does not cover → card; covered by the same grant → none.
  const child = definition(api, { id: "wf-child", name: "Child" });
  api.on("GET", "/api/workflows/wf-child", { status: 200, body: { workflow: child, problems: [] } });
  const parent = definition(api, { nodes: [...definition(api).nodes, { id: "s", name: "Sub", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-child" } }] as Workflow["nodes"] });
  serveDefinition(api, parent);
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: { ...runRecord(parent), subWorkflowRevisions: { "wf-child": 7 } } } });
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(port.cards.length, 2, "the child is not in the grant");
  assert.deepEqual(port.cards[1]!.grantOptions, ["chat"]);
  port.file.grants[0]!.workflowIds = ["wf-1", "wf-child"];
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(port.cards.length, 2, "parent and child covered by the same grant: no card");
});

test("secrets: editing what a secret-reading block does is never granted (card every time); an unrelated edit stays covered", async (t) => {
  const api = await sandbox(t);
  const base = definition(api, {
    nodes: [
      ...definition(api).nodes,
      {
        id: "h", name: "Notify", type: "http", position: { x: 0, y: 0 },
        config: { method: "POST", url: "{{ nodes.Work.output.url }}", headers: [{ name: "Authorization", value: "Bearer {{ secrets.TOKEN }}" }], query: [] }
      },
      { id: "s", name: "Plain", type: "http", position: { x: 0, y: 0 }, config: { method: "GET", url: "https://example.com/{{ secrets.PATH }}", headers: [], query: [] } }
    ] as Workflow["nodes"],
    edges: [...definition(api).edges, { id: "ah", source: "a", sourceHandle: "success", target: "h" }, { id: "ts", source: "t", sourceHandle: "success", target: "s" }]
  });
  serveDefinition(api, base);
  const port = new FakeApprovalPort({ outcome: "denied", approvalId: "" }).grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1"] });
  const update = (ops: unknown[]) => exec(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops }, { who: chat(api), port });
  // Finish is not upstream of a secret-reading block: the grant covers it.
  await update([{ op: "update_node", node: "Finish", set: { config: { source: "export default async function () { return 3; }" } } }]);
  assert.equal(port.cards.length, 0, "an unrelated edit stays covered by the grant");
  // Retargeting the HTTP block that sends the token: a card, no grant options, the note says why.
  await update([{ op: "update_node", node: "Notify", set: { config: { url: "https://evil.example/" } } }]);
  assert.equal(port.cards.length, 1);
  assert.deepEqual(port.cards[0]!.grantOptions, []);
  assert.match(sectionText(port.cards[0]!.sections), /reads a workflow secret/);
  // Changing what feeds its URL (an upstream block it interpolates): a card too.
  await update([{ op: "update_node", node: "Work", set: { config: { source: "export default async function () { return { url: 'https://evil.example/' }; }" } } }]);
  assert.equal(port.cards.length, 2);
  assert.deepEqual(port.cards[1]!.grantOptions, []);
  // Plain reads a secret but only a constant URL: an upstream edit of Start's neighbours does not touch it…
  // …while adding a block that reads a secret does.
  await update([{ op: "add_node", node: { type: "shell", name: "Publish", config: { script: "npm publish", env: [{ name: "NPM_TOKEN", value: "{{ secrets.NPM_TOKEN }}" }] } } }]);
  assert.equal(port.cards.length, 3);
  assert.deepEqual(port.cards[2]!.grantOptions, []);
  // A create always cards (no grant covers a workflow that does not exist yet); its grant options stand.
  serveDefinition(api, base);
  await exec(api, "create_workflow", { ...draft(), nodes: [{ type: "trigger.manual", name: "Start" }, { type: "code", name: "Work", config: { source: "export default async function ({ secrets }) { return secrets.KEY; }" } }] }, { who: chat(api), port });
  assert.equal(port.cards.length, 4);
  assert.deepEqual(port.cards.at(-1)!.grantOptions, ["chat"]);
});

test("reverse direction: a grant never covers changing or deleting a workflow that a workflow outside the grant runs as a sub-workflow (directly or through others); running it stays covered", async (t) => {
  const api = await sandbox(t);
  const child = serveDefinition(api);
  const subBlock = (id: string, target: string) => ({ id, name: `Run ${target}`, type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: target } });
  const userParent = definition(api, { id: "wf-user", name: "Nightly", enabled: true, nodes: [...definition(api).nodes, subBlock("s", "wf-1")] as Workflow["nodes"] });
  api.on("GET", "/api/workflows/wf-user", { status: 200, body: { workflow: userParent, problems: [] } });
  // The daemon's reference index over the stored definitions.
  const stored: Workflow[] = [child, userParent];
  const unreadable: unknown[] = [];
  serveWorkflowReferences(api, () => stored, () => unreadable);
  const referenceReads = () => api.calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/workflow-references/")).length;
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(child) } });
  const port = new FakeApprovalPort({ outcome: "denied", approvalId: "" }).grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1"] });
  const update = () => exec(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "update_node", node: "Finish", set: { config: { source: "export default async function () { return 3; }" } } }] }, { who: chat(api), port });
  await update();
  await exec(api, "delete_workflow", { workflowId: "wf-1", confirm: true }, { who: chat(api), port });
  assert.equal(port.cards.length, 2, "update and delete card");
  // Running it changes nothing Nightly runs: the grant covers the run, and no caller list is read.
  const readsBefore = referenceReads();
  const ran = await exec(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(ran.isError, undefined, JSON.stringify(ran.structuredContent));
  assert.equal(port.cards.length, 2, "the run is covered by the grant");
  assert.equal(referenceReads(), readsBefore, "no caller check for a run");
  // One index read per card, never a read of every definition.
  assert.ok(!api.calls.some((c) => c.method === "GET" && c.path === "/api/workflows"), "no list read for callers");
  for (const card of port.cards) {
    assert.deepEqual(card.grantOptions, [], "a grant chosen here could never cover it");
    assert.match(sectionText(card.sections), /Workflows that run it as a sub-workflow/);
    assert.match(sectionText(card.sections), /Nightly/);
  }
  // The calling workflow in the same grant: covered again.
  port.file.grants[0]!.workflowIds = ["wf-1", "wf-user"];
  await update();
  assert.equal(port.cards.length, 2, "caller and callee in one grant: no card");
  // Through another workflow: Weekly (outside) runs Nightly (inside), which runs wf-1.
  const outer = definition(api, { id: "wf-outer", name: "Weekly", nodes: [...definition(api).nodes, subBlock("o", "wf-user")] as Workflow["nodes"] });
  api.on("GET", "/api/workflows/wf-outer", { status: 200, body: { workflow: outer, problems: [] } });
  stored.push(outer);
  await update();
  assert.equal(port.cards.length, 3, "a transitive caller outside the grant cards");
  assert.match(sectionText(port.cards[2]!.sections), /Weekly/);
  // All three in the grant: covered.
  port.file.grants[0]!.workflowIds = ["wf-1", "wf-user", "wf-outer"];
  await update();
  assert.equal(port.cards.length, 3);
  // A definition the daemon cannot read that names one of them: the callers are unknown — fail closed.
  unreadable.push({ id: "wf-future", name: "From a newer build", nodes: [{ type: "workflow.v2", config: { target: "wf-user" } }] });
  await update();
  assert.equal(port.cards.length, 4);
  assert.deepEqual(port.cards[3]!.grantOptions, []);
  assert.match(sectionText(port.cards[3]!.sections), /could not check which workflows run this one/);
  unreadable.length = 0;
  // Callers that cannot be read at all: fail closed too.
  api.on("GET", "/api/workflow-references/workflows/*", { status: 500, body: { error: { code: "INTERNAL", message: "x" } } });
  await update();
  assert.equal(port.cards.length, 5);
  assert.deepEqual(port.cards[4]!.grantOptions, []);
});

test("changesSecretUse: added, changed, newly reachable and (for interpolating blocks) upstream changes count; unrelated ones do not", () => {
  const node = (id: string, type: string, config: Record<string, unknown>) => ({ id, name: id, type, position: { x: 0, y: 0 }, config }) as Workflow["nodes"][number];
  const edges = [{ id: "1", source: "t", sourceHandle: "success", target: "a" }, { id: "2", source: "a", sourceHandle: "success", target: "h" }];
  const after = { nodes: [node("t", "trigger.manual", {}), node("a", "code", { source: "1" }), node("h", "http", { url: "https://x/{{ secrets.P }}" })], edges };
  assert.equal(changesSecretUse(null, after, null), true, "a create with a secret-reading block");
  assert.equal(changesSecretUse(after, after, new Set(["h"])), true);
  assert.equal(changesSecretUse(after, after, new Set(["a"])), false, "h interpolates only a secret: an upstream change cannot retarget it");
  const fed = { ...after, nodes: [...after.nodes.slice(0, 2), node("h", "http", { url: "{{ nodes.a.output }}", headers: [{ name: "X", value: "{{ secrets.P }}" }] })] };
  assert.equal(changesSecretUse(fed, fed, new Set(["a"])), true, "h's URL comes from a: changing a retargets it");
  assert.equal(changesSecretUse(fed, fed, new Set(["t"])), true, "transitively upstream");
  const plain = { ...after, nodes: [after.nodes[0]!, after.nodes[1]!, node("h", "http", { url: "https://x/" })] };
  assert.equal(changesSecretUse(null, plain, null), false, "no secret anywhere");
  assert.equal(blockUsesSecrets(node("c", "code", { source: "export default async ({ secrets }) => secrets" })), true);
  assert.equal(blockUsesSecrets(node("p", "agent", { prompt: "never print secrets" })), false, "prose is not a template");
  assert.equal(blockUsesSecrets(node("d", "code", { source: "export default async function ({ input, nodes, secrets, log }) {\n  return { ok: true };\n}\n" })), false, "the standard signature alone reads nothing");
  assert.equal(blockUsesSecrets(node("e", "code", { source: "export default async function ({ secrets }) { await fetch(secrets.URL); }" })), true);
});

test("an update card shows in full what the change makes run: an added edge's target and its downstream, newly reachable blocks, a re-routed if's branches", async (t) => {
  const api = await sandbox(t);
  const base = definition(api, {
    nodes: [
      ...definition(api).nodes,
      { id: "x", name: "Dormant", type: "shell", position: { x: 0, y: 0 }, config: { script: "rm -rf build", env: [] } },
      { id: "y", name: "After", type: "code", position: { x: 0, y: 0 }, config: { source: "return 'after'" } },
      { id: "i", name: "Gate", type: "if", position: { x: 0, y: 0 }, config: { combine: "all", rules: [{ left: "{{ input }}", op: "isTrue" }] } },
      { id: "z", name: "Branch", type: "code", position: { x: 0, y: 0 }, config: { source: "return 'branch'" } }
    ] as Workflow["nodes"],
    edges: [...definition(api).edges, { id: "xy", source: "x", sourceHandle: "success", target: "y" }, { id: "bi", source: "b", sourceHandle: "success", target: "i" }, { id: "iz", source: "i", sourceHandle: "true", target: "z" }]
  });
  serveDefinition(api, base);
  const port = new FakeApprovalPort({ outcome: "denied", approvalId: "" });
  await exec(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "connect", source: "Start", target: "Dormant" }] }, { who: chat(api), port });
  const shown = (card: (typeof port.cards)[number]) => card.sections.filter((s) => s.kind === "code" || s.kind === "fields").map((s) => ("title" in s ? s.title : ""));
  const first = shown(port.cards[0]!);
  assert.ok(first.includes("Shell (bash) · Dormant"), "the newly wired block in full");
  assert.ok(first.includes("Code · After"), "its downstream in full");
  assert.ok(!first.includes("Code · Branch"));
  await exec(api, "update_workflow", { workflowId: "wf-1", revision: 7, ops: [{ op: "update_node", node: "Gate", set: { config: { rules: [{ left: "true", op: "isTrue" }] } } }] }, { who: chat(api), port });
  assert.ok(shown(port.cards[1]!).includes("Code · Branch"), "a re-routed if shows its branches in full");
});

test("a run card whose DEFINITION is too large to show: measured whole, an outline with a red warning, the prompts listed, the input whole — never grantable", async (t) => {
  const api = await sandbox(t);
  const big = "x".repeat(400 * 1024);
  const huge = definition(api, { nodes: [
    ...definition(api).nodes,
    ...["A", "B", "C"].map((name) => ({ id: name, name, type: "code", position: { x: 0, y: 0 }, config: { source: big } })),
    { id: "p", name: "Ask", type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "saved", promptId: "p1" }, chain: [{ agent: "claude", model: "opus" }] } }
  ] as Workflow["nodes"] });
  serveDefinition(api, huge);
  api.on("GET", "/api/saved-prompts", { status: 200, body: { prompts: [{ id: "p1", title: "Triage", body: "Look.", projectPath: null }] } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(huge) } });
  // A grant that would cover wf-1: an outline card is never covered.
  const port = new FakeApprovalPort().grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1"] });
  const input = { blob: "y".repeat(100 * 1024) };
  const result = await call(api, "run_workflow", { workflowId: "wf-1", revision: 7, input }, { who: chat(api), port });
  assert.equal(result.runId, "run-1");
  const card = port.cards[0]!;
  assert.ok(card, "a card opened despite the grant");
  assert.deepEqual(card.grantOptions, []);
  assert.deepEqual(card.sections[0], { kind: "warning", level: "danger", text: "This workflow is too large to show here — open it in Workflows to review every block before approving." });
  assert.ok(!card.sections.some((s) => s.kind === "code" && s.title.startsWith("Code · ")), "no block bodies");
  assert.match(sectionText(card.sections), /code · A.*code · B.*code · C/);
  assert.match(sectionText(card.sections), /"label":"Triage","value":"5 characters"/);
  const shownInput = card.sections.find((s) => s.kind === "code" && s.title.startsWith("Input")) as { text: string; partial?: boolean };
  assert.equal(shownInput.partial, undefined, "the agent's input is never cut");
  assert.equal(shownInput.text, JSON.stringify(input, null, 2));
  // A smaller one is shown whole, covered by the grant.
  serveDefinition(api, definition(api));
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(port.cards.length, 1, "the whole-card run is covered by the grant");
});

test("PREVIEW_STALE wording tells a grant pass from a card approval", async (t) => {
  const api = await sandbox(t);
  let reads = 0;
  api.on("GET", "/api/workflows/wf-1", () => ({ status: 200, body: { workflow: definition(api, { revision: (reads += 1) >= 3 ? 8 : 7 }), problems: [] } }));
  const port = new FakeApprovalPort().grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1"] });
  const error = await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port }), "PREVIEW_STALE", /The workflow \(revision 7 → 8\) changed after this chat's grant allowed the call/);
  assert.doesNotMatch(error.message, /approved the card/);
  assert.equal(port.cards.length, 0);
});

test("an input too large to show is PREVIEW_TOO_LARGE before any card (never cut, never outlined away)", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  const port = new FakeApprovalPort();
  await rejects(call(api, "run_workflow", { workflowId: "wf-1", revision: 7, input: { blob: "z".repeat(1_100_000) } }, { who: chat(api), port }), "PREVIEW_TOO_LARGE", /Pass a smaller input/);
  assert.equal(port.cards.length, 0);
  assert.ok(!api.calls.some((c) => c.path === "/api/workflows/wf-1/run"));
});

test("the children-join-the-grant title only where a grant chosen there records them; a create records its children only on an explicit grant choice", async (t) => {
  const api = await sandbox(t);
  const child = definition(api, { id: "wf-child", name: "Child", revision: 2 });
  api.on("GET", "/api/workflows/wf-child", { status: 200, body: { workflow: child, problems: [] } });
  const parent = definition(api, { nodes: [...definition(api).nodes, { id: "s", name: "Sub", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-child" } }] as Workflow["nodes"] });
  serveDefinition(api, parent);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: { ...runRecord(parent), subWorkflowRevisions: { "wf-child": 2 } } } });
  api.on("DELETE", "/api/workflows/wf-1", { status: 200, body: { ok: true } });
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [] } });
  api.on("PUT", "/api/workflow-secrets/*", { status: 200, body: { secrets: [] } });
  const titleOf = (card: { sections: ApprovalPreviewSection[] }) => (card.sections.find((s) => s.kind === "fields" && /^Workflows it also runs/.test(s.title ?? "")) as { title: string } | undefined)?.title;
  const JOIN = "Workflows it also runs (a chat grant chosen here covers them too)";
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "", secrets: { value: "v4lue" } });
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(titleOf(port.cards[0]!), JOIN, "full-access, own project: a grant chosen here records the child");
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api, { runtimeMode: "auto" }), port });
  assert.equal(titleOf(port.cards[1]!), "Workflows it also runs", "no grant can be offered: neutral");
  await call(api, "delete_workflow", { workflowId: "wf-1", confirm: true }, { who: chat(api), port });
  assert.equal(titleOf(port.cards[2]!), "Workflows it also runs", "deleting runs nothing: neutral");
  await call(api, "set_workflow_secret", { name: "TOKEN", workflowId: "wf-1" }, { who: chat(api), port });
  assert.equal(titleOf(port.cards[3]!), "Workflows it also runs", "secrets are never grantable: neutral");
  // A create wiring in a sub-workflow: the join path (grantId, no choice) records nothing; an explicit choice records the child.
  serveDefinition(api, definition(api, { id: "wf-new" }));
  const nodes = [{ type: "trigger.manual", name: "Go" }, { type: "workflow", name: "Sub", config: { workflowId: "wf-child" } }];
  port.answerWith({ outcome: "approved", approvalId: "", grantId: "g_9" });
  await call(api, "create_workflow", { ...draft(), nodes, edges: [] }, { who: chat(api), port });
  assert.equal(titleOf(port.cards.at(-1)!), JOIN);
  assert.deepEqual(port.recorded.map((r) => r.workflowId), ["wf-new"], "joining: only the new workflow (after it ran)");
  port.answerWith({ outcome: "approved", approvalId: "", grantId: "g_9", grantChosen: "chat" });
  await call(api, "create_workflow", { ...draft(), nodes, edges: [] }, { who: chat(api), port });
  assert.deepEqual(port.recorded.slice(1).map((r) => [r.workflowId, r.grantId]), [["wf-child", "g_9"], ["wf-new", "g_9"]], "an explicit grant choice records the child too");
});

test("a sub-workflow that does not exist makes the card ungrantable, even under a grant naming both", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/workflows/wf-ghost", failure(404, "WORKFLOW_NOT_FOUND", "gone"));
  const parent = definition(api, { nodes: [...definition(api).nodes, { id: "z", name: "Nowhere", type: "workflow", position: { x: 0, y: 0 }, config: { workflowId: "wf-ghost" } }] as Workflow["nodes"] });
  serveDefinition(api, parent);
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(parent) } });
  const port = new FakeApprovalPort().grant({ family: "workflows", scope: "chat", threadId: "me", projectPath: api.own, workflowIds: ["wf-1", "wf-ghost"] });
  await call(api, "run_workflow", { workflowId: "wf-1", revision: 7 }, { who: chat(api), port });
  assert.equal(port.cards.length, 1);
  assert.deepEqual(port.cards[0]!.grantOptions, []);
  assert.equal(port.grantQueries.length, 0, "never looked up");
});

test("create_workflow's stale pins name the sub-workflow that changed", async (t) => {
  const api = await sandbox(t);
  serveDefinition(api);
  let child = definition(api, { id: "wf-child", name: "Child", revision: 2 });
  api.on("GET", "/api/workflows/wf-child", () => ({ status: 200, body: { workflow: child, problems: [] } }));
  const port = new FakeApprovalPort(() => {
    child = { ...child, revision: 3 };
    return { outcome: "approved", approvalId: "" };
  });
  const nodes = [{ type: "trigger.manual", name: "Go" }, { type: "workflow", name: "Sub", config: { workflowId: "wf-child" } }];
  await rejects(call(api, "create_workflow", { ...draft(), nodes, edges: [] }, { who: chat(api), port }), "PREVIEW_STALE", /^The sub-workflow wf-child \(revision 2 → 3\) changed after the user approved the card/);
  assert.ok(!api.calls.some((c) => c.method === "POST" && c.path === "/api/workflows"));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("unifiedDiff is exact for a change in the middle; graphDiff ignores canvas moves", async (t) => {
  const api = await sandbox(t);
  assert.equal(unifiedDiff("a\nb\nc", "a\nb\nc"), "");
  assert.equal(unifiedDiff("1\n2\n3\n4\n5\n6\n7\n8", "1\n2\n3\n4\nX\n6\n7\n8"), "@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+X\n 6\n 7\n 8");
  const before = definition(api);
  const moved = definition(api, { nodes: before.nodes.map((n) => ({ ...n, position: { x: 99, y: 99 } })) });
  assert.deepEqual(graphDiff(before, moved, api.workspacesDir).touched.size, 0);
});

test("workflowsReferencingPrompt (for Task 12): every workflow whose agent blocks use the saved prompt, with those blocks", async (t) => {
  const api = await sandbox(t);
  const agent = (id: string, promptId: string) => ({ id, name: `Ask${id}`, type: "agent", position: { x: 0, y: 0 }, config: { prompt: { kind: "saved", promptId }, chain: [{ agent: "claude", model: "opus" }] } });
  const uses = definition(api, { id: "wf-a", name: "Uses", nodes: [agent("1", "p1"), agent("2", "p2"), agent("3", "p1")] as Workflow["nodes"] });
  const other = definition(api, { id: "wf-b", name: "Other", nodes: [agent("4", "p2")] as Workflow["nodes"] });
  const unreadable: unknown[] = [];
  serveWorkflowReferences(api, () => [uses, other], () => unreadable);
  const found = await workflowsReferencingPrompt(api, "p1");
  assert.deepEqual(found!.map((use) => [use.workflowId, use.name, use.nodes.map((n) => n.name)]), [["wf-a", "Uses", ["Ask1", "Ask3"]]]);
  assert.deepEqual(await workflowsReferencingPrompt(api, "p9"), []);
  // One index read, never every definition.
  assert.ok(!api.calls.some((c) => c.path === "/api/workflows" || c.path.startsWith("/api/workflows/")));
  // A record the daemon cannot read that mentions the prompt: unknown (null) — the caller fails closed.
  unreadable.push({ id: "wf-new", nodes: [{ type: "agent.v2", prompt: { ref: "p9" } }] });
  assert.equal(await workflowsReferencingPrompt(api, "p9"), null);
  assert.equal((await workflowsReferencingPrompt(api, "p1"))?.length, 1, "a prompt it does not mention stays known");
  api.on("GET", "/api/workflow-references/prompts/*", { status: 503, body: { error: { code: "WORKFLOWS_UNAVAILABLE", message: "x" } } });
  assert.equal(await workflowsReferencingPrompt(api, "p1"), null, "an unreadable index: unknown");
});
