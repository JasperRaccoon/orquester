// End to end: the MCP workflow tools against the REAL workflow routes and the REAL runtime (the
// daemon's own `InjectDaemonApi` over a Fastify app carrying `registerWorkflowRoutes`, the stores on
// a temp appdir, the engine as `startDaemon` wires it). These retain the authoring guide,
// draft validation and run/output round trip against the production services.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { WORKFLOW_BLOCK_GUIDES, WORKFLOW_CODE_ARGUMENT_NAMES, WORKFLOW_EXPRESSION_GUIDE, WORKFLOW_RECIPES, WORKFLOW_SANDBOX_ENV_NAMES } from "@orquester/api";
import { registerMcp } from "../mcp/server.ts";
import { ToolError } from "../mcp/errors.ts";
import { MAX_RESULT_BYTES, resultBytes } from "../mcp/result.ts";
import { JIRA_FIXER_EDIT_OPS, JIRA_FIXER_EXAMPLE, WORKFLOW_AUTHORING_GUIDE } from "../mcp/tools/workflows-guide.ts";
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

  test("list_workflow_block_types returns every config schema and both whole guides within the result budget", async () => {
    const listed = await call("list_workflow_block_types", {});
    assert.equal(listed.configSchemasOmitted, undefined, "no schema had to be dropped");
    const rows = listed.types as Result[];
    assert.ok(rows.length > 0 && rows.every((row) => !("guide" in row)), "the contracts ride in the authoring guide, not per type");
    assert.equal(listed.authoringGuide, WORKFLOW_AUTHORING_GUIDE);
    assert.equal(listed.expressionGuide, WORKFLOW_EXPRESSION_GUIDE);
    // The tool's own budget (workflows.ts WORKFLOW_RESULT_BUDGET): the cap less room for ok()'s framing.
    assert.ok(resultBytes(listed) <= MAX_RESULT_BYTES - 4_000, `${resultBytes(listed)} bytes`);
  });

  test("list_workflow_block_types {type} returns that block's full contract: schema and guide sections", async () => {
    const listed = await call("list_workflow_block_types", { type: "code" });
    const [row] = listed.types as Result[];
    assert.equal(row!.type, "code");
    assert.ok(row!.configSchema, "the whole config schema");
    assert.deepEqual(row!.guide, JSON.parse(JSON.stringify(WORKFLOW_BLOCK_GUIDES.code)));
    assert.ok((row!.guide as { title: string }[]).length > 0);
    assert.equal(listed.authoringGuide, undefined);
  });

  test("every published recipe creates on the real routes with zero errors", async () => {
    for (const recipe of WORKFLOW_RECIPES) {
      const created = await call("create_workflow", {
        name: recipe.title,
        project: { kind: "existing", project: "acme/api" },
        nodes: recipe.nodes,
        edges: recipe.edges
      } as unknown as Result);
      assert.equal(created.errorCount, 0, `${recipe.id}: ${JSON.stringify(created.problems)}`);
      await call("delete_workflow", { workflowId: created.workflowId as string, confirm: true });
    }
  });

  test("a code block gets exactly the documented arguments, environment and result rules", async () => {
    const created = await call("create_workflow", {
      name: "Code contract",
      project: { kind: "existing", project: "acme/api" },
      nodes: [
        { type: "trigger.manual", name: "Go" },
        {
          type: "code",
          name: "Probe",
          config: {
            source:
              "export default async function (arg) {\n  return { keys: Object.keys(arg), env: Object.keys(process.env).sort(), cwd: process.cwd(), globals: [typeof fetch, typeof Buffer, typeof setTimeout, typeof require], attempt: arg.run.attempt, triggerInput: arg.trigger.input };\n}\n"
          }
        },
        { type: "code", name: "Nothing", config: { source: "export default async function () {}\n" } },
        { type: "code", name: "Halt", config: { source: "export default async function ({ stop }) {\n  stop(\"enough\");\n}\n" } },
        { type: "code", name: "After", config: { source: "export default async function () {\n  return 1;\n}\n" } }
      ],
      edges: [
        { source: "Go", target: "Probe" },
        { source: "Probe", target: "Nothing" },
        { source: "Nothing", target: "Halt" },
        { source: "Halt", target: "After" }
      ]
    });
    const id = created.workflowId as string;
    const ran = await call("run_workflow", { workflowId: id, input: { n: 1 }, wait: true, timeoutSeconds: 60 });
    assert.equal(ran.finished, true, JSON.stringify(ran));
    assert.equal((ran.run as { status: string }).status, "stopped", "stop() ends the run as stopped, not failed");
    const blocks = ran.blocks as { name: string; status: string; output?: unknown }[];
    const probe = blocks.find((block) => block.name === "Probe")!.output as Record<string, unknown>;
    assert.deepEqual(probe.keys, [...WORKFLOW_CODE_ARGUMENT_NAMES]);
    assert.deepEqual(probe.env, [...WORKFLOW_SANDBOX_ENV_NAMES].sort());
    assert.equal(probe.cwd, join(dir.workspacesDir, "acme", "api"));
    assert.deepEqual(probe.globals, ["function", "function", "function", "undefined"], "fetch, Buffer and timers are global; require is only the argument");
    assert.equal(probe.attempt, 1);
    assert.deepEqual(probe.triggerInput, { n: 1 });
    assert.equal(blocks.find((block) => block.name === "Nothing")!.output, null, "undefined returns as null");
    assert.notEqual(blocks.find((block) => block.name === "After")?.status, "succeeded", "nothing runs after stop()");
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

  test("preview_expression renders templates against a real run, from a block's point of view", async () => {
    await h.secrets.set("PREVIEW_TOKEN", "tok-e2e-secret");
    const created = await call("create_workflow", {
      name: "Previewed",
      project: { kind: "existing", project: "acme/api" },
      nodes: [
        { type: "trigger.manual", name: "Go" },
        { type: "code", name: "Double", config: { source: "export default ({ input }) => ({ doubled: input.input.n * 2, note: 'tok-e2e-secret' })" } },
        { type: "code", name: "Report", config: { source: "export default () => 'ok'" } }
      ],
      edges: [{ source: "Go", target: "Double" }, { source: "Double", target: "Report" }]
    });
    const id = created.workflowId as string;
    const ran = await call("run_workflow", { workflowId: id, input: { n: 4 }, wait: true, timeoutSeconds: 60 });
    assert.equal((ran.run as { status: string }).status, "succeeded", JSON.stringify(ran));
    const preview = await call("preview_expression", {
      workflowId: id,
      node: "Report",
      templates: ["{{ input.doubled }} / {{ nodes.Double.output.doubled | json }}", "{{ nodes.Double.output.nope }}", "{{ secrets.PREVIEW_TOKEN }} {{ input.note }}"]
    });
    const results = preview.results as { text: string; warnings: string[] }[];
    assert.equal(results[0]!.text, "8 / 8");
    assert.match(results[1]!.warnings[0]!, /nothing at nodes\.Double\.output\.nope/);
    assert.equal(results[2]!.text, "«secret:PREVIEW_TOKEN» «secret:PREVIEW_TOKEN»");
    assert.ok(!JSON.stringify(preview).includes("tok-e2e-secret"));
    assert.equal((preview.source as { run: string }).run, "reached-node");
    const value = await call("preview_expression", { workflowId: id, node: "Report", mode: "value", template: "{{ input.doubled }}" });
    assert.equal((value.results as { value: unknown }[])[0]!.value, 8);
  });
});
