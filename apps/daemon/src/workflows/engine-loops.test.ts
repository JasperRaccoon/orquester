import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isGateWaiting, type Workflow, type WorkflowGateState, type WorkflowRun } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeExecutorRegistry, NodeResult, WaitingOn, WorkflowNotifier } from "./contracts.ts";
import {
  controlledExecutor,
  edge,
  FakeProjects,
  FakeSandbox,
  flush,
  InMemoryRunStore,
  InMemorySecretStore,
  InMemoryWorkflowStore,
  ManualClock,
  node,
  sequentialIds,
  workflow
} from "./testing/fakes.ts";
import { createHarness, scripted, type Harness } from "./testing/harness.ts";
import { loopTemplate, previousSessionId } from "./agent/loop-turn.ts";
import { createGateExecutor } from "./nodes/gate.ts";

const T = (id = "T") => node(id, "trigger.manual");
const CHAIN = [{ agent: "claude", model: "default" }];
const agentNode = (id: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  node(id, "agent", { prompt: { kind: "text", text: `Do ${id}` }, chain: CHAIN, ...config }, extra);
const reviewer = (id = "Rev") => agentNode(id, { outcomes: [{ id: "approved" }, { id: "changes" }] });

function loopEdge(source: string, target: string, handle: string, maxLoops = 2, session: "continue" | "new" = "continue", id = `${source}-loop-${target}`) {
  return { ...edge(source, target, handle, id), loop: { maxLoops, session } };
}

const USER = { kind: "user" } as const;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** A notifier collecting the gate pushes. */
const pushing = (pushed: WorkflowGateState[]): WorkflowNotifier => ({ runFinished: () => undefined, gateWaiting: (gate) => pushed.push(structuredClone(gate)) });

/** The one waiting loop-limit gate of a run. */
async function limitGate(h: Harness, runId: string): Promise<WorkflowGateState> {
  const run = await h.engine.getRun(runId);
  const waiting = Object.values(run?.gates ?? {}).filter((gate) => gate.source === "loop_limit" && isGateWaiting(gate));
  assert.equal(waiting.length, 1, `one waiting loop-limit gate: ${JSON.stringify(run?.gates)}`);
  return waiting[0]!;
}

async function runToEnd(h: Harness, workflowId: string, request: Parameters<Harness["engine"]["run"]>[1] = {}) {
  const response = await h.engine.run(workflowId, request);
  assert.ok(response.runId, "the run started");
  const result = await h.engine.waitForRun(response.runId);
  const run = (await h.engine.getRun(response.runId))!;
  return { runId: response.runId, result, run };
}

/** A reviewer whose n-th pass (1-based) answers `outcomes[n - 1]` (the last one after that), with a summary. */
function reviewing(name: string, outcomes: string[]) {
  let calls = 0;
  return (ctx: NodeExecutionContext<"agent">): NodeResult => {
    calls += 1;
    const outcome = outcomes[Math.min(calls, outcomes.length) - 1]!;
    return { status: "succeeded", output: { text: `${name} #${calls}`, sessionId: `s-${name}-${calls}`, outcome, summary: `${name} says ${outcome} (${calls})`, pass: ctx.expressionContext().loop?.pass }, handle: `outcome:${outcome}` };
  };
}

/** Fix → Rev; Rev.changes ↺ Fix; Rev.approved → Done. */
function fixReview(maxLoops = 3, extra: { revRetry?: number; errorEdge?: boolean } = {}): Workflow {
  return workflow(
    "w1",
    [
      T(),
      agentNode("Fix"),
      { ...reviewer(), ...(extra.revRetry ? { retry: { maxTries: extra.revRetry, delaySeconds: 0 } } : {}) },
      node("Done", "code"),
      ...(extra.errorEdge ? [node("Handle", "code")] : [])
    ],
    [
      edge("T", "Fix"),
      edge("Fix", "Rev"),
      edge("Rev", "Done", "outcome:approved"),
      loopEdge("Rev", "Fix", "outcome:changes", maxLoops),
      ...(extra.errorEdge ? [edge("Rev", "Handle", "error")] : [])
    ]
  );
}

describe("engine: loop edges (spec 2026-11-10 §7.2)", () => {
  test("under its limit a loop edge runs its reset set again as new passes; the latest pass is what reads", async () => {
    const seen: { pass?: number; feedback?: string; reviewLatest?: unknown; attempt: number }[] = [];
    const agent = scripted("agent", {
      Fix: (ctx) => {
        const context = ctx.expressionContext();
        seen.push({ pass: context.loop?.pass, feedback: context.loop?.feedback, reviewLatest: context.nodes.Rev?.output, attempt: context.run.attempt });
        return { status: "succeeded", output: { text: `fixed ${seen.length}`, sessionId: `fix-${seen.length}` } };
      },
      Rev: reviewing("Rev", ["changes", "changes", "approved"])
    });
    let doneRead: unknown;
    const code = scripted("code", {
      Done: (ctx) => {
        doneRead = ctx.expressionContext().nodes.Fix?.output;
        return { status: "succeeded", output: "done" };
      }
    });
    const h = createHarness({ workflows: [fixReview(3)], executors: { agent, code } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded");
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev", "Fix", "Rev"]);
    assert.deepEqual(code.seen, ["Done"], "the approved branch runs once");
    assert.deepEqual(seen.map((entry) => entry.pass), [1, 2, 3]);
    assert.deepEqual(seen.map((entry) => entry.feedback), [undefined, "Rev says changes (1)", "Rev says changes (2)"]);
    assert.deepEqual(seen.map((entry) => entry.attempt), [1, 1, 1], "run.attempt counts within the pass");
    assert.equal(seen[0]!.reviewLatest, undefined, "nothing to read before the first review");
    assert.equal((seen[1]!.reviewLatest as { summary: string }).summary, "Rev says changes (1)", "nodes.Rev reads its latest finished pass");
    assert.deepEqual(doneRead, { text: "fixed 3", sessionId: "fix-3" }, "nodes.Fix.output is the latest pass");
    assert.deepEqual(run.loopCounters, { "Rev-loop-Fix": 2 });

    const fix = run.blocks.Fix!;
    assert.equal(fix.pass, 3);
    assert.equal(fix.loopFeedback, "Rev says changes (2)");
    assert.deepEqual(fix.passes!.map((pass) => [pass.pass, pass.status, (pass.output as { text: string }).text, pass.loopFeedback ?? null]), [
      [1, "succeeded", "fixed 1", null],
      [2, "succeeded", "fixed 2", "Rev says changes (1)"]
    ]);
    assert.equal(run.blocks.Rev!.pass, 3);
    assert.deepEqual(run.blocks.Rev!.passes!.map((pass) => pass.handle), ["outcome:changes", "outcome:changes"]);
    assert.equal(run.blocks.T!.pass, undefined, "the trigger is never in a reset set");
    assert.equal(run.blocks.Done!.pass, undefined, "Done never ran before the last pass: it has no earlier one");
    // Nothing internal crosses the wire.
    for (const block of Object.values(run.blocks)) {
      assert.equal("passAttemptBase" in block, false);
      assert.equal("loopEdgeId" in block, false);
    }
    // The run's events say what the loop did.
    const events = h.runStore.events.get(run.id)!.filter((event) => String(event.type).startsWith("loop."));
    assert.deepEqual(events.map((event) => [event.type, event.count]), [["loop.taken", 1], ["loop.taken", 2]]);
    // The run's updates carried the counters.
    const updates = h.eventsOf("workflowRun.updated").filter((payload) => payload.loopCounters !== undefined);
    assert.deepEqual(updates.at(-1)!.loopCounters, { "Rev-loop-Fix": 2 });
  });

  test("a block that ran in an earlier pass but is skipped in the latest reads as skipped, with no output (live and after a restart)", async () => {
    // T → C; C.true → X, C.false → Y; X, Y → M (first) → L; L.false ↺ C. Pass 1 runs X, pass 2 runs Y.
    const wf = workflow(
      "w1",
      [T(), node("C", "if"), node("X", "code"), node("Y", "code"), node("M", "merge", { mode: "first" }), node("L", "if"), node("Done", "code")],
      [edge("T", "C"), edge("C", "X", "true"), edge("C", "Y", "false"), edge("X", "M"), edge("Y", "M"), edge("M", "L"), loopEdge("L", "C", "false", 2), edge("L", "Done", "true")]
    );
    const env = restartable([wf]);
    const branch = () => scripted("if", { C: (ctx) => ({ status: "succeeded", output: null, handle: (ctx.expressionContext().loop?.pass ?? 1) === 1 ? "true" : "false" }) });
    const lastCheck = controlledExecutor("if");
    const first = env.boot({ if: { type: "if", execute: (ctx) => (ctx.node.name === "L" ? lastCheck.execute(ctx) : branch().execute(ctx)) }, code: scripted("code", { X: () => ({ status: "succeeded", output: "x pass 1" }) }) });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    assert.equal((lastCheck.calls[0]!.ctx.expressionContext().nodes.X as { output: unknown }).output, "x pass 1");
    lastCheck.calls[0]!.resolve({ status: "succeeded", output: null, handle: "false" });
    await flush();
    assert.equal(lastCheck.calls.length, 2, "pass 2 reached L");
    const live = lastCheck.calls[1]!.ctx.expressionContext().nodes.X as { output?: unknown; status: string };
    assert.deepEqual([live.status, live.output], ["skipped", undefined], "skipped in pass 2: no earlier pass's output");
    assert.deepEqual(await first.engine.nodeOutput(runId!, "X"), { found: true });
    await first.engine.stop();

    let read: unknown = "unread";
    const second = env.boot({
      if: scripted("if", {
        L: (ctx) => {
          read = ctx.expressionContext().nodes.X;
          return { status: "succeeded", output: null, handle: "true" };
        }
      }),
      code: scripted("code")
    });
    await second.engine.resume();
    assert.equal((await second.engine.waitForRun(runId!)).status, "succeeded");
    assert.deepEqual([(read as { status?: string }).status, (read as { output?: unknown }).output], ["skipped", undefined], "after a restart too");
    assert.deepEqual(await second.engine.nodeOutput(runId!, "X"), { found: true });
  });

  test("taken at its limit, the source waits on a person gate; Stop fails the pass with loop_limit: not retried, the run fails without an error edge", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const pushed: WorkflowGateState[] = [];
    const h = createHarness({ workflows: [fixReview(1, { revRetry: 3 })], executors: { agent }, notifier: pushing(pushed) });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev"], "one loop, then the limit");
    const gate = await limitGate(h, runId!);
    assert.equal(gate.question, "Rev → Fix reached its limit (1).");
    assert.equal(gate.source, "loop_limit");
    assert.equal(gate.edgeId, "Rev-loop-Fix");
    assert.equal(gate.nodeId, "Rev");
    assert.equal(gate.pass, 2);
    assert.deepEqual(gate.decider, { kind: "human", label: "you" });
    assert.equal(gate.phase, "person");
    assert.deepEqual(gate.choices.map((choice) => [choice.id, choice.label, choice.color]), [["allow", "Allow one more loop", "primary"], ["stop", "Stop", "danger"]]);
    assert.equal(pushed.length, 1, "the person is pushed");
    assert.equal(pushed[0]!.gateId, gate.gateId);
    const waiting = (await h.runStore.load(runId!))!;
    const rev = waiting.blocks.Rev!;
    assert.equal(rev.status, "waiting");
    assert.equal(rev.gateId, gate.gateId, "the block names the gate it waits on");
    assert.deepEqual(rev.waitingOn?.kind === "gate" && rev.waitingOn.loopLimit, { edgeId: "Rev-loop-Fix", handle: "outcome:changes" });
    assert.equal((rev.output as { outcome: string }).outcome, "changes", "its output is kept while it waits");
    assert.equal(waiting.pendingPersonGates, 1, "Needs you");
    assert.equal(waiting.parked, true, "a loop-limit wait parks the run like any gate");

    const decided = await h.engine.decideGate!(runId!, gate.gateId, { choice: "stop" }, USER);
    assert.equal(decided.alreadyDecided, false);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    const run = (await h.engine.getRun(runId!))!;
    const stopped = run.blocks.Rev!;
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.handle, "error");
    assert.equal(stopped.error?.kind, "loop_limit");
    assert.equal(stopped.error?.message, "Rev → Fix reached its limit (1 loop); stopped.");
    assert.equal(stopped.attempt, 1, "never retried");
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev"]);
    assert.equal((stopped.output as { outcome: string }).outcome, "changes", "the pass keeps its output");
    assert.match(run.error ?? "", /reached its limit/);
    assert.deepEqual(run.loopCounters, { "Rev-loop-Fix": 1 });
    assert.equal(run.loopLimits, undefined);
    assert.equal(run.blocks.Done!.status, "cancelled", "the failing run cancels what had not run");
    assert.equal(run.gates![gate.gateId]!.decision?.choice, "stop");
    assert.equal(run.pendingGates, undefined);
  });

  test("Stop at the limit with an error edge: the failure is handled there", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const code = scripted("code");
    const h = createHarness({ workflows: [fixReview(2, { errorEdge: true })], executors: { agent, code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const gate = await limitGate(h, runId!);
    assert.match(gate.details ?? "", /Rev fails and its error connection runs/);
    await h.engine.decideGate!(runId!, gate.gateId, { choice: "stop" }, USER);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    const run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(code.seen, ["Handle"]);
    assert.equal(run.blocks.Rev!.error?.kind, "loop_limit");
    assert.equal(run.blocks.Rev!.pass, 3);
  });

  test("Allow one more loop raises the edge's limit for the run and takes it; at the new limit the person is asked again", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes", "changes", "changes", "approved"]) });
    const pushed: WorkflowGateState[] = [];
    const h = createHarness({ workflows: [fixReview(1)], executors: { agent, code: scripted("code") }, notifier: pushing(pushed) });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const first = await limitGate(h, runId!);
    await h.engine.decideGate!(runId!, first.gateId, { choice: "allow" }, USER);
    await flush();
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev", "Fix", "Rev"], "the loop was taken once more");
    let run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(run.loopLimits, { "Rev-loop-Fix": 2 });
    assert.deepEqual(run.loopCounters, { "Rev-loop-Fix": 2 });
    assert.equal(run.blocks.Fix!.pass, 3);
    assert.equal(run.blocks.Fix!.loopFeedback, "Rev says changes (2)", "the feedback is the pass that hit the limit");
    const archived = run.blocks.Rev!.passes!.at(-1)!;
    assert.equal(archived.status, "succeeded");
    assert.equal(archived.handle, "outcome:changes");
    assert.equal(archived.gateId, first.gateId, "the pass keeps the loop-limit gate it waited on");
    // At the raised limit: a new gate, its own id; the first stays decided.
    const second = await limitGate(h, runId!);
    assert.notEqual(second.gateId, first.gateId);
    assert.equal(second.question, "Rev → Fix reached its limit (2).");
    assert.equal(second.pass, 3);
    run = (await h.engine.getRun(runId!))!;
    assert.equal(run.gates![first.gateId]!.decision?.choice, "allow");
    assert.equal(pushed.length, 2);
    await h.engine.decideGate!(runId!, second.gateId, { choice: "allow" }, USER);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(run.loopLimits, { "Rev-loop-Fix": 3 });
    assert.equal(run.blocks.Rev!.handle, "outcome:approved");
    assert.equal(run.blocks.Done!.status, "succeeded");
    const loopEvents = h.runStore.events.get(runId!)!.filter((event) => String(event.type).startsWith("loop."));
    assert.deepEqual(loopEvents.map((event) => event.type), ["loop.taken", "loop.limit", "loop.taken", "loop.limit", "loop.taken"]);
  });

  test("a loop-limit gate nobody decides expires after 7 days: the pass fails loop_limit", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const h = createHarness({ workflows: [fixReview(1)], executors: { agent } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const gate = await limitGate(h, runId!);
    await h.clock.advance(7 * DAY + MIN);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.gates![gate.gateId]!.expired, true);
    assert.equal(run.blocks.Rev!.error?.kind, "loop_limit");
    assert.match(run.blocks.Rev!.error?.message ?? "", /nobody decided/);
  });

  test("a test run's loop-limit gate is the editor's only: no push, no Needs you", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const pushed: WorkflowGateState[] = [];
    const h = createHarness({ workflows: [fixReview(1)], executors: { agent }, notifier: pushing(pushed) });
    const { runId } = await h.engine.run("w1", { test: true });
    await flush();
    const gate = await limitGate(h, runId!);
    assert.equal(gate.test, true);
    assert.equal(pushed.length, 0);
    assert.equal((await h.engine.getRun(runId!))!.pendingPersonGates, undefined);
    await h.engine.decideGate!(runId!, gate.gateId, { choice: "stop" }, USER);
    assert.equal((await h.engine.waitForRun(runId!)).status, "failed");
  });

  test("a loop-limit wait parks the run: it frees the run cap and its workflow's overlap skip says why; a cancel cancels its gate", async () => {
    const working = ["c1", "c2", "c3", "c4"].map((id) => workflow(id, [T(), node("Work", "code")], [edge("T", "Work")]));
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [fixReview(1), ...working], executors: { agent, code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    await limitGate(h, runId!);
    assert.equal((await h.engine.getRun(runId!))!.parked, true);
    const busy: string[] = [];
    for (const id of ["c1", "c2", "c3", "c4"]) busy.push((await h.engine.run(id, {})).runId!);
    await flush();
    assert.equal(code.calls.length, 4, "the parked run leaves the whole cap (4) free");
    const skipped = await h.engine.run("w1", {});
    assert.deepEqual(skipped, { runId: null, skipped: "overlap", skipDetail: "previous run is waiting on gate “Rev → Fix reached its limit (1).”" });
    for (const call of code.calls) call.resolve({ status: "succeeded", output: 1 });
    for (const id of busy) await h.engine.waitForRun(id);
    await h.engine.cancel(runId!);
    await h.engine.waitForRun(runId!);
    const cancelled = (await h.engine.getRun(runId!))!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(Object.values(cancelled.gates!)[0]!.cancelled, true, "cancelling the run cancels its loop-limit gate");
    assert.equal(cancelled.blocks.Rev!.status, "cancelled");
  });

  test("an outer loop that runs a block waiting at an inner loop's limit again cancels that gate; the next pass asks afresh", async () => {
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("X", "code"), node("C", "if"), node("S", "shell"), node("D", "if")],
      [edge("T", "A"), edge("A", "X"), edge("X", "C"), loopEdge("C", "X", "false", 1), edge("A", "S"), edge("S", "D"), loopEdge("D", "A", "false", 1)]
    );
    let checks = 0;
    const flow = scripted("if", { C: () => ({ status: "succeeded", output: null, handle: "false" }), D: () => ({ status: "succeeded", output: null, handle: ++checks === 1 ? "false" : "true" }) });
    const shell = controlledExecutor("shell");
    const h = createHarness({ workflows: [wf], executors: { code: scripted("code"), if: flow, shell } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const inner = await limitGate(h, runId!);
    assert.equal(inner.nodeId, "C");
    // The outer loop runs A again — and C with it.
    shell.calls[0]!.resolve({ status: "succeeded", output: "slow" });
    await flush();
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(run.gates![inner.gateId]!.cancelled, true, "the moot question is cancelled");
    const stopped = run.blocks.C!.passes!.find((pass) => pass.gateId === inner.gateId)!;
    assert.equal(stopped.status, "cancelled");
    const persisted = (await h.runStore.load(runId!))!.blocks.C!.passes!.find((pass) => pass.gateId === inner.gateId)!;
    assert.equal(persisted.interruptedFrom, undefined, "its stopping settled");
    assert.equal(stopped.error?.kind, "interrupted");
    assert.equal(run.loopCounters?.["C-loop-X"], 1, "the outer loop gave the inner one a fresh budget, used once again");
    const again = await limitGate(h, runId!);
    assert.notEqual(again.gateId, inner.gateId);
    assert.equal(again.nodeId, "C");
    assert.equal(run.pendingPersonGates, 1, "only the waiting gate needs the person");
    await h.engine.cancel(runId!);
  });

  test("a run stopped at its loop limit can be retried with a fresh budget, seeded from the latest pass", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes", "changes", "approved"]) });
    const h = createHarness({ workflows: [fixReview(1)], executors: { agent, code: scripted("code") } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    await h.engine.decideGate!(runId!, (await limitGate(h, runId!)).gateId, { choice: "stop" }, USER);
    assert.equal((await h.engine.waitForRun(runId!)).status, "failed");
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev"]);
    const retried = await runToEnd(h, "w1", { retryOf: runId! });
    assert.equal(retried.run.status, "succeeded");
    assert.deepEqual(agent.seen.slice(4), ["Rev"], "Fix's latest pass is reused; only the failed review runs again");
    assert.equal(retried.run.loopCounters, undefined, "the counters start at 0");
    assert.equal(retried.run.loopLimits, undefined, "a raised limit is not carried over");
    assert.equal(retried.run.gates, undefined, "gates are never seeded");
    assert.equal(retried.run.blocks.Fix!.pass, undefined);
    assert.equal(retried.run.blocks.Fix!.passes, undefined, "a seed carries the latest pass only");
    assert.equal(retried.run.blocks.Rev!.handle, "outcome:approved");
  });

  test("a retry never seeds a block that ended on a loop handle: its loop decides again", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["approved"]) });
    const h = createHarness({ workflows: [fixReview(2)], executors: { agent, code: scripted("code") } });
    const first = await runToEnd(h, "w1");
    // The record of a run that ended (cancelled) right as Rev finished on its loop handle.
    const stored = (await h.runStore.load(first.runId))!;
    stored.status = "cancelled";
    stored.blocks.Rev!.handle = "outcome:changes";
    stored.blocks.Done!.status = "cancelled";
    await h.runStore.save(stored);
    const retried = await runToEnd(h, "w1", { retryOf: first.runId });
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Rev"], "Fix is reused, Rev runs again");
    assert.equal(retried.run.blocks.Rev!.handle, "outcome:approved");
    assert.equal(retried.run.status, "succeeded");
  });

  test("a run that ends as a source finishes on its loop handle takes no loop", async () => {
    const agent = controlledExecutor("agent");
    const h = createHarness({ workflows: [fixReview(2)], executors: { agent } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    agent.calls[0]!.resolve({ status: "succeeded", output: { text: "fixed" } });
    await flush();
    await h.engine.cancel(runId!);
    await h.engine.waitForRun(runId!);
    const cancelled = (await h.engine.getRun(runId!))!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.loopCounters, undefined);
    assert.equal(cancelled.blocks.Fix!.pass, undefined);
  });

  test("an outer loop gives the loops inside it a fresh budget", async () => {
    let innerVisits = 0;
    let outerVisits = 0;
    const flow = scripted("if", {
      // Each outer pass: the inner check loops once, then passes.
      InnerCheck: () => ({ status: "succeeded", output: null, handle: ++innerVisits % 2 === 1 ? "false" : "true" }),
      OuterCheck: () => ({ status: "succeeded", output: null, handle: ++outerVisits === 1 ? "false" : "true" })
    });
    const code = scripted("code");
    const wf = workflow(
      "w1",
      [T(), node("Outer", "code"), node("Inner", "code"), node("InnerCheck", "if"), node("OuterCheck", "if"), node("Done", "code")],
      [
        edge("T", "Outer"),
        edge("Outer", "Inner"),
        edge("Inner", "InnerCheck"),
        loopEdge("InnerCheck", "Inner", "false", 1),
        edge("InnerCheck", "OuterCheck", "true"),
        loopEdge("OuterCheck", "Outer", "false", 1),
        edge("OuterCheck", "Done", "true")
      ]
    );
    const h = createHarness({ workflows: [wf], executors: { code, if: flow } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded", run.error);
    assert.deepEqual(code.seen, ["Outer", "Inner", "Inner", "Outer", "Inner", "Inner", "Done"]);
    assert.deepEqual(run.loopCounters, { "InnerCheck-loop-Inner": 1, "OuterCheck-loop-Outer": 1 });
    assert.equal(run.blocks.Inner!.pass, 4);
    assert.equal(run.blocks.Outer!.pass, 2);
  });

  test("blocks of the reset set still running are stopped and run again; branches outside it go on", async () => {
    const code = controlledExecutor("code");
    let checks = 0;
    const flow = scripted("if", { Check: () => ({ status: "succeeded", output: null, handle: ++checks === 1 ? "false" : "true" }) });
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("Slow", "code"), node("Check", "if"), node("M", "merge", { mode: "all" }), node("Side", "code"), node("Done", "code")],
      [
        edge("T", "A"),
        edge("A", "Slow"),
        edge("A", "Check"),
        loopEdge("Check", "A", "false", 2),
        edge("Check", "M", "true"),
        edge("Slow", "M"),
        edge("M", "Done"),
        edge("T", "Side")
      ]
    );
    const h = createHarness({ workflows: [wf], executors: { code, if: flow } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const call = (name: string, index = 0) => code.calls.filter((c) => c.ctx.node.name === name)[index]!;
    call("A").resolve({ status: "succeeded", output: "a1" });
    await flush();
    // Slow is running, Check took the loop: Slow is stopped, A runs again; Side is untouched.
    assert.equal(call("Slow").ctx.signal.aborted, true);
    assert.equal(call("Side").ctx.signal.aborted, false);
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.Slow!.pass, 2);
    assert.equal(run.blocks.Slow!.passes![0]!.status, "cancelled");
    assert.equal(run.blocks.Slow!.passes![0]!.error?.kind, "interrupted");
    assert.equal(run.status, "running", "the stopped pass does not fail the run");
    call("A", 1).resolve({ status: "succeeded", output: "a2" });
    await flush();
    assert.equal(code.calls.filter((c) => c.ctx.node.name === "Slow").length, 2, "Slow's next pass started once A's finished");
    call("Slow", 1).resolve({ status: "succeeded", output: "slow2" });
    await flush();
    call("Side").resolve({ status: "succeeded", output: "side" });
    await flush();
    call("Done").resolve({ status: "succeeded", output: "done" });
    const result = await h.engine.waitForRun(runId!);
    run = (await h.engine.getRun(runId!))!;
    assert.equal(result.status, "succeeded");
    assert.equal(run.blocks.Side!.pass, undefined);
    assert.deepEqual(run.blocks.M!.output, { Check: null, Slow: "slow2" }, "the merge read the latest passes");
  });

  test("child-run ids, attempt directories and output files are unique across passes", async () => {
    const dirs: string[] = [];
    const attempts: number[] = [];
    const code = scripted("code", {
      Work: async (ctx) => {
        dirs.push(await ctx.attemptDir());
        attempts.push(ctx.attempt);
        // Large: spilled to the attempt's output file.
        return { status: "succeeded", output: "x".repeat(70 * 1024) };
      }
    });
    let checks = 0;
    const flow = scripted("if", { Check: () => ({ status: "succeeded", output: null, handle: ++checks < 3 ? "false" : "true" }) });
    const child = workflow("w2", [T(), node("Leaf", "code")], [edge("T", "Leaf")]);
    const parent = workflow(
      "w1",
      [T(), node("Work", "code", {}, { retry: { maxTries: 2, delaySeconds: 0 } }), node("Sub", "workflow", { workflowId: "w2" }), node("Check", "if")],
      [edge("T", "Work"), edge("Work", "Sub"), edge("Sub", "Check"), loopEdge("Check", "Work", "false", 2)]
    );
    let workCalls = 0;
    const flaky: NodeExecutor<"code"> = {
      type: "code",
      async execute(ctx) {
        if (ctx.node.name === "Work" && ++workCalls === 2) return { status: "failed", error: { kind: "exception", message: "flaky" } };
        return code.execute(ctx);
      }
    };
    const h = createHarness({ workflows: [parent, child], executors: { code: flaky, if: flow } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded", run.error);
    assert.deepEqual(attempts, [1, 3, 4], "pass 2 retried once (attempt 2 failed, 3 ran): storage counts on");
    assert.equal(new Set(dirs).size, 3);
    assert.equal(run.blocks.Work!.attempt, 1, "the block's own attempt counts within its pass");
    assert.deepEqual(run.blocks.Work!.passes!.map((pass) => pass.attempt), [1, 2]);
    const childIds = [...run.blocks.Sub!.passes!.map((pass) => pass.childRunId), run.blocks.Sub!.childRunId];
    assert.equal(new Set(childIds).size, 3, "each pass started its own child run");
    for (const id of childIds) assert.ok(await h.runStore.exists(id!), "every child run is on record");
    const files = [...h.runStore.files.keys()].filter((path) => path.includes("/Work/"));
    assert.equal(new Set(files).size, 3, "each pass's large output has its own file");
    for (const pass of run.blocks.Work!.passes!) {
      assert.equal("outputFile" in pass, false, "no file path on the wire");
      assert.equal(pass.outputTruncated, true);
    }
  });

  test("a disabled block passing through on its loop's handle never takes the loop", async () => {
    const wf = fixReview(2);
    const rev = wf.nodes.find((n) => n.id === "Rev")!;
    Object.assign(rev, { disabled: true, config: { ...(rev.config as Record<string, unknown>), outcomes: [{ id: "changes" }, { id: "approved" }] } });
    const agent = scripted("agent");
    const h = createHarness({ workflows: [wf], executors: { agent, code: scripted("code") } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded");
    assert.deepEqual(agent.seen, ["Fix"], "Fix ran once; the disabled review did not loop it");
    assert.equal(run.blocks.Rev!.handle, "outcome:changes");
    assert.equal(run.loopCounters, undefined);
    assert.equal(run.gates, undefined, "no loop-limit gate either");
    assert.ok(run.blocks.Rev!.warnings?.some((warning) => /loop back to Fix is not taken/.test(warning)));
    assert.equal(run.blocks.Done!.status, "skipped");
  });

  test("a single-block test never takes a loop edge", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const h = createHarness({ workflows: [fixReview(2)], executors: { agent } });
    const response = await h.engine.testNode("w1", "Rev");
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.blocks.Rev!.status, "succeeded");
    assert.equal(run.loopCounters, undefined);
  });

  test("a trigger-less workflow's root can be a loop target: it starts again on its next pass", async () => {
    let checks = 0;
    const flow = scripted("if", { Check: () => ({ status: "succeeded", output: null, handle: ++checks === 1 ? "false" : "true" }) });
    const code = scripted("code");
    const wf = workflow("w1", [node("Root", "code"), node("Check", "if")], [edge("Root", "Check"), loopEdge("Check", "Root", "false", 1)]);
    const h = createHarness({ workflows: [wf], executors: { code, if: flow } });
    const { run } = await runToEnd(h, "w1", { input: { go: 1 } });
    assert.equal(run.status, "succeeded", run.error);
    assert.deepEqual(code.seen, ["Root", "Root"]);
    assert.deepEqual((run.blocks.Root!.output as { input: unknown }).input, { go: 1 }, "it reads the run's input on every pass");
  });
});

// ---------------------------------------------------------------------------
// Restart safety
// ---------------------------------------------------------------------------

function restartable(workflows: Workflow[], runStore = new InMemoryRunStore()) {
  const shared = {
    clock: new ManualClock(),
    runStore,
    store: new InMemoryWorkflowStore(workflows),
    secrets: new InMemorySecretStore(),
    projects: new FakeProjects(),
    sandbox: new FakeSandbox(),
    mintId: sequentialIds("run")
  };
  return {
    shared,
    boot: (executors: NodeExecutorRegistry = {}, notifier?: WorkflowNotifier): Harness => createHarness({ ...shared, executors, ...(notifier ? { notifier } : {}) })
  };
}

class HeldRunStore extends InMemoryRunStore {
  private held: Promise<void> | null = null;
  private releaseHeld: (() => void) | null = null;
  hold(): void {
    this.held = new Promise((resolve) => {
      this.releaseHeld = resolve;
    });
  }
  release(): void {
    this.releaseHeld?.();
    this.held = null;
  }
  override async save(run: Parameters<InMemoryRunStore["save"]>[0]): Promise<void> {
    if (this.held) await this.held;
    return super.save(run);
  }
}

/** A "shell" block that persists a process wait and runs until stopped; it records how each execution began and ended. */
function longRunning() {
  const log: { resumed: boolean; abortedAtStart: boolean; ended?: string }[] = [];
  const finish: ((result: NodeResult) => void)[] = [];
  const executor: NodeExecutor<"shell"> = {
    type: "shell",
    async execute(ctx) {
      const entry: (typeof log)[number] = { resumed: ctx.resumeFrom !== undefined, abortedAtStart: ctx.signal.aborted };
      log.push(entry);
      if (!ctx.resumeFrom) {
        const waitingOn: WaitingOn = { kind: "process", pid: 4242, starttime: 1, attemptDir: await ctx.attemptDir(), deadlineAt: "2026-09-28T12:00:00.000Z" };
        await ctx.setWaitingOn(waitingOn);
      }
      const result = await new Promise<NodeResult>((resolve) => {
        finish.push(resolve);
        if (ctx.signal.aborted) resolve({ status: "cancelled" });
        else ctx.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      });
      entry.ended = result.status;
      await ctx.setWaitingOn(undefined).catch(() => undefined);
      return result;
    }
  };
  return { executor, log, finish };
}

describe("engine: loops across a daemon restart", () => {
  test("between passes: the counters, passes and the next pass's wait resume where they were", async () => {
    let reviews = 0;
    const review = () => scripted("agent", { Rev: () => ({ status: "succeeded", output: { text: "r", summary: `round ${++reviews}` }, handle: reviews === 1 ? "outcome:changes" : "outcome:approved" }) });
    const wf = workflow(
      "w1",
      [T(), node("W", "wait", { kind: "duration", minutes: 1 }), reviewer(), node("Done", "code")],
      [edge("T", "W"), edge("W", "Rev"), edge("Rev", "Done", "outcome:approved"), loopEdge("Rev", "W", "outcome:changes", 2)]
    );
    const env = restartable([wf]);
    const first = env.boot({ agent: review(), code: scripted("code") });
    const { runId } = await first.engine.run("w1", {});
    await env.shared.clock.advance(60_000);
    let stored = (await env.shared.runStore.load(runId!))!;
    assert.equal(stored.blocks.W!.pass, 2, "the loop was taken");
    assert.equal(stored.blocks.W!.status, "waiting");
    assert.equal(stored.blocks.W!.loopFeedback, "round 1");
    assert.deepEqual(stored.loopCounters, { "Rev-loop-W": 1 });
    await first.engine.stop();

    const second = env.boot({ agent: review(), code: scripted("code") });
    await second.engine.resume();
    await env.shared.clock.advance(60_000);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    stored = (await env.shared.runStore.load(runId!))!;
    assert.equal(reviews, 2);
    assert.deepEqual(stored.loopCounters, { "Rev-loop-W": 1 });
    assert.equal(stored.blocks.W!.passes!.length, 1);
    assert.equal(stored.blocks.Rev!.passes![0]!.handle, "outcome:changes");
    assert.equal(stored.blocks.Done!.status, "succeeded");
  });

  test("at a loop's limit: the gate is re-awaited (not re-pushed) after a restart, and Allow then loops on", async () => {
    const env = restartable([fixReview(1)]);
    const pushed: WorkflowGateState[] = [];
    const rev = reviewing("Rev", ["changes", "changes", "approved"]);
    const first = env.boot({ agent: scripted("agent", { Rev: rev }), code: scripted("code") }, pushing(pushed));
    const { runId } = await first.engine.run("w1", {});
    await flush();
    const gate = await limitGate(first, runId!);
    assert.equal(pushed.length, 1);
    await first.engine.stop();

    const agent = scripted("agent", { Rev: rev });
    const second = env.boot({ agent, code: scripted("code") }, pushing(pushed));
    await second.engine.resume();
    await flush();
    const resumed = await limitGate(second, runId!);
    assert.equal(resumed.gateId, gate.gateId, "the same gate");
    assert.equal(pushed.length, 1, "the person is not pushed again");
    assert.deepEqual(agent.seen, [], "the waiting block's executor is not resumed");
    await second.engine.decideGate!(runId!, gate.gateId, { choice: "allow" }, USER);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(agent.seen, ["Fix", "Rev"], "the loop ran once more");
    const run = (await second.engine.getRun(runId!))!;
    assert.deepEqual(run.loopLimits, { "Rev-loop-Fix": 2 });
    assert.equal(run.blocks.Fix!.loopFeedback, "Rev says changes (2)", "the feedback survives the restart (the output is reloaded)");
    assert.equal(run.blocks.Rev!.handle, "outcome:approved");
  });

  test("at a loop's limit: a restart before the gate's record was stored opens that same gate, then pushes", async () => {
    const env = restartable([fixReview(1)]);
    const pushed: WorkflowGateState[] = [];
    const rev = reviewing("Rev", ["changes", "changes"]);
    const first = env.boot({ agent: scripted("agent", { Rev: rev }) });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    const gate = await limitGate(first, runId!);
    await first.engine.stop();
    // The record as the block's finish left it, before `openPersonGate` stored the gate.
    const stored = (await env.shared.runStore.load(runId!))!;
    delete stored.gates;
    delete stored.gateNotices;
    delete stored.pendingGates;
    delete stored.pendingPersonGates;
    await env.shared.runStore.save(stored);

    const second = env.boot({ agent: scripted("agent", { Rev: rev }) }, pushing(pushed));
    await second.engine.resume();
    await flush();
    const reopened = await limitGate(second, runId!);
    assert.equal(reopened.gateId, gate.gateId, "the id persisted with the wait");
    assert.equal(pushed.length, 1);
    assert.equal((await env.shared.runStore.load(runId!))!.pendingPersonGates, 1);
    await second.engine.decideGate!(runId!, gate.gateId, { choice: "stop" }, USER);
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.equal((await second.engine.getRun(runId!))!.blocks.Rev!.error?.kind, "loop_limit");
  });

  test("mid-reset: a reset saved before its running blocks were stopped stops them after the restart, then runs their next pass", async () => {
    const runStore = new HeldRunStore();
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("Long", "shell"), node("Check", "if"), node("M", "merge", { mode: "all" })],
      [edge("T", "A"), edge("A", "Long"), edge("A", "Check"), loopEdge("Check", "A", "false", 2), edge("Check", "M", "true"), edge("Long", "M")]
    );
    const env = restartable([wf], runStore);
    const longOne = longRunning();
    const checkGate = controlledExecutor("if");
    const first = env.boot({ code: scripted("code"), shell: longOne.executor, if: checkGate });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    assert.equal(longOne.log.length, 1, "Long is running");
    // Check takes the loop while every save is held: the reset is recorded, nothing is stopped yet…
    runStore.hold();
    checkGate.calls[0]!.resolve({ status: "succeeded", output: null, handle: "false" });
    await flush();
    const stopping = first.engine.stop();
    runStore.release();
    await stopping;
    assert.equal(longOne.log[0]!.ended, undefined, "…and a stopping engine stops nothing");
    let stored = (await runStore.load(runId!))!;
    assert.equal(stored.blocks.Long!.pass, 2);
    assert.equal(stored.blocks.Long!.passes![0]!.interruptedFrom?.kind, "process", "the stopped pass's wait is on disk");

    const second = env.boot({ code: scripted("code"), shell: longOne.executor, if: scripted("if", { Check: () => ({ status: "succeeded", output: null, handle: "true" }) }) });
    await second.engine.resume();
    await flush();
    // The restart resumed the stopped pass's wait under an aborted signal first…
    assert.deepEqual({ resumed: longOne.log[1]!.resumed, abortedAtStart: longOne.log[1]!.abortedAtStart, ended: longOne.log[1]!.ended }, { resumed: true, abortedAtStart: true, ended: "cancelled" });
    // …then Long's next pass ran fresh.
    assert.equal(longOne.log.length, 3);
    assert.deepEqual({ resumed: longOne.log[2]!.resumed, abortedAtStart: longOne.log[2]!.abortedAtStart }, { resumed: false, abortedAtStart: false });
    stored = (await runStore.load(runId!))!;
    assert.equal(stored.blocks.Long!.passes![0]!.interruptedFrom, undefined, "settled");
    longOne.finish[2]!({ status: "succeeded", output: "long 2" });
    const result = await second.engine.waitForRun(runId!);
    assert.equal(result.status, "succeeded");
    const run = (await second.engine.getRun(runId!)) as WorkflowRun;
    assert.deepEqual(run.blocks.M!.output, { Check: null, Long: "long 2" });
  });

  test("mid-reset: a reviewer gate's stopped pass interrupts its reviewer's turn after the restart, then cancels its gate", async () => {
    const runStore = new HeldRunStore();
    const decider = { kind: "agent", prompt: { kind: "text", text: "Review." }, chain: CHAIN, maxMinutes: 30 };
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("G", "gate", { question: "Ship?", decider }), node("Check", "if"), node("M", "merge", { mode: "all" })],
      [edge("T", "A"), edge("A", "G"), edge("A", "Check"), loopEdge("Check", "A", "false", 2), edge("Check", "M", "true"), edge("G", "M", "choice:approve")]
    );
    const env = restartable([wf], runStore);
    const firstAgent = controlledExecutor("agent");
    const checkGate = controlledExecutor("if");
    const first = env.boot({ code: scripted("code"), gate: createGateExecutor({ agent: firstAgent }), if: checkGate });
    const { runId } = await first.engine.run("w1", {});
    await flush();
    const reviewerCall = firstAgent.calls[0]! as AgentCall;
    reviewerCall.ctx.update({ sessionId: "rev-1" });
    await reviewerCall.ctx.setWaitingOn({ kind: "agent", sessionId: "rev-1", commandId: "cmd-1", command: "turn", baseline: null, deadlineAt: "2026-09-28T11:00:00.000Z", phase: "watching", state: { v: 1 } });
    await flush();
    const firstGateId = (await first.engine.getRun(runId!))!.blocks.G!.gateId!;
    runStore.hold();
    checkGate.calls[0]!.resolve({ status: "succeeded", output: null, handle: "false" });
    await flush();
    const stopping = first.engine.stop();
    runStore.release();
    await stopping;
    const stored = (await runStore.load(runId!))!;
    const interrupted = stored.blocks.G!.passes![0]!.interruptedFrom;
    assert.ok(interrupted?.kind === "gate" && interrupted.agent?.sessionId === "rev-1", "the stopped pass's reviewer state is on disk");

    const agent = controlledExecutor("agent");
    const second = env.boot({ code: scripted("code"), gate: createGateExecutor({ agent }), if: scripted("if", { Check: () => ({ status: "succeeded", output: null, handle: "true" }) }) });
    await second.engine.resume();
    await flush();
    const stopped = agent.calls.find((call) => call.ctx.resumeFrom?.kind === "agent");
    assert.ok(stopped, "the stopped pass's reviewer is resumed once more…");
    assert.equal(stopped.ctx.resumeFrom?.kind === "agent" && stopped.ctx.resumeFrom.sessionId, "rev-1");
    assert.equal(stopped.ctx.signal.aborted, true, "…under an aborted signal: its turn is interrupted");
    // The agent executor's cancel ends that turn.
    stopped.resolve({ status: "cancelled" });
    await flush();
    const run = (await second.engine.getRun(runId!))!;
    assert.equal(run.gates![firstGateId]!.cancelled, true, "its gate is cancelled");
    assert.equal((await runStore.load(runId!))!.blocks.G!.passes![0]!.interruptedFrom, undefined, "settled");
    await second.engine.cancel(runId!);
  });
});

