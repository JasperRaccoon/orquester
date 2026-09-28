import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "@orquester/api";
import { ToolError } from "../errors.ts";
import { ok,toSafeToolError } from "../result.ts";
import { z } from "zod";
import type { ToolContext } from "../tool.ts";
import { JIRA_FIXER_EXAMPLE } from "./workflows-guide.ts";
import { FakeWorkflowDaemon } from "./workflows.testing.ts";
import { workflowTools } from "./workflows.ts";

const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

type Result = Record<string, unknown>;

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeWorkflowDaemon> {
  const root = await mkdtemp(join(tmpdir(), "mcp-wf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  await mkdir(join(root, "acme", "web"), { recursive: true });
  const api = new FakeWorkflowDaemon();
  api.fsRoot = root;
  api.workspacesDir = root;
  return api;
}

const ctx = (api: FakeWorkflowDaemon, signal = new AbortController().signal): ToolContext => ({ api, todos: {} as never, files: {} as never, signal, now: () => Date.parse("2026-09-28T12:00:00.000Z") });

/** A tool call as tools/call makes it: the strict schema (defaults applied), then run, then ok()'s cap. */
async function call(api: FakeWorkflowDaemon, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  const tool = workflowTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name}`);
  const parsed = z.object(tool.input).strict().safeParse(args);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const result = await tool.run(parsed.data as never, ctx(api, signal));
  assert.ok(resultBytes(result) <= 60_000, `${name} stays under the cap (${resultBytes(result)} bytes)`);
  assert.equal(ok(result).structuredContent, result, `${name} is never cut by ok()`);
  return result;
}

async function rejects(p: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await p.then(() => assert.fail(`expected ${code}`), (e) => { caught = e; });
  assert.ok(caught instanceof ToolError, `a ToolError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (match) assert.match(caught.message, match);
  return caught;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function createJira(api: FakeWorkflowDaemon): Promise<Result> {
  return call(api, "create_workflow", JIRA_FIXER_EXAMPLE as unknown as Record<string, unknown>);
}

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
});

test("list_workflow_block_types: schemas too big for one result are omitted largest first and named", async (t) => {
  const api = await sandbox(t);
  const base = (await api.request("GET", "/api/workflows/block-types")).body as { types: { type: string; configSchema: unknown }[]; expressionGuide: string };
  const big = { ...base, types: base.types.map((x, i) => ({ ...x, configSchema: { blob: "s".repeat(i < 3 ? 20_000 : 500) } })) };
  api.on("GET", "/api/workflows/block-types", { status: 200, body: big });
  const r = await call(api, "list_workflow_block_types", {});
  const omitted = r.configSchemasOmitted as string[];
  assert.ok(omitted.length >= 1 && omitted.length <= 3, `omitted ${omitted.join(",")}`);
  assert.ok(omitted.every((type) => base.types.slice(0, 3).some((x) => x.type === type)), "only the big ones");
});

test("create_workflow: names in edges, project resolved, auto-layout, host time zone, disabled by default, problems returned", async (t) => {
  const api = await sandbox(t);
  const r = await createJira(api);
  const post = api.calls.find((c) => c.method === "POST" && c.path === "/api/workflows")!;
  const body = post.body as { project: unknown; autoLayout: boolean; settings: { timezone: string }; edges: { source: string }[]; enabled: boolean };
  assert.deepEqual(body.project, { kind: "existing", projectPath: join(api.workspacesDir, "acme", "api") });
  assert.equal(body.autoLayout, true);
  assert.ok(body.settings.timezone.length > 0);
  assert.equal(body.enabled, false);
  assert.equal(body.edges[0]!.source, "Every15Min", "names go to the daemon as names");
  assert.equal(r.created, true);
  assert.equal(r.revision, 0);
  assert.equal(r.project, "acme/api");
  assert.equal(r.errorCount, 0, JSON.stringify(r.problems));
});

