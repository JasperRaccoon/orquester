import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow } from "@orquester/api";
import { ToolError } from "../errors.ts";
import { MAX_RESULT_BYTES, ok, resultBytes, toSafeToolError } from "../result.ts";
import { argumentsSchema } from "../server.ts";
import { busEvent } from "../testing.ts";
import type { ToolContext } from "../tool.ts";
import { JIRA_FIXER_EDIT_OPS, JIRA_FIXER_EXAMPLE } from "./workflows-guide.ts";
import { FakeWorkflowDaemon } from "./workflows.testing.ts";
import { outputWindow, RunEndTap, waitForRunEnd, workflowError, workflowTools } from "./workflows.ts";

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
  const parsed = argumentsSchema(tool).safeParse(args);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const result = await tool.run(parsed.data as never, ctx(api, signal));
  assert.ok(resultBytes(result) <= MAX_RESULT_BYTES, `${name} stays under the cap (${resultBytes(result)} bytes)`);
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

test("tool descriptions teach the authoring rules and stay short", () => {
  const byName = Object.fromEntries(workflowTools.map((t) => [t.name, t]));
  assert.equal(workflowTools.length, 13);
  for (const t of workflowTools) assert.ok(t.description.length <= 400, `${t.name}: ${t.description.length}`);
  assert.match(byName.create_workflow!.description, /list_workflow_block_types/);
  assert.match(byName.update_workflow!.description, /REVISION_CONFLICT/);
  assert.match(byName.set_workflow_secret!.description, /transcript/);
  assert.match(byName.delete_workflow!.description, /confirm: true/);
});

test("list_workflow_block_types: every type with handles, schema, example, the expression guide and the authoring guide", async (t) => {
  const api = await sandbox(t);
  const r = await call(api, "list_workflow_block_types", {});
  const types = r.types as { type: string; handles: string[]; configSchema?: unknown; example: unknown }[];
  assert.equal(types.length, 14);
  assert.deepEqual(types.find((x) => x.type === "if")!.handles, ["true", "false", "error"]);
  assert.ok(types.every((x) => x.configSchema !== undefined && x.example !== undefined));
  assert.match(r.expressionGuide as string, /nodes\.<Name>\.output/);
  const guide = r.authoringGuide as string;
  for (const needle of ["{{ nodes.<Name>.output", "success", "error", "true", "case:0", "env", "full-access", "update_workflow", "get_workflow", "Jira fixer", "rename_node", "NOT a\n   name inside a code block"]) assert.ok(guide.includes(needle), needle);
  assert.equal(r.configSchemasOmitted, undefined);
  const one = await call(api, "list_workflow_block_types", { type: "agent" });
  assert.equal((one.types as unknown[]).length, 1);
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
  assert.match(r.schemaNote as string, /\{type\}/);
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
  assert.match(r.next as string, /set_enabled/);
  const wf = r.workflow as Workflow;
  assert.equal(wf.nodes.length, 6);
  assert.ok(wf.nodes.every((n) => typeof n.position.x === "number"));
  assert.deepEqual(r.connections, ["Every15Min → FetchTickets", "FetchTickets → HasTickets", "HasTickets (true) → FixTickets", "HasTickets (false) → NothingToDo", "FixTickets → MarkDone"]);
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
  const edge = await rejects(call(api, "create_workflow", { name: "X", project: { kind: "existing", project: "acme/api" }, nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Work" }], edges: [{ source: "Go", target: "Work" }, { source: "Go", target: "Nobody" }] }), "INVALID_REQUEST", /^edges\[1\]: .*Nobody/);
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
  assert.match(r.truncationNote as string, /Never send a cut text back/);
  const nodes = (r.workflow as Workflow).nodes;
  assert.match((nodes[1]!.config as { source: string }).source, /… \[truncated\]$/);
  assert.equal((nodes[2]!.config as { source: string }).source, "export default async function () { return 2; }", "short texts stay whole");
  assert.ok(resultBytes(r) > 40_000, "the room is used, not wasted");
});

test("update_workflow: add_node + connect + rename in one batch; revision moves; names resolve", async (t) => {
  const api = await sandbox(t);
  const created = await createJira(api);
  const id = created.workflowId as string;
  const r = await call(api, "update_workflow", { workflowId: id, revision: 0, ops: JIRA_FIXER_EDIT_OPS });
  assert.equal(r.updated, true);
  assert.equal(r.revision, 1);
  const wf = r.workflow as Workflow;
  assert.ok(wf.nodes.some((n) => n.name === "NotifySlack"));
  assert.ok(wf.nodes.some((n) => n.name === "NoTickets"));
  assert.ok((r.connections as string[]).includes("MarkDone → NotifySlack"));
  assert.ok((r.connections as string[]).includes("FixTickets (error) → Failed"));
  assert.ok((r.connections as string[]).includes("HasTickets (false) → NoTickets"));
  const schedule = wf.nodes.find((n) => n.name === "Every15Min")!;
  assert.equal((schedule.config as { cron: string }).cron, "0 * * * *", "update_node replaced the config keys it names");
  assert.equal(r.errorCount, 0, JSON.stringify(r.problems));
});

test("update_workflow: a stale revision says to re-read; a failing op is named by index; nothing is saved", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 7, ops: [{ op: "set_enabled", enabled: false }] }), "REVISION_CONFLICT", /get_workflow/);
  const e = await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "add_node", node: { type: "code", name: "Extra" } }, { op: "connect", source: "Extra", target: "Ghost" }] }), "INVALID_REQUEST", /^ops\[1\] \(connect\) failed: .*Ghost.*Nothing was saved\.$/);
  assert.deepEqual({ opIndex: (e.detail as { opIndex: number }).opIndex, op: (e.detail as { op: string }).op }, { opIndex: 1, op: "connect" });
  assert.equal(api.workflows.get(id)!.revision, 0);
  assert.ok(!api.workflows.get(id)!.nodes.some((n) => n.name === "Extra"));
  // A daemon that names the op itself is believed without a replay.
  api.on("POST", `/api/workflows/${id}/patch`, { status: 400, body: { error: { code: "INVALID_REQUEST", message: "bad op", opIndex: 0 } } });
  const before = api.calls.length;
  await rejects(call(api, "update_workflow", { workflowId: id, revision: 0, ops: [{ op: "remove_node", node: "FetchTickets" }] }), "INVALID_REQUEST", /^ops\[0\] \(remove_node\) failed: bad op/);
  assert.equal(api.calls.length - before, 1, "no replay read");
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
  assert.ok(!(r.connections as string[]).includes("FixTickets → MarkDone"));
});

