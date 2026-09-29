import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  CreateWorkflowRequest,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowSecretsResponse,
  ListWorkflowsResponse,
  PatchWorkflowRequest,
  RunWorkflowRequest,
  RunWorkflowResponse,
  Workflow,
  WorkflowBlockRun,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowWriteResponse
} from "@orquester/api";

import {
  applyWorkflowsEvent,
  createWorkflow,
  deleteWorkflow,
  dismissWorkflowsNotice,
  loadWorkflowRun,
  loadWorkflowRuns,
  loadWorkflows,
  loadWorkflowSecrets,
  markWorkflowsStale,
  resetWorkflows,
  runWorkflowNow,
  setWorkflowEnabled,
  workflowSecretsKey,
  workflowRunLoadError,
  workflowsStore,
  withEnabledOverride,
  type WorkflowsApi
} from "./store.ts";
import { sanitizeWorkflowSummary } from "./sanitize.ts";

const T0 = "2026-09-28T10:00:00.000Z";

function summary(overrides: Partial<WorkflowSummary> & { id: string }): WorkflowSummary {
  return {
    name: `Workflow ${overrides.id}`,
    enabled: false,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/acme/app" },
    triggers: [],
    nodeCount: 1,
    errorCount: 0,
    activeRuns: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}

function run(overrides: Partial<WorkflowRunSummary> & { id: string; workflowId: string }): WorkflowRunSummary {
  return {
    workflowName: "",
    status: "running",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: T0,
    startedAt: T0,
    ...overrides
  };
}

function record(overrides: Partial<Workflow> & { id: string }): Workflow {
  return {
    name: `Workflow ${overrides.id}`,
    enabled: false,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/acme/app" },
    settings: {
      overlap: "skip",
      maxConcurrent: 2,
      timezone: "UTC",
      notify: { onFailure: true, onSuccess: false },
      keepFailedTempDays: 3
    },
    nodes: [{ id: "n1", name: "Manual", type: "trigger.manual", position: { x: 0, y: 0 }, config: {} }],
    edges: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  } as Workflow;
}

function block(overrides: Partial<WorkflowBlockRun> & { nodeId: string }): WorkflowBlockRun {
  return { name: overrides.nodeId, type: "shell", status: "running", attempt: 1, ...overrides };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A daemon error as the API client throws it. */
function apiError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), {
    status,
    code,
    serverMessage: message,
    body: { error: { code, message } }
  });
}

class FakeApi implements WorkflowsApi {
  connection = { id: "local" };
  list: WorkflowSummary[] = [];
  nextList: Deferred<ListWorkflowsResponse> | null = null;
  listCalls = 0;
  records = new Map<string, Workflow>();
  patches: { id: string; req: PatchWorkflowRequest }[] = [];
  patchErrors: unknown[] = [];
  runAnswer: RunWorkflowResponse = { runId: "r-new" };
  runs: { id: string; req?: RunWorkflowRequest }[] = [];
  runList: WorkflowRunSummary[] = [];
  runDetail: unknown = null;
  nextRunDetail: Deferred<GetWorkflowRunResponse> | null = null;
  deleteError: unknown = null;

