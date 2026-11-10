// Typed outcomes in the engine (spec 2026-11-10 §5, §7.5): `reportStepResult` finds the reporting
// pass from the calling chat and the pass's recorded sessions (never the session's owner),
// validates, persists before answering and lets a later call replace an earlier one; the outcome
// handle routes the walk and the other outcomes' edges die; a disabled agent with outcomes passes
// through on its first outcome; a pin picks its handle with `outcome`.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { NodeExecutionContext, NodeResult } from "./contracts.ts";
import { WorkflowEngineError } from "./run-context.ts";
import { controlledExecutor, edge, flush, node, workflow } from "./testing/fakes.ts";
import { createHarness, scripted } from "./testing/harness.ts";

const T = () => node("T", "trigger.manual");
const OUTCOMES = [{ id: "approved", label: "Approved" }, { id: "changes_requested" }];
const OUTPUTS = [{ name: "pr_url", type: "string" }, { name: "count", type: "number", required: false }];
const agent = (id: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  node(id, "agent", { prompt: { kind: "text", text: "Review." }, chain: [{ agent: "claude", model: "opus" }], ...config }, extra);

/** The graph Review →(approved) Ship, →(changes_requested) Fix. */
function reviewGraph(reviewConfig: Record<string, unknown> = { outcomes: OUTCOMES, outputs: OUTPUTS }, reviewExtra: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return workflow(
    "w1",
    [T(), agent("Review", reviewConfig, reviewExtra), node("Ship", "code"), node("Fix", "code")],
    [edge("T", "Review"), edge("Review", "Ship", "outcome:approved"), edge("Review", "Fix", "outcome:changes_requested")],
    extra
  );
}

/** Persist the agent block's WaitingOn the way the executor does once it has a session. */
async function holdSession(ctx: Pick<NodeExecutionContext, "setWaitingOn">, sessionId: string, knownSessionIds: string[] = [sessionId]): Promise<void> {
  await ctx.setWaitingOn({ kind: "agent", sessionId, commandId: "c1", command: "turn", baseline: null, deadlineAt: "2099-01-01T00:00:00.000Z", phase: "watching", state: { v: 1, knownSessionIds } });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await flush();
  assert.ok(check(), "condition never held");
}

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp | string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkflowEngineError, String(error));
    assert.equal(error.code, code);
    if (typeof message === "string") assert.equal(error.message, message);
    else if (message) assert.match(error.message, message);
    return true;
  });
}