// ---------------------------------------------------------------------------
// Gates inside loops (spec 2026-11-10 §6, §7.2, §7.3)
// ---------------------------------------------------------------------------

/** Fix → G (a gate); G.reject ↺ Fix; G.approve → Done. */
function fixGate(decider?: Record<string, unknown>, session: "continue" | "new" = "continue"): Workflow {
  return workflow(
    "w1",
    [T(), node("Fix", "code"), node("G", "gate", { question: "Ship pass {{ loop.pass }}?", ...(decider ? { decider } : {}) }), node("Done", "code")],
    [edge("T", "Fix"), edge("Fix", "G"), edge("G", "Done", "choice:approve"), loopEdge("G", "Fix", "choice:reject", 2, session)]
  );
}

type AgentCall = { ctx: NodeExecutionContext<"agent">; resolve(result: NodeResult): void };

describe("engine: gates inside loops", () => {
  test("a gate the loop runs again opens a new gate with its own decision; the earlier one stays decided; only the waiting one needs the person", async () => {
    const seen: (string | undefined)[] = [];
    const code = scripted("code", {
      Fix: (ctx) => {
        seen.push(ctx.expressionContext().loop?.feedback);
        return { status: "succeeded", output: "fixed" };
      }
    });
    const h = createHarness({ workflows: [fixGate()], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const [first] = (await h.engine.gates.list({})).gates;
    assert.equal(first!.question, "Ship pass 1?");
    await h.engine.decideGate!(runId!, first!.gateId, { choice: "reject", comment: "add a test" }, USER);
    await flush();
    assert.deepEqual(seen, [undefined, "Reject: add a test"], "the gate's choice label and comment are the loop's feedback");
    const listed = (await h.engine.gates.list({})).gates;
    assert.equal(listed.length, 1, "only the waiting gate is listed");
    const second = listed[0]!;
    assert.notEqual(second.gateId, first!.gateId);
    assert.equal(second.question, "Ship pass 2?");
    assert.equal(second.pass, 2);
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(run.pendingPersonGates, 1);
    assert.equal(run.gates![first!.gateId]!.decision?.choice, "reject", "the earlier pass's gate keeps its decision");
    assert.equal(run.blocks.G!.gateId, second.gateId);
    assert.equal(run.blocks.G!.passes![0]!.gateId, first!.gateId);
    assert.deepEqual((run.blocks.G!.passes![0]!.output as { choice: string; comment: string }).comment, "add a test");
    const withHistory = (await h.engine.gates.list({ includeDecided: true })).gates;
    assert.deepEqual(withHistory.map((gate) => [gate.pass ?? 1, gate.decision?.choice ?? null]), [[1, "reject"], [2, null]]);
    await h.engine.decideGate!(runId!, second.gateId, { choice: "approve" }, USER);
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(code.seen, ["Fix", "Fix", "Done"]);
    assert.equal(run.pendingGates, undefined);
  });

  for (const session of ["continue", "new"] as const) {
    test(`a reviewer-agent decider the loop runs again follows the loop's session option (${session})`, async () => {
      const agent = controlledExecutor("agent");
      const decider = { kind: "agent", prompt: { kind: "text", text: "Review the fix." }, chain: CHAIN };
      const h = createHarness({ workflows: [fixGate(decider, session)], executors: { code: scripted("code"), gate: createGateExecutor({ agent }) } });
      const { runId } = await h.engine.run("w1", {});
      await flush();
      const first = agent.calls[0]! as AgentCall;
      assert.equal(first.ctx.loop, undefined, "its first pass is no loop's");
      first.ctx.update({ sessionId: "rev-1" });
      await flush();
      const [gate] = (await h.engine.gates.list({})).gates;
      await h.engine.decideGate!(runId!, gate!.gateId, { choice: "reject", comment: "missing test" }, { kind: "agent", threadId: "rev-1", projectPath: "" });
      first.resolve({ status: "succeeded", output: {} });
      await flush();
      assert.equal(agent.calls.length, 2, "the gate's next pass asks its reviewer again");
      const second = agent.calls[1]! as AgentCall;
      const loop = second.ctx.loop!;
      assert.ok(loop, "the reviewer gets the gate's loop context");
      assert.equal(loop.session, session);
      assert.equal(loop.pass, 2);
      assert.equal(loop.target, false);
      assert.equal(previousSessionId(loop), "rev-1", "a continue goes on in the previous pass's reviewer chat");
      assert.equal((loop.previous?.output as { choice: string }).choice, "reject");
      assert.equal(second.ctx.node.config.session.kind, "new", "the loop, not the block's session, picks the chat");
      const text = loopTemplate(loop, session, "Review the fix.", "abcdefabcdef");
      if (session === "new") assert.match(text, /The gate's decision then \(by Reviewer agent \(claude\)\): `reject`: missing test/);
      else assert.match(text, /^Workflow loop: pass 2 of up to 3\. The earlier steps ran again/);
      const [again] = (await h.engine.gates.list({})).gates;
      assert.notEqual(again!.gateId, gate!.gateId);
      second.ctx.update({ sessionId: session === "continue" ? "rev-1" : "rev-2" });
      await flush();
      await h.engine.decideGate!(runId!, again!.gateId, { choice: "approve", comment: "good now" }, { kind: "agent", threadId: session === "continue" ? "rev-1" : "rev-2", projectPath: "" });
      second.resolve({ status: "succeeded", output: {} });
      assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
    });
  }
});