  async listWorkflows(): Promise<ListWorkflowsResponse> {
    this.listCalls += 1;
    if (this.nextList) {
      const next = this.nextList;
      this.nextList = null;
      return next.promise;
    }
    return { workflows: this.list };
  }
  async getWorkflow(id: string): Promise<GetWorkflowResponse> {
    const found = this.records.get(id);
    if (!found) throw apiError(404, "WORKFLOW_NOT_FOUND", "gone");
    return { workflow: found, problems: [] };
  }
  async createWorkflow(req: CreateWorkflowRequest): Promise<WorkflowWriteResponse> {
    const created = record({ id: "w-new", name: req.name, project: req.project });
    this.records.set(created.id, created);
    return { workflow: created, problems: [] };
  }
  async patchWorkflow(id: string, req: PatchWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.patches.push({ id, req });
    const error = this.patchErrors.shift();
    if (error) throw error;
    const current = this.records.get(id) ?? record({ id });
    const op = req.ops[0];
    const next = record({
      ...current,
      id,
      revision: current.revision + 1,
      enabled: op && op.op === "set_enabled" ? op.enabled : current.enabled
    });
    this.records.set(id, next);
    return { workflow: next, problems: [] };
  }
  async duplicateWorkflow(id: string): Promise<WorkflowWriteResponse> {
    const copy = record({ id: `${id}-copy`, name: "Copy" });
    return { workflow: copy, problems: [] };
  }
  async deleteWorkflow(): Promise<void> {
    if (this.deleteError) throw this.deleteError;
  }
  async runWorkflow(id: string, req?: RunWorkflowRequest): Promise<RunWorkflowResponse> {
    this.runs.push({ id, req });
    return this.runAnswer;
  }
  async listWorkflowRuns(): Promise<ListWorkflowRunsResponse> {
    return { runs: this.runList, before: null };
  }
  async getWorkflowRun(): Promise<GetWorkflowRunResponse> {
    if (this.nextRunDetail) {
      const next = this.nextRunDetail;
      this.nextRunDetail = null;
      return next.promise;
    }
    return this.runDetail as GetWorkflowRunResponse;
  }
  async listWorkflowSecrets(): Promise<ListWorkflowSecretsResponse> {
    return {
      secrets: [
        { name: "TOKEN", scope: "global", updatedAt: T0, short: false },
        { name: "bad name?", scope: "nope", updatedAt: T0, short: false } as never
      ]
    };
  }
  async setWorkflowSecret(): Promise<void> {}
  async deleteWorkflowSecret(): Promise<void> {}
}

const event = (type: string, payload: unknown) => ({ type, payload });
const state = () => workflowsStore.getState();

beforeEach(() => resetWorkflows());

describe("sanitising", () => {
  it("drops a row with no id or name, and repairs the rest field by field", () => {
    assert.equal(sanitizeWorkflowSummary({ name: "x" }), null);
    assert.equal(sanitizeWorkflowSummary({ id: "a" }), null);
    const repaired = sanitizeWorkflowSummary({
      id: "a",
      name: "A",
      enabled: "yes",
      revision: -3,
      project: { kind: "mars" },
      triggers: [{ nodeId: "t", type: "trigger.schedule", text: "Every 15 min", nextRunAt: 7 }, { nodeId: "x" }],
      activeRuns: [run({ id: "r1", workflowId: "a" }), run({ id: "r2", workflowId: "other" }), { id: "r3" }]
    });
    assert.ok(repaired);
    assert.equal(repaired.enabled, false, "only `true` enables");
    assert.equal(repaired.revision, 0);
    assert.deepEqual(repaired.project, { kind: "existing", projectPath: "" }, "an unreadable project matches none");
    assert.deepEqual(repaired.triggers, [{ nodeId: "t", type: "trigger.schedule", text: "Every 15 min" }]);
    assert.deepEqual(
      repaired.activeRuns.map((r) => r.id),
      ["r1"],
      "another workflow's run and a malformed one never ride this row"
    );
  });
});

describe("sanitising a row's errors", () => {
  const base = { id: "a", name: "A" };
  const opus = { severity: "error", code: "unknown_model", message: 'NightlyTask: claude has no model "opus"', nodeId: "n1", field: "config.chain.0.model" };

  it("keeps the listed errors and what they leave out", () => {
    const row = sanitizeWorkflowSummary({ ...base, errorCount: 7, errors: [opus], errorsOmitted: 6 });
    assert.equal(row?.errorCount, 7);
    assert.deepEqual(row?.errors, [opus]);
    assert.equal(row?.errorsOmitted, 6);
  });

  it("an older daemon's row (the count alone) has no list", () => {
    const row = sanitizeWorkflowSummary({ ...base, errorCount: 1 });
    assert.equal(row?.errorCount, 1);
    assert.equal(row && "errors" in row, false);
    assert.equal(row && "errorsOmitted" in row, false);
  });

  it("repairs a malformed list entry by entry, and never counts fewer errors than it lists", () => {
    const row = sanitizeWorkflowSummary({
      ...base,
      errorCount: "two",
      errors: [
        opus,
        { severity: "error", message: "" },
        { severity: "fatal", code: "x", message: "m" },
        { severity: "warning", code: "w", message: "only a warning" },
        { severity: "error", code: 5, message: "Second", nodeId: 9, field: "" },
        "text",
        null
      ],
      errorsOmitted: -2
    });
    assert.equal(row?.errorCount, 2);
    assert.deepEqual(row?.errors, [opus, { severity: "error", code: "", message: "Second" }]);
    assert.equal(row && "errorsOmitted" in row, false);
    for (const errors of ["x", { 0: opus }, 42, null]) {
      const bad = sanitizeWorkflowSummary({ ...base, errorCount: 1, errors });
      assert.equal(bad && "errors" in bad, false);
      assert.equal(bad?.errorCount, 1);
    }
  });

  it("caps the list", () => {
    const row = sanitizeWorkflowSummary({ ...base, errorCount: 9, errors: Array.from({ length: 9 }, (_, i) => ({ ...opus, message: `m${i}` })) });
    assert.equal(row?.errors?.length, 5);
    assert.equal(row?.errorCount, 9);
  });
});

