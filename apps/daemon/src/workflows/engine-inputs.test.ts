// Typed manual-trigger inputs at run creation (spec 2026-11-10 §4.2, §7.5, §11): validated and
// defaulted for a run, lenient for a test run and "Test one block", never re-checked for a retry,
// and checked against a sub-workflow's own declared inputs.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkflowInputDecl } from "@orquester/api";

import { WorkflowEngineError } from "./run-context.ts";
import { edge, node, workflow } from "./testing/fakes.ts";
import { createHarness, scripted } from "./testing/harness.ts";

const INPUTS: WorkflowInputDecl[] = [
  { name: "env", type: "enum", values: ["stg", "prd"], required: true },
  { name: "count", type: "number", default: 2 },
  { name: "dry", type: "boolean" }
];

const typed = (id = "T", inputs: WorkflowInputDecl[] = INPUTS) => node(id, "trigger.manual", { inputs });

function isInvalidInput(error: unknown): error is WorkflowEngineError {
  return error instanceof WorkflowEngineError && error.code === "INVALID_INPUT" && error.statusCode === 400;
}

describe("engine: typed manual-trigger inputs", () => {
  test("a run stores the validated, defaulted input; blocks read it", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [workflow("w1", [typed(), node("A", "code")], [edge("T", "A")])], executors: { code } });
    const response = await h.engine.run("w1", { input: { env: "prd", dry: "true" } });
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.triggerPayload, { kind: "manual", input: { env: "prd", count: 2, dry: true } });
    assert.deepEqual(run.blocks.A!.output, { node: "A", input: { kind: "manual", input: { env: "prd", count: 2, dry: true } } });
  });

  test("a bad input refuses the run with every problem, and starts nothing", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [workflow("w1", [typed(), node("A", "code")], [edge("T", "A")])], executors: { code } });
    let caught: unknown;
    await h.engine.run("w1", { input: { count: "lots", extra: 1 } }).catch((error: unknown) => {
      caught = error;
    });
    assert.ok(isInvalidInput(caught));
    assert.deepEqual(
      caught.inputErrors?.map((error) => error.input),
      ["env", "count", "extra"]
    );
    assert.match(caught.message, /input `env` is required: pass one of: stg, prd; input `count` must be a number \(got "lots"\); unknown input `extra`/);
    assert.equal((await h.engine.listRuns("w1", { limit: 10 })).runs.length, 0, "no run was recorded");
    assert.deepEqual(code.seen, []);
    await assert.rejects(h.engine.run("w1", {}), isInvalidInput, "no input at all misses the required one");
    await assert.rejects(h.engine.run("w1", { input: [1] }), isInvalidInput, "a list is not an object of inputs");
  });

  test("without declared inputs any input passes through as before", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [workflow("w1", [node("T", "trigger.manual"), node("A", "code")], [edge("T", "A")])], executors: { code } });
    const response = await h.engine.run("w1", { input: ["anything", 1] });
    await h.engine.waitForRun(response.runId!);
    assert.deepEqual((await h.engine.getRun(response.runId!))!.triggerPayload, { kind: "manual", input: ["anything", 1] });
  });

  test("a test run applies defaults without requiring every input, but still refuses a wrong type", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [workflow("w1", [typed(), node("A", "code")], [edge("T", "A")])], executors: { code } });
    const response = await h.engine.run("w1", { test: true });
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.test, true);
    assert.deepEqual(run.triggerPayload, { kind: "manual", input: { count: 2 } });
    await assert.rejects(h.engine.run("w1", { test: true, input: { env: "dev" } }), isInvalidInput);
  });

  test("Test one block runs with the defaults", async () => {
    const code = scripted("code");
    const h = createHarness({ workflows: [workflow("w1", [typed(), node("A", "code"), node("B", "code")], [edge("T", "A"), edge("A", "B")])], executors: { code } });
    const response = await h.engine.testNode("w1", "A");
    await h.engine.waitForRun(response.runId!);
    assert.deepEqual((await h.engine.getRun(response.runId!))!.triggerPayload, { kind: "manual", input: { count: 2 } });
  });

  test("a retry reuses its source run's payload, never re-checked against a later inputs change", async () => {
    let fail = true;
    const code = scripted("code", {
      A: (ctx) => (fail ? { status: "failed", error: { kind: "exception", message: "flaky" } } : { status: "succeeded", output: ctx.expressionContext().trigger })
    });
    const h = createHarness({ workflows: [workflow("w1", [typed(), node("A", "code")], [edge("T", "A")])], executors: { code } });
    const first = await h.engine.run("w1", { input: { env: "stg" } });
    await h.engine.waitForRun(first.runId!);
    // A new required input the first run never had.
    h.store.put(workflow("w1", [typed("T", [...INPUTS, { name: "ticket", type: "string", required: true }]), node("A", "code")], [edge("T", "A")]));
    fail = false;
    const retry = await h.engine.run("w1", { retryOf: first.runId! });
    await h.engine.waitForRun(retry.runId!);
    const run = (await h.engine.getRun(retry.runId!))!;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.triggerPayload, { kind: "manual", input: { env: "stg", count: 2 } });
  });
});

