import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Workflow, WorkflowRunSummary } from "@orquester/api";

import { createWorkflowEngine } from "./engine.ts";

import { controlledExecutor, edge, flush, node, workflow } from "./testing/fakes.ts";
import { createHarness, scripted } from "./testing/harness.ts";
import { WorkflowEngineError } from "./run-context.ts";

const T = (id = "T") => node(id, "trigger.manual");

async function runToEnd(h: ReturnType<typeof createHarness>, workflowId: string, request: Parameters<typeof h.engine.run>[1] = {}) {
  const response = await h.engine.run(workflowId, request);
  assert.ok(response.runId, "the run started");
  const result = await h.engine.waitForRun(response.runId);
  const run = (await h.engine.getRun(response.runId))!;
  return { runId: response.runId, result, run };
}

describe("engine: the graph walk", () => {
  test("a linear run executes every block in order, feeds outputs forward and succeeds", async () => {
    const code = scripted("code", {
      B: (ctx) => ({
        status: "succeeded",
        output: { got: ctx.expressionContext().input, name: ctx.render("{{ nodes.A.output.node }}").text }
      })
    });
    const h = createHarness({
      workflows: [workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")])],
      executors: { code }
    });
    const { result, run, runId } = await runToEnd(h, "w1", { input: { x: 1 } });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(code.seen, ["A", "B"]);
    assert.deepEqual(run.blocks.T!.output, { kind: "manual", input: { x: 1 } });
    assert.deepEqual(run.blocks.A!.output, { node: "A", input: { kind: "manual", input: { x: 1 } } });
    assert.deepEqual(run.blocks.B!.output, { got: run.blocks.A!.output, name: "A" });
    assert.deepEqual(run.finalOutput, run.blocks.B!.output);
    assert.deepEqual(result.finalOutput, run.blocks.B!.output);
    assert.deepEqual(run.takenEdges.sort(), ["A-success-B", "T-success-A"]);
    assert.equal(run.blocks.A!.attempt, 1);
    assert.equal(run.trigger.kind, "manual");
    assert.equal(run.trigger.nodeId, "T");
    // Persisted and announced.
    assert.equal((await h.runStore.load(runId))!.status, "succeeded");
    const types = h.events.map((event) => event.type);
    assert.equal(types[0], "workflowRun.started");
    assert.ok(types.includes("workflowRun.finished"));
    assert.ok(types.includes("workflow.upserted"));
    assert.ok(types.indexOf("workflowRun.finished") > types.lastIndexOf("workflowRun.updated"), "the last update precedes finished");
    assert.deepEqual(h.notified, [{ status: "succeeded", workflowId: "w1" }]);
    assert.equal(h.engine.activeRunIds().length, 0);
  });

  test("IF takes one branch; the other is skipped with its edges dead", async () => {
    const code = scripted("code");
    const wf = workflow(
      "w1",
      [T(), node("If", "if", { combine: "all", rules: [{ left: "{{ trigger.input.go }}", op: "isTrue" }] }), node("Yes", "code"), node("No", "code"), node("After", "code")],
      [edge("T", "If"), edge("If", "Yes", "true"), edge("If", "No", "false"), edge("No", "After")]
    );
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1", { input: { go: true } });
    assert.equal(run.status, "succeeded");
    assert.equal(run.blocks.If!.handle, "true");
    assert.equal(run.blocks.Yes!.status, "succeeded");
    assert.equal(run.blocks.No!.status, "skipped");
    assert.equal(run.blocks.After!.status, "skipped", "dead paths propagate");
    assert.deepEqual(code.seen, ["Yes"]);
    assert.ok(run.deadEdges.includes("If-false-No") && run.deadEdges.includes("No-success-After"));
    assert.ok(run.takenEdges.includes("If-true-Yes"));
    // The IF passes its input through.
    assert.deepEqual(run.blocks.If!.output, run.blocks.T!.output);
  });

  test("Switch: the first matching case wins, the fallback takes the rest, no fallback kills every edge", async () => {
    const code = scripted("code");
    const cases = [
      { label: "a", combine: "all", rules: [{ left: "{{ trigger.input.k }}", op: "equals", right: "a" }] },
      { label: "b", combine: "all", rules: [{ left: "{{ trigger.input.k }}", op: "equals", right: "b" }] }
    ];
    const build = (fallback: boolean) =>
      workflow(
        "w1",
        [T(), node("Sw", "switch", { cases, fallback }), node("A", "code"), node("B", "code"), node("D", "code")],
        [edge("T", "Sw"), edge("Sw", "A", "case:0"), edge("Sw", "B", "case:1"), ...(fallback ? [edge("Sw", "D", "default")] : [])]
      );
    const h = createHarness({ workflows: [build(true)], executors: { code } });
    let { run } = await runToEnd(h, "w1", { input: { k: "b" } });
    assert.equal(run.blocks.Sw!.handle, "case:1");
    assert.equal(run.blocks.B!.status, "succeeded");
    assert.equal(run.blocks.A!.status, "skipped");
    ({ run } = await runToEnd(h, "w1", { input: { k: "zzz" } }));
    assert.equal(run.blocks.Sw!.handle, "default");
    assert.equal(run.blocks.D!.status, "succeeded");
    h.store.put(build(false));
    ({ run } = await runToEnd(h, "w1", { input: { k: "zzz" } }));
    assert.equal(run.status, "succeeded");
    assert.equal(run.blocks.A!.status, "skipped");
    assert.equal(run.blocks.B!.status, "skipped");
    assert.equal(run.blocks.D!.status, "skipped", "D has no edge in: never runs");
  });

  test("independent branches run concurrently; Merge (all) waits for every live input", async () => {
    const code = controlledExecutor("code");
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("B", "code"), node("M", "merge", { mode: "all" }), node("After", "stop", { value: "{{ input }}" })],
      [edge("T", "A"), edge("T", "B"), edge("A", "M"), edge("B", "M"), edge("M", "After")]
    );
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal(code.calls.length, 2, "both branches started");
    code.calls.find((call) => call.ctx.node.id === "A")!.resolve({ status: "succeeded", output: "a" });
    await flush();
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.M!.status, "pending", "Merge waits for B");
    code.calls.find((call) => call.ctx.node.id === "B")!.resolve({ status: "succeeded", output: "b" });
    const result = await h.engine.waitForRun(runId!);
    run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(run.blocks.M!.output, { A: "a", B: "b" });
    assert.equal(result.status, "stopped", "a Stop ends the run as stopped");
    assert.deepEqual(result.finalOutput, { A: "a", B: "b" });
  });

  test("Merge (first) runs on the first arrival and ignores the later one", async () => {
    const code = controlledExecutor("code");
    const merged = scripted("http");
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("B", "code"), node("M", "merge", { mode: "first" }), node("After", "http", { url: "https://example.test" })],
      [edge("T", "A"), edge("T", "B"), edge("A", "M"), edge("B", "M"), edge("M", "After")]
    );
    const h = createHarness({ workflows: [wf], executors: { code, http: merged } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    code.calls.find((call) => call.ctx.node.id === "B")!.resolve({ status: "succeeded", output: "b" });
    await flush();
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.M!.status, "succeeded");
    assert.deepEqual(run.blocks.M!.output, { B: "b" });
    assert.deepEqual(merged.seen, ["After"]);
    code.calls.find((call) => call.ctx.node.id === "A")!.resolve({ status: "succeeded", output: "a" });
    await h.engine.waitForRun(runId!);
    run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(run.blocks.M!.output, { B: "b" }, "not re-run");
    assert.deepEqual(merged.seen, ["After"]);
    assert.equal(run.status, "succeeded");
  });

  test("a block with several live inputs and no Merge reads the merge object", async () => {
    let seen: unknown;
    const code = scripted("code", {
      C: (ctx) => {
        seen = ctx.expressionContext().input;
        return { status: "succeeded", output: 1 };
      }
    });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code"), node("C", "code")], [edge("T", "A"), edge("T", "B"), edge("A", "C"), edge("B", "C")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    await runToEnd(h, "w1");
    assert.deepEqual(Object.keys(seen as object).sort(), ["A", "B"]);
  });

  test("a failure with an error edge routes down it and the run succeeds", async () => {
    const code = scripted("code", { A: () => ({ status: "failed", error: { kind: "exception", message: "boom" }, output: { partial: true } }) });
    let handlerInput: unknown;
    const handler = scripted("http", {
      Handler: (ctx) => {
        handlerInput = ctx.expressionContext();
        return { status: "succeeded", output: "handled" };
      }
    });
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("Ok", "code"), node("Handler", "http", { url: "https://x.test" })],
      [edge("T", "A"), edge("A", "Ok"), edge("A", "Handler", "error")]
    );
    const h = createHarness({ workflows: [wf], executors: { code, http: handler } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "succeeded");
    assert.equal(run.blocks.A!.status, "failed");
    assert.equal(run.blocks.A!.handle, "error");
    assert.deepEqual(run.blocks.A!.output, { partial: true }, "the failed block's output is kept");
    assert.equal(run.blocks.Ok!.status, "skipped");
    assert.equal(run.blocks.Handler!.status, "succeeded");
    const ctx = handlerInput as { input: unknown; nodes: Record<string, { status: string; error?: { message: string } }> };
    assert.deepEqual(ctx.input, { partial: true });
    assert.equal(ctx.nodes.A!.status, "failed");
    assert.equal(ctx.nodes.A!.error!.message, "boom");
  });

  test("a failure without an error edge fails the run and cancels the running siblings", async () => {
    const slow = controlledExecutor("http");
    const code = scripted("code", { A: () => ({ status: "failed", error: { kind: "exit_code", message: "exit 2" } }) });
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("Slow", "http", { url: "https://x.test" }), node("Later", "code")],
      [edge("T", "A"), edge("T", "Slow"), edge("Slow", "Later")]
    );
    const h = createHarness({ workflows: [wf], executors: { code, http: slow } });
    const { run, result } = await runToEnd(h, "w1");
    assert.equal(result.status, "failed");
    assert.equal(result.error, "A: exit 2");
    assert.equal(run.blocks.Slow!.status, "cancelled");
    assert.ok(slow.calls[0]!.ctx.signal.aborted, "its signal was aborted");
    assert.equal(run.blocks.Later!.status, "cancelled", "never started");
    assert.deepEqual(h.notified, [{ status: "failed", workflowId: "w1" }]);
  });

  test("retries wait their delay on a persisted timer, then succeed", async () => {
    let calls = 0;
    const code = scripted("code", {
      A: () => {
        calls += 1;
        return calls < 3 ? { status: "failed", error: { kind: "exception", message: `try ${calls}` } } : { status: "succeeded", output: "third" };
      }
    });
    const wf = workflow("w1", [T(), node("A", "code", {}, { retry: { maxTries: 3, delaySeconds: 30 } })], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    let block = (await h.runStore.load(runId!))!.blocks.A!;
    assert.equal(block.status, "waiting");
    assert.equal(block.attempt, 1);
    assert.equal(block.error?.message, "try 1");
    assert.deepEqual(block.waitingOn, { kind: "timer", until: "2026-09-28T10:00:30.000Z", purpose: "retry-delay" });
    await h.clock.advance(29_000);
    assert.equal(calls, 1, "not before the delay");
    await h.clock.advance(1_000);
    assert.equal(calls, 2);
    await h.clock.advance(30_000);
    const result = await h.engine.waitForRun(runId!);
    block = (await h.runStore.load(runId!))!.blocks.A!;
    assert.equal(result.status, "succeeded");
    assert.equal(block.attempt, 3);
    assert.equal(block.error, undefined, "a later success clears the error");
    assert.equal(block.output, "third");
  });

  test("all_burnt and limit_exceeded failures are never retried", async () => {
    for (const kind of ["all_burnt", "limit_exceeded"] as const) {
      const agent = scripted("agent", { A: () => ({ status: "failed", error: { kind, message: kind } }) });
      const wf = workflow("w1", [T(), node("A", "agent", { prompt: { kind: "text", text: "go" } }, { retry: { maxTries: 3, delaySeconds: 0 } })], [edge("T", "A")]);
      const h = createHarness({ workflows: [wf], executors: { agent } });
      const { run } = await runToEnd(h, "w1");
      assert.deepEqual(agent.seen, ["A"], `${kind}: one attempt`);
      assert.equal(run.blocks.A!.attempt, 1);
      assert.equal(run.blocks.A!.error?.kind, kind);
    }
  });

  test("an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such", async () => {
    const agent = controlledExecutor("agent");
    const wf = workflow("w1", [T(), node("A", "agent", { prompt: { kind: "text", text: "go" } })], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { agent }, limits: { maxConcurrentAgentBlocks: 1 } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const waitingOn = {
      kind: "agent" as const,
      sessionId: "s1",
      commandId: "c1",
      command: "turn" as const,
      baseline: null,
      deadlineAt: "2026-09-28T20:00:00.000Z",
      phase: "waiting-reset",
      state: {}
    };
    await agent.calls[0]!.ctx.setWaitingOn(waitingOn);
    agent.calls[0]!.ctx.update({ waitingUntil: "2026-09-28T12:00:00.000Z" });
    await flush();
    let block = (await h.runStore.load(runId!))!.blocks.A!;
    assert.equal(block.status, "waiting");
    assert.equal(block.waitingUntil, "2026-09-28T12:00:00.000Z");
    await agent.calls[0]!.ctx.setWaitingOn({ ...waitingOn, phase: "watch" });
    block = (await h.runStore.load(runId!))!.blocks.A!;
    assert.equal(block.status, "running");
    assert.equal(block.waitingUntil, undefined);
    agent.calls[0]!.resolve({ status: "succeeded", output: 1 });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("summarize refuses a delegate that calls back into the engine", async () => {
    const h = createHarness({ workflows: [workflow("w1", [T()])] });
    let engineRef: { summarize(w: Workflow): unknown } | null = null;
    const engine = createWorkflowEngine({
      store: h.store,
      runStore: h.runStore,
      secrets: h.secrets,
      executors: {},
      services: {} as never,
      publish: () => undefined,
      summarize: (wf) => engineRef!.summarize(wf) as never,
      clock: h.clock,
      mintId: () => "x",
      logger: h.logger
    });
    engineRef = engine;
    assert.throws(() => engine.summarize(h.store.get("w1")!), /pass a builder, not a delegate/);
  });

  test("retries exhausted: the last failure stands", async () => {
    const code = scripted("code", { A: () => ({ status: "failed", error: { kind: "exception", message: "nope" } }) });
    const wf = workflow("w1", [T(), node("A", "code", {}, { retry: { maxTries: 2, delaySeconds: 0 } })], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.status, "failed");
    assert.equal(run.blocks.A!.attempt, 2);
    assert.deepEqual(code.seen, ["A", "A"]);
  });

  test("a disabled block passes its input through as success without running", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [T(), node("A", "code", {}, { disabled: true }), node("B", "code")], [edge("T", "A"), edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1", { input: 5 });
    assert.deepEqual(code.seen, ["B"]);
    assert.equal(run.blocks.A!.status, "succeeded");
    assert.deepEqual(run.blocks.A!.output, { kind: "manual", input: 5 });
  });

  test("Stop as failure fails the run with its message and value", async () => {
    const slow = controlledExecutor("code");
    const wf = workflow(
      "w1",
      [T(), node("S", "stop", { as: "failure", message: "No tickets for {{ trigger.input.who }}", value: "{{ trigger.input }}" }), node("Slow", "code")],
      [edge("T", "S"), edge("T", "Slow")]
    );
    const h = createHarness({ workflows: [wf], executors: { code: slow } });
    const { run, result } = await runToEnd(h, "w1", { input: { who: "Ada" } });
    assert.equal(result.status, "failed");
    assert.equal(result.error, "No tickets for Ada");
    assert.deepEqual(result.finalOutput, { who: "Ada" });
    assert.equal(run.blocks.S!.status, "failed");
    assert.equal(run.blocks.S!.error?.kind, "stopped");
    assert.equal(run.blocks.Slow!.status, "cancelled");
  });

  test("code's stop() ends the run as stopped", async () => {
    const code = scripted("code", { A: () => ({ status: "stopped", as: "success", message: "nothing to do" }) });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { result, run } = await runToEnd(h, "w1");
    assert.equal(result.status, "stopped");
    assert.equal(result.error, "nothing to do");
    assert.equal(run.blocks.B!.status, "cancelled");
    assert.deepEqual(h.notified, [{ status: "stopped", workflowId: "w1" }]);
  });

  test("a trigger-less workflow starts at its roots with the manual input", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [node("A", "code"), node("B", "code")], [edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1", { input: { hello: 1 } });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.blocks.A!.output, { node: "A", input: { hello: 1 } });
    assert.deepEqual(code.seen, ["A", "B"]);
  });

  test("a fired trigger runs; the others are skipped", async () => {
    const code = scripted("code");
    const wf = workflow(
      "w1",
      [node("Sched", "trigger.schedule", { preset: { kind: "minutes", every: 5 }, cron: "*/5 * * * *" }), T("Manual"), node("A", "code"), node("B", "code")],
      [edge("Sched", "A"), edge("Manual", "B")]
    );
    const h = createHarness({ workflows: [wf], executors: { code } });
    const fired = await h.engine.fire({
      workflowId: "w1",
      triggerNodeId: "Sched",
      kind: "schedule",
      payload: { kind: "schedule", firedAt: "2026-09-28T10:00:00.000Z", scheduledFor: "2026-09-28T10:00:00.000Z" },
      text: "Every 5 min"
    });
    const result = await h.engine.waitForRun(fired.runId!);
    const run = (await h.engine.getRun(fired.runId!))!;
    assert.equal(result.status, "succeeded");
    assert.equal(run.trigger.kind, "schedule");
    assert.equal(run.trigger.text, "Every 5 min");
    assert.equal(run.blocks.Manual!.status, "skipped");
    assert.equal(run.blocks.B!.status, "skipped");
    assert.deepEqual(code.seen, ["A"]);
    assert.equal((run.blocks.Sched!.output as { kind: string }).kind, "schedule");
  });

  test("a run with validation errors is refused (manual) or recorded as failed (trigger)", async () => {
    const wf = workflow("w1", [T(), node("H", "http", { url: "" })], [edge("T", "H")]);
    const h = createHarness({ workflows: [wf] });
    await assert.rejects(h.engine.run("w1", {}), (error: unknown) => error instanceof WorkflowEngineError && error.code === "INVALID_WORKFLOW" && (error.problems?.length ?? 0) > 0);
    const fired = await h.engine.fire({ workflowId: "w1", kind: "schedule", payload: { kind: "schedule", firedAt: "x", scheduledFor: "x" } });
    const stub = (await h.runStore.load(fired.runId!))!;
    assert.equal(stub.status, "failed");
    assert.match(stub.error!, /has errors/);
    await assert.rejects(h.engine.run("nope", {}), (error: unknown) => error instanceof WorkflowEngineError && error.code === "WORKFLOW_NOT_FOUND");
  });

  test("a missing existing project fails the run at start", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")], { project: { kind: "existing", projectPath: "/w/ws/gone" } });
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { result, run } = await runToEnd(h, "w1");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /does not exist/);
    assert.deepEqual(code.seen, []);
    assert.equal(run.blocks.A!.status, "cancelled");
  });

  test("a projectOverride block runs in that project; a missing one fails the block", async () => {
    let seenPath = "";
    const code = scripted("code", {
      A: (ctx) => {
        seenPath = ctx.project.path;
        return { status: "succeeded", output: 1 };
      }
    });
    const wf = workflow("w1", [T(), node("A", "code", {}, { projectOverride: "/w/ws/other" })], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    h.projects.existing.add("/w/ws/other");
    await runToEnd(h, "w1");
    assert.equal(seenPath, "/w/ws/other");
    h.projects.existing.delete("/w/ws/other");
    const { run } = await runToEnd(h, "w1");
    assert.equal(run.blocks.A!.error?.kind, "project_missing");
  });

  test("an executor that throws or answers nonsense fails its block as internal", async () => {
    const code = scripted("code", {
      A: () => {
        throw new Error("kaput");
      },
      B: () => ({ status: "weird" }) as never
    });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B", "error")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1");
    assert.deepEqual(run.blocks.A!.error, { kind: "internal", message: "kaput" });
    assert.equal(run.blocks.B!.error?.kind, "internal");
  });
});