describe("the list load", () => {
  it("loads once, shares a request in flight, and refreshes when stale", async () => {
    const api = new FakeApi();
    api.list = [summary({ id: "a" }), summary({ id: "b" })];
    await Promise.all([loadWorkflows(api), loadWorkflows(api)]);
    assert.equal(api.listCalls, 1);
    assert.equal(state().load.status, "loaded");
    assert.deepEqual([...state().summaries.keys()].sort(), ["a", "b"]);
    await loadWorkflows(api);
    assert.equal(api.listCalls, 1, "a fresh list is not asked again");
    markWorkflowsStale();
    assert.equal(state().load.stale, true);
    api.list = [summary({ id: "a" })];
    await loadWorkflows(api);
    assert.equal(api.listCalls, 2);
    assert.deepEqual([...state().summaries.keys()], ["a"], "a row the daemon no longer lists goes");
  });

  it("a failure is the error state, and a refresh failure keeps the rows", async () => {
    const api = new FakeApi();
    api.listWorkflows = async () => { throw apiError(404, "", "no route"); };
    await loadWorkflows(api);
    assert.equal(state().load.status, "error");
    assert.ok(state().load.error);

    api.listWorkflows = async () => ({ workflows: [summary({ id: "a" })] });
    await loadWorkflows(api);
    api.listWorkflows = async () => { throw apiError(503, "UNAVAILABLE", "offline"); };
    await loadWorkflows(api, { force: true });
    assert.equal(state().load.status, "loaded");
    assert.equal(state().load.stale, true);
    assert.equal(state().load.error, "offline");
    assert.deepEqual([...state().summaries.keys()], ["a"]);
  });

  it("an event that crosses the answer is not undone by it", async () => {
    const api = new FakeApi();
    const answer = deferred<ListWorkflowsResponse>();
    api.nextList = answer;
    const loading = loadWorkflows(api);
    await settle();
    applyWorkflowsEvent(event("workflow.upserted", { workflow: summary({ id: "a", revision: 3, name: "New" }) }));
    applyWorkflowsEvent(event("workflow.deleted", { id: "b" }));
    answer.resolve({ workflows: [summary({ id: "a", revision: 2, name: "Old" }), summary({ id: "b" })] });
    await loading;
    assert.equal(state().summaries.get("a")?.name, "New", "the newer revision stands");
    assert.equal(state().summaries.has("b"), false, "a deleted id never comes back");
  });

  it("a client of another connection resets first", async () => {
    const api = new FakeApi();
    api.list = [summary({ id: "a" })];
    await loadWorkflows(api);
    const other = new FakeApi();
    other.connection = { id: "remote" };
    other.list = [summary({ id: "z" })];
    await loadWorkflows(other);
    assert.deepEqual([...state().summaries.keys()], ["z"]);
  });
});