test("validate_workflow: problems for a draft, placeholders filled in", async (t) => {
  const api = await sandbox(t);
  const created = (await createJira(api)).workflow as Workflow;
  const { id: _id, createdAt: _c, updatedAt: _u, revision: _r, ...draft } = created;
  const good = await call(api, "validate_workflow", { workflow: draft as unknown as Record<string, unknown> });
  assert.equal(good.valid, true, JSON.stringify(good.problems));
  const sent = (api.calls.at(-1)!.body as { workflow: Workflow }).workflow;
  assert.equal(sent.id, "draft");
  const cyclic = { ...draft, edges: [...draft.edges, { id: "back", source: created.nodes[4]!.id, sourceHandle: "success", target: created.nodes[1]!.id }] };
  const bad = await call(api, "validate_workflow", { workflow: cyclic as unknown as Record<string, unknown> });
  assert.equal(bad.valid, false);
  assert.ok((bad.errorCount as number) >= 1);
  assert.equal((bad.problems as { severity: string }[])[0]!.severity, "error", "errors first");
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
  assert.deepEqual(api.runs.get("run-1")!.triggerPayload, { kind: "manual", input: { ticket: "PROJ-1" } });
  const skipped = await call(api, "run_workflow", { workflowId: id });
  assert.equal(skipped.runId, null);
  assert.equal(skipped.skipped, "overlap");
  assert.match(skipped.message as string, /force:true/);
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
  assert.match(r.next as string, /get_workflow_run/);
  assert.equal(api.listenerCount(), 0);
});

test("waitForRunEnd: the re-read safety net ends a wait the bus never told; abort ends it; an end heard mid-read is not lost", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await call(api, "run_workflow", { workflowId: id });
  // Ended without a bus event: only the re-read finds it.
  api.runs.get("run-1")!.status = "failed";
  const tap = new RunEndTap(api);
  const quiet = await waitForRunEnd(api, tap, "run-1", { timeoutMs: 5_000, signal: new AbortController().signal, rereadMs: 20 });
  tap.close();
  assert.equal(quiet.ended, true);
  assert.equal(quiet.run!.status, "failed");
  // Abort.
  await call(api, "run_workflow", { workflowId: id, force: true });
  const ac = new AbortController();
  const tap2 = new RunEndTap(api);
  const pending = waitForRunEnd(api, tap2, "run-2", { timeoutMs: 60_000, signal: ac.signal, rereadMs: 60_000 });
  await tick();
  ac.abort();
  assert.equal((await pending).ended, false);
  tap2.close();
  // A heard end whose read still says active waits for the schedule, without spinning; the next event ends it.
  await call(api, "run_workflow", { workflowId: id, force: true });
  const tap3 = new RunEndTap(api);
  let reads = 0;
  api.on("GET", "/api/workflow-runs/run-3", () => { reads += 1; return { status: 200, body: { run: api.runs.get("run-3") } }; });
  const p3 = waitForRunEnd(api, tap3, "run-3", { timeoutMs: 5_000, signal: new AbortController().signal, rereadMs: 60_000 });
  api.emit(busEvent("workflowRun.finished", { run: { id: "run-3", status: "succeeded" } }, "workflows"));
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(reads, 1, "one read for the heard end, no spin");
  api.finishRun("run-3", "succeeded");
  const done = await p3;
  tap3.close();
  assert.equal(done.ended, true);
  assert.equal(reads, 2);
});