describe("engine: report_step_result (spec 2026-11-10 §5.2)", () => {
  test("records on the running pass, refuses others, validates precisely, replaces until settle; the outcome routes the walk", async () => {
    const agents = controlledExecutor("agent");
    const code = scripted("code");
    const h = createHarness({ workflows: [reviewGraph()], executors: { agent: agents, code } });
    const { runId } = await h.engine.run("w1", {});
    await waitFor(() => agents.calls.length === 1);
    const call = agents.calls[0]!;

    // Before the block holds a session nobody can report.
    await rejects(h.engine.reportStepResult("s-1", { outcome: "approved", summary: "x", outputs: { pr_url: "u" } }), "NOT_A_WORKFLOW_STEP", "This chat is not a workflow step that reports a result.");
    // The pass's sessions: its current one and one an account failover left behind.
    await holdSession(call.ctx, "s-2", ["s-1", "s-2"]);
    await rejects(h.engine.reportStepResult("stranger", { outcome: "approved", summary: "x" }), "NOT_A_WORKFLOW_STEP");

    await rejects(
      h.engine.reportStepResult("s-2", { outcome: "lgtm", summary: "x", outputs: { count: "many" } }),
      "INVALID_REPORT",
      "The report was not recorded:\n- outcome \"lgtm\" is not one of this step's outcomes: use `approved` or `changes_requested`.\n- outputs.pr_url is required: a string.\n- outputs.count must be a number."
    );
    assert.equal(call.ctx.stepReport!(), undefined, "a refused call stores nothing");

    const first = await h.engine.reportStepResult("s-1", { outcome: "changes_requested", summary: "nits", outputs: { pr_url: "u1", count: "2" } });
    assert.equal(first.replaced, false);
    assert.equal(first.nodeName, "Review");
    assert.deepEqual(first.report.outputs, { pr_url: "u1", count: 2 }, "number text is coerced");
    // Persisted before the answer.
    const stored = (await h.runStore.load(runId!))!.blocks.Review!.report!;
    assert.equal(stored.outcome, "changes_requested");
    assert.equal(stored.sessionId, "s-1");

    const second = await h.engine.reportStepResult("s-2", { outcome: "approved", summary: "fixed", outputs: { pr_url: "u2" } });
    assert.equal(second.replaced, true);
    const report = call.ctx.stepReport!()!;
    assert.equal(report.outcome, "approved");

    call.resolve({ status: "succeeded", output: { text: "", outcome: report.outcome, summary: report.summary, outputs: report.outputs }, handle: `outcome:${report.outcome}` });
    await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.status, "succeeded");
    assert.equal(run.blocks.Review!.handle, "outcome:approved");
    assert.equal(run.blocks.Review!.report!.summary, "fixed");
    assert.deepEqual(code.seen, ["Ship"]);
    assert.equal(run.blocks.Fix!.status, "skipped", "the other outcome's edge is dead");
    assert.ok(run.takenEdges.includes("Review-outcome:approved-Ship"));
    assert.ok(run.deadEdges.includes("Review-outcome:changes_requested-Fix"));
    // A settled block takes no more reports.
    await rejects(h.engine.reportStepResult("s-2", { outcome: "approved", summary: "late" }), "NOT_A_WORKFLOW_STEP");
  });

  test("matches the pass's recorded sessions, not the session owner: a continue block reports through the chat it reuses", async () => {
    const agents = controlledExecutor("agent");
    const wf = workflow(
      "w1",
      [T(), agent("Write"), agent("Review", { outcomes: OUTCOMES, session: { kind: "continue", fromNode: "Write" } }), node("Ship", "code")],
      [edge("T", "Write"), edge("Write", "Review"), edge("Review", "Ship", "outcome:approved")]
    );
    const h = createHarness({ workflows: [wf], executors: { agent: agents, code: scripted("code") } });
    const { runId } = await h.engine.run("w1", {});
    await waitFor(() => agents.calls.length === 1);
    // Write does not declare outcomes: its chat is not a reporting step.
    await holdSession(agents.calls[0]!.ctx, "chat-1");
    await rejects(h.engine.reportStepResult("chat-1", { summary: "x" }), "NOT_A_WORKFLOW_STEP");
    agents.calls[0]!.resolve({ status: "succeeded", output: { text: "w", sessionId: "chat-1" } });
    await waitFor(() => agents.calls.length === 2);
    await holdSession(agents.calls[1]!.ctx, "chat-1");
    const recorded = await h.engine.reportStepResult("chat-1", { outcome: "approved", summary: "ok" });
    assert.equal(recorded.nodeId, "Review");
    agents.calls[1]!.resolve({ status: "succeeded", output: {}, handle: "outcome:approved" });
    await h.engine.waitForRun(runId!);
  });

  test("two running passes hold one session: the most recently started pass owns the report", async () => {
    const agents = controlledExecutor("agent");
    const gate = controlledExecutor("code");
    const wf = workflow(
      "w1",
      [T(), agent("A", { outcomes: OUTCOMES }), node("X", "code"), agent("B", { outcomes: OUTCOMES })],
      [edge("T", "A"), edge("T", "X"), edge("X", "B")]
    );
    const h = createHarness({ workflows: [wf], executors: { agent: agents, code: gate } });
    const { runId } = await h.engine.run("w1", {});
    await waitFor(() => agents.calls.length === 1 && gate.calls.length === 1);
    await holdSession(agents.calls[0]!.ctx, "shared");
    assert.equal((await h.engine.reportStepResult("shared", { outcome: "approved", summary: "a" })).nodeId, "A");
    await h.clock.advance(1_000);
    gate.calls[0]!.resolve({ status: "succeeded", output: null });
    await waitFor(() => agents.calls.length === 2);
    await holdSession(agents.calls[1]!.ctx, "shared");
    assert.equal((await h.engine.reportStepResult("shared", { outcome: "approved", summary: "b" })).nodeId, "B", "B started later");
    for (const call of agents.calls) call.resolve({ status: "succeeded", output: {}, handle: "outcome:approved" });
    await h.engine.waitForRun(runId!);
  });

  test("a new attempt reports afresh: a retried block's earlier report is cleared", async () => {
    let attempts = 0;
    const seen: (string | undefined)[] = [];
    const agentExec = {
      type: "agent" as const,
      async execute(ctx: NodeExecutionContext<"agent">): Promise<NodeResult> {
        attempts += 1;
        seen.push(ctx.stepReport!()?.outcome);
        await holdSession(ctx, `s-${attempts}`);
        if (attempts === 1) {
          await h.engine.reportStepResult("s-1", { outcome: "approved", summary: "x" });
          await ctx.setWaitingOn(undefined);
          return { status: "failed", error: { kind: "agent_error", message: "boom" } };
        }
        await ctx.setWaitingOn(undefined);
        return { status: "failed", error: { kind: "no_report", message: "none" } };
      }
    };
    const h = createHarness({ workflows: [reviewGraph({ outcomes: OUTCOMES }, { retry: { maxTries: 3, delaySeconds: 0 } })], executors: { agent: agentExec, code: scripted("code") } });
    const { runId } = await h.engine.run("w1", {});
    await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(seen, [undefined, undefined, undefined]);
    assert.equal(attempts, 3, "no_report is retried");
    assert.equal(run.blocks.Review!.error!.kind, "no_report");
    assert.equal(run.blocks.Review!.report, undefined);
  });
});