test("create_workflow: a temp project passes through; unknown projects and bad arguments are refused", async (t) => {
  const api = await sandbox(t);
  await call(api, "create_workflow", { name: "Scratch", project: { kind: "temp", workspace: "acme", source: { kind: "clone", url: "git@github.com:a/b.git" } }, nodes: [{ type: "trigger.manual" }] });
  assert.deepEqual((api.calls.at(-1)!.body as { project: unknown }).project, { kind: "temp", workspace: "acme", source: { kind: "clone", url: "git@github.com:a/b.git" } });
  await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/nope" }, nodes: [] }), "PROJECT_NOT_FOUND");
  await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [], bogus: 1 }), "INVALID_ARGUMENT", /bogus/);
  await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "code", nme: "Typo" }] }), "INVALID_ARGUMENT", /nme/);
  await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "code", name: "1bad" }] }), "INVALID_ARGUMENT", /block name/);
  await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "teleport" }] }), "INVALID_ARGUMENT");
});

test("create_workflow: a refused edge is named by its index; enabling with errors carries the problems in the text and detail", async (t) => {
  const api = await sandbox(t);
  const edge = await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Work" }], edges: [{ source: "Go", target: "Work" }, { source: "Go", target: "Nobody" }] }), "INVALID_WORKFLOW", /^edges\[1\]: (?!Item).*Nobody/);
  assert.equal((edge.detail as { opIndex: number }).opIndex, 3);
  const invalid = await rejects(call(api, "create_workflow", { name: "X", enabled: true, project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Go" }, { type: "shell", name: "Sh", config: { script: "echo {{ trigger.input }}" } }], edges: [{ source: "Go", target: "Sh" }] }), "INVALID_WORKFLOW", /Problems: error shell_template/);
  const detail = invalid.detail as { problems: { code: string }[]; errorCount: number };
  assert.ok(detail.errorCount >= 1);
  assert.ok(detail.problems.some((p) => p.code === "shell_template"));
  assert.match(toSafeToolError(invalid).content[0].text, /^INVALID_WORKFLOW: /);
});

test("get_workflow: definition, revision, problems and connections; one block by name; unknown ids get the hint", async (t) => {
  const api = await sandbox(t);
  const created = await createJira(api);
  const id = created.workflowId as string;
  const r = await call(api, "get_workflow", { workflowId: id });
  assert.equal(r.revision, 0);
  assert.equal((r.workflow as Workflow).id, id);
  assert.ok(Array.isArray(r.problems));
  assert.equal((r.connections as string[]).length, 5);
  const one = await call(api, "get_workflow", { workflowId: id, node: "HasTickets" });
  assert.equal((one.node as { name: string }).name, "HasTickets");
  assert.deepEqual((one.connections as { text: string }[]).map((c) => c.text), ["FetchTickets → HasTickets", "HasTickets (true) → FixTickets", "HasTickets (false) → NothingToDo"]);
  await rejects(call(api, "get_workflow", { workflowId: id, node: "Ghost" }), "NODE_NOT_FOUND", /HasTickets/);
  await rejects(call(api, "get_workflow", { workflowId: "nope" }), "WORKFLOW_NOT_FOUND", /list_workflows/);
});

test("get_workflow: a definition too big for one result cuts its long texts and names them", async (t) => {
  const api = await sandbox(t);
  const source = `export default async function () {\n${"  // padding\n".repeat(20_000)}  return 1;\n}\n`;
  const created = await call(api, "create_workflow", { name: "Huge", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Big", config: { source } }, { type: "code", name: "Small", config: { source: "export default async function () { return 2; }" } }], edges: [{ source: "Go", target: "Big" }] });
  assert.ok(Array.isArray(created.truncatedFields), "the create answer is fitted too");
  const r = await call(api, "get_workflow", { workflowId: created.workflowId as string });
  assert.deepEqual(r.truncatedFields, ["workflow.nodes[1].config.source"]);
  const nodes = (r.workflow as Workflow).nodes;
  assert.match((nodes[1]!.config as { source: string }).source, /… \[truncated\]$/);
  assert.equal((nodes[2]!.config as { source: string }).source, "export default async function () { return 2; }", "short texts stay whole");
});

test("update_workflow: a stale revision says to re-read; a failing op is named by index; nothing is saved", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 7, ops: [{ op: "set_enabled", enabled: false }] }), "REVISION_CONFLICT", /get_workflow/);
  const e = await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "add_node", node: { type: "code", name: "Extra" } }, { op: "connect", source: "Extra", target: "Ghost" }] }), "INVALID_WORKFLOW", /^ops\[1\] \(connect\) failed: (?!Operation).*Ghost.*Nothing was saved\.$/);
  assert.deepEqual({ opIndex: (e.detail as { opIndex: number }).opIndex, op: (e.detail as { op: string }).op }, { opIndex: 1, op: "connect" });
  // A daemon that names the op itself is believed without a replay.
  api.on("POST", `/api/workflows/${id}/patch`, { status: 400, body: { error: { code: "INVALID_REQUEST", message: "bad op", opIndex: 0 } } });
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "remove_node", node: "FetchTickets" }] }), "INVALID_REQUEST", /^ops\[0\] \(remove_node\) failed: bad op/);
});