test("get_workflow_run: outputs fitted to the cap with outputTruncated; includeOutputs:false; one block's output paged", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await call(api, "run_workflow", { workflowId: id });
  const huge = { text: "x".repeat(200_000) };
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
  assert.ok(fix.outputText!.startsWith("{\"text\":\"xxx"));
  assert.ok(fix.outputText!.length > 30_000, "the big output gets the room the small ones leave");
  assert.deepEqual(blocks.find((b) => b.name === "FetchTickets")!.output, { tickets: [{ key: "PROJ-1" }] }, "small outputs whole");
  assert.equal(blocks.find((b) => b.name === "MarkDone")!.outputTruncated, true, "the daemon's own preview flag is kept");
  assert.match(r.outputNote as string, /nodeId/);
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

test("outputWindow never splits a character and keeps the escaped window within its bytes", () => {
  const text = "é".repeat(10) + "\"".repeat(10);
  const w = outputWindow(text, 1, 7);
  assert.equal(w.offset, 2, "an offset inside a character moves to the next one");
  assert.equal(w.text, "ééé");
  const q = outputWindow(text, 20, 8);
  assert.equal(q.text, "\"\"\"\"", "each quote costs two bytes escaped");
  assert.equal(q.nextOffset, 24);
});

test("list_workflow_runs pages newest first; cancel_workflow_run cancels and then says RUN_NOT_ACTIVE", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  for (let i = 0; i < 3; i += 1) await call(api, "run_workflow", { workflowId: id, force: true });
  const first = await call(api, "list_workflow_runs", { workflowId: id, limit: 2 });
  assert.deepEqual((first.runs as { runId: string }[]).map((r) => r.runId), ["run-3", "run-2"]);
  assert.equal(first.before, "run-2");
  const second = await call(api, "list_workflow_runs", { workflowId: id, limit: 2, before: first.before as string });
  assert.deepEqual((second.runs as { runId: string }[]).map((r) => r.runId), ["run-1"]);
  assert.equal(second.before, null);
  const c = await call(api, "cancel_workflow_run", { runId: "run-1" });
  assert.equal(c.cancelRequested, true);
  assert.equal((c.run as { status: string }).status, "cancelled");
  await rejects(call(api, "cancel_workflow_run", { runId: "run-1" }), "RUN_NOT_ACTIVE", /already ended/);
  await rejects(call(api, "list_workflow_runs", { workflowId: id, limit: 51 }), "INVALID_ARGUMENT");
});

test("delete_workflow needs confirm: true", async (t) => {
  const api = await sandbox(t);
  const id = (await createJira(api)).workflowId as string;
  await rejects(call(api, "delete_workflow", { workflowId: id }), "INVALID_ARGUMENT");
  await rejects(call(api, "delete_workflow", { workflowId: id, confirm: false }), "INVALID_ARGUMENT");
  assert.deepEqual(await call(api, "delete_workflow", { workflowId: id, confirm: true }), { deleted: true, workflowId: id });
  assert.equal(api.workflows.size, 0);
  await rejects(call(api, "delete_workflow", { workflowId: id, confirm: true }), "WORKFLOW_NOT_FOUND");
});

test("secrets: names only; set is write-only, scoped by workflowId, warns on a short value; bad names refused", async (t) => {
  const api = await sandbox(t);
  const set = await call(api, "set_workflow_secret", { name: "JIRA_TOKEN", value: "tok-123456" });
  assert.deepEqual(set, { set: true, name: "JIRA_TOKEN", scope: "global" });
  assert.ok(!JSON.stringify(set).includes("tok-123456"), "the value never comes back");
  const own = await call(api, "set_workflow_secret", { name: "PIN", value: "12", workflowId: "wf-9" });
  assert.match(own.warning as string, /not redacted/);
  assert.deepEqual(api.calls.at(-1)!.query, { workflowId: "wf-9" });
  const global = await call(api, "list_workflow_secrets", {});
  assert.deepEqual((global.secrets as { name: string }[]).map((s) => s.name), ["JIRA_TOKEN"]);
  const scoped = await call(api, "list_workflow_secrets", { workflowId: "wf-9" });
  assert.deepEqual((scoped.secrets as { name: string; scope: string }[]).map((s) => `${s.name}:${s.scope}`), ["JIRA_TOKEN:global", "PIN:workflow"]);
  assert.ok(!JSON.stringify(scoped).includes("12\""), "no values listed");
  await rejects(call(api, "set_workflow_secret", { name: "lower", value: "x" }), "INVALID_ARGUMENT", /secret name/);
  await rejects(call(api, "set_workflow_secret", { name: "BIG", value: "x".repeat(64 * 1024 + 1) }), "INVALID_ARGUMENT", /64 KiB/);
});

