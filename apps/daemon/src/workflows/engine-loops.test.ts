import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow, WorkflowRun } from "@orquester/api";

import type { NodeExecutionContext, NodeExecutor, NodeExecutorRegistry, NodeResult, WaitingOn } from "./contracts.ts";
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

const T = (id = "T") => node(id, "trigger.manual");
const CHAIN = [{ agent: "claude", model: "default" }];
const agentNode = (id: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  node(id, "agent", { prompt: { kind: "text", text: `Do ${id}` }, chain: CHAIN, ...config }, extra);
const reviewer = (id = "Rev") => agentNode(id, { outcomes: [{ id: "approved" }, { id: "changes" }] });

function loopEdge(source: string, target: string, handle: string, maxLoops = 2, session: "continue" | "new" = "continue", id = `${source}-loop-${target}`) {
  return { ...edge(source, target, handle, id), loop: { maxLoops, session } };
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

  test("taken at its limit, the source pass fails with loop_limit: not retried; the run fails without an error edge", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const h = createHarness({ workflows: [fixReview(1, { revRetry: 3 })], executors: { agent } });
    const { run, result } = await runToEnd(h, "w1");
    assert.equal(result.status, "failed");
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev"], "one loop, then no retry of the limit");
    const rev = run.blocks.Rev!;
    assert.equal(rev.status, "failed");
    assert.equal(rev.handle, "error");
    assert.equal(rev.error?.kind, "loop_limit");
    assert.equal(rev.error?.message, "Rev → Fix reached its limit (1 loop).");
    assert.equal(rev.attempt, 1);
    assert.equal((rev.output as { outcome: string }).outcome, "changes", "the pass keeps its output");
    assert.match(run.error ?? "", /reached its limit/);
    assert.deepEqual(run.loopCounters, { "Rev-loop-Fix": 1 });
    assert.equal(run.blocks.Done!.status, "cancelled", "the failing run cancels what had not run");
  });

  test("at the limit with an error edge, the failure is handled there", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes"]) });
    const code = scripted("code");
    const h = createHarness({ workflows: [fixReview(2, { errorEdge: true })], executors: { agent, code } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded");
    assert.deepEqual(code.seen, ["Handle"]);
    assert.equal(run.blocks.Rev!.error?.kind, "loop_limit");
    assert.equal(run.blocks.Rev!.pass, 3);
  });

  test("a run that failed at its loop limit can be retried with a fresh budget, seeded from the latest pass", async () => {
    const agent = scripted("agent", { Rev: reviewing("Rev", ["changes", "changes", "approved"]) });
    const h = createHarness({ workflows: [fixReview(1)], executors: { agent, code: scripted("code") } });
    const first = await runToEnd(h, "w1");
    assert.equal(first.run.status, "failed");
    assert.deepEqual(agent.seen, ["Fix", "Rev", "Fix", "Rev"]);
    const retried = await runToEnd(h, "w1", { retryOf: first.runId });
    assert.equal(retried.run.status, "succeeded");
    assert.deepEqual(agent.seen.slice(4), ["Rev"], "Fix's latest pass is reused; only the failed review runs again");
    assert.equal(retried.run.loopCounters, undefined, "the counters start at 0");
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
  return { shared, boot: (executors: NodeExecutorRegistry = {}): Harness => createHarness({ ...shared, executors }) };
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
});