test("update_workflow: strict op shapes; set_project resolves a project; disconnect needs a connection", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "rename_node", from: "FixTickets", to: "X" }] }), "INVALID_ARGUMENT");
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "explode" }] }), "INVALID_ARGUMENT");
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [] }), "INVALID_ARGUMENT");
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "disconnect", source: "FixTickets" }] }), "INVALID_ARGUMENT", /edgeId/);
  const r = await call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "set_project", project: { kind: "existing", project: "acme/web" } }, { op: "disconnect", source: "FixTickets", target: "MarkDone" }] });
  assert.equal(r.project, "acme/web");
});

test("validate_workflow fills draft identity and returns daemon validation problems with errors first", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [
    { severity: "warning", code: "unreachable", message: "Unreachable block" },
    { severity: "error", code: "cycle", message: "Cycle detected" }
  ] } });
  const r = await call(api, "validate_workflow", { workflow: { name: "Draft", nodes: [], edges: [] } });
  const sent = (api.calls.at(-1)!.body as { workflow: Workflow }).workflow;
  assert.equal(sent.id, "draft");
  assert.equal(sent.revision, 0);
  assert.equal(sent.enabled, false);
  assert.equal(r.valid, false);
  assert.equal(r.errorCount, 1);
  assert.equal(r.warningCount, 1);
  assert.deepEqual((r.problems as { code: string }[]).map((p) => p.code), ["cycle", "unreachable"]);
});

test("list_workflows: summaries, filtered by a resolved project", async (t) => {
  const api = await sandbox(t);
  await createJira(api);
  await call(api, "create_workflow", { name: "Other", project: { kind: "existing", project: join(api.workspacesDir, "acme", "web") }, nodes: [{ type: "trigger.manual" }] });
  const all = await call(api, "list_workflows", {});
  assert.equal((all.workflows as unknown[]).length, 2);
  const only = await call(api, "list_workflows", { project: "acme/api" });
  const rows = only.workflows as { name: string; project: string; triggers: string[]; enabled: boolean; activeRuns: number; errorCount: number }[];
  assert.deepEqual(rows.map((w) => w.name), ["Jira fixer"]);
  assert.equal(rows[0]!.project, "acme/api");
  assert.equal(rows[0]!.triggers.length, 1);
  assert.equal(rows[0]!.activeRuns, 0);
  assert.deepEqual(api.calls.at(-1)!.query, { projectPath: join(api.workspacesDir, "acme", "api") });
  await rejects(call(api, "list_workflows", { project: "acme" }), "PROJECT_NOT_FOUND");
});

test("run_workflow: without wait answers the runId; the overlap policy's skip is explained; force passes through", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  const r = await call(api, "run_workflow", { workflowId: id, input: { ticket: "PROJ-1" } });
  assert.equal(r.runId, "run-1");
  assert.deepEqual((api.calls.at(-1)!.body as { input: unknown }).input, { ticket: "PROJ-1" });
  const skipped = await call(api, "run_workflow", { workflowId: id });
  assert.equal(skipped.runId, null);
  assert.equal(skipped.skipped, "overlap");
  const forced = await call(api, "run_workflow", { workflowId: id, force: true });
  assert.equal(forced.runId, "run-2");
  assert.deepEqual(api.calls.at(-1)!.body, { force: true });
  await rejects(call(api, "run_workflow", { workflowId: id, timeoutSeconds: 601 }), "INVALID_ARGUMENT");
});