describe("engine: limits, outputs and redaction", () => {
  test("a big output goes to a file with an inline preview; downstream and nodeOutput read it whole", async () => {
    const big = "x".repeat(5000);
    let downstream: unknown;
    const code = scripted("code", {
      A: () => ({ status: "succeeded", output: { big } }),
      B: (ctx) => {
        downstream = ctx.expressionContext().input;
        return { status: "succeeded", output: 1 };
      }
    });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code }, limits: { inlineOutputPreviewBytes: 1024 } });
    const { run, runId } = await runToEnd(h, "w1");
    assert.equal(run.blocks.A!.outputTruncated, true);
    assert.equal(typeof run.blocks.A!.output, "string");
    assert.ok((run.blocks.A!.output as string).length < 1100);
    assert.equal((run.blocks.A! as { outputFile?: string }).outputFile, undefined, "the file path never crosses the wire");
    assert.deepEqual(downstream, { big });
    assert.deepEqual(await h.engine.nodeOutput(runId, "A"), { found: true, output: { big } });
    assert.deepEqual(await h.engine.nodeOutput(runId, "nope"), { found: false });
    const persisted = (await h.runStore.load(runId))!;
    assert.ok(persisted.blocks.A!.outputFile);
  });

  test("an output over the hard cap fails the block with limit_exceeded", async () => {
    const code = scripted("code", { A: () => ({ status: "succeeded", output: "y".repeat(3000) }) });
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code }, limits: { maxOutputBytes: 2048 } });
    const { run, result } = await runToEnd(h, "w1");
    assert.equal(run.blocks.A!.error?.kind, "limit_exceeded");
    assert.equal(result.status, "failed");
  });

  test("a secret appearing in an output, an error or a warning is redacted everywhere", async () => {
    const code = scripted("code", {
      A: (ctx) => ({ status: "succeeded", output: { token: ctx.secrets.API_TOKEN, text: `Bearer ${ctx.secrets.API_TOKEN}` }, warnings: [`saw ${ctx.secrets.API_TOKEN}`] }),
      B: (ctx) => ({ status: "failed", error: { kind: "exception", message: `bad ${ctx.render("{{ secrets.API_TOKEN }}").text}` } })
    });
    let downstream: unknown;
    const code2 = scripted("http", {
      C: (ctx) => {
        downstream = ctx.expressionContext().nodes.A!.output;
        return { status: "succeeded", output: 1 };
      }
    });
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("B", "code"), node("C", "http", { url: "https://x.test" })],
      [edge("T", "A"), edge("A", "B"), edge("B", "C", "error")]
    );
    const h = createHarness({ workflows: [wf], executors: { code, http: code2 } });
    await h.secrets.set("API_TOKEN", "s3cr3t-value");
    const { run, runId } = await runToEnd(h, "w1");
    assert.deepEqual(run.blocks.A!.output, { token: "«secret:API_TOKEN»", text: "Bearer «secret:API_TOKEN»" });
    assert.deepEqual(run.blocks.A!.warnings, ["saw «secret:API_TOKEN»"]);
    assert.equal(run.blocks.B!.error?.message, "bad «secret:API_TOKEN»");
    assert.deepEqual(downstream, { token: "«secret:API_TOKEN»", text: "Bearer «secret:API_TOKEN»" });
    const everything = JSON.stringify([h.events, [...h.runStore.runs.values()], [...h.runStore.events.values()]]);
    assert.ok(!everything.includes("s3cr3t-value"), "nothing persisted or published holds the value");
    assert.ok((await h.runStore.load(runId))!.blocks.B!.error!.message.includes("«secret:API_TOKEN»"));
  });

  test("the per-run update events are throttled; the final state is always published", async () => {
    const code = controlledExecutor("code");
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const updatesBefore = h.eventsOf("workflowRun.updated").length;
    for (let i = 0; i < 50; i += 1) {
      code.calls[0]!.ctx.update({ activity: `step ${i}` });
      await flush(2);
    }
    const burst = h.eventsOf("workflowRun.updated").length - updatesBefore;
    assert.ok(burst <= 1, `at most one update in the same instant (got ${burst})`);
    await h.clock.advance(250);
    const afterTick = h.eventsOf("workflowRun.updated");
    const last = afterTick[afterTick.length - 1] as { blocks: { nodeId: string; activity?: string }[] };
    assert.equal(last.blocks.find((block) => block.nodeId === "A")?.activity, "step 49", "the latest state is what goes out");
    code.calls[0]!.ctx.update({ activity: "final words" });
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    await h.engine.waitForRun(runId!);
    const updates = h.eventsOf("workflowRun.updated");
    const final = updates[updates.length - 1] as { run: WorkflowRunSummary; blocks: { nodeId: string; status: string; activity?: string }[] };
    assert.equal(final.run.status, "succeeded");
    assert.equal(final.blocks.find((block) => block.nodeId === "A")?.status, "succeeded");
    assert.equal(final.blocks.find((block) => block.nodeId === "A")?.activity, "final words");
    assert.equal(h.events[h.events.length - 1]!.type, "workflow.upserted");
    assert.ok(h.events.findIndex((event) => event.type === "workflowRun.finished") > h.events.lastIndexOf(h.events.find((e) => e.payload === final)!));
  });
});

