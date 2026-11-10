/**
 * The workflows store's gates (spec 2026-11-10 §6.4): what a loaded run, an
 * update, the cross-project list and a decision bring, merged so nothing goes
 * backwards; a run that ends settles its gates; the list drops what is no
 * longer waiting; a decision drops the badges at once; a reconnect, or a
 * count the client cannot cover, asks the list again. Plus the run fields
 * the gates add (`pendingGates`, `skipDetail`, a block's `gateId`).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  DecideWorkflowGateRequest,
  DecideWorkflowGateResponse,
  ListWorkflowGatesResponse,
  RunWorkflowResponse,
  WorkflowGateState,
  WorkflowRunSummary
} from "@orquester/api";

import { pendingGateFocus, requestGateFocus } from "./gate-focus.ts";
import { sanitizeBlockRun, sanitizeRunSummary, sanitizeWorkflowRun } from "./sanitize.ts";
import {
  applyWorkflowsEvent,
  decideWorkflowGate,
  loadWorkflowGates,
  loadWorkflowRun,
  markWorkflowsStale,
  resetWorkflows,
  runWorkflowNow,
  workflowsStore,
  type WorkflowsApi
} from "./store.ts";
import { node, workflow } from "./testing.ts";

const T0 = "2026-11-10T10:00:00.000Z";

function gate(overrides: Partial<WorkflowGateState> = {}): WorkflowGateState {
  return {
    gateId: "g1",
    runId: "r1",
    workflowId: "wf-1",
    nodeId: "Gate",
    nodeName: "Gate",
    source: "gate",
    question: "Deploy?",
    choices: [
      { id: "approve", label: "Approve", comment: "none" },
      { id: "reject", label: "Reject", comment: "optional" }
    ],
    decider: { kind: "human", label: "you" },
    phase: "person",
    openedAt: T0,
    escalated: false,
    ...overrides
  };
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: "r1",
    workflowId: "wf-1",
    workflowName: "Deploy",
    status: "running",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: T0,
    startedAt: T0,
    ...overrides
  };
}

const decided = (choice = "approve", label = "you"): WorkflowGateState["decision"] => ({
  choice,
  decidedBy: { kind: "human", label },
  decidedAt: T0
});

class GateApi implements WorkflowsApi {
  connection = { id: "local" };
  gateList: WorkflowGateState[] = [];
  nextGateList: { resolve: (value: ListWorkflowGatesResponse) => void } | null = null;
  gateListCalls = 0;
  decideAnswer: DecideWorkflowGateResponse | null = null;
  decideError: unknown = null;
  decides: { runId: string; gateId: string; req: DecideWorkflowGateRequest }[] = [];
  runDetail: unknown = null;
  runAnswer: RunWorkflowResponse = { runId: "r-new" };

  async listWorkflowGates(): Promise<ListWorkflowGatesResponse> {
    this.gateListCalls += 1;
    if (this.nextGateList === null) return { gates: this.gateList };
    return new Promise((resolve) => {
      this.nextGateList = { resolve };
    });
  }
  async decideWorkflowGate(runId: string, gateId: string, req: DecideWorkflowGateRequest): Promise<DecideWorkflowGateResponse> {
    this.decides.push({ runId, gateId, req });
    if (this.decideError) throw this.decideError;
    return this.decideAnswer!;
  }
  async getWorkflowRun() {
    return { run: this.runDetail } as never;
  }
  async runWorkflow(): Promise<RunWorkflowResponse> {
    return this.runAnswer;
  }
  listWorkflows = async () => ({ workflows: [] });
  getWorkflow = async () => {
    throw new Error("unused");
  };
  createWorkflow = async () => {
    throw new Error("unused");
  };
  patchWorkflow = async () => {
    throw new Error("unused");
  };
  duplicateWorkflow = async () => {
    throw new Error("unused");
  };
  deleteWorkflow = async () => undefined;
  listWorkflowRuns = async () => ({ runs: [], before: null });
  listWorkflowSecrets = async () => ({ secrets: [] });
  setWorkflowSecret = async () => undefined;
  deleteWorkflowSecret = async () => undefined;
}

const gates = () => workflowsStore.getState().gates;

function update(summary: Partial<WorkflowRunSummary>, payload: Record<string, unknown> = {}): void {
  applyWorkflowsEvent({ type: "workflowRun.updated", payload: { run: run(summary), blocks: [], ...payload } });
}

beforeEach(() => resetWorkflows());

describe("the run fields gates add", () => {
  it("reads the badge counts, parked and the skip reason; a block's gate; a run's gates and loop limits", () => {
    const summary = sanitizeRunSummary({ ...run(), pendingGates: 2.4, pendingPersonGates: -1, parked: true, skipDetail: "  previous run is waiting on gate “Deploy?”  " });
    assert.equal(summary?.pendingGates, 2);
    assert.equal(summary?.pendingPersonGates, undefined);
    assert.equal(summary?.parked, true);
    assert.equal(summary?.skipDetail, "previous run is waiting on gate “Deploy?”");
    assert.equal(sanitizeBlockRun({ nodeId: "Gate", status: "waiting", gateId: "g1" })?.gateId, "g1");
    // A reported agent block, as the daemon sends it: the report (and each earlier pass's) survives.
    const report = { outcome: "changes_requested", summary: "Add a test.", outputs: { files: 2 }, sessionId: "s1", reportedAt: "2026-11-10T10:00:00.000Z" };
    const reviewed = sanitizeBlockRun({
      nodeId: "Review",
      status: "succeeded",
      pass: 2,
      report: { ...report, outcome: "approved", summary: "Good now." },
      passes: [{ pass: 1, status: "succeeded", attempt: 1, report, gateId: "g0" }]
    });
    assert.deepEqual(reviewed?.report, { ...report, outcome: "approved", summary: "Good now." });
    assert.deepEqual(reviewed?.passes?.[0]?.report, report);
    assert.equal(reviewed?.passes?.[0]?.gateId, "g0");
    assert.equal(sanitizeBlockRun({ nodeId: "Review", status: "running", report: { outcome: "x" } })?.report, undefined, "no summary, no report");
    const whole = sanitizeWorkflowRun({
      ...run(),
      definition: workflow([node("T", "trigger.manual"), node("Gate", "gate")]),
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      gates: { g1: gate(), bad: { gateId: "bad" } },
      loopLimits: { "loop-1": 4, bad: "x" }
    });
    assert.deepEqual(Object.keys(whole?.gates ?? {}), ["g1"]);
    assert.deepEqual(whole?.loopLimits, { "loop-1": 4 });
  });
});

describe("gates from runs and updates", () => {
  it("an update brings its gates; an older state never undoes a newer one", () => {
    update({}, { gates: [gate({ phase: "agent", decider: { kind: "agent", label: "Reviewer" } })] });
    assert.equal(gates().r1?.g1?.phase, "agent");
    update({}, { gates: [gate({ escalated: true })] });
    assert.equal(gates().r1?.g1?.phase, "person");
    update({}, { gates: [gate({ phase: "agent" })] });
    assert.equal(gates().r1?.g1?.phase, "person");
    update({}, { gates: [gate({ decision: decided() })] });
    update({}, { gates: [gate()] });
    assert.equal(gates().r1?.g1?.decision?.choice, "approve");
  });

  it("a loaded run brings its gates; its summary does not carry them", async () => {
    const api = new GateApi();
    api.runDetail = {
      ...run({ pendingGates: 1, pendingPersonGates: 1 }),
      definition: workflow([node("T", "trigger.manual"), node("Gate", "gate")]),
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      gates: { g1: gate() }
    };
    await loadWorkflowRun(api, "r1");
    assert.equal(gates().r1?.g1?.question, "Deploy?");
    const entry = workflowsStore.getState().runs.r1;
    assert.equal(entry?.summary.pendingPersonGates, 1);
    assert.equal("gates" in (entry?.summary ?? {}), false);
  });

  it("a run that ends settles the gates it held", () => {
    update({}, { gates: [gate(), gate({ gateId: "g2", decision: decided() })] });
    applyWorkflowsEvent({ type: "workflowRun.finished", payload: { run: run({ status: "cancelled", endedAt: T0 }) } });
    assert.equal(gates().r1?.g1?.cancelled, true);
    assert.equal(gates().r1?.g2?.cancelled, undefined);
    assert.equal(gates().r1?.g2?.decision?.choice, "approve");
  });

  it("a deleted workflow takes its gates with it", () => {
    update({}, { gates: [gate()] });
    applyWorkflowsEvent({ type: "workflow.deleted", payload: { id: "wf-1" } });
    assert.equal(gates().r1, undefined);
    update({}, { gates: [gate()] });
    assert.equal(gates().r1, undefined);
  });

  it("a reset forgets them, and any gate asked to be selected", () => {
    update({}, { gates: [gate()] });
    requestGateFocus({ runId: "r1", gateId: "g1" });
    resetWorkflows();
    assert.deepEqual(gates(), {});
    assert.equal(pendingGateFocus("r1"), null);
  });
});

describe("the cross-project gate list", () => {
  it("loads once while fresh; a reconnect asks again", async () => {
    const api = new GateApi();
    api.gateList = [gate({ workflowName: "Deploy", projectPath: "/w/a/app" })];
    await loadWorkflowGates(api);
    await loadWorkflowGates(api);
    assert.equal(api.gateListCalls, 1);
    assert.equal(gates().r1?.g1?.workflowName, "Deploy");
    markWorkflowsStale();
    assert.equal(workflowsStore.getState().gatesLoad.stale, true);
    await loadWorkflowGates(api);
    assert.equal(api.gateListCalls, 2);
    assert.equal(workflowsStore.getState().gatesLoad.stale, false);
  });

  it("drops a held waiting gate it no longer lists (its held run reloads), keeps settled, test and touched ones", async () => {
    const api = new GateApi();
    api.runDetail = {
      ...run(),
      definition: workflow([node("T", "trigger.manual"), node("Gate", "gate")]),
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: [],
      gates: { g1: gate(), g2: gate({ gateId: "g2", decision: decided() }), g3: gate({ gateId: "g3", test: true }) }
    };
    await loadWorkflowRun(api, "r1");
    api.nextGateList = { resolve: () => undefined };
    const loading = loadWorkflowGates(api);
    await Promise.resolve();
    await Promise.resolve();
    // An update lands while the list is in flight: its gate stands.
    update({ id: "r9" }, { gates: [gate({ runId: "r9" })] });
    api.nextGateList!.resolve({ gates: [] });
    await loading;
    assert.equal(gates().r1?.g1, undefined);
    assert.equal(gates().r1?.g2?.decision?.choice, "approve");
    assert.equal(gates().r1?.g3?.test, true);
    assert.equal(gates().r9?.g1?.question, "Deploy?");
    assert.equal(workflowsStore.getState().runs.r1?.stale, true);
  });

  it("a daemon without the route: an error, quietly", async () => {
    const api = new GateApi();
    const without = Object.assign(Object.create(Object.getPrototypeOf(api)), api, { listWorkflowGates: undefined }) as WorkflowsApi;
    await loadWorkflowGates(without);
    assert.equal(workflowsStore.getState().gatesLoad.status, "error");
  });

  it("a top-level run that counts more gates waiting for the user than held asks the list again", async () => {
    const api = new GateApi();
    await loadWorkflowGates(api);
    update({ pendingGates: 1, pendingPersonGates: 1 });
    assert.equal(workflowsStore.getState().gatesLoad.stale, true);
    await loadWorkflowGates(api);
    // Held now (the update carried it): nothing to ask.
    update({ pendingGates: 1, pendingPersonGates: 1 }, { gates: [gate()] });
    assert.equal(workflowsStore.getState().gatesLoad.stale, false);
    // A child run's count is its parent's business.
    update({ id: "c1", parentRunId: "r1", pendingPersonGates: 3 });
    assert.equal(workflowsStore.getState().gatesLoad.stale, false);
  });
});

describe("deciding", () => {
  it("applies the answer at once and drops the badges", async () => {
    const api = new GateApi();
    update({ pendingGates: 1, pendingPersonGates: 1 }, { gates: [gate()] });
    api.decideAnswer = { alreadyDecided: false, decision: decided("reject"), gate: gate({ decision: { ...decided("reject")!, comment: "not yet" } }) };
    const result = await decideWorkflowGate(api, "r1", "g1", { choice: "reject", comment: "not yet" });
    assert.equal(result.ok, true);
    assert.deepEqual(api.decides, [{ runId: "r1", gateId: "g1", req: { choice: "reject", comment: "not yet" } }]);
    assert.equal(gates().r1?.g1?.decision?.comment, "not yet");
    const summary = workflowsStore.getState().runs.r1?.summary;
    assert.equal(summary?.pendingGates, undefined);
    assert.equal(summary?.pendingPersonGates, undefined);
  });

  it("already decided by someone else: the decision that stands, counted down once", async () => {
    const api = new GateApi();
    update({ pendingGates: 2, pendingPersonGates: 2 }, { gates: [gate()] });
    const first = { choice: "approve", decidedBy: { kind: "human" as const, label: "Ana" }, decidedAt: T0 };
    // The update that settled it landed before the answer.
    update({ pendingGates: 1, pendingPersonGates: 1 }, { gates: [gate({ decision: first })] });
    api.decideAnswer = { alreadyDecided: true, decision: first, gate: gate({ decision: first }) };
    const result = await decideWorkflowGate(api, "r1", "g1", { choice: "reject" });
    assert.equal(result.ok && result.value.alreadyDecided, true);
    assert.equal(workflowsStore.getState().runs.r1?.summary.pendingPersonGates, 1);
  });

  it("a refusal is returned, and a gate that is gone reloads its run", async () => {
    const api = new GateApi();
    let loads = 0;
    api.getWorkflowRun = async () => {
      loads += 1;
      throw Object.assign(new Error("gone"), { status: 404 });
    };
    api.decideError = Object.assign(new Error("No such gate"), { status: 404, code: "GATE_NOT_FOUND" });
    const result = await decideWorkflowGate(api, "r1", "g1", { choice: "approve" });
    assert.deepEqual(result, { ok: false, error: "No such gate", code: "GATE_NOT_FOUND" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, 1);
  });

  it("a daemon that cannot decide says so", async () => {
    const api = new GateApi();
    const without = Object.assign(Object.create(Object.getPrototypeOf(api)), api, { decideWorkflowGate: undefined }) as WorkflowsApi;
    const result = await decideWorkflowGate(without, "r1", "g1", { choice: "approve" });
    assert.equal(result.ok, false);
  });
});

describe("Run now held back by a gate", () => {
  it("says why a run was skipped or queued", async () => {
    const api = new GateApi();
    api.runAnswer = { runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Deploy?”" };
    await runWorkflowNow(api, "wf-1");
    assert.equal(workflowsStore.getState().notice?.text, "“the workflow” was skipped: previous run is waiting on gate “Deploy?”.");
    assert.equal(workflowsStore.getState().notice?.action, "run-anyway");
    api.runAnswer = { runId: "r2", skipDetail: "previous run is waiting on gate “Deploy?”" };
    await runWorkflowNow(api, "wf-1");
    assert.equal(workflowsStore.getState().notice?.text, "“the workflow” is queued: previous run is waiting on gate “Deploy?”.");
  });

  it("a quiet run (the Run now form) leaves an overlap skip to the form: no second Run anyway", async () => {
    const api = new GateApi();
    api.runAnswer = { runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Deploy?”" };
    const result = await runWorkflowNow(api, "wf-1", { input: { v: 1 } }, { quiet: true });
    assert.equal(result.ok && result.value.skipDetail, "previous run is waiting on gate “Deploy?”", "the form gets the why");
    assert.equal(workflowsStore.getState().notice, null);
  });
});
