// validateWorkflow's gate rules (spec 2026-11-10 §6.1, §7.5).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testEdge, testNode, testWorkflow } from "./testing.ts";
import type { WorkflowProblem } from "./types.ts";
import { hasWorkflowErrors, validateWorkflow, type ValidateWorkflowOptions } from "./validate.ts";

const manual = () => testNode("t", "trigger.manual", {}, { name: "Manual" });

function problemsOf(input: unknown, opts?: ValidateWorkflowOptions): WorkflowProblem[] {
  return validateWorkflow(input, opts).problems;
}

function codes(problems: WorkflowProblem[], severity?: WorkflowProblem["severity"]): string[] {
  return problems.filter((problem) => severity === undefined || problem.severity === severity).map((problem) => problem.code);
}

function gate(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return testNode("g", "gate", { question: "Deploy {{ trigger.input.env }}?", ...config }, { name: "Gate", ...extra });
}

function withGate(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return testWorkflow(
    [manual(), gate(config, extra), testNode("ok", "code", {}, { name: "Ok" })],
    [testEdge("t", "g"), testEdge("g", "ok", "choice:approve")],
    overrides
  );
}

describe("validate: gates", () => {
  it("the palette's default gate with a question is valid; its handles are choice:<id> and error", () => {
    assert.deepEqual(problemsOf(withGate()), []);
    const wrong = testWorkflow([manual(), gate(), testNode("ok", "code", {}, { name: "Ok" })], [testEdge("t", "g"), testEdge("g", "ok", "success")]);
    const problem = problemsOf(wrong).find((p) => p.code === "edge_invalid_handle");
    assert.match(problem?.message ?? "", /choice:approve, choice:reject, error/);
  });

  it("2–8 unique choices with labels", () => {
    assert.ok(codes(problemsOf(withGate({ choices: [{ id: "approve", label: "Approve" }] })), "error").includes("gate_choices"));
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, label: `C${i}` }));
    assert.ok(codes(problemsOf(withGate({ choices: [{ id: "approve", label: "A" }, ...nine.slice(1)] })), "error").includes("gate_choices"));
    const dup = problemsOf(withGate({ choices: [{ id: "approve", label: "A" }, { id: "approve", label: "B" }] }));
    assert.ok(codes(dup, "error").includes("gate_choice_duplicate"));
    assert.ok(codes(problemsOf(withGate({ choices: [{ id: "approve", label: "  " }, { id: "reject", label: "No" }] })), "error").includes("gate_choice_label"));
  });

  it("a question is required and at most 300 characters; details at most 8 KB", () => {
    assert.ok(codes(problemsOf(withGate({ question: "  " })), "error").includes("gate_question_empty"));
    assert.ok(codes(problemsOf(withGate({ question: "x".repeat(301) })), "error").includes("gate_question_too_long"));
    assert.ok(codes(problemsOf(withGate({ details: "y".repeat(8 * 1024 + 1) })), "error").includes("gate_details_too_large"));
    assert.deepEqual(problemsOf(withGate({ details: "## Diff\n{{ trigger.input | json }}" })), []);
  });

  it("the timeout is at most 7 days and its choice must exist", () => {
    assert.deepEqual(problemsOf(withGate({ timeout: { minutes: 7 * 24 * 60, then: { kind: "choice", choice: "reject" } } })), []);
    const long = problemsOf(withGate({ timeout: { minutes: 7 * 24 * 60 + 1, then: { kind: "fail" } } }));
    assert.equal(long.find((p) => p.code === "timeout_too_long")?.field, "config.timeout.minutes");
    const missing = problemsOf(withGate({ timeout: { minutes: 30, then: { kind: "choice", choice: "maybe" } } }));
    assert.match(missing.find((p) => p.code === "gate_timeout_choice")?.message ?? "", /"maybe", which is not one of its choices \(approve, reject\)/);
  });

  it("a reviewer agent's chain, prompt and profile are checked like an agent block's", () => {
    const decider = { kind: "agent", prompt: { kind: "text", text: " " }, chain: [{ agent: "nope", model: "x" }], profileId: "gone" };
    const problems = problemsOf(withGate({ decider }), { catalog: { agents: [{ id: "claude", models: ["opus"] }] }, sessionProfileIds: ["p1"] });
    assert.deepEqual(
      problems.filter((p) => ["unknown_agent", "empty_prompt", "unknown_profile"].includes(p.code)).map((p) => [p.code, p.field]),
      [
        ["unknown_agent", "config.decider.chain.0.agent"],
        ["empty_prompt", "config.decider.prompt.text"],
        ["unknown_profile", "config.decider.profileId"]
      ]
    );
    const tooLong = problemsOf(withGate({ decider: { kind: "launcher", maxMinutes: 24 * 60 + 1 } }));
    assert.equal(tooLong.find((p) => p.code === "timeout_too_long")?.field, "config.decider.maxMinutes");
    const chainless = structuredClone(withGate({ decider: { kind: "agent", prompt: { kind: "text", text: "Review" }, chain: [{ agent: "claude", model: "opus" }] } })) as unknown as { nodes: { config: { decider: { chain: unknown[] } } }[] };
    chainless.nodes[1]!.config.decider.chain = [];
    assert.ok(hasWorkflowErrors(problemsOf(chainless)), "a reviewer needs a chain");
  });

  it("a disabled gate warns that it takes its first choice", () => {
    const problems = problemsOf(withGate({}, { disabled: true }));
    const warning = problems.find((p) => p.code === "gate_disabled");
    assert.equal(warning?.severity, "warning");
    assert.match(warning?.message ?? "", /takes its first choice \(Approve\)/);
    assert.equal(hasWorkflowErrors(problems), false);
  });

  it("a pinned gate needs a choice of its own", () => {
    assert.deepEqual(problemsOf(withGate({}, {}, { pinned: { g: { choice: "reject" } } })), []);
    for (const pin of [{ text: "x" }, { choice: "maybe" }, "approve"]) {
      const problem = problemsOf(withGate({}, {}, { pinned: { g: pin } })).find((p) => p.code === "pinned_gate_choice");
      assert.equal(problem?.severity, "error", JSON.stringify(pin));
      assert.match(problem!.message, /approve, reject/);
    }
  });
});
