// End to end: the MCP workflow tools against the REAL workflow routes and the REAL runtime (the
// daemon's own `InjectDaemonApi` over a Fastify app carrying `registerWorkflowRoutes`, the stores on
// a temp appdir, the engine as `startDaemon` wires it). The tools' unit tests run against an
// in-memory fake daemon; this is where the two are held to agree.

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { argumentsSchema } from "../mcp/server.ts";
import { ToolError } from "../mcp/errors.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "../mcp/result.ts";
import type { ToolContext } from "../mcp/tool.ts";
import { JIRA_FIXER_EDIT_OPS, JIRA_FIXER_EXAMPLE } from "../mcp/tools/workflows-guide.ts";
import { workflowTools } from "../mcp/tools/workflows.ts";
import { boot, tempAppdir, type Booted } from "./testing/daemon-harness.ts";

type Result = Record<string, unknown>;

let dir: Awaited<ReturnType<typeof tempAppdir>>;
let h: Booted;

before(async () => {
  dir = await tempAppdir(["acme/api", "acme/web"]);
  h = await boot(dir.root);
});

after(async () => {
  await h.close();
  await dir.cleanup();
});

/** A tool call as `tools/call` makes it: the strict schema (defaults applied), then run, then ok()'s cap. */
async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const tool = workflowTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name}`);
  const parsed = argumentsSchema(tool).safeParse(args);
  if (!parsed.success) throw new ToolError("INVALID_ARGUMENT", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const ctx: ToolContext = { api: h.api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.now() };
  const result = await tool.run(parsed.data as never, ctx);
  assert.ok(resultBytes(result) <= MAX_RESULT_BYTES, `${name} stays under the cap`);
  assert.equal(ok(result).structuredContent, result, `${name} is never cut by ok()`);
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
  test("block types: every type with its handles and a JSON schema from the real catalogue", async () => {
    const r = await call("list_workflow_block_types", {});
    const types = r.types as { type: string; handles: string[] }[];
    assert.equal(types.length, 14);
    assert.deepEqual(types.find((t) => t.type === "if")!.handles, ["true", "false", "error"]);
    const one = await call("list_workflow_block_types", { type: "shell" });
    assert.ok((one.types as { configSchema?: unknown }[])[0]!.configSchema);
  });

  test("the Jira fixer: create by names, read, edit with ops, list by project, refusals named by index", async () => {
    const created = await call("create_workflow", JIRA_FIXER_EXAMPLE as unknown as Result);
    const id = created.workflowId as string;
    assert.equal(created.created, true);
    assert.equal(created.revision, 0);
    assert.equal(created.project, "acme/api");
    assert.ok((created.connections as string[]).includes("HasTickets (true) → FixTickets"), JSON.stringify(created.connections));
    assert.equal(created.errorCount, 0, JSON.stringify(created.problems));

    const read = await call("get_workflow", { workflowId: id });
    assert.equal(read.revision, 0);
    const node = await call("get_workflow", { workflowId: id, node: "FixTickets" });
    assert.equal((node.node as { type: string }).type, "agent");

    const updated = await call("update_workflow", { workflowId: id, revision: 0, ops: JIRA_FIXER_EDIT_OPS });
    assert.equal(updated.revision, 1);
    assert.ok((updated.connections as string[]).includes("MarkDone → NotifySlack"));
    assert.ok((updated.connections as string[]).includes("FixTickets (error) → Failed"));

    // A stale revision, and a failing op named by the daemon's own opIndex — nothing saved.
    await rejects(call("update_workflow", { workflowId: id, revision: 0, ops: [{ op: "set_enabled", enabled: false }] }), "REVISION_CONFLICT", /get_workflow/);
    const bad = await rejects(
      call("update_workflow", { workflowId: id, revision: 1, ops: [{ op: "add_node", node: { type: "code", name: "Extra" } }, { op: "connect", source: "Extra", target: "Ghost" }] }),
      "INVALID_WORKFLOW",
      /^ops\[1\] \(connect\) failed: (?!Operation).*Ghost.*Nothing was saved\.$/
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
      /^edges\[1\]: (?!Item).*Nobody/
    );

    // Listing by project: the real route's filter.
    const api = await call("list_workflows", { project: "acme/api" });
    assert.deepEqual((api.workflows as { workflowId: string }[]).map((w) => w.workflowId), [id]);
    const web = await call("list_workflows", { project: "acme/web" });
    assert.deepEqual(web.workflows, []);
    const all = await call("list_workflows", {});
    const row = (all.workflows as { workflowId: string; triggers: string[] }[]).find((w) => w.workflowId === id)!;
    assert.match(row.triggers[0]!, /hour/i);

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
