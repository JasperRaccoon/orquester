/**
 * The `workflows` chat grant end to end (unified MCP design 2026-10-15 §7.6, §14.2.11, rulings):
 * the REAL catalog tools, the executor and the REAL approval port, registry and `agent-tools.json`
 * store (`connectExecutor`, as `index.ts` wires them), over a fake workflow backend. A person
 * answers each card on the registry.
 *
 * - create → run → fix → run → delete under one chat grant (the create approved with "Allow in this
 *   chat" makes the grant and joins it);
 * - a second create joins the grant only through the card that says so;
 * - a workflow the chat did not create (or explicitly grant) cards every time — approving once never
 *   widens the grant — until the user grants it explicitly on its card;
 * - the grant never covers a change whose project union leaves the caller's project, nor a caller
 *   below Full access.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSETS, type Workflow, type WorkflowPatchOp } from "@orquester/api";
import { agentChatRoutes, TOOL_APPROVAL_EVENT_TYPE, type AgentChatToolApprovalEventPayload } from "@orquester/api/agent-chat";
import { applyWorkflowPatch, createWorkflowFromRequest, type CreateWorkflowRequest } from "@orquester/api";

import { connectExecutor, createAgentToolsRuntime, WORKFLOW_GRANT_NOTICE } from "../../agent-tools/approval-port.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall, executorPorts } from "../executor.ts";
import { head, snapshot } from "../fixtures.ts";
import { FakeDaemonApi } from "../testing.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "umcp-wf-grants-")));
const WS = join(ROOT, "w");
const OWN = join(WS, "acme/api");
const OTHER = join(WS, "beta/app");
for (const dir of [OWN, OTHER]) mkdirSync(dir, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A small in-memory workflow backend behind the real routes' paths. */
function workflowBackend(api: FakeDaemonApi) {
  const store = new Map<string, Workflow>();
  let ids = 0;
  let runs = 0;
  const env = () => ({ mintId: () => `n${(ids += 1)}`, now: new Date("2026-10-15T00:00:00Z") });
  const notFound = { status: 404, body: { error: { code: "WORKFLOW_NOT_FOUND", message: "No such workflow" } } };
  api.on("POST", "/api/workflows/validate", { status: 200, body: { problems: [] } });
  api.on("POST", "/api/workflows", ({ body }) => {
    const created = createWorkflowFromRequest(body as CreateWorkflowRequest, env());
    const workflow = { ...created, id: `wf-${store.size + 1}` };
    store.set(workflow.id, workflow);
    return { status: 201, body: { workflow, problems: [] } };
  });
  api.on("GET", "/api/workflows/*", () => notFound);
  const serve = (id: string) => {
    api.on("GET", `/api/workflows/${id}`, () => (store.has(id) ? { status: 200, body: { workflow: store.get(id), problems: [] } } : notFound));
    api.on("POST", `/api/workflows/${id}/patch`, ({ body }) => {
      const current = store.get(id)!;
      const { revision, ops } = body as { revision: number; ops: WorkflowPatchOp[] };
      if (revision !== current.revision) return { status: 409, body: { error: { code: "REVISION_CONFLICT", message: "Stale" } } };
      const next = { ...applyWorkflowPatch(current, ops, env()), id, revision: current.revision + 1 };
      store.set(id, next);
      return { status: 200, body: { workflow: next, problems: [] } };
    });
    api.on("POST", `/api/workflows/${id}/run`, () => {
      runs += 1;
      const runId = `run-${runs}`;
      api.on("GET", `/api/workflow-runs/${runId}`, { status: 200, body: { run: { id: runId, workflowId: id, workflowName: "x", status: "running", trigger: { kind: "manual" }, test: false, queuedAt: "2026-10-15T00:00:00Z", definition: store.get(id), blocks: {}, takenEdges: [], deadEdges: [], triggerPayload: null } } });
      return { status: 200, body: { runId } };
    });
    api.on("DELETE", `/api/workflows/${id}`, () => (store.delete(id) ? { status: 200, body: { ok: true } } : notFound));
  };
  /** A workflow the USER made (not through this chat). */
  const seed = (name: string): Workflow => {
    const workflow = { ...createWorkflowFromRequest({ name, project: { kind: "existing", projectPath: OWN }, nodes: [{ type: "trigger.manual", name: "Go" }] }, env()), id: `wf-user-${name}` };
    store.set(workflow.id, workflow);
    serve(workflow.id);
    return workflow;
  };
  return { store, serve, seed, runs: () => runs };
}