describe("engine: cancel and run timeout", () => {
  test("cancel mid-block aborts it and ends the run cancelled", async () => {
    const code = controlledExecutor("code");
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal(await h.engine.cancel(runId!), true);
    const result = await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(result.status, "cancelled");
    assert.equal(run.blocks.A!.status, "cancelled");
    assert.equal(run.blocks.B!.status, "cancelled");
    assert.equal(await h.engine.cancel(runId!), false, "not twice");
    assert.deepEqual(h.notified, [{ status: "cancelled", workflowId: "w1" }]);
  });

  test("a block that ignores its abort cannot hold a cancelled run forever", async () => {
    const stubborn = { type: "code" as const, execute: () => new Promise<never>(() => undefined) };
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code: stubborn }, limits: { endingGraceMs: 5_000 } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    await h.engine.cancel(runId!);
    await h.clock.advance(5_000);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "cancelled");
    assert.equal((await h.engine.getRun(runId!))!.blocks.A!.status, "cancelled");
  });

  test("the run timeout fails the run and cancels what runs", async () => {
    const code = controlledExecutor("code");
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")], { settings: { runTimeoutMinutes: 2 } });
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await h.clock.advance(119_000);
    assert.equal((await h.engine.getRun(runId!))!.status, "running");
    await h.clock.advance(1_000);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "The run timed out after 2 minutes.");
    assert.equal((await h.engine.getRun(runId!))!.blocks.A!.status, "cancelled");
  });
});