test("workflowError: the workflow envelope's code passes through with its hint; other bodies fall back to the MCP mapping", () => {
  const e = workflowError({ status: 409, body: { error: { code: "REVISION_CONFLICT", message: "stale" } } });
  assert.equal(e.code, "REVISION_CONFLICT");
  assert.match(e.message, /^stale\. The workflow changed .*get_workflow/);
  const many = workflowError({ status: 400, body: { error: { code: "INVALID_WORKFLOW", message: "bad", problems: Array.from({ length: 150 }, (_, i) => ({ severity: i === 149 ? "error" : "warning", code: `c${i}`, message: `m${i}` })) } } });
  assert.match(many.message, /Problems: error c149: m149; warning c0/, "errors first");
  assert.match(many.message, /142 more in detail\.problems/);
  const detail = many.detail as { problems: unknown[]; problemsOmitted: number; errorCount: number };
  assert.equal(detail.problems.length, 100);
  assert.equal(detail.problemsOmitted, 50);
  assert.equal(detail.errorCount, 1);
  assert.equal(workflowError({ status: 503, body: { message: "/secret/path failed" } }).code, "HOST_UNAVAILABLE");
  assert.equal(workflowError({ status: 500, body: "<html>" }).code, "INTERNAL");
});

test("round trip: create → update (add_node + connect + rename) → validate → run → get_run", async (t) => {
  const api = await sandbox(t);
  const created = await call(api, "create_workflow", {
    name: "Round trip",
    project: { kind: "existing", project: "acme/api" },
    nodes: [{ type: "trigger.manual", name: "Start" }, { type: "shell", name: "List", config: { script: "ls \"$DIR\"", env: [{ name: "DIR", value: "{{ trigger.input.dir | default(\".\") }}" }] } }],
    edges: [{ source: "Start", target: "List" }]
  });
  const id = created.workflowId as string;
  const read = await call(api, "get_workflow", { workflowId: id });
  const updated = await call(api, "update_workflow", {
    workflowId: id,
    revision: read.revision as number,
    ops: [
      { op: "add_node", node: { type: "if", name: "HasFiles", config: { rules: [{ left: "{{ nodes.List.output.stdout }}", op: "isNotEmpty" }] } } },
      { op: "connect", source: "List", target: "HasFiles" },
      { op: "rename_node", node: "List", to: "ListFiles" }
    ]
  });
  assert.equal(updated.revision, 1);
  const wf = updated.workflow as Workflow;
  const ifNode = wf.nodes.find((n) => n.name === "HasFiles")!;
  assert.equal((ifNode.config as { rules: { left: string }[] }).rules[0]!.left, "{{ nodes.ListFiles.output.stdout }}", "the rename rewrote the new block's reference");
  const { id: _i, createdAt: _c, updatedAt: _u, revision: _r, ...draft } = wf;
  const valid = await call(api, "validate_workflow", { workflow: draft as unknown as Record<string, unknown> });
  assert.equal(valid.valid, true, JSON.stringify(valid.problems));
  api.onRunStarted = (run) => setImmediate(() => api.finishRun(run.id, "succeeded", { Start: { output: { kind: "manual", input: { dir: "src" } } }, ListFiles: { output: { stdout: "a.ts\n", stderr: "", exitCode: 0 } }, HasFiles: { handle: "true", output: { stdout: "a.ts\n" } } }));
  const ran = await call(api, "run_workflow", { workflowId: id, input: { dir: "src" }, wait: true, timeoutSeconds: 10 });
  assert.equal(ran.finished, true);
  const run = await call(api, "get_workflow_run", { runId: ran.runId as string });
  assert.deepEqual((run.blocks as { name: string; status: string }[]).map((b) => `${b.name}:${b.status}`), ["Start:succeeded", "ListFiles:succeeded", "HasFiles:succeeded"]);
  assert.equal((run.run as { status: string }).status, "succeeded");
});
