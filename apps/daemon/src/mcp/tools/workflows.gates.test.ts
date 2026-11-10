/**
 * The gate tools and run_workflow's launcher return (spec 2026-11-10 §6.3, §8), through THE executor:
 * `run_workflow {wait: true}` returns at once when a gate of its run tree (a sub-workflow's too) asks
 * the calling chat; `decide_workflow_gate` resolves a gate by block name, maps each answer to a
 * compact next step, and is Act with no card; `list_workflow_gates` keeps a chat to its project plus
 * the gates assigned to it. The route's own authorization is in `workflows/e2e-gates.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workflow, WorkflowGateState, WorkflowRun } from "@orquester/api";

import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { executeToolCall } from "../executor.ts";
import { busEvent, FakeDaemonApi, serveWorkflowReferences } from "../testing.ts";

type Result = Record<string, unknown>;
const stamp = "2026-11-10T12:00:00.000Z";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-gates-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const project of ["acme/api", "beta/app"]) await mkdir(join(root, project), { recursive: true });
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = root;
  api.on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: join(root, "acme"), projectCount: 1 }, { name: "beta", path: join(root, "beta"), projectCount: 1 }] });
  serveWorkflowReferences(api, () => []);
  return { api, own: join(root, "acme", "api"), other: join(root, "beta", "app") };
}

function definition(projectPath: string): Workflow {
  return {
    id: "wf-1", name: "Deploy", revision: 3, enabled: false,
    project: { kind: "existing", projectPath },
    settings: { overlap: "skip", maxConcurrent: 2, timezone: "UTC", notify: { onFailure: true, onSuccess: false }, keepFailedTempDays: 3 },
    nodes: [
      { id: "t", name: "Start", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} },
      { id: "g", name: "Approve", type: "gate", position: { x: 0, y: 0 }, config: { question: "Ship?", choices: [{ id: "approve", label: "Approve", comment: "none" }, { id: "reject", label: "Reject", comment: "optional" }], decider: { kind: "launcher", maxMinutes: 60 } } }
    ],
    edges: [{ id: "tg", source: "t", sourceHandle: "success", target: "g" }],
    createdAt: stamp, updatedAt: stamp
  } as Workflow;
}

function gate(over: Partial<WorkflowGateState> = {}): WorkflowGateState {
  return {
    gateId: "gate-1", runId: "run-1", workflowId: "wf-1", nodeId: "g", nodeName: "Approve", source: "gate", question: "Ship?",
    choices: [{ id: "approve", label: "Approve", comment: "none" }, { id: "reject", label: "Reject", comment: "optional" }],
    decider: { kind: "launcher", label: "the launching chat", sessionId: "me" }, phase: "agent", openedAt: stamp,
    phaseStartedAt: stamp, phaseDeadlineAt: "2026-11-10T13:00:00.000Z", escalated: false, ...over
  };
}

function runRecord(workflow: Workflow, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1", workflowId: "wf-1", workflowName: "Deploy", status: "running", trigger: { kind: "manual" }, test: false,
    queuedAt: stamp, definition: workflow, triggerPayload: { kind: "manual", input: null }, takenEdges: [], deadEdges: [],
    blocks: { t: { nodeId: "t", name: "Start", type: "trigger.manual", status: "succeeded", attempt: 1 }, g: { nodeId: "g", name: "Approve", type: "gate", status: "waiting", attempt: 1, gateId: "gate-1" } },
    ...over
  };
}

function chat(projectPath: string, over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Lead", projectPath, workspace: "acme", cwd: projectPath, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, who: ThreadCaller | { kind: "external" } = { kind: "external" }, port: FakeApprovalPort | null = null): Promise<{ isError: boolean; result: Result }> {
  const answer = await executeToolCall({ approvals: port, now: () => Date.parse(stamp) + 5 * 60_000 }, { name, arguments: args }, { caller: who, api, signal: new AbortController().signal });
  return { isError: answer.isError === true, result: answer.structuredContent as Result };
}

test("run_workflow {wait} returns at once when a gate of its run (or a child's) asks the calling chat", async (t) => {
  const { api, own } = await sandbox(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workflow = definition(own);
  api.on("GET", "/api/workflows/wf-1", { status: 200, body: { workflow, problems: [] } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: "run-1" } });
  // The run's first read is the signal: the tap listens from before the start, so events after it count.
  let firstRead!: () => void;
  const read = new Promise<void>((resolve) => (firstRead = resolve));
  api.on("GET", "/api/workflow-runs/run-1", () => {
    firstRead();
    return { status: 200, body: { run: runRecord(workflow) } };
  });
  const port = new FakeApprovalPort();
  const pending = call(api, "run_workflow", { workflowId: "wf-1", revision: 3, wait: true }, chat(own), port);
  await read;
  await tick();
  // Another chat's launcher gate does not end this wait; this chat's child-run gate does.
  api.emit(busEvent("workflowRun.updated", { run: { id: "run-9", status: "running" }, blocks: [], gates: [gate({ runId: "run-9", gateId: "x", decider: { kind: "launcher", label: "other", sessionId: "other" } })] }, "workflows"));
  await tick();
  api.emit(busEvent("workflowRun.updated", { run: { id: "child-1", status: "running" }, blocks: [], gates: [gate({ runId: "child-1", rootRunId: "run-1" })] }, "workflows"));
  const { isError, result } = await pending;
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.finished, false);
  const waiting = result.waitingOnGate as Result;
  assert.equal(waiting.runId, "child-1");
  assert.equal(waiting.gateId, "gate-1");
  assert.match(String(result.next), /YOUR decision: decide_workflow_gate \{"runId": "child-1", "gateId": "gate-1", "choice": "<id>", "comment": "<why>"\}/);
  assert.equal(api.listenerCount(), 0);
});

test("run_workflow: a skip names the gate that holds it back", async (t) => {
  const { api, own } = await sandbox(t);
  const workflow = definition(own);
  api.on("GET", "/api/workflows/wf-1", { status: 200, body: { workflow, problems: [] } });
  api.on("POST", "/api/workflows/wf-1/run", { status: 200, body: { runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Ship?”" } });
  const { result } = await call(api, "run_workflow", { workflowId: "wf-1", revision: 3 });
  assert.equal(result.skipDetail, "previous run is waiting on gate “Ship?”");
  assert.match(String(result.message), /waiting on gate “Ship\?”/);
});

test("decide_workflow_gate: a block name finds its waiting gate; decided, escalated and already-decided answers say what next", async (t) => {
  const { api, own, other } = await sandbox(t);
  const workflow = definition(own);
  const older = gate({ gateId: "gate-0", openedAt: "2026-11-10T10:00:00.000Z", decision: { choice: "reject", decidedBy: { kind: "human", label: "you" }, decidedAt: stamp } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(workflow, { gates: { "gate-0": older, "gate-1": gate() } }) } });
  const posts: { path: string; body: unknown }[] = [];
  api.on("POST", "/api/workflow-runs/run-1/gates/gate-1/decide", ({ body, path }) => {
    posts.push({ path, body });
    const request = body as { choice?: string; escalate?: boolean; comment?: string };
    if (request.escalate) return { status: 200, body: { alreadyDecided: false, gate: gate({ phase: "person", escalated: true }) } };
    return { status: 200, body: { alreadyDecided: false, decision: { choice: request.choice, comment: request.comment, decidedBy: { kind: "launcher", label: "the launching chat", sessionId: "me" }, decidedAt: stamp }, gate: gate() } };
  });
  // A launcher in ANOTHER project, approval-required: Act, no card (the port would fail the test).
  const caller = chat(other, { workspace: "beta", cwd: other, runtimeMode: "approval-required" });
  const decided = await call(api, "decide_workflow_gate", { runId: "run-1", nodeName: "Approve", choice: "approve", comment: "ok" }, caller, null);
  assert.equal(decided.isError, false, JSON.stringify(decided.result));
  assert.deepEqual(posts[0], { path: "/api/workflow-runs/run-1/gates/gate-1/decide", body: { choice: "approve", comment: "ok" } });
  assert.equal(decided.result.decided, true);
  assert.match(String(decided.result.next), /Recorded: "Approve"\. The run continues on that choice\. End your turn now\./);
  const escalated = await call(api, "decide_workflow_gate", { runId: "run-1", gateId: "gate-1", escalate: true, comment: "unsure" }, caller, null);
  assert.equal(escalated.result.escalated, true);
  assert.deepEqual(posts[1]!.body, { comment: "unsure", escalate: true });

  api.on("POST", "/api/workflow-runs/run-1/gates/gate-1/decide", { status: 200, body: { alreadyDecided: true, decision: { choice: "reject", comment: "no", decidedBy: { kind: "human", label: "you" }, decidedAt: stamp }, gate: gate() } });
  const already = await call(api, "decide_workflow_gate", { runId: "run-1", gateId: "gate-1", choice: "approve", comment: "x" });
  assert.equal(already.result.alreadyDecided, true);
  assert.equal(already.result.decidedBy, "you");
  assert.match(String(already.result.next), /Nothing changed: "Reject" by you stands\. get_workflow_runs/);

  const refused = await call(api, "decide_workflow_gate", { runId: "run-1", choice: "approve" });
  assert.equal(refused.result.code, "INVALID_ARGUMENT");
  const both = await call(api, "decide_workflow_gate", { runId: "run-1", gateId: "gate-1", choice: "approve", escalate: true, comment: "x" });
  assert.equal(both.result.code, "INVALID_ARGUMENT");
  const none = await call(api, "decide_workflow_gate", { runId: "run-1", nodeName: "Nope", choice: "approve" });
  assert.equal(none.result.code, "GATE_NOT_FOUND");
  api.on("POST", "/api/workflow-runs/run-1/gates/gate-1/decide", { status: 403, body: { error: { code: "GATE_NOT_DECIDER", message: "Only the person may decide this gate." } } });
  const intruder = await call(api, "decide_workflow_gate", { runId: "run-1", gateId: "gate-1", choice: "approve", comment: "x" }, caller, null);
  assert.equal(intruder.result.code, "GATE_NOT_DECIDER");
  assert.match(String(intruder.result.message), /Do not retry/);
  // A planning turn is refused before anything is sent.
  const sent = posts.length;
  const planning = await call(api, "decide_workflow_gate", { runId: "run-1", gateId: "gate-1", choice: "approve", comment: "x" }, chat(own, { planning: true }), null);
  assert.equal(planning.result.code, "PERMISSION_DENIED");
  assert.equal(posts.length, sent);
});

test("decide_workflow_gate by nodeName from a chat finds only a gate assigned to it: any other answer is one refusal, nothing sent", async (t) => {
  const { api, own, other } = await sandbox(t);
  const workflow = definition(own);
  const theirs = gate({ decider: { kind: "launcher", label: "the launching chat “Secret plans”", sessionId: "someone-else" } });
  api.on("GET", "/api/workflow-runs/run-1", { status: 200, body: { run: runRecord(workflow, { gates: { "gate-1": theirs } }) } });
  api.on("GET", "/api/workflow-runs/run-404", { status: 404, body: { error: { code: "RUN_NOT_FOUND", message: "No run with id \"run-404\"." } } });
  let posts = 0;
  api.on("POST", "/api/workflow-runs/run-1/gates/gate-1/decide", () => {
    posts += 1;
    return { status: 500, body: {} };
  });
  const prober = chat(other, { threadId: "prober", workspace: "beta", cwd: other, runtimeMode: "approval-required" });
  const answers = [
    await call(api, "decide_workflow_gate", { runId: "run-1", nodeName: "Approve", choice: "approve", comment: "x" }, prober, null),
    await call(api, "decide_workflow_gate", { runId: "run-1", nodeName: "Nope", choice: "approve", comment: "x" }, prober, null),
    await call(api, "decide_workflow_gate", { runId: "run-404", nodeName: "Approve", choice: "approve", comment: "x" }, prober, null)
  ];
  for (const answer of answers) {
    assert.equal(answer.isError, true);
    assert.equal(answer.result.code, "GATE_NOT_DECIDER");
    assert.doesNotMatch(String(answer.result.message), /Secret plans|Approve|run-404/);
  }
  assert.equal(new Set(answers.map((answer) => answer.result.message)).size, 1, "the same refusal whether the run or gate exists or not");
  assert.equal(posts, 0, "nothing is sent");
});

test("list_workflow_gates: a chat sees its project's gates plus the ones assigned to it; external callers every project's", async (t) => {
  const { api, own, other } = await sandbox(t);
  const mine = gate({ gateId: "mine", runId: "run-2", projectPath: other, workflowName: "Elsewhere" });
  const local = gate({ gateId: "local", decider: { kind: "human", label: "you" }, phase: "person", projectPath: own, workflowName: "Deploy" });
  const foreign = gate({ gateId: "foreign", runId: "run-3", decider: { kind: "human", label: "you" }, phase: "person", projectPath: other });
  api.on("GET", "/api/workflow-gates", ({ query }) => ({ status: 200, body: { gates: query?.projectPath === own ? [local] : query?.projectPath === other ? [foreign, mine] : [local, foreign, mine] } }));
  const chatList = await call(api, "list_workflow_gates", {}, chat(own));
  const ids = (chatList.result.gates as Result[]).map((row) => row.gateId);
  assert.deepEqual(ids, ["local", "mine"]);
  const yours = (chatList.result.gates as Result[]).find((row) => row.gateId === "mine")!;
  assert.equal(yours.yours, true);
  assert.match(String(yours.call), /decide_workflow_gate \{"runId": "run-2", "gateId": "mine"/);
  assert.equal((chatList.result.gates as Result[])[0]!.waitingFor, "5 min");
  const external = await call(api, "list_workflow_gates", {});
  assert.deepEqual((external.result.gates as Result[]).map((row) => row.gateId), ["local", "foreign", "mine"]);
  const projectOnly = await call(api, "list_workflow_gates", { project: "beta/app", includeDecided: true });
  assert.deepEqual((projectOnly.result.gates as Result[]).map((row) => row.gateId), ["foreign", "mine"]);
  assert.ok(api.calls.some((c) => c.path === "/api/workflow-gates" && c.query?.includeDecided === "1"));
});