async function rig(t: TestContext) {
  const appdir = mkdtempSync(join(tmpdir(), "umcp-wf-grants-appdir-"));
  const opened: string[] = [];
  const waiters: ((id: string) => void)[] = [];
  const api = new FakeDaemonApi().on("GET", agentChatRoutes.thread("me"), {
    status: 200,
    body: { kind: "snapshot", thread: snapshot({ head: head({ id: "me", runtimeMode: "full-access" }) }) }
  });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const backend = workflowBackend(api);
  const runtime = createAgentToolsRuntime({
    baseDir: appdir,
    publish: (_channel, type, payload) => {
      const event = payload as AgentChatToolApprovalEventPayload;
      if (type !== TOOL_APPROVAL_EVENT_TYPE || !event.opened) return;
      const waiter = waiters.shift();
      if (waiter) waiter(event.opened.approvalId);
      else opened.push(event.opened.approvalId);
    },
    onApprovalsChanged: () => {},
    tab: (id) => (id === "me" ? { projectPath: OWN } : undefined),
    agentOf: (id) => (id === "me" ? "claude" : null),
    api: () => api,
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  await runtime.load();
  const disconnect = connectExecutor(runtime, executorPorts);
  t.after(async () => {
    disconnect();
    await runtime.shutdown();
    rmSync(appdir, { recursive: true, force: true });
  });
  const nextCard = (): Promise<string> => (opened.length > 0 ? Promise.resolve(opened.shift()!) : new Promise((resolve) => waiters.push(resolve)));
  const caller = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
    kind: "thread", threadId: "me", title: "Automate", projectPath: OWN, workspace: "acme", cwd: OWN, agentId: "claude", callId: "c",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  });
  const all = new Set(TOOLSETS.map((toolset) => toolset.id));
  // The REAL catalog lookup; the ports are the ones `connectExecutor` set.
  const call = (name: string, args: Record<string, unknown>, who = caller()) =>
    executeToolCall({ enabledToolsets: async () => all }, { name, arguments: args }, { caller: who, api, signal: new AbortController().signal });
  /** Call, answer the card it opens with `answer`, and return the result and the card. */
  const carded = async (name: string, args: Record<string, unknown>, answer: { decision: "approve" | "deny"; grant?: "chat" }, who = caller()) => {
    const pending = call(name, args, who);
    const id = await nextCard();
    const card = runtime.approvals.list("me").find((c) => c.approvalId === id)!;
    const answered = await runtime.approvals.answer("me", id, answer);
    assert.ok(answered.ok, JSON.stringify(answered));
    return { result: await pending, card };
  };
  /** A call that must open NO card: one that does is denied at once (so the test fails instead of waiting). */
  const uncarded = async (name: string, args: Record<string, unknown>, who = caller()) => {
    let carded = false;
    const watcher = (id: string) => {
      carded = true;
      void runtime.approvals.answer("me", id, { decision: "deny" });
    };
    waiters.push(watcher);
    const result = await call(name, args, who);
    const index = waiters.indexOf(watcher);
    if (index >= 0) waiters.splice(index, 1);
    assert.ok(!carded, `${name} opened a card`);
    return result;
  };
  const workflowGrant = () => runtime.tools.snapshot().grants.filter((g) => g.family === "workflows" && g.threadId === "me");
  return { api, backend, runtime, call, carded, uncarded, caller, opened, workflowGrant };
}

const ok = (result: CallToolResult): Record<string, unknown> => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent as Record<string, unknown>;
};
const codeOf = (result: CallToolResult) => (result.structuredContent as { code?: string }).code;