describe("events", () => {
  it("ignores malformed payloads and unknown types without a throw", () => {
    for (const payload of [null, 7, "x", [], { workflow: null }, { id: 3 }]) {
      assert.doesNotThrow(() => {
        applyWorkflowsEvent(event("workflow.upserted", payload));
        applyWorkflowsEvent(event("workflow.deleted", payload));
        applyWorkflowsEvent(event("workflowRun.updated", payload));
        applyWorkflowsEvent(event("mystery", payload));
      });
    }
    assert.equal(state().summaries.size, 0);
  });

  it("upserts are idempotent and report what the tabs mirror", () => {
    const row = summary({ id: "a", name: "Nightly" });
    const effect = applyWorkflowsEvent(event("workflow.upserted", { workflow: row }));
    assert.equal(effect?.kind, "upserted");
    const first = state().summaries;
    applyWorkflowsEvent(event("workflow.upserted", { workflow: row }));
    assert.equal(state().summaries.get("a")?.name, "Nightly");
    assert.equal(state().summaries.size, first.size);
    assert.deepEqual(applyWorkflowsEvent(event("workflow.deleted", { id: "a" })), { kind: "deleted", id: "a" });
    applyWorkflowsEvent(event("workflow.upserted", { workflow: row }));
    assert.equal(state().summaries.has("a"), false, "a tombstoned id is never re-added");
  });

  it("a run's start, updates and end fold into its workflow's row", () => {
    applyWorkflowsEvent(event("workflow.upserted", { workflow: summary({ id: "a" }) }));
    const started = run({ id: "r1", workflowId: "a", status: "running" });
    applyWorkflowsEvent(event("workflowRun.started", { run: started }));
    assert.deepEqual(state().summaries.get("a")?.activeRuns.map((r) => r.id), ["r1"]);
    assert.equal(state().summaries.get("a")?.lastRun?.id, "r1");

    applyWorkflowsEvent(
      event("workflowRun.updated", {
        run: { ...started, current: { nodeId: "n2", name: "Review", index: 2, total: 5 } },
        blocks: [block({ nodeId: "n2", status: "running" }), { nodeId: "bad" }],
        takenEdges: ["e1"]
      })
    );
    const entry = state().runs.r1;
    assert.equal(entry?.blocks.n2?.status, "running");
    assert.equal(entry?.blocks.bad, undefined, "a malformed block is dropped");
    assert.deepEqual(entry?.takenEdges, ["e1"]);
    assert.equal(state().summaries.get("a")?.activeRuns[0]?.current?.index, 2);

    const finished = { ...started, status: "succeeded" as const, endedAt: T0, durationMs: 1000 };
    applyWorkflowsEvent(event("workflowRun.finished", { run: finished }));
    assert.deepEqual(state().summaries.get("a")?.activeRuns, []);
    assert.equal(state().summaries.get("a")?.lastRun?.status, "succeeded");

    // A late update of the ended run never reads it as running again.
    applyWorkflowsEvent(event("workflowRun.updated", { run: started, blocks: [] }));
    assert.equal(state().runs.r1?.summary.status, "succeeded");
    assert.deepEqual(state().summaries.get("a")?.activeRuns, []);
    // Nor does a stale row that still lists it active.
    applyWorkflowsEvent(event("workflow.upserted", { workflow: summary({ id: "a", activeRuns: [started] }) }));
    assert.deepEqual(state().summaries.get("a")?.activeRuns, []);
  });

  it("a secrets change marks the scopes it touches stale", async () => {
    const api = new FakeApi();
    await loadWorkflowSecrets(api, null);
    await loadWorkflowSecrets(api, "a");
    await loadWorkflowSecrets(api, "b");
    applyWorkflowsEvent(event("workflowSecrets.changed", { workflowId: "a" }));
    assert.equal(state().secrets[workflowSecretsKey("a")]?.stale, true);
    assert.equal(state().secrets[workflowSecretsKey("b")]?.stale, false);
    assert.equal(state().secrets[workflowSecretsKey(null)]?.stale, false);
    applyWorkflowsEvent(event("workflowSecrets.changed", { workflowId: null }));
    assert.equal(state().secrets[workflowSecretsKey("b")]?.stale, true, "a global secret is in every list");
    assert.deepEqual(
      state().secrets[workflowSecretsKey(null)]?.secrets.map((s) => s.name),
      ["TOKEN"],
      "a malformed name row is dropped"
    );
  });
});

describe("block progress events", () => {
  it("block updates accept a retry but ignore an earlier attempt or state", () => {
    const update = (status: WorkflowBlockRun["status"], attempt: number) => applyWorkflowsEvent(event("workflowRun.updated", {
      run: run({ id: "r", workflowId: "a" }),
      blocks: [block({ nodeId: "n", status, attempt })]
    }));
    update("succeeded", 1);
    update("running", 1);
    assert.equal(state().runs.r?.blocks.n?.status, "succeeded");
    update("running", 2);
    assert.equal(state().runs.r?.blocks.n?.status, "running");
    assert.equal(state().runs.r?.blocks.n?.attempt, 2);
    update("succeeded", 1);
    assert.equal(state().runs.r?.blocks.n?.status, "running");
    assert.equal(state().runs.r?.blocks.n?.attempt, 2);
  });
});

