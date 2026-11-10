// End to end: gates over the REAL workflow routes and runtime (spec 2026-11-10 §6.3, §8) — who
// started a run comes from the request's principal (an in-chat agent's in-process token), never the
// body; the gate list and decide routes; `decide_workflow_gate` through THE MCP executor, where only
// the assigned chat decides (no card, from any project) and every other chat is refused.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { CreateWorkflowRequest, DecideWorkflowGateResponse, GetWorkflowRunResponse, ListWorkflowGatesResponse, RunWorkflowResponse, WorkflowWriteResponse } from "@orquester/api";
import { agentChatCommandPath } from "@orquester/api/agent-chat";
import { join } from "node:path";

import type { ThreadCaller } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { executeToolCall } from "../mcp/executor.ts";
import { chatSummary } from "../mcp/fixtures.ts";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { boot, runFinished, tempAppdir, type Booted } from "./testing/daemon-harness.ts";

let dir: Awaited<ReturnType<typeof tempAppdir>>;
let h: Booted;
let projectPath: string;
const chats = new FakeDaemonApi();
const turns: Record<string, unknown>[] = [];

before(async () => {
  dir = await tempAppdir(["acme/api", "beta/app"]);
  projectPath = join(dir.workspacesDir, "acme", "api");
  chats.on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "lead", title: "Lead", projectPath: join(dir.workspacesDir, "beta", "app") })] });
  chats.on("POST", agentChatCommandPath("lead", "turn"), ({ body }) => {
    turns.push(body as Record<string, unknown>);
    return { status: 200, body: { seq: 1 } };
  });
  // The engine's client: the chat routes are the fake's, everything else the real app's.
  h = await boot(dir.root, {
    engineApi: (inject): DaemonApi => ({
      request: (method, path, opts) => (path.startsWith("/api/sessions") ? chats.request(method, path, opts) : inject.request(method, path, opts)),
      uploadAttachment: (...args) => inject.uploadAttachment(...args),
      subscribe: (listener) => inject.subscribe(listener),
      publishHtmlRender: (request) => inject.publishHtmlRender(request),
      previewHtmlRender: (request) => inject.previewHtmlRender(request),
      get fsRoot() {
        return inject.fsRoot;
      },
      get workspacesDir() {
        return inject.workspacesDir;
      }
    })
  });
});

after(async () => {
  await h.close();
  await dir.cleanup();
});

/** The bus event that carries a gate of `runId` (every event is kept: no race with a late subscribe). */
const gateOpened = (runId: string) => (event: { type: string; payload: unknown }): boolean =>
  event.type === "workflowRun.updated" && ((event.payload as { gates?: { runId: string }[] }).gates ?? []).some((gate) => gate.runId === runId);

async function json<T>(method: "GET" | "POST", url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await h.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: JSON.parse(res.body) as T };
}

function chat(threadId: string, over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId, title: threadId, projectPath, workspace: "acme", cwd: projectPath, agentId: "claude", callId: `c-${threadId}`,
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

async function tool(caller: ThreadCaller | { kind: "external" }, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; result: Record<string, unknown> }> {
  const answer = await executeToolCall({ approvals: null, now: () => Date.now() }, { name, arguments: args }, { caller, api: h.api, signal: new AbortController().signal });
  return { isError: answer.isError === true, result: answer.structuredContent as Record<string, unknown> };
}

async function createGated(name: string): Promise<string> {
  const request: CreateWorkflowRequest = {
    name,
    project: { kind: "existing", projectPath },
    settings: { overlap: "parallel", maxConcurrent: 4 },
    nodes: [
      { id: "t", name: "Start", type: "trigger.manual" },
      { id: "g", name: "Approve", type: "gate", config: { question: "Ship it?", decider: { kind: "launcher", maxMinutes: 30 } } }
    ] as CreateWorkflowRequest["nodes"],
    edges: [{ source: "t", target: "g" }]
  };
  const created = await json<WorkflowWriteResponse>("POST", "/api/workflows", request);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.problems.filter((p) => p.severity === "error").length, 0, JSON.stringify(created.body.problems));
  return created.body.workflow.id;
}

