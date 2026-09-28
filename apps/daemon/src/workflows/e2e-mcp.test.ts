// End to end: the MCP workflow tools against the REAL workflow routes and the REAL runtime (the
// daemon's own `InjectDaemonApi` over a Fastify app carrying `registerWorkflowRoutes`, the stores on
// a temp appdir, the engine as `startDaemon` wires it). The tools' unit tests run against an
// in-memory fake daemon; this is where the two are held to agree.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { registerMcp } from "../mcp/server.ts";
import { ToolError } from "../mcp/errors.ts";
import { JIRA_FIXER_EDIT_OPS, JIRA_FIXER_EXAMPLE } from "../mcp/tools/workflows-guide.ts";
import { boot, tempAppdir, type Booted } from "./testing/daemon-harness.ts";

type Result = Record<string, unknown>;

let dir: Awaited<ReturnType<typeof tempAppdir>>;
let h: Booted;
let mcp: FastifyInstance;

before(async () => {
  dir = await tempAppdir(["acme/api", "acme/web"]);
  h = await boot(dir.root);
  mcp = Fastify();
  registerMcp(mcp, { createApi: () => h.api, todos: {} as never, files: {} as never });
  // Match IncomingMessage after Fastify has consumed its body (light-my-request omits it).
  mcp.addHook("preHandler", async (request) => { (request.raw as unknown as { destroyed: boolean }).destroyed = true; });
  await mcp.ready();
});

after(async () => {
  await mcp.close();
  await h.close();
  await dir.cleanup();
});

/** Exercise the public MCP request/response envelope against the real workflow daemon. */
async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const response = await mcp.inject({
    method: "POST", url: "/mcp",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }
  });
  assert.equal(response.statusCode, 200, response.body);
  const envelope = response.json().result;
  const result = envelope.structuredContent;
  if (envelope.isError) throw new ToolError(result.code, result.message, result.detail);
  return result;
}