const fixer = {
  name: "Fixer",
  project: { kind: "existing", project: "acme/api" },
  nodes: [{ type: "trigger.manual", name: "Go" }, { type: "code", name: "Fix", config: { source: "export default () => 1" } }],
  edges: [{ source: "Go", target: "Fix" }]
};

test("create → run → fix → run → delete under ONE chat grant: the approved create makes the grant and joins it; nothing else cards", async (t) => {
  const r = await rig(t);
  const { result, card } = await r.carded("create_workflow", fixer, { decision: "approve", grant: "chat" });
  assert.deepEqual(card.grantOptions, ["chat"]);
  const created = ok(result);
  const id = created.workflowId as string;
  r.backend.serve(id);
  assert.deepEqual(r.workflowGrant().map((g) => g.workflowIds), [[id]], "the new workflow joined the grant its card made");

  const run1 = ok(await r.uncarded("run_workflow", { workflowId: id, revision: 0 }));
  assert.equal(run1.status, "started");
  const watched = ok(await r.uncarded("get_workflow_runs", { runId: run1.runId as string }));
  assert.equal((watched.run as { status: string }).status, "running");
  const fixed = ok(await r.uncarded("update_workflow", { workflowId: id, revision: 0, ops: [{ op: "update_node", node: "Fix", set: { config: { source: "export default () => 2" } } }] }));
  assert.equal(fixed.revision, 1);
  ok(await r.uncarded("run_workflow", { workflowId: id, revision: 1 }));
  ok(await r.uncarded("update_workflow", { workflowId: id, revision: 1, ops: [{ op: "set_enabled", enabled: true }] }));
  assert.deepEqual(ok(await r.uncarded("delete_workflow", { workflowId: id, confirm: true })), { deleted: true, workflowId: id });
  assert.equal(r.opened.length, 0, "no further card was opened");
  assert.equal(r.runtime.approvals.list("me").length, 0);
  assert.equal(r.backend.runs(), 2);
});

test("a second create joins the chat's grant only through the card that says so; approve-once of another workflow's run never widens the grant", async (t) => {
  const r = await rig(t);
  const first = ok((await r.carded("create_workflow", fixer, { decision: "approve", grant: "chat" })).result);
  r.backend.serve(first.workflowId as string);
  // The second create's card carries the join notice; a plain approval joins it.
  const second = await r.carded("create_workflow", { ...fixer, name: "Second" }, { decision: "approve" });
  assert.equal(second.card.sections[0]!.kind, "warning");
  assert.equal((second.card.sections[0] as { text: string }).text, WORKFLOW_GRANT_NOTICE);
  const secondId = ok(second.result).workflowId as string;
  r.backend.serve(secondId);
  assert.deepEqual(r.workflowGrant()[0]!.workflowIds, [first.workflowId, secondId]);
  ok(await r.uncarded("run_workflow", { workflowId: secondId, revision: 0 }));
  assert.equal(r.opened.length, 0);

  // A workflow the user made: every run cards, and approving once joins nothing.
  const theirs = r.backend.seed("Theirs");
  const once = await r.carded("run_workflow", { workflowId: theirs.id, revision: theirs.revision }, { decision: "approve" });
  ok(once.result);
  assert.deepEqual(once.card.grantOptions, ["chat"]);
  assert.deepEqual(r.workflowGrant()[0]!.workflowIds, [first.workflowId, secondId], "approve-once never widens the grant");
  const denied = await r.carded("run_workflow", { workflowId: theirs.id, revision: theirs.revision }, { decision: "deny", reason: "not that one" } as never);
  assert.equal(codeOf(denied.result), "APPROVAL_DENIED");
  // Explicitly granted on its card: covered from then on.
  ok((await r.carded("run_workflow", { workflowId: theirs.id, revision: theirs.revision }, { decision: "approve", grant: "chat" })).result);
  assert.ok(r.workflowGrant()[0]!.workflowIds!.includes(theirs.id));
  ok(await r.uncarded("run_workflow", { workflowId: theirs.id, revision: theirs.revision }));
  assert.equal(r.opened.length, 0);
});