describe("engine: a sub-workflow's declared inputs", () => {
  test("the block's value is validated and defaulted against the child's inputs", async () => {
    const code = scripted("code");
    const parent = workflow("p", [node("T", "trigger.manual"), node("S", "workflow", { workflowId: "c", input: "{{ trigger.input }}" })], [edge("T", "S")]);
    const child = workflow("c", [typed(), node("X", "code")], [edge("T", "X")]);
    const h = createHarness({ workflows: [parent, child], executors: { code } });
    const response = await h.engine.run("p", { input: { env: "prd", count: "5" } });
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.status, "succeeded");
    const childRun = (await h.engine.getRun(run.blocks.S!.childRunId!))!;
    assert.deepEqual((childRun.triggerPayload as { input: unknown }).input, { env: "prd", count: 5 });
  });

  test("a value the child's inputs refuse fails the block with the same error list; no child starts", async () => {
    const code = scripted("code");
    const parent = workflow("p", [node("T", "trigger.manual"), node("S", "workflow", { workflowId: "c", input: "{{ trigger.input }}" })], [edge("T", "S")]);
    const child = workflow("c", [typed(), node("X", "code")], [edge("T", "X")]);
    const h = createHarness({ workflows: [parent, child], executors: { code } });
    const response = await h.engine.run("p", { input: { env: "dev", junk: true } });
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.status, "failed");
    const error = run.blocks.S!.error!;
    assert.equal(error.kind, "validation");
    assert.match(error.message, /The input does not fit the inputs of the sub-workflow "Workflow c": input `env` must be one of: stg, prd/);
    assert.deepEqual(
      (error.detail as { inputErrors: { input?: string }[] }).inputErrors.map((entry) => entry.input),
      ["env", "junk"]
    );
    assert.equal(run.blocks.S!.childRunId, undefined);
    assert.deepEqual(code.seen, []);
  });

  test("a test run's child gets defaults without needing every required input", async () => {
    const code = scripted("code");
    const parent = workflow("p", [node("T", "trigger.manual"), node("S", "workflow", { workflowId: "c", input: "{{ trigger.input }}" })], [edge("T", "S")]);
    const child = workflow("c", [typed(), node("X", "code")], [edge("T", "X")]);
    const h = createHarness({ workflows: [parent, child], executors: { code } });
    const response = await h.engine.run("p", { test: true, input: {} });
    await h.engine.waitForRun(response.runId!);
    const run = (await h.engine.getRun(response.runId!))!;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(((await h.engine.getRun(run.blocks.S!.childRunId!))!.triggerPayload as { input: unknown }).input, { count: 2 });
  });
});
