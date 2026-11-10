import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkStepReport, passThroughHandle, pinnedHandle, pinnedOutcomeProblem, reportRequired, stepReportDecl, type StepReportDecl } from "./outcomes.ts";
import { testNode } from "./testing.ts";

const decl: StepReportDecl = {
  outcomes: [{ id: "approved" }, { id: "changes_requested" }],
  outputs: [
    { name: "pr_url", type: "string" },
    { name: "count", type: "number" },
    { name: "ok", type: "boolean", required: false },
    { name: "env", type: "enum", values: ["stg", "prd"], required: false },
    { name: "data", type: "json", required: false }
  ]
};

describe("reportRequired / stepReportDecl", () => {
  it("only an agent block that declares outcomes or outputs reports", () => {
    assert.equal(reportRequired({}), false);
    assert.equal(reportRequired({ outcomes: [], outputs: [] }), false);
    assert.equal(reportRequired({ outputs: [{ name: "a", type: "string" }] }), true);
    assert.equal(reportRequired(stepReportDecl(testNode("A", "agent", { outcomes: [{ id: "a" }, { id: "b" }] }))), true);
    assert.deepEqual(stepReportDecl(testNode("C", "code")), {});
  });
});

describe("checkStepReport (spec 2026-11-10 §5.2)", () => {
  it("accepts a valid report, coercing number and boolean text and nothing else", () => {
    const check = checkStepReport(decl, { outcome: "approved", summary: " Looks good. ", outputs: { pr_url: "https://x/1", count: "42", ok: "true", env: "prd", data: { a: [1] } } });
    assert.deepEqual(check, { ok: true, report: { outcome: "approved", summary: "Looks good.", outputs: { pr_url: "https://x/1", count: 42, ok: true, env: "prd", data: { a: [1] } } } });
  });

  it("lists every problem at once, each naming what is allowed", () => {
    const check = checkStepReport(decl, { outcome: "lgtm", summary: "", outputs: { count: "many", ok: "yes", env: "dev", extra: 1 } });
    assert.equal(check.ok, false);
    if (check.ok) return;
    assert.deepEqual(check.problems, [
      "outcome \"lgtm\" is not one of this step's outcomes: use `approved` or `changes_requested`.",
      "summary is required: a short text saying what you did and found.",
      "Unknown output `extra`: this step's outputs are `pr_url`, `count`, `ok`, `env` or `data`.",
      "outputs.pr_url is required: a string.",
      "outputs.count must be a number.",
      "outputs.ok must be a boolean.",
      "outputs.env must be one of `stg` or `prd`."
    ]);
  });

  it("requires an outcome when outcomes are declared, and refuses one when none are", () => {
    const missing = checkStepReport(decl, { summary: "x", outputs: { pr_url: "u", count: 1 } });
    assert.ok(!missing.ok && missing.problems[0] === "outcome is required: one of `approved` or `changes_requested`.");
    const outputsOnly: StepReportDecl = { outputs: [{ name: "pr_url", type: "string" }] };
    const stray = checkStepReport(outputsOnly, { outcome: "approved", summary: "x", outputs: { pr_url: "u" } });
    assert.ok(!stray.ok && stray.problems[0] === "This step declares no outcomes: leave outcome out.");
    assert.deepEqual(checkStepReport(outputsOnly, { summary: "x", outputs: { pr_url: "u" } }), { ok: true, report: { summary: "x", outputs: { pr_url: "u" } } });
  });

  it("caps the summary and refuses outputs on a step that declares none", () => {
    const long = checkStepReport({ outcomes: [{ id: "a" }, { id: "b" }] }, { outcome: "a", summary: "x".repeat(2_001) });
    assert.ok(!long.ok && /at most 2000/.test(long.problems[0]!));
    const noOutputs = checkStepReport({ outcomes: [{ id: "a" }, { id: "b" }] }, { outcome: "a", summary: "x", outputs: { y: 1 } });
    assert.ok(!noOutputs.ok && noOutputs.problems[0] === "This step declares no outputs: leave outputs out.");
    assert.deepEqual(checkStepReport({ outcomes: [{ id: "a" }, { id: "b" }] }, { outcome: "a", summary: "x" }), { ok: true, report: { outcome: "a", summary: "x" } });
  });

  it("refuses outputs that are not an object", () => {
    const check = checkStepReport(decl, { outcome: "approved", summary: "x", outputs: ["a"] });
    assert.ok(!check.ok && check.problems[0]!.startsWith("outputs must be an object with `pr_url`"));
  });

  it("coerces outputs exactly as run inputs are coerced (§4.2): plain decimal numerals, true/false", () => {
    const typed: StepReportDecl = {
      outputs: [
        { name: "n", type: "number", required: false },
        { name: "b", type: "boolean", required: false },
        { name: "s", type: "string", required: false }
      ]
    };
    const outputsOf = (outputs: Record<string, unknown>) => {
      const check = checkStepReport(typed, { summary: "x", outputs });
      return check.ok ? check.report.outputs : null;
    };
    assert.deepEqual(outputsOf({ n: " 3.5 ", b: "true", s: "t" }), { n: 3.5, b: true, s: "t" });
    assert.deepEqual(outputsOf({ n: "-42" }), { n: -42 });
    for (const bad of ["", "0x1f", "0b11", "0o7", "1e3", "+1", ".5", "1.", "Infinity"]) assert.equal(outputsOf({ n: bad }), null, `rejects ${JSON.stringify(bad)}`);
    assert.equal(outputsOf({ s: 5 }), null);
    assert.equal(outputsOf({ b: "True" }), null);
  });
});

describe("disabled and pinned blocks with outcomes (§7.5)", () => {
  const withOutcomes = testNode("Review", "agent", { outcomes: [{ id: "approved" }, { id: "changes_requested" }] });
  const plain = testNode("Plain", "agent");

  it("a disabled block passes through on its first outcome, else success", () => {
    assert.equal(passThroughHandle(withOutcomes), "outcome:approved");
    assert.equal(passThroughHandle(plain), "success");
    assert.equal(passThroughHandle(testNode("t", "trigger.manual")), "success");
  });

  it("a pin picks the outcome handle, and needs a declared outcome", () => {
    assert.equal(pinnedHandle(withOutcomes, { outcome: "changes_requested", text: "" }), "outcome:changes_requested");
    assert.equal(pinnedHandle(withOutcomes, { text: "" }), null);
    assert.equal(pinnedHandle(withOutcomes, { outcome: "nope" }), null);
    assert.equal(pinnedHandle(plain, { text: "" }), "success");
    assert.equal(pinnedHandle(testNode("s", "stop"), 1), null);
    assert.equal(pinnedOutcomeProblem(plain, {}), null);
    assert.match(pinnedOutcomeProblem(withOutcomes, 5)!, /must include "outcome"/);
  });

  it("a disabled gate takes its first choice; a pinned gate the choice its pin names (§7.5)", () => {
    const gate = testNode("Gate", "gate", { question: "Ship?", choices: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }] });
    assert.equal(passThroughHandle(gate), "choice:approve");
    assert.equal(pinnedHandle(gate, { choice: "reject" }), "choice:reject");
    assert.equal(pinnedHandle(gate, { choice: "nope" }), null);
    assert.equal(pinnedHandle(gate, { outcome: "approve" }), null);
    assert.equal(pinnedOutcomeProblem(gate, {}), null);
  });
});