describe("e2e: gates over the real routes", () => {
  test("startedBy is the principal's: a body field never names the launcher; the gate list and decide routes answer", async () => {
    const workflowId = await createGated("Gated");
    // The person (no principal) cannot pose as a chat.
    const forged = await json<RunWorkflowResponse>("POST", `/api/workflows/${workflowId}/run`, { startedBy: { kind: "thread", sessionId: "lead" } });
    assert.equal(forged.status, 200);
    await h.waitEvent(gateOpened(forged.body.runId!), 60_000);
    const forgedRun = (await json<GetWorkflowRunResponse>("GET", `/api/workflow-runs/${forged.body.runId}`)).body.run;
    assert.deepEqual(forgedRun.startedBy, { kind: "human" });
    const forgedGate = Object.values(forgedRun.gates ?? {})[0]!;
    assert.equal(forgedGate.phase, "person", "no chat started it: the person decides");

    // A chat's run (its in-process principal) asks that chat.
    const res = await h.api.request("POST", `/api/workflows/${workflowId}/run`, { body: {}, principal: { kind: "agent", threadId: "lead", projectPath: "" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const runId = (res.body as RunWorkflowResponse).runId!;
    await h.waitEvent(gateOpened(runId), 60_000);
    const run = (await json<GetWorkflowRunResponse>("GET", `/api/workflow-runs/${runId}`)).body.run;
    assert.deepEqual(run.startedBy, { kind: "thread", sessionId: "lead" });
    const gate = Object.values(run.gates!)[0]!;
    assert.equal(gate.phase, "agent");
    assert.equal(gate.decider.sessionId, "lead");

    const listed = await json<ListWorkflowGatesResponse>("GET", "/api/workflow-gates");
    assert.ok(listed.body.gates.some((g) => g.gateId === gate.gateId && g.workflowName === "Gated" && g.projectPath === projectPath));
    const filtered = await json<ListWorkflowGatesResponse>("GET", `/api/workflow-gates?projectPath=${encodeURIComponent(join(dir.workspacesDir, "beta", "app"))}`);
    assert.equal(filtered.body.gates.length, 0);

    // The person may decide the forged run's gate through the route (no principal = the person).
    const personal = await json<DecideWorkflowGateResponse>("POST", `/api/workflow-runs/${forged.body.runId}/gates/${forgedGate.gateId}/decide`, { choice: "approve" });
    assert.equal(personal.status, 200, JSON.stringify(personal.body));
    assert.equal(personal.body.decision?.decidedBy.kind, "human");
    const again = await json<DecideWorkflowGateResponse>("POST", `/api/workflow-runs/${forged.body.runId}/gates/${forgedGate.gateId}/decide`, { choice: "reject" });
    assert.equal(again.body.alreadyDecided, true);
    const bad = await json<{ error: { code: string } }>("POST", `/api/workflow-runs/${runId}/gates/${gate.gateId}/decide`, { choice: 3 });
    assert.equal(bad.status, 400);
    const missing = await json<{ error: { code: string } }>("POST", `/api/workflow-runs/${runId}/gates/nope/decide`, { choice: "approve" });
    assert.equal(missing.body.error.code, "GATE_NOT_FOUND");

    // decide_workflow_gate through the MCP executor: another chat is refused (no card) …
    const intruder = await tool(chat("intruder"), "decide_workflow_gate", { runId, gateId: gate.gateId, choice: "approve", comment: "mine now" });
    assert.equal(intruder.isError, true);
    assert.equal(intruder.result.code, "GATE_NOT_DECIDER");
    assert.match(String(intruder.result.message), /^This chat is not assigned to decide this gate\./);
    assert.doesNotMatch(String(intruder.result.message), /Lead/, "never another chat's title");
    // … a planning launcher gets the planning refusal …
    const planning = await tool(chat("lead", { planning: true }), "decide_workflow_gate", { runId, gateId: gate.gateId, choice: "approve", comment: "ok" });
    assert.equal(planning.result.code, "PERMISSION_DENIED");
    assert.match(String(planning.result.message), /planning/);
    // … and the launcher decides from another project, workflow-owned and approval-required alike: no card.
    const own = await tool(
      chat("lead", { projectPath: join(dir.workspacesDir, "beta", "app"), workspace: "beta", cwd: join(dir.workspacesDir, "beta", "app"), workflowOwned: true }),
      "decide_workflow_gate",
      { runId, nodeName: "Approve", choice: "approve", comment: "tests pass" }
    );
    assert.equal(own.isError, false, JSON.stringify(own.result));
    assert.equal(own.result.decided, true);
    assert.match(String(own.result.next), /End your turn/);
    await h.waitEvent(runFinished(runId), 60_000);
    const ended = (await json<GetWorkflowRunResponse>("GET", `/api/workflow-runs/${runId}`)).body.run;
    assert.equal(ended.status, "succeeded");
    assert.equal(Object.values(ended.gates!)[0]!.decision?.decidedBy.kind, "launcher");
    assert.equal(turns.length, 1, "the launcher got one queued message");
    const repeat = await tool(chat("lead"), "decide_workflow_gate", { runId, gateId: gate.gateId, choice: "reject", comment: "changed my mind" });
    assert.equal(repeat.result.alreadyDecided, true);
  });

  test("list_workflow_gates and an external decide_workflow_gate decide as the person", async () => {
    const workflowId = await createGated("Listed");
    const run = await json<RunWorkflowResponse>("POST", `/api/workflows/${workflowId}/run`, {});
    const runId = run.body.runId!;
    await h.waitEvent(gateOpened(runId), 60_000);
    const listed = await tool({ kind: "external" }, "list_workflow_gates", { project: "acme/api" });
    const gates = (listed.result.gates as Record<string, unknown>[]).filter((g) => g.runId === runId);
    assert.equal(gates.length, 1);
    assert.equal(gates[0]!.question, "Ship it?");
    const decided = await tool({ kind: "external" }, "decide_workflow_gate", { runId, gateId: gates[0]!.gateId, choice: "reject" });
    assert.equal(decided.isError, false, JSON.stringify(decided.result));
    await h.waitEvent(runFinished(runId), 60_000);
    const ended = (await json<GetWorkflowRunResponse>("GET", `/api/workflow-runs/${runId}`)).body.run;
    assert.equal(Object.values(ended.gates!)[0]!.decision?.decidedBy.kind, "external");
    const runs = await tool({ kind: "external" }, "get_workflow_runs", { runId });
    const listedGates = runs.result.gates as { decision?: { choice: string } }[];
    assert.equal(listedGates[0]!.decision?.choice, "reject");
  });
});