describe("engine: overlap and global caps", () => {
  const slowWorkflow = (id: string, overlap: "skip" | "queue" | "parallel", maxConcurrent = 2) =>
    workflow(id, [T(), node("A", "code")], [edge("T", "A")], { settings: { overlap, maxConcurrent } });

  test("skip: a second fire records a skipped stub; force runs anyway", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [slowWorkflow("w1", "skip")], executors: { code } });
    const first = await h.engine.run("w1", {});
    const second = await h.engine.run("w1", {});
    assert.deepEqual(second, { runId: null, skipped: "overlap" });
    const runs = await h.engine.listRuns("w1", { limit: 10 });
    assert.equal(runs.runs.length, 2);
    const stub = runs.runs.find((run) => run.id !== first.runId)!;
    assert.equal(stub.status, "skipped");
    assert.equal(stub.skipReason, "overlap");
    const forced = await h.engine.run("w1", { force: true });
    assert.ok(forced.runId);
    await flush();
    assert.equal(code.calls.length, 2);
  });

  test("queue: one pending fire waits for the active run; a further fire is skipped", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [slowWorkflow("w1", "queue")], executors: { code } });
    const first = await h.engine.run("w1", {});
    const second = await h.engine.run("w1", {});
    const third = await h.engine.run("w1", {});
    assert.ok(second.runId);
    assert.deepEqual(third, { runId: null, skipped: "overlap" });
    await flush();
    let queued = (await h.runStore.load(second.runId!))!;
    assert.equal(queued.status, "queued");
    assert.equal(queued.queuedFor, "overlap");
    assert.equal(code.calls.length, 1);
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    await h.engine.waitForRun(first.runId!);
    await flush();
    queued = (await h.runStore.load(second.runId!))!;
    assert.equal(queued.status, "running");
    assert.equal(queued.queuedFor, undefined);
    assert.equal(code.calls.length, 2);
  });

  test("parallel: up to maxConcurrent, then skipped", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [slowWorkflow("w1", "parallel", 2)], executors: { code } });
    assert.ok((await h.engine.run("w1", {})).runId);
    assert.ok((await h.engine.run("w1", {})).runId);
    assert.equal((await h.engine.run("w1", {})).skipped, "overlap");
    await flush();
    assert.equal(code.calls.length, 2);
  });

  test("the global run cap queues runs beyond it, FIFO", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({
      workflows: [slowWorkflow("a", "skip"), slowWorkflow("b", "skip"), slowWorkflow("c", "skip")],
      executors: { code },
      limits: { maxConcurrentRuns: 2 }
    });
    const a = await h.engine.run("a", {});
    const b = await h.engine.run("b", {});
    const c = await h.engine.run("c", {});
    await flush();
    assert.equal(code.calls.length, 2);
    const waiting = (await h.runStore.load(c.runId!))!;
    assert.equal(waiting.status, "queued");
    assert.equal(waiting.queuedFor, "capacity");
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    await h.engine.waitForRun(a.runId!);
    await flush();
    assert.equal(code.calls.length, 3);
    assert.equal(code.calls[2]!.ctx.runId, c.runId);
    void b;
  });

  test("a queued run can be cancelled before it starts", async () => {
    const code = controlledExecutor("code");
    const h = createHarness({ workflows: [slowWorkflow("a", "skip"), slowWorkflow("b", "skip")], executors: { code }, limits: { maxConcurrentRuns: 1 } });
    await h.engine.run("a", {});
    const b = await h.engine.run("b", {});
    assert.equal(await h.engine.cancel(b.runId!), true);
    const result = await h.engine.waitForRun(b.runId!);
    assert.equal(result.status, "cancelled");
    assert.equal(result.startedAt, undefined);
  });

  test("agent blocks and sandbox processes wait behind their global caps", async () => {
    const agent = controlledExecutor("agent");
    const code = controlledExecutor("code");
    const agentConfig = { prompt: { kind: "text", text: "go" } };
    const wf = workflow(
      "w1",
      [T(), node("A1", "agent", agentConfig), node("A2", "agent", agentConfig), node("C1", "code"), node("C2", "code")],
      [edge("T", "A1"), edge("T", "A2"), edge("T", "C1"), edge("T", "C2")]
    );
    const h = createHarness({ workflows: [wf], executors: { agent, code }, limits: { maxConcurrentAgentBlocks: 1, maxConcurrentProcesses: 1 } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal(agent.calls.length, 1);
    assert.equal(code.calls.length, 1);
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.A2!.status, "queued");
    assert.equal(run.blocks.C2!.status, "queued");
    agent.calls[0]!.resolve({ status: "succeeded", output: 1 });
    code.calls[0]!.resolve({ status: "succeeded", output: 1 });
    await flush();
    assert.equal(agent.calls.length, 2);
    assert.equal(code.calls.length, 2);
    agent.calls[1]!.resolve({ status: "succeeded", output: 1 });
    code.calls[1]!.resolve({ status: "succeeded", output: 1 });
    run = (await h.engine.getRun(runId!))!;
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });

  test("an agent block's timer wait releases its slot; waking takes it back", async () => {
    const agent = controlledExecutor("agent");
    const agentConfig = { prompt: { kind: "text", text: "go" } };
    const wf = workflow("w1", [T(), node("A1", "agent", agentConfig), node("A2", "agent", agentConfig)], [edge("T", "A1"), edge("T", "A2")]);
    const h = createHarness({ workflows: [wf], executors: { agent }, limits: { maxConcurrentAgentBlocks: 1 } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    assert.equal(agent.calls.length, 1);
    await agent.calls[0]!.ctx.setWaitingOn({ kind: "timer", until: "2026-09-28T12:00:00.000Z", purpose: "wait-for-reset" });
    await flush();
    assert.equal(agent.calls.length, 2, "the other agent block got the slot");
    assert.equal((await h.engine.getRun(runId!))!.blocks[agent.calls[0]!.ctx.node.id]!.status, "waiting");
    const retaking = agent.calls[0]!.ctx.setWaitingOn(undefined);
    await flush();
    agent.calls[1]!.resolve({ status: "succeeded", output: 1 });
    await retaking;
    assert.equal((await h.engine.getRun(runId!))!.blocks[agent.calls[0]!.ctx.node.id]!.status, "running");
    agent.calls[0]!.resolve({ status: "succeeded", output: 1 });
    assert.equal((await h.engine.waitForRun(runId!)).status, "succeeded");
  });
});

describe("engine: test runs, pins and retries", () => {
  test("usePinned: a pinned block is not executed and downstream reads its pin", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")], { pinned: { A: { pinned: "yes" } } });
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { run } = await runToEnd(h, "w1", { test: true, usePinned: true });
    assert.deepEqual(code.seen, ["B"]);
    assert.equal(run.blocks.A!.pinned, true);
    assert.deepEqual(run.blocks.A!.output, { pinned: "yes" });
    assert.deepEqual(run.blocks.B!.output, { node: "B", input: { pinned: "yes" } });
    assert.equal(run.test, true);
    assert.equal(run.trigger.kind, "test");
  });

  test("without usePinned, pins are ignored", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")], { pinned: { A: 1 } });
    const h = createHarness({ workflows: [wf], executors: { code } });
    await runToEnd(h, "w1");
    assert.deepEqual(code.seen, ["A"]);
  });

  test("fromNodeId runs that block and its downstream; upstream from pins, else the latest run", async () => {
    const code = scripted("code", { B: (ctx) => ({ status: "succeeded", output: { fromA: ctx.expressionContext().nodes.A?.output ?? null, x: ctx.expressionContext().nodes.X?.output ?? null } }) });
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("X", "code"), node("B", "code"), node("C", "code")],
      [edge("T", "A"), edge("A", "X"), edge("X", "B"), edge("B", "C")]
    );
    const h = createHarness({ workflows: [wf], executors: { code } });
    await runToEnd(h, "w1", { input: 1 });
    code.seen.length = 0;
    h.store.put(workflow("w1", wf.nodes, wf.edges as never, { pinned: { X: "pinned-x" } }));
    const { run } = await runToEnd(h, "w1", { fromNodeId: "B" });
    assert.deepEqual(code.seen, ["B", "C"]);
    assert.equal(run.test, true);
    assert.deepEqual(run.blocks.B!.output, { fromA: { node: "A", input: { kind: "manual", input: 1 } }, x: "pinned-x" });
    assert.equal(run.blocks.X!.pinned, true);
    assert.equal(run.blocks.A!.status, "succeeded", "seeded from the latest run");
    assert.equal(run.blocks.C!.status, "succeeded");
    await assert.rejects(h.engine.run("w1", { fromNodeId: "nope" }), (error: unknown) => error instanceof WorkflowEngineError && error.code === "NODE_NOT_FOUND");
  });

  test("testNode executes only that block, even with no upstream data", async () => {
    const code = scripted("code");
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code"), node("C", "code")], [edge("T", "A"), edge("A", "B"), edge("B", "C")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const response = await h.engine.testNode("w1", "B");
    const result = await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.deepEqual(code.seen, ["B"]);
    assert.equal(result.status, "succeeded");
    assert.equal(run.blocks.A!.status, "skipped");
    assert.equal(run.blocks.C!.status, "skipped");
    assert.deepEqual(result.finalOutput, { node: "B", input: null });
  });

  test("testNode seeds only the tested block's upstream: downstream and side branches stay skipped", async () => {
    const code = scripted("code");
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("B", "code"), node("C", "code"), node("S", "code")],
      [edge("T", "A"), edge("A", "B"), edge("B", "C"), edge("T", "S")]
    );
    const h = createHarness({ workflows: [wf], executors: { code } });
    const first = await runToEnd(h, "w1", { input: 1 });
    assert.equal(first.run.blocks.C!.status, "succeeded");
    code.seen.length = 0;
    const response = await h.engine.testNode("w1", "B");
    const result = await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.deepEqual(code.seen, ["B"]);
    assert.equal(run.blocks.A!.status, "succeeded", "the upstream is seeded from the latest run");
    assert.equal(run.blocks.C!.status, "skipped", "the downstream is not filled from the earlier run");
    assert.equal(run.blocks.C!.output, undefined);
    assert.equal(run.blocks.S!.status, "skipped", "an unrelated branch is not seeded");
    assert.deepEqual(result.finalOutput, { node: "B", input: first.run.blocks.A!.output });
    assert.ok(run.takenEdges.includes("A-success-B"));
    assert.ok(!run.takenEdges.includes("B-success-C"), "the tested block's outgoing edge did not run");
    assert.ok(!run.takenEdges.includes("T-success-S"));
  });

  test("retryOf reuses the succeeded blocks and re-runs the failed ones", async () => {
    let fail = true;
    const code = scripted("code", {
      B: (ctx) => (fail ? { status: "failed", error: { kind: "exception", message: "flaky" } } : { status: "succeeded", output: { b: ctx.expressionContext().input } })
    });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code"), node("C", "code")], [edge("T", "A"), edge("A", "B"), edge("B", "C")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const first = await runToEnd(h, "w1", { input: "payload" });
    assert.equal(first.result.status, "failed");
    fail = false;
    code.seen.length = 0;
    const retry = await runToEnd(h, "w1", { retryOf: first.runId });
    assert.equal(retry.result.status, "succeeded");
    assert.deepEqual(code.seen, ["B", "C"], "A was not re-run");
    assert.equal(retry.run.retryOf, first.runId);
    assert.equal(retry.run.trigger.kind, "retry");
    assert.deepEqual(retry.run.blocks.A!.output, first.run.blocks.A!.output);
    assert.deepEqual(retry.run.triggerPayload, { kind: "manual", input: "payload" });
    await assert.rejects(h.engine.run("w1", { retryOf: "missing" }), (error: unknown) => error instanceof WorkflowEngineError && error.code === "RUN_NOT_FOUND");
  });

  test("retryOf + fromNodeId on the fired trigger re-runs everything with the same event", async () => {
    let fail = true;
    const code = scripted("code", {
      B: (ctx) => (fail ? { status: "failed", error: { kind: "exception", message: "flaky" } } : { status: "succeeded", output: { sha: (ctx.expressionContext().trigger as { sha: string }).sha } })
    });
    const git = node("G", "trigger.git", { repo: { kind: "url", url: "https://git.test/r.git" }, event: { kind: "tag" } });
    const wf = workflow("w1", [git, T("Manual"), node("A", "code"), node("B", "code"), node("M", "code")], [edge("G", "A"), edge("A", "B"), edge("Manual", "M")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const payload = { kind: "git" as const, event: "tag" as const, repo: { url: "https://git.test/r.git", name: "r" }, ref: "refs/tags/v1", sha: "abc", tag: "v1" };
    const fired = await h.engine.fire({ workflowId: "w1", triggerNodeId: "G", kind: "git", payload });
    const first = await h.engine.waitForRun(fired.runId!);
    assert.equal(first.status, "failed");
    fail = false;
    code.seen.length = 0;
    const retry = await runToEnd(h, "w1", { retryOf: fired.runId!, fromNodeId: "G" });
    assert.equal(retry.result.status, "succeeded");
    assert.deepEqual(code.seen, ["A", "B"], "A ran again: nothing reused");
    assert.deepEqual(retry.run.triggerPayload, payload);
    assert.equal(retry.run.trigger.kind, "retry");
    assert.equal(retry.run.trigger.nodeId, "G");
    assert.equal(retry.run.retryOf, fired.runId);
    assert.equal(retry.run.test, false);
    assert.equal((await h.runStore.load(retry.runId))!.fromNodeId, undefined);
    assert.equal(retry.run.blocks.Manual!.status, "skipped", "only the retried trigger fires");
    assert.equal(retry.run.blocks.M!.status, "skipped");
    assert.deepEqual(retry.run.blocks.B!.output, { sha: "abc" });
  });

  test("retryOf + a non-trigger fromNodeId runs from there on that run's upstream outputs", async () => {
    let calls = 0;
    const code = scripted("code", { A: () => ({ status: "succeeded", output: `a${++calls}` }) });
    const wf = workflow("w1", [T(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const source = await runToEnd(h, "w1");
    await runToEnd(h, "w1"); // a later run with another A output
    code.seen.length = 0;
    const retry = await runToEnd(h, "w1", { retryOf: source.runId, fromNodeId: "B" });
    assert.deepEqual(code.seen, ["B"]);
    assert.deepEqual(retry.run.blocks.B!.output, { node: "B", input: "a1" }, "the retried run's A, not the latest");
    assert.equal(retry.run.trigger.kind, "retry");
  });

  test("retryOf does not reuse a success that sits below a block being re-run", async () => {
    let failA = true;
    const code = scripted("code", { A: () => (failA ? { status: "failed", error: { kind: "exception", message: "x" } } : { status: "succeeded", output: "a2" }) });
    const handler = scripted("http");
    const wf = workflow(
      "w1",
      [T(), node("A", "code"), node("E", "http", { url: "https://x.test" }), node("B", "code")],
      [edge("T", "A"), edge("A", "E", "error"), edge("A", "B")]
    );
    const h = createHarness({ workflows: [wf], executors: { code, http: handler } });
    const first = await runToEnd(h, "w1");
    assert.equal(first.run.blocks.E!.status, "succeeded");
    failA = false;
    const retry = await runToEnd(h, "w1", { retryOf: first.runId });
    assert.equal(retry.run.blocks.A!.status, "succeeded");
    assert.equal(retry.run.blocks.E!.status, "skipped", "the error branch is not carried over");
    assert.equal(retry.run.blocks.B!.status, "succeeded");
  });
});

describe("engine: temporary projects", () => {
  const tempWorkflow = (source: Record<string, unknown>, nodes = [T(), node("A", "code")], edges = [edge("T", "A")]) =>
    workflow("w1", nodes, edges, { name: "Nightly Fix!", project: { kind: "temp", workspace: "ws", source } });

  test("created per run, deleted when the run succeeds", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [tempWorkflow({ kind: "clone", url: "https://git.test/r.git", ref: "main" })], executors: { code } });
    const { run, runId } = await runToEnd(h, "w1");
    assert.deepEqual(h.projects.created, [{ workspace: "ws", name: "wf-nightly-fix-run0001", source: { kind: "clone", url: "https://git.test/r.git", ref: "main" } }]);
    assert.equal(run.projectPath, "/w/ws/wf-nightly-fix-run0001");
    assert.deepEqual(h.projects.deleted, ["/w/ws/wf-nightly-fix-run0001"]);
    assert.deepEqual(run.tempProject, { path: "/w/ws/wf-nightly-fix-run0001", deleted: true });
    assert.equal(await h.engine.deleteTempProject(runId), false, "already gone");
  });

  test("kept keepFailedTempDays when the run fails; Delete now removes it", async () => {
    const code = scripted("code", { A: () => ({ status: "failed", error: { kind: "exception", message: "x" } }) });
    const h = createHarness({ workflows: [tempWorkflow({ kind: "empty" })], executors: { code } });
    const { run, runId } = await runToEnd(h, "w1");
    assert.deepEqual(h.projects.deleted, []);
    assert.equal(run.tempProject?.deleted, false);
    assert.equal(run.tempProject?.deleteAfter, "2026-10-01T10:00:00.000Z");
    assert.equal(await h.engine.deleteTempProject(runId), true);
    assert.deepEqual(h.projects.deleted, [run.projectPath]);
    assert.equal((await h.runStore.load(runId))!.tempProject?.deleted, true);
  });

  test("a git trigger on the project repo clones at the event's sha", async () => {
    const code = scripted("code");
    const git = node("G", "trigger.git", { repo: { kind: "project" }, event: { kind: "push", branches: ["main"] } });
    const h = createHarness({
      workflows: [tempWorkflow({ kind: "clone", url: "https://git.test/r.git", ref: "main" }, [git, node("A", "code")], [edge("G", "A")])],
      executors: { code }
    });
    const fired = await h.engine.fire({
      workflowId: "w1",
      triggerNodeId: "G",
      kind: "git",
      payload: { kind: "git", event: "push", repo: { url: "https://git.test/r.git", name: "r" }, ref: "refs/heads/main", sha: "abc123", branch: "main" }
    });
    await h.engine.waitForRun(fired.runId!);
    assert.deepEqual(h.projects.created[0]!.source, { kind: "clone", url: "https://git.test/r.git", ref: "abc123" });
  });

  test("a temp project that cannot be made fails the run", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [tempWorkflow({ kind: "empty" })], executors: { code } });
    h.projects.failCreate = new Error("NO_GIT_ACCOUNT");
    const { result } = await runToEnd(h, "w1");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /NO_GIT_ACCOUNT/);
  });
});