test("the grant never covers a change whose union leaves the caller's project, a caller below Full access, or a workflow secret", async (t) => {
  const r = await rig(t);
  const created = ok((await r.carded("create_workflow", fixer, { decision: "approve", grant: "chat" })).result);
  const id = created.workflowId as string;
  r.backend.serve(id);
  // Moving a block into another workspace's project: a card, offering no grant.
  const away = await r.carded("update_workflow", { workflowId: id, revision: 0, ops: [{ op: "update_node", node: "Fix", set: { projectOverride: "beta/app" } }] }, { decision: "deny" });
  assert.deepEqual(away.card.grantOptions, []);
  assert.deepEqual(away.card.scope.projects?.map((p) => p.path), [OWN, OTHER]);
  assert.equal(codeOf(away.result), "APPROVAL_DENIED");
  // Below Full access the grant is not honoured: the run cards.
  const auto = await r.carded("run_workflow", { workflowId: id, revision: 0 }, { decision: "approve" }, r.caller({ runtimeMode: "auto" }));
  assert.deepEqual(auto.card.grantOptions, []);
  // A workflow secret: always a card, never a grant option.
  const secret = await r.carded("set_workflow_secret", { name: "TOKEN", workflowId: id }, { decision: "approve", secrets: { value: "typed-by-user" } } as never);
  assert.deepEqual(secret.card.grantOptions, []);
  assert.deepEqual(secret.card.secretFields, [{ key: "value", label: "Value of TOKEN" }]);
  assert.ok(!JSON.stringify(r.runtime.approvals.list("me")).includes("typed-by-user"));
});

test("no escape through sub-workflows: wiring the user's (disabled) workflow into a granted one, and running it, both card until that workflow is granted too", async (t) => {
  const r = await rig(t);
  const created = ok((await r.carded("create_workflow", fixer, { decision: "approve", grant: "chat" })).result);
  const id = created.workflowId as string;
  r.backend.serve(id);
  const theirs = r.backend.seed("Theirs");
  assert.equal(theirs.enabled, false);
  // The edit that wires it in: a card (the grant covers the parent, not the child), its warning naming the disabled child.
  const wire = await r.carded("update_workflow", { workflowId: id, revision: 0, ops: [{ op: "add_node", node: { type: "workflow", name: "Call", config: { workflowId: theirs.id } } }, { op: "connect", source: "Fix", target: "Call" }] }, { decision: "approve" });
  ok(wire.result);
  assert.ok(wire.card.sections.some((s) => s.kind === "warning" && /DISABLED workflow "Theirs"/.test(s.text)));
  assert.deepEqual(r.workflowGrant()[0]!.workflowIds, [id], "approve-once did not widen the grant");
  // Running the parent now runs the user's workflow: a card every time.
  const run = await r.carded("run_workflow", { workflowId: id, revision: 1 }, { decision: "deny" });
  assert.equal(codeOf(run.result), "APPROVAL_DENIED");
  // Approving once covers nothing more.
  ok((await r.carded("run_workflow", { workflowId: id, revision: 1 }, { decision: "approve" })).result);
  assert.deepEqual(r.workflowGrant()[0]!.workflowIds, [id]);
  // A grant chosen on that card names the child (with its revision) and covers it too: from then on, no card.
  const granted = await r.carded("run_workflow", { workflowId: id, revision: 1 }, { decision: "approve", grant: "chat" });
  ok(granted.result);
  const named = granted.card.sections.find((s) => s.kind === "fields" && /a chat grant chosen here covers them too/.test(s.title ?? "")) as { rows: { label: string; value: string }[] };
  assert.deepEqual(named.rows.map((row) => [row.label, row.value]), [[`Theirs (${theirs.id})`, `revision ${theirs.revision}, disabled`]]);
  assert.deepEqual(r.workflowGrant()[0]!.workflowIds, [id, theirs.id]);
  ok(await r.uncarded("run_workflow", { workflowId: id, revision: 1 }));
});
