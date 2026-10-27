// End to end: the MCP workflow tools against the REAL workflow routes and the REAL runtime (the
// daemon's own `InjectDaemonApi` over a Fastify app carrying `registerWorkflowRoutes`, the stores on
// a temp appdir, the engine as `startDaemon` wires it). These retain the authoring guide,
// dry-run validation, the revision-pinned run and the run/output round trip against the production services.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { registerMcp } from "../mcp/server.ts";
import { ToolError } from "../mcp/errors.ts";
import { boot, retainWorkflowArtifact, tempAppdir, type Booted } from "./testing/daemon-harness.ts";

type Result = Record<string, unknown>;

let dir: Awaited<ReturnType<typeof tempAppdir>>;
let h: Booted;
let mcp: FastifyInstance;

before(async () => {
  dir = await tempAppdir(["acme/api"]);
  h = await boot(dir.root);
  mcp = Fastify();
  registerMcp(mcp, { createApi: () => h.api });
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

  test("the published Jira create and edit example stays valid on the real routes", async (t) => {
    const listed = await call("list_workflow_block_types", {});
    const guide = String(listed.authoringGuide);
    const createExample = /^create_workflow (\{.*\})$/m.exec(guide);
    const editExample = /^update_workflow (\{.*\})$/m.exec(guide);
    assert.ok(createExample && editExample, "the published guide includes runnable create and edit commands");
    const created = await call("create_workflow", JSON.parse(createExample[1]!));
    assert.equal(created.created, true);
    assert.equal(created.errorCount, 0, JSON.stringify(created.problems));
    const id = created.workflowId as string;
    const updated = await call("update_workflow", { ...JSON.parse(editExample[1]!), workflowId: id });
    assert.equal(updated.errorCount, 0, JSON.stringify(updated.problems));
    const saved = h.service.get(id)!;
    assert.equal(saved.enabled, false, "the example is safe to save without firing it");
    assert.equal(saved.revision, 1);
    await call("delete_workflow", { workflowId: id, confirm: true });
    await retainWorkflowArtifact(t, { created, updated });
  });

  test("create_workflow and update_workflow {dryRun: true} validate on the real route and save nothing", async (t) => {
    const before = h.service.list().length;
    const minimal = await call("create_workflow", {
      name: "Minimal",
      project: { kind: "existing", project: "acme/api" },
      nodes: [
        { type: "trigger.manual", name: "Go" },
        { type: "code", name: "Work", config: { source: "export default () => 1" } }
      ],
      edges: [{ source: "Go", target: "Work" }],
      dryRun: true
    });
    assert.equal(minimal.valid, true, JSON.stringify(minimal.problems));
    assert.equal(minimal.saved, false);
    const broken = await call("create_workflow", {
      name: "Broken",
      project: { kind: "existing", project: "acme/api" },
      nodes: [{ type: "shell", name: "Sh", config: { script: "echo {{ input }}" } }],
      dryRun: true
    });
    assert.equal(broken.valid, false);
    assert.equal(h.service.list().length, before, "a dry run saves nothing");
    const created = await call("create_workflow", {
      name: "Edited",
      project: { kind: "existing", project: "acme/api" },
      nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Work", config: { source: "export default () => 1" } }],
      edges: [{ source: "Go", target: "Work" }]
    });
    const id = created.workflowId as string;
    const dry = await call("update_workflow", { workflowId: id, revision: created.revision, ops: [{ op: "rename_node", node: "Work", to: "Renamed" }], dryRun: true });
    assert.equal(dry.valid, true, JSON.stringify(dry.problems));
    const saved = await call("get_workflow", { workflowId: id, node: "Work" });
    assert.equal((saved.node as { name: string }).name, "Work", "a dry run leaves the stored node unchanged");
    assert.equal(h.service.get(id)!.revision, created.revision, "a dry run saves nothing");
    await call("delete_workflow", { workflowId: id, confirm: true });
    await retainWorkflowArtifact(t, { minimal, broken, dry });
  });

  test("run_workflow waits for a real run and its stored output can be read by node name", async (t) => {
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
    await assert.rejects(call("run_workflow", { workflowId: id, revision: (created.revision as number) + 1 }), (error: ToolError) => error.code === "REVISION_CONFLICT");
    const ran = await call("run_workflow", { workflowId: id, revision: created.revision, input: { n: 21 }, wait: true, timeoutSeconds: 60 });
    assert.equal(ran.finished, true, JSON.stringify(ran));
    const run = ran.run as { runId: string; status: string };
    assert.equal(run.status, "succeeded");
    const blocks = ran.blocks as { name: string; output?: unknown }[];
    assert.deepEqual(blocks.find((block) => block.name === "Double")!.output, { doubled: 42 });
    const runs = await call("get_workflow_runs", { workflowId: id });
    assert.deepEqual((runs.runs as { runId: string }[]).map((row) => row.runId), [run.runId]);
    const one = await call("get_workflow_runs", { runId: run.runId, nodeId: "Double" });
    assert.deepEqual(one.output, { doubled: 42 });
    assert.equal((await h.runStore.load(run.runId))!.status, "succeeded");
    await retainWorkflowArtifact(t, { ran, runs, output: one.output });
  });
});