describe("engine: sub-workflows", () => {
  const child = (id: string, nodes = [T(), node("X", "code")], edges = [edge("T", "X")]) => workflow(id, nodes, edges);

  test("the child's final output is the block's output; runs are linked both ways", async () => {
    const code = scripted("code", { X: (ctx) => ({ status: "succeeded", output: { doubled: (ctx.expressionContext().trigger as { input: number }).input * 2 } }) });
    const parent = workflow("p", [T(), node("S", "workflow", { workflowId: "c", input: "{{ trigger.input }}" })], [edge("T", "S")]);
    const h = createHarness({ workflows: [parent, child("c")], executors: { code } });
    const { run, result } = await runToEnd(h, "p", { input: 21 });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(run.blocks.S!.output, { doubled: 42 });
    const childRunId = run.blocks.S!.childRunId!;
    const childRun = (await h.engine.getRun(childRunId))!;
    assert.equal(childRun.parentRunId, run.id);
    assert.equal(childRun.trigger.kind, "subworkflow");
    assert.deepEqual(childRun.triggerPayload, { kind: "subworkflow", input: 21, parentRunId: run.id, parentNodeId: "S" });
  });

  test("a failing child fails the block with child_run_failed", async () => {
    const code = scripted("code", { X: () => ({ status: "failed", error: { kind: "exception", message: "inner" } }) });
    const parent = workflow("p", [T(), node("S", "workflow", { workflowId: "c" })], [edge("T", "S")]);
    const h = createHarness({ workflows: [parent, child("c")], executors: { code } });
    const { run } = await runToEnd(h, "p");
    assert.equal(run.blocks.S!.error?.kind, "child_run_failed");
    assert.match(run.blocks.S!.error!.message, /inner/);
  });

  test("the depth limit and cycles are refused at run time", async () => {
    const chain = [
      workflow("a", [T(), node("S", "workflow", { workflowId: "b" })], [edge("T", "S")]),
      workflow("b", [T(), node("S", "workflow", { workflowId: "c" })], [edge("T", "S")]),
      workflow("c", [T(), node("X", "code")], [edge("T", "X")])
    ];
    const h = createHarness({ workflows: chain, executors: { code: scripted("code") }, limits: { maxSubWorkflowDepth: 1 } });
    let { run } = await runToEnd(h, "a");
    assert.equal(run.status, "failed");
    const bRun = (await h.engine.getRun(run.blocks.S!.childRunId!))!;
    assert.equal(bRun.blocks.S!.error?.kind, "limit_exceeded");

    const cycle = [
      workflow("x", [T(), node("S", "workflow", { workflowId: "y" })], [edge("T", "S")]),
      workflow("y", [T(), node("S", "workflow", { workflowId: "x" })], [edge("T", "S")])
    ];
    const h2 = createHarness({ workflows: cycle });
    ({ run } = await runToEnd(h2, "x"));
    const yRun = (await h2.engine.getRun(run.blocks.S!.childRunId!))!;
    assert.equal(yRun.blocks.S!.error?.kind, "validation");
    assert.match(yRun.blocks.S!.error!.message, /cycle/);
  });

  test("cancelling the parent cancels the child", async () => {
    const code = controlledExecutor("code");
    const parent = workflow("p", [T(), node("S", "workflow", { workflowId: "c" })], [edge("T", "S")]);
    const h = createHarness({ workflows: [parent, child("c")], executors: { code } });
    const { runId } = await h.engine.run("p", {});
    await flush();
    assert.equal(code.calls.length, 1, "the child is running");
    const childRunId = code.calls[0]!.ctx.runId;
    await h.engine.cancel(runId!);
    assert.equal((await h.engine.waitForRun(childRunId)).status, "cancelled");
    assert.equal((await h.engine.waitForRun(runId!)).status, "cancelled");
  });

  test("child runs bypass the global run cap (no deadlock)", async () => {
    const parent = workflow("p", [T(), node("S", "workflow", { workflowId: "c" })], [edge("T", "S")]);
    const h = createHarness({ workflows: [parent, child("c")], executors: { code: scripted("code") }, limits: { maxConcurrentRuns: 1 } });
    const { result } = await runToEnd(h, "p");
    assert.equal(result.status, "succeeded");
  });
});