describe("runs", () => {
  it("a workflow's recent runs load newest first, and a started run joins them", async () => {
    const api = new FakeApi();
    api.runList = [
      run({ id: "old", workflowId: "a", status: "succeeded", startedAt: "2026-09-27T10:00:00.000Z" }),
      run({ id: "new", workflowId: "a", status: "failed", startedAt: "2026-09-28T09:00:00.000Z" }),
      run({ id: "foreign", workflowId: "b", status: "failed" })
    ];
    await loadWorkflowRuns(api, "a");
    assert.deepEqual(state().recentRuns.a?.runs.map((r) => r.id), ["new", "old"]);
    applyWorkflowsEvent(event("workflowRun.started", { run: run({ id: "live", workflowId: "a" }) }));
    assert.deepEqual(state().recentRuns.a?.runs.map((r) => r.id), ["live", "new", "old"]);
  });

  it("a loaded run keeps the deltas that landed while it was in flight", async () => {
    const api = new FakeApi();
    const answer = deferred<GetWorkflowRunResponse>();
    api.nextRunDetail = answer;
    const loading = loadWorkflowRun(api, "r1");
    await settle();
    applyWorkflowsEvent(
      event("workflowRun.updated", {
        run: run({ id: "r1", workflowId: "a" }),
        blocks: [block({ nodeId: "n1", status: "succeeded" })]
      })
    );
    answer.resolve({
      run: {
        ...run({ id: "r1", workflowId: "a" }),
        definition: record({ id: "a" }),
        triggerPayload: null,
        blocks: { n1: block({ nodeId: "n1", status: "running" }), n2: block({ nodeId: "n2", status: "pending" }) },
        takenEdges: [],
        deadEdges: []
      }
    });
    await loading;
    const entry = state().runs.r1;
    assert.ok(entry?.detail, "the whole run is held");
    assert.equal(entry.blocks.n1?.status, "succeeded", "the delta further along stands");
    assert.equal(entry.blocks.n2?.status, "pending");
  });

  it("a reconnect marks a held run stale; a forced reload clears it and takes the run's end", async () => {
    const api = new FakeApi();
    api.runDetail = {
      run: { ...run({ id: "r3", workflowId: "a" }), definition: record({ id: "a" }), triggerPayload: null, blocks: {}, takenEdges: [], deadEdges: [] }
    };
    await loadWorkflowRun(api, "r3");
    assert.equal(state().runs.r3?.summary.status, "running");
    markWorkflowsStale();
    assert.equal(state().runs.r3?.stale, true);
    api.runDetail = {
      run: {
        ...run({ id: "r3", workflowId: "a", status: "failed", endedAt: T0 }),
        definition: record({ id: "a" }),
        triggerPayload: null,
        blocks: {},
        takenEdges: [],
        deadEdges: []
      }
    };
    await loadWorkflowRun(api, "r3", { force: true });
    assert.equal(state().runs.r3?.stale, false);
    assert.equal(state().runs.r3?.summary.status, "failed");
  });

  it("a list refresh updates the summary of a run held whole", async () => {
    const api = new FakeApi();
    api.runDetail = {
      run: { ...run({ id: "r4", workflowId: "a" }), definition: record({ id: "a" }), triggerPayload: null, blocks: {}, takenEdges: [], deadEdges: [] }
    };
    await loadWorkflowRun(api, "r4");
    api.runList = [run({ id: "r4", workflowId: "a", status: "succeeded", endedAt: T0 })];
    await loadWorkflowRuns(api, "a", { force: true });
    assert.equal(state().runs.r4?.summary.status, "succeeded");
  });

  it("a run whose definition does not parse is an error, not a crash", async () => {
    const api = new FakeApi();
    api.runDetail = { run: {
      ...run({ id: "r2", workflowId: "a" }),
      definition: { nope: true },
      triggerPayload: null,
      blocks: {},
      takenEdges: [],
      deadEdges: []
    } };
    await assert.doesNotReject(loadWorkflowRun(api, "r2"));
    assert.equal(state().runs.r2, undefined);
    assert.ok(workflowRunLoadError("r2"));
  });
});