describe("engine: disabled and pinned agent blocks with outcomes (spec 2026-11-10 §7.5)", () => {
  test("a disabled agent with outcomes passes its input through on its first outcome", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [reviewGraph({ outcomes: OUTCOMES }, { disabled: true })], executors: { agent: scripted("agent"), code } });
    const { runId } = await h.engine.run("w1", { input: 7 });
    await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.Review!.handle, "outcome:approved");
    assert.deepEqual(run.blocks.Review!.output, { kind: "manual", input: 7 });
    assert.deepEqual(code.seen, ["Ship"]);
    assert.equal(run.blocks.Fix!.status, "skipped");
  });

  test("a pin with an outcome picks that handle, in a test run and as a seed of a run from a later block", async () => {
    const code = scripted("code");
    const agents = scripted("agent", { Review: () => ({ status: "succeeded", output: { ran: true }, handle: "outcome:approved" }) });
    const pinned = reviewGraph({ outcomes: OUTCOMES }, {}, { pinned: { Review: { outcome: "changes_requested", text: "pinned" } } });
    const h = createHarness({ workflows: [pinned], executors: { agent: agents, code } });
    const { runId } = await h.engine.run("w1", { test: true, usePinned: true });
    await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.Review!.pinned, true);
    assert.equal(run.blocks.Review!.handle, "outcome:changes_requested");
    assert.deepEqual(agents.seen, []);
    assert.deepEqual(code.seen, ["Fix"]);

    // "Run from here" seeds upstream from pins the same way.
    code.seen.length = 0;
    const from = await h.engine.run("w1", { fromNodeId: "Fix" });
    await h.engine.waitForRun(from.runId!);
    const fromRun = (await h.engine.getRun(from.runId!))!;
    assert.equal(fromRun.blocks.Review!.handle, "outcome:changes_requested");
    assert.deepEqual(code.seen, ["Fix"]);
  });
});