describe("engine: deletion and triggers", () => {
  test("deleting a workflow cancels its runs and stops writing them", async () => {
    const code = controlledExecutor("code");
    const wf = workflow("w1", [T(), node("A", "code")], [edge("T", "A")]);
    const h = createHarness({ workflows: [wf], executors: { code } });
    const { runId } = await h.engine.run("w1", {});
    await flush();
    const savesBefore = h.runStore.saves;
    h.store.remove("w1");
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "cancelled");
    assert.equal(h.runStore.saves, savesBefore, "no write after the deletion");
    assert.deepEqual(h.notified, []);
  });

  test("enabledTriggers lists enabled workflows' live trigger nodes; definition changes are forwarded", async () => {
    const sched = (id: string, disabled = false) =>
      node(id, "trigger.schedule", { preset: { kind: "minutes", every: 5 }, cron: "*/5 * * * *" }, { disabled });
    const h = createHarness({
      workflows: [
        workflow("on", [sched("S1"), sched("S2", true), node("A", "code")], [edge("S1", "A"), edge("S2", "A")]),
        workflow("off", [sched("S1"), node("A", "code")], [edge("S1", "A")], { enabled: false })
      ]
    });
    const found = h.engine.enabledTriggers("trigger.schedule");
    assert.deepEqual(found.map((entry) => `${entry.workflow.id}:${entry.node.id}`), ["on:S1"]);
    let calls = 0;
    const off = h.engine.onDefinitionsChanged(() => (calls += 1));
    h.store.put(h.store.get("off")!);
    h.store.remove("off");
    off();
    h.store.remove("on");
    assert.equal(calls, 2);
  });

  test("recordSkipped writes a visible stub", async () => {
    const h = createHarness({ workflows: [workflow("w1", [T(), node("A", "code")], [edge("T", "A")])] });
    await h.engine.recordSkipped({ workflowId: "w1", kind: "schedule", payload: { kind: "schedule", firedAt: "a", scheduledFor: "b" }, text: "Every hour" }, "missed");
    const { runs } = await h.engine.listRuns("w1", { limit: 5 });
    assert.equal(runs[0]!.status, "skipped");
    assert.equal(runs[0]!.skipReason, "missed");
    assert.equal(runs[0]!.trigger.text, "Every hour");
    assert.ok(h.eventsOf("workflowRun.finished").length === 1);
  });

  test("accountPreview answers without a selector", async () => {
    const h = createHarness();
    const decision = await h.engine.accountPreview([], undefined);
    assert.equal(decision.chosen, null);
  });
});
