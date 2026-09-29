// End to end: the MCP workflow tools against the REAL workflow routes and the REAL runtime (the
// daemon's own `InjectDaemonApi` over a Fastify app carrying `registerWorkflowRoutes`, the stores on
// a temp appdir, the engine as `startDaemon` wires it). These retain the authoring guide,
// draft validation and run/output round trip against the production services.

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
  dir = await tempAppdir(["acme/api"]);
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

describe("e2e: the MCP workflow tools against the real routes", () => {

  test("the published Jira create and edit example stays valid on the real routes", async () => {
    const created = await call("create_workflow", JIRA_FIXER_EXAMPLE as unknown as Result);
    assert.equal(created.created, true);
    assert.equal(created.errorCount, 0, JSON.stringify(created.problems));
    const id = created.workflowId as string;
    const updated = await call("update_workflow", { workflowId: id, revision: 0, ops: JIRA_FIXER_EDIT_OPS });
    assert.equal(updated.errorCount, 0, JSON.stringify(updated.problems));
    const saved = h.service.get(id)!;
    assert.equal(saved.enabled, false, "the example is safe to save without firing it");
    assert.equal(saved.revision, 1);
    await call("delete_workflow", { workflowId: id, confirm: true });
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

  test("run_workflow waits for a real run and its stored output can be read by node name", async () => {
    const created = await call("create_workflow", {
      name: "Doubler",
      project: { kind: "existing", project: "acme/api" },
      nodes: [
        { type: "trigger.manual", name: "Go" },
        { type: "code", name: "Double", config: { source: "export default ({ input }) => ({ doubled: input.input.n * 2 })" } }
      ],
      edges: [{ source: "Go", target: "Double" }]
    });
    const id = created.workflowId as string;
    const ran = await call("run_workflow", { workflowId: id, input: { n: 21 }, wait: true, timeoutSeconds: 60 });
    assert.equal(ran.finished, true, JSON.stringify(ran));
    const run = ran.run as { runId: string; status: string };
    assert.equal(run.status, "succeeded");
    const blocks = ran.blocks as { name: string; output?: unknown }[];
    assert.deepEqual(blocks.find((block) => block.name === "Double")!.output, { doubled: 42 });
    const runs = await call("list_workflow_runs", { workflowId: id });
    assert.deepEqual((runs.runs as { runId: string }[]).map((row) => row.runId), [run.runId]);
    const one = await call("get_workflow_run", { runId: run.runId, nodeId: "Double" });
    assert.deepEqual(one.output, { doubled: 42 });
    assert.equal((await h.runStore.load(run.runId))!.status, "succeeded");
  });
});