test("run_workflow {wait}: the bus ends the wait; every block's status and output come back", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  api.onRunStarted = (run) => {
    // Ends after the POST answered, on the bus only.
    setImmediate(() => api.finishRun(run.id, "succeeded", {
      Every15Min: { output: { kind: "schedule" }, handle: "success" },
      FetchTickets: { output: { tickets: [{ key: "PROJ-1" }] }, handle: "success" },
      HasTickets: { output: { tickets: [{ key: "PROJ-1" }] }, handle: "true" },
      NothingToDo: { status: "skipped" },
      FixTickets: { output: { text: "{\"fixed\":[\"PROJ-1\"]}", sessionId: "s-1" }, sessionId: "s-1", hops: [{ agent: "claude", model: "opus", accountId: "a1", sessionId: "s-1", startedAt: "2026-09-28T10:00:00.000Z", via: "initial" }] },
      MarkDone: { output: { moved: ["PROJ-1"] } }
    }, { moved: ["PROJ-1"] }));
  };
  const r = await call(api, "run_workflow", { workflowId: id, wait: true, timeoutSeconds: 30 });
  assert.equal(r.finished, true);
  assert.equal((r.run as { status: string }).status, "succeeded");
  const blocks = r.blocks as { name: string; status: string; handle?: string; output?: unknown; sessionId?: string; hops?: unknown[] }[];
  assert.deepEqual(blocks.map((b) => b.name), ["Every15Min", "FetchTickets", "HasTickets", "NothingToDo", "FixTickets", "MarkDone"], "in the definition's order");
  assert.equal(blocks[2]!.handle, "true");
  assert.equal(blocks[3]!.status, "skipped");
  assert.equal(blocks[4]!.sessionId, "s-1");
  assert.equal(blocks[4]!.hops!.length, 1);
  assert.deepEqual(blocks[5]!.output, { moved: ["PROJ-1"] });
  assert.deepEqual((r.run as { finalOutput: unknown }).finalOutput, { moved: ["PROJ-1"] });
  assert.equal(api.listenerCount(), 0, "the tap is closed");
});

test("run_workflow {wait}: a timeout answers where the run is", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  const r = await call(api, "run_workflow", { workflowId: id, wait: true, timeoutSeconds: 1 });
  assert.equal(r.finished, false);
  assert.equal(r.timedOut, true);
  assert.equal((r.run as { status: string }).status, "running");
  assert.equal(api.listenerCount(), 0);
});

test("run_workflow wait rereads a silently finished run and releases its subscription on abort", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const pending = call(api, "run_workflow", { workflowId: id, wait: true, timeoutSeconds: 30 });
  await tick();
  api.runs.get("run-1")!.status = "failed";
  clock = 10_000;
  t.mock.timers.tick(10_000);
  const finished = await pending;
  assert.equal(finished.finished, true);
  assert.equal((finished.run as { status: string }).status, "failed");
  const ac = new AbortController();
  const aborted = call(api, "run_workflow", { workflowId: id, force: true, wait: true, timeoutSeconds: 30 }, ac.signal);
  await tick();
  ac.abort();
  assert.equal((await aborted).finished, false);
  assert.equal(api.listenerCount(), 0);
});

test("get_workflow_run: outputs fitted to the cap with outputTruncated; includeOutputs:false; one block's output paged", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await call(api, "run_workflow", { workflowId: id });
  const huge = { text: '😀語é"\n'.repeat(15_000) };
  api.finishRun("run-1", "succeeded", {
    FetchTickets: { output: { tickets: [{ key: "PROJ-1" }] } },
    FixTickets: { output: huge },
    MarkDone: { output: { moved: ["PROJ-1"] }, outputTruncated: true }
  });
  const r = await call(api, "get_workflow_run", { runId: "run-1" });
  const blocks = r.blocks as { name: string; output?: unknown; outputText?: string; outputTruncated?: boolean }[];
  const fix = blocks.find((b) => b.name === "FixTickets")!;
  assert.equal(fix.output, undefined);
  assert.equal(fix.outputTruncated, true);
  assert.ok(fix.outputText!.startsWith(JSON.stringify(huge).slice(0, 20)));
  assert.deepEqual(blocks.find((b) => b.name === "FetchTickets")!.output, { tickets: [{ key: "PROJ-1" }] }, "small outputs whole");
  assert.equal(blocks.find((b) => b.name === "MarkDone")!.outputTruncated, true, "the daemon's own preview flag is kept");
  const bare = await call(api, "get_workflow_run", { runId: "run-1", includeOutputs: false });
  assert.ok((bare.blocks as { output?: unknown }[]).every((b) => b.output === undefined));
  assert.equal(bare.outputNote, undefined);
  // Page the whole output by name.
  let offset = 0;
  let text = "";
  for (let page = 0; page < 10; page += 1) {
    const w = await call(api, "get_workflow_run", { runId: "run-1", nodeId: "FixTickets", outputOffset: offset });
    text += w.outputText as string;
    if (w.nextOffset === undefined) break;
    offset = w.nextOffset as number;
  }
  assert.equal(text, JSON.stringify(huge));
  const small = await call(api, "get_workflow_run", { runId: "run-1", nodeId: "FetchTickets" });
  assert.deepEqual(small.output, { tickets: [{ key: "PROJ-1" }] });
  await rejects(call(api, "get_workflow_run", { runId: "run-1", nodeId: "Ghost" }), "NODE_NOT_FOUND", /FixTickets/);
  await rejects(call(api, "get_workflow_run", { runId: "run-9" }), "RUN_NOT_FOUND", /list_workflow_runs/);
});