async function rejects(promise: Promise<unknown>, code: string, match?: RegExp): Promise<ToolError> {
  let caught: unknown;
  await promise.then(
    () => assert.fail(`expected ${code}`),
    (error) => {
      caught = error;
    }
  );
  assert.ok(caught instanceof ToolError, `a ToolError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  if (match) assert.match(caught.message, match);
  return caught;
}

describe("e2e: the MCP workflow tools against the real routes", () => {

  test("the Jira fixer: create by names, read, edit with ops, list by project, refusals named by index", async () => {
    const created = await call("create_workflow", JIRA_FIXER_EXAMPLE as unknown as Result);
    const id = created.workflowId as string;
    assert.equal(created.created, true);
    assert.equal(created.revision, 0);
    assert.equal(created.project, "acme/api");
    assert.equal(created.errorCount, 0, JSON.stringify(created.problems));

    const read = await call("get_workflow", { workflowId: id });
    assert.equal(read.revision, 0);
    const node = await call("get_workflow", { workflowId: id, node: "FixTickets" });
    assert.equal((node.node as { type: string }).type, "agent");

    const updated = await call("update_workflow", { workflowId: id, revision: 0, ops: JIRA_FIXER_EDIT_OPS });
    assert.equal(updated.revision, 1);

    // A stale revision, and a failing op named by the daemon's own opIndex — nothing saved.
    await rejects(call("update_workflow", { workflowId: id, revision: 0, ops: [{ op: "set_enabled", enabled: false }] }), "REVISION_CONFLICT");
    const bad = await rejects(
      call("update_workflow", { workflowId: id, revision: 1, ops: [{ op: "add_node", node: { type: "code", name: "Extra" } }, { op: "connect", source: "Extra", target: "Ghost" }] }),
      "INVALID_WORKFLOW",
    );
    assert.equal((bad.detail as { opIndex: number }).opIndex, 1);
    assert.equal((await call("get_workflow", { workflowId: id })).revision, 1, "nothing was saved");

    // A create refusal names the edge (the daemon counts nodes, then edges).
    await rejects(
      call("create_workflow", {
        name: "Broken",
        project: { kind: "existing", project: "acme/api" },
        nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Work" }],
        edges: [{ source: "Go", target: "Work" }, { source: "Go", target: "Nobody" }]
      }),
      "INVALID_WORKFLOW",
    );

    // Listing by project: the real route's filter.
    const api = await call("list_workflows", { project: "acme/api" });
    assert.deepEqual((api.workflows as { workflowId: string }[]).map((w) => w.workflowId), [id]);
    const web = await call("list_workflows", { project: "acme/web" });
    assert.deepEqual(web.workflows, []);

    await rejects(call("delete_workflow", { workflowId: id, confirm: false }), "INVALID_ARGUMENT");
    assert.deepEqual(await call("delete_workflow", { workflowId: id, confirm: true }), { deleted: true, workflowId: id });
    await rejects(call("get_workflow", { workflowId: id }), "WORKFLOW_NOT_FOUND");
  });

  test("validate_workflow: a draft with the placeholders the tool fills in validates on the real route", async () => {
    const projectPath = join(dir.workspacesDir, "acme", "api");
    const good = await call("validate_workflow", {
      workflow: {
        name: "Draft",
        project: { kind: "existing", projectPath },
        settings: { timezone: "UTC" },
        nodes: [
          { id: "t", type: "trigger.manual", name: "Go", position: { x: 0, y: 0 }, config: {} },
          { id: "c", type: "code", name: "Work", position: { x: 200, y: 0 }, config: { source: "export default () => 1" } }
        ],
        edges: [{ id: "e1", source: "t", sourceHandle: "success", target: "c" }]
      }
    });
    assert.equal(good.valid, true, JSON.stringify(good.problems));
    const minimal = await call("validate_workflow", {
      workflow: {
        name: "Minimal",
        project: { kind: "existing", projectPath },
        nodes: [
          { id: "t", type: "trigger.manual", name: "Go", config: {} },
          { id: "c", type: "code", name: "Work", config: { source: "export default () => 1" } }
        ],
        edges: [{ source: "t", target: "c" }]
      }
    });
    assert.equal(minimal.valid, true, JSON.stringify(minimal.problems));
    const bad = await call("validate_workflow", {
      workflow: {
        name: "Bad",
        project: { kind: "existing", projectPath },
        nodes: [
          { id: "t", type: "trigger.manual", name: "Go", config: {} },
          { id: "s", type: "shell", name: "Sh", config: { script: "echo {{ trigger.input }}" } }
        ],
        edges: [{ id: "e1", source: "t", sourceHandle: "success", target: "s" }]
      }
    });
    assert.equal(bad.valid, false);
    assert.ok((bad.problems as { code: string }[]).some((p) => p.code === "shell_template"), JSON.stringify(bad.problems));
  });

  test("run_workflow waits on the bus for a real run; runs, outputs, secrets and cancel round-trip", async () => {
    const set = await call("set_workflow_secret", { name: "API_KEY", value: "mcp-secret-value-42" });
    assert.equal(set.set, true);
    const listed = await call("list_workflow_secrets", {});
    assert.deepEqual((listed.secrets as { name: string }[]).map((s) => s.name), ["API_KEY"]);
    assert.ok(!JSON.stringify(listed).includes("mcp-secret-value-42"));

    const created = await call("create_workflow", {
      name: "Doubler",
      project: { kind: "existing", project: "acme/api" },
      nodes: [
        { type: "trigger.manual", name: "Go" },
        { type: "code", name: "Double", config: { source: "export default ({ input, secrets }) => ({ doubled: input.input.n * 2, key: secrets.API_KEY })" } },
        { type: "if", name: "Big", config: { rules: [{ left: "{{ nodes.Double.output.doubled }}", op: "gt", right: "10" }] } },
        { type: "shell", name: "Say", config: { script: 'echo "big: $N"', env: [{ name: "N", value: "{{ nodes.Double.output.doubled }}" }] } }
      ],
      edges: [
        { source: "Go", target: "Double" },
        { source: "Double", target: "Big" },
        { source: "Big", sourceHandle: "true", target: "Say" }
      ]
    });
    const id = created.workflowId as string;
    assert.equal(created.errorCount, 0, JSON.stringify(created.problems));

    const ran = await call("run_workflow", { workflowId: id, input: { n: 21 }, wait: true, timeoutSeconds: 60 });
    assert.equal(ran.finished, true, JSON.stringify(ran));
    const run = ran.run as { runId: string; status: string };
    assert.equal(run.status, "succeeded");
    const blocks = ran.blocks as { name: string; status: string; handle?: string; output?: unknown }[];
    assert.deepEqual(blocks.find((b) => b.name === "Double")!.output, { doubled: 42, key: "«secret:API_KEY»" });
    assert.equal(blocks.find((b) => b.name === "Big")!.handle, "true");
    assert.match((blocks.find((b) => b.name === "Say")!.output as { stdout: string }).stdout, /big: 42/);

    const runs = await call("list_workflow_runs", { workflowId: id });
    assert.deepEqual((runs.runs as { runId: string }[]).map((r) => r.runId), [run.runId]);
    assert.equal(runs.before, null);
    const one = await call("get_workflow_run", { runId: run.runId, nodeId: "Double" });
    assert.deepEqual(one.output, { doubled: 42, key: "«secret:API_KEY»" });
    await rejects(call("cancel_workflow_run", { runId: run.runId }), "RUN_NOT_ACTIVE");
    await rejects(call("get_workflow_run", { runId: "no-such-run" }), "RUN_NOT_FOUND");

    // A run the overlap policy skips, then forced.
    const long = await call("create_workflow", {
      name: "Long",
      project: { kind: "existing", project: "acme/api" },
      nodes: [{ type: "trigger.manual", name: "Go" }, { type: "shell", name: "Nap", config: { script: "sleep 5" } }],
      edges: [{ source: "Go", target: "Nap" }]
    });
    const first = await call("run_workflow", { workflowId: long.workflowId as string });
    assert.equal(first.status, "started");
    const skipped = await call("run_workflow", { workflowId: long.workflowId as string });
    assert.equal(skipped.runId, null);
    assert.equal(skipped.skipped, "overlap");
    const cancelled = await call("cancel_workflow_run", { runId: first.runId as string });
    assert.equal(cancelled.cancelRequested, true);
    await h.waitEvent((e) => e.type === "workflowRun.finished" && (e.payload as { run: { id: string } }).run.id === first.runId);
    const after = await call("get_workflow_run", { runId: first.runId as string, includeOutputs: false });
    assert.equal((after.run as { status: string }).status, "cancelled");
  });
});