describe("mutations", () => {
  it("enabling shows at once, then carries the daemon's answer", async () => {
    const api = new FakeApi();
    api.list = [summary({ id: "a", revision: 4 })];
    api.records.set("a", record({ id: "a", revision: 4 }));
    await loadWorkflows(api);
    const pending = setWorkflowEnabled(api, "a", true);
    assert.equal(state().enabledOverrides.get("a"), true);
    const shown = withEnabledOverride(state().summaries.get("a")!, state().enabledOverrides);
    assert.equal(shown.enabled, true);
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(api.patches[0]?.req, { revision: 4, ops: [{ op: "set_enabled", enabled: true }] });
    assert.equal(state().enabledOverrides.size, 0);
    assert.equal(state().summaries.get("a")?.enabled, true);
    assert.equal(state().summaries.get("a")?.revision, 5);
  });

  it("a refusal rolls back and becomes the notice; a stale revision is re-read once", async () => {
    const api = new FakeApi();
    api.list = [summary({ id: "a", revision: 1, name: "Nightly" })];
    api.records.set("a", record({ id: "a", revision: 7, name: "Nightly" }));
    await loadWorkflows(api);
    api.patchErrors = [apiError(409, "REVISION_CONFLICT", "stale")];
    const retried = await setWorkflowEnabled(api, "a", true);
    assert.equal(retried.ok, true);
    assert.equal(api.patches[1]?.req.revision, 7, "the retry sends the revision it re-read");

    api.patchErrors = [apiError(400, "INVALID_WORKFLOW", "The workflow has 2 errors")];
    const refused = await setWorkflowEnabled(api, "a", false);
    assert.equal(refused.ok, false);
    assert.equal(state().enabledOverrides.size, 0, "rolled back");
    assert.equal(refused.ok ? null : refused.code, "INVALID_WORKFLOW");
    assert.equal(state().notice?.tone, "error");
    assert.equal(state().notice?.workflowId, "a");
    dismissWorkflowsNotice();
    assert.equal(state().notice, null);
  });

  it("an overlap skip offers Run anyway", async () => {
    const api = new FakeApi();
    api.list = [summary({ id: "a", name: "Nightly" })];
    await loadWorkflows(api);
    api.runAnswer = { runId: null, skipped: "overlap" };
    await runWorkflowNow(api, "a");
    assert.equal(state().notice?.action, "run-anyway");
    assert.equal(state().notice?.workflowId, "a");
    api.runAnswer = { runId: "r9" };
    await runWorkflowNow(api, "a", { force: true });
    assert.deepEqual(api.runs[1]?.req, { force: true });
  });

  it("create shows the row at once; delete removes it, and a gone workflow counts as deleted", async () => {
    const api = new FakeApi();
    const created = await createWorkflow(api, {
      name: "Fresh",
      project: { kind: "existing", projectPath: "/w/acme/app" },
      nodes: [{ type: "trigger.manual", config: {} }]
    });
    assert.equal(created.ok, true);
    const row = state().summaries.get("w-new");
    assert.equal(row?.name, "Fresh");
    api.deleteError = apiError(404, "WORKFLOW_NOT_FOUND", "gone");
    const deleted = await deleteWorkflow(api, "w-new");
    assert.equal(deleted.ok, true);
    assert.equal(state().summaries.has("w-new"), false);
  });

  it("a write's own row lists the errors its answer carries", async () => {
    const api = new FakeApi();
    api.createWorkflow = async (req: CreateWorkflowRequest): Promise<WorkflowWriteResponse> => {
      const created = record({ id: "w-new", name: req.name, project: req.project });
      return {
        workflow: created,
        problems: [
          { severity: "warning", code: "w", message: "a warning" },
          { severity: "error", code: "unknown_model", message: 'A: claude has no model "opus"', nodeId: "a", field: "config.chain.0.model" }
        ]
      };
    };
    await createWorkflow(api, { name: "Fresh", project: { kind: "existing", projectPath: "/w/acme/app" } });
    const row = state().summaries.get("w-new");
    assert.equal(row?.errorCount, 1);
    assert.deepEqual(row?.errors, [
      { severity: "error", code: "unknown_model", message: 'A: claude has no model "opus"', nodeId: "a", field: "config.chain.0.model" }
    ]);
    assert.equal(row && "errorsOmitted" in row, false);
  });

  it("a reset drops answers still in flight", async () => {
    const api = new FakeApi();
    const answer = deferred<ListWorkflowsResponse>();
    api.nextList = answer;
    const loading = loadWorkflows(api);
    await settle();
    resetWorkflows();
    answer.resolve({ workflows: [summary({ id: "a" })] });
    await loading;
    assert.equal(state().summaries.size, 0);
    assert.equal(state().load.status, "idle");
  });
});