test("delete_workflow needs confirm: true", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await rejects(call(api, "delete_workflow", { workflowId: id }), "INVALID_ARGUMENT");
  await rejects(call(api, "delete_workflow", { workflowId: id, confirm: false }), "INVALID_ARGUMENT");
  assert.deepEqual(await call(api, "delete_workflow", { workflowId: id, confirm: true }), { deleted: true, workflowId: id });
});

test("secrets: names only; set is write-only, scoped by workflowId, warns on a short value; bad names refused", async (t) => {
  const api = await sandbox(t);
  const set = await call(api, "set_workflow_secret", { name: "JIRA_TOKEN", value: "tok-123456" });
  assert.deepEqual(set, { set: true, name: "JIRA_TOKEN", scope: "global" });
  assert.ok(!JSON.stringify(set).includes("tok-123456"), "the value never comes back");
  const own = await call(api, "set_workflow_secret", { name: "PIN", value: "12", workflowId: "wf-9" });
  assert.match(own.warning as string, /not redacted/);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-9" });
  api.on("GET", "/api/workflow-secrets", { status: 200, body: { secrets: [{ name: "JIRA_TOKEN", scope: "global", updatedAt: "2026-09-28T12:00:00Z", value: "must-stay-private" }] } });
  const global = await call(api, "list_workflow_secrets", {});
  assert.ok(!JSON.stringify(global).includes("must-stay-private"));
  assert.deepEqual((global.secrets as { name: string }[]).map((s) => s.name), ["JIRA_TOKEN"]);
  const scoped = await call(api, "list_workflow_secrets", { workflowId: "wf-9" });
  assert.deepEqual((scoped.secrets as { name: string; scope: string }[]).map((s) => `${s.name}:${s.scope}`), ["JIRA_TOKEN:global"]);
  assert.ok(!JSON.stringify(scoped).includes("12\""), "no values listed");
  await rejects(call(api, "set_workflow_secret", { name: "lower", value: "x" }), "INVALID_ARGUMENT", /secret name/);
  await rejects(call(api, "set_workflow_secret", { name: "BIG", value: "x".repeat(64 * 1024 + 1) }), "INVALID_ARGUMENT", /64 KiB/);
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

test("get_workflow / create_workflow: 200 blocks too big even cut are outlined, never byte-cut by ok()", async (t) => {
  const api = await sandbox(t);
  const nodes = Array.from({ length: 200 }, (_, i) => ({
    type: "code",
    name: `Block${i}`,
    config: { source: `export default async function () {\n  // ${"padding ".repeat(60)}\n  return ${i};\n}\n` }
  }));
  const created = await call(api, "create_workflow", { name: "Wide", project: { kind: "existing", project: "acme/api" }, nodes });
  assert.equal(created.blocksOutlined, true);
  const r = await call(api, "get_workflow", { workflowId: created.workflowId as string });
  assert.equal(r.blocksOutlined, true);
  const listed = (r.workflow as { nodes: Record<string, unknown>[] }).nodes;
  assert.equal(listed.length, 200);
  assert.equal(listed[0]!.name, "Block0");
  assert.equal(listed[0]!.type, "code");
  assert.equal(listed[0]!.config, undefined);
  const one = await call(api, "get_workflow", { workflowId: created.workflowId as string, node: "Block7" });
  assert.match(((one.node as { config: { source: string } }).config.source), /return 7;/);
});
