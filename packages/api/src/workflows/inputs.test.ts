import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowInputDecl, WorkflowNodeOf } from "@orquester/config";

import {
  coerceTypedValue,
  declaredInputs,
  inputDeclarationProblems,
  manualTriggerFor,
  validateWorkflowInput,
  workflowInputErrorsText,
  workflowRunInputs
} from "./inputs.ts";
import { testNode, testWorkflow } from "./testing.ts";

const ENV: WorkflowInputDecl = { name: "env", type: "enum", values: ["stg", "prd"], required: true };
const COUNT: WorkflowInputDecl = { name: "count", type: "number", default: 3 };
const DRY: WorkflowInputDecl = { name: "dry", type: "boolean" };
const NOTE: WorkflowInputDecl = { name: "note", type: "string", multiline: true };
const DECLS = [ENV, COUNT, DRY, NOTE];

describe("coerceTypedValue", () => {
  it("numbers: numbers and plain decimal numerals only", () => {
    assert.deepEqual(coerceTypedValue({ type: "number" }, 42), { ok: true, value: 42 });
    assert.deepEqual(coerceTypedValue({ type: "number" }, "42"), { ok: true, value: 42 });
    assert.deepEqual(coerceTypedValue({ type: "number" }, " -1.5 "), { ok: true, value: -1.5 });
    assert.deepEqual(coerceTypedValue({ type: "number" }, "0.25"), { ok: true, value: 0.25 });
    for (const bad of ["", "abc", "0x10", "0b11", "0o7", "1e3", "-1.5e2", "+1", ".5", "1.", "-", "- 1", "Infinity", "1,5", true, null, [], {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(coerceTypedValue({ type: "number" }, bad).ok, false, `rejects ${String(bad)}`);
    }
  });

  it("booleans: true/false and their exact text only", () => {
    assert.deepEqual(coerceTypedValue({ type: "boolean" }, true), { ok: true, value: true });
    assert.deepEqual(coerceTypedValue({ type: "boolean" }, "false"), { ok: true, value: false });
    for (const bad of ["TRUE", "yes", 1, 0, "1", ""]) assert.equal(coerceTypedValue({ type: "boolean" }, bad).ok, false);
  });

  it("text is never coerced from another type", () => {
    assert.deepEqual(coerceTypedValue({ type: "string" }, ""), { ok: true, value: "" });
    assert.equal(coerceTypedValue({ type: "string" }, 42).ok, false);
    assert.equal(coerceTypedValue({ type: "string" }, false).ok, false);
  });

  it("an enum value must be one of the values, exactly", () => {
    assert.deepEqual(coerceTypedValue(ENV, "stg"), { ok: true, value: "stg" });
    const bad = coerceTypedValue(ENV, "STG");
    assert.deepEqual(bad, { ok: false, expected: "must be one of: stg, prd" });
    assert.equal(coerceTypedValue({ type: "enum", values: ["1"] }, 1).ok, false);
  });

  it("json takes any value", () => {
    assert.deepEqual(coerceTypedValue({ type: "json" }, { a: [1] }), { ok: true, value: { a: [1] } });
    assert.deepEqual(coerceTypedValue({ type: "json" }, null), { ok: true, value: null });
  });
});

describe("validateWorkflowInput", () => {
  it("passes any input through when nothing is declared", () => {
    assert.deepEqual(validateWorkflowInput(undefined, [1, 2]), { value: [1, 2], errors: [] });
    assert.deepEqual(validateWorkflowInput([], "text"), { value: "text", errors: [] });
    assert.deepEqual(validateWorkflowInput(undefined, undefined), { value: undefined, errors: [] });
  });

  it("applies defaults and coerces, in declared order", () => {
    const result = validateWorkflowInput(DECLS, { note: "hi", dry: "true", env: "prd" });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.value, { env: "prd", count: 3, dry: true, note: "hi" });
    assert.deepEqual(Object.keys(result.value as object), ["env", "count", "dry", "note"]);
  });

  it("a given value wins over the default; null counts as absent for an optional input", () => {
    assert.deepEqual(validateWorkflowInput(DECLS, { env: "stg", count: "7" }).value, { env: "stg", count: 7 });
    assert.deepEqual(validateWorkflowInput(DECLS, { env: "stg", count: null, dry: null }).value, { env: "stg", count: 3 });
  });

  it("null for a required input is a wrong type, also with a default and in a test run", () => {
    const required: WorkflowInputDecl = { name: "count", type: "number", required: true, default: 3 };
    const expected = [{ input: "count", message: "input `count` must be a number (got null)" }];
    assert.deepEqual(validateWorkflowInput([required], { count: null }).errors, expected);
    assert.deepEqual(validateWorkflowInput([required], { count: null }, { requireAll: false }).errors, expected);
    assert.deepEqual(validateWorkflowInput([ENV], { env: null }).errors, [{ input: "env", message: "input `env` must be one of: stg, prd (got null)" }]);
  });

  it("an absent optional input without a default stays absent", () => {
    const result = validateWorkflowInput([DRY, NOTE], {});
    assert.deepEqual(result, { value: {}, errors: [] });
  });

  it("absent or null input counts as an empty object", () => {
    assert.deepEqual(validateWorkflowInput([COUNT], null), { value: { count: 3 }, errors: [] });
    assert.deepEqual(validateWorkflowInput([COUNT], undefined), { value: { count: 3 }, errors: [] });
  });

  it("returns every error at once, each naming the input and the fix", () => {
    const result = validateWorkflowInput(DECLS, { count: "many", dry: "yes", note: 5, extra: 1 });
    assert.deepEqual(result.errors, [
      { input: "env", message: "input `env` is required: pass one of: stg, prd" },
      { input: "count", message: 'input `count` must be a number (got "many")' },
      { input: "dry", message: 'input `dry` must be true or false (got "yes")' },
      { input: "note", message: "input `note` must be text (got 5)" },
      { input: "extra", message: "unknown input `extra`: remove it (this workflow takes env, count, dry, note)" }
    ]);
  });

  it("names the allowed values for a bad enum value", () => {
    const result = validateWorkflowInput([ENV], { env: "dev" });
    assert.deepEqual(result.errors, [{ input: "env", message: 'input `env` must be one of: stg, prd (got "dev")' }]);
  });

  it("an empty text is missing when the input is required", () => {
    const required: WorkflowInputDecl = { name: "title", type: "string", required: true };
    assert.deepEqual(validateWorkflowInput([required], { title: "" }).errors, [
      { input: "title", message: "input `title` is required: it cannot be empty" }
    ]);
    assert.deepEqual(validateWorkflowInput([{ ...required, required: false }], { title: "" }), { value: { title: "" }, errors: [] });
  });

  it("suggests the declared name for a key in another case", () => {
    const result = validateWorkflowInput([ENV], { env: "stg", ENV: "prd" });
    assert.deepEqual(result.errors, [{ input: "ENV", message: "unknown input `ENV`: did you mean `env`?" }]);
  });

  it("refuses an input that is not an object", () => {
    for (const bad of ["text", 5, [1], true]) {
      const result = validateWorkflowInput(DECLS, bad);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]!.input, undefined);
      assert.match(result.errors[0]!.message, /must be a JSON object of named inputs, e\.g\. \{"env": …, "count": …, "dry": …\}/);
    }
  });

  it("requireAll: false (test runs) skips only the missing required inputs", () => {
    const lenient = validateWorkflowInput(DECLS, {}, { requireAll: false });
    assert.deepEqual(lenient, { value: { count: 3 }, errors: [] });
    const wrong = validateWorkflowInput(DECLS, { count: "x" }, { requireAll: false });
    assert.equal(wrong.errors.length, 1);
    assert.equal(wrong.errors[0]!.input, "count");
  });

  it("names at most ten unknown keys, then counts the rest", () => {
    const input: Record<string, unknown> = { env: "stg" };
    for (let i = 0; i < 25; i += 1) input[`k${i}`] = i;
    const errors = validateWorkflowInput([ENV], input).errors;
    assert.equal(errors.length, 11);
    assert.equal(errors[10]!.message, "15 more unknown inputs: this workflow takes only env");
  });

  it("an own __proto__ key is an unknown input, never a prototype write", () => {
    const input = JSON.parse('{"env":"stg","__proto__":{"polluted":1}}') as unknown;
    const result = validateWorkflowInput([ENV], input);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.input, "__proto__");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  });

  it("quotes long values short", () => {
    const result = validateWorkflowInput([COUNT], { count: "x".repeat(200) });
    assert.ok(result.errors[0]!.message.length < 100);
  });

  it("workflowInputErrorsText joins and caps", () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({ message: `e${i}` }));
    assert.equal(workflowInputErrorsText(errors.slice(0, 2)), "e0; e1");
    assert.match(workflowInputErrorsText(errors), /e9; … \(2 more\)$/);
  });
});

describe("which trigger's inputs a run uses", () => {
  const first = testNode("m1", "trigger.manual", { inputs: [ENV] }, { name: "First", disabled: true });
  const second = testNode("m2", "trigger.manual", { inputs: [COUNT] }, { name: "Second" });
  const schedule = testNode("s", "trigger.schedule", { cron: "0 * * * *" }, { name: "Hourly" });
  const wf = testWorkflow([first, second, schedule]);

  it("the named manual trigger, else the first enabled one", () => {
    assert.equal(manualTriggerFor(wf, "m1")?.id, "m1");
    assert.equal(manualTriggerFor(wf)?.id, "m2");
    assert.equal(manualTriggerFor(wf, "s"), undefined);
    assert.deepEqual(workflowRunInputs(wf), [COUNT]);
    assert.deepEqual(workflowRunInputs(wf, "m1"), [ENV]);
    assert.equal(workflowRunInputs(wf, "s"), undefined);
  });

  it("an empty list declares nothing", () => {
    assert.equal(declaredInputs([]), undefined);
    assert.equal(declaredInputs(undefined), undefined);
    assert.deepEqual(declaredInputs([ENV]), [ENV]);
  });
});

describe("inputDeclarationProblems", () => {
  const manual = (inputs: unknown[]): WorkflowNodeOf<"trigger.manual"> =>
    testNode("t", "trigger.manual", { inputs }, { name: "Manual" }) as WorkflowNodeOf<"trigger.manual">;
  const codesAt = (inputs: unknown[]) => inputDeclarationProblems(manual(inputs)).map((problem) => `${problem.severity}:${problem.code}@${problem.field}`);

  it("a good declaration has no problems", () => {
    assert.deepEqual(codesAt(DECLS), []);
    assert.deepEqual(codesAt([]), []);
  });

  it("names are unique", () => {
    assert.deepEqual(codesAt([COUNT, { ...DRY, name: "count" }]), ["error:duplicate_input@config.inputs.1.name"]);
  });

  it("at most 30 inputs", () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `i${i}`, type: "string" }));
    assert.deepEqual(codesAt(many), ["error:too_many_inputs@config.inputs"]);
  });

  it("an enum has 1–50 unique, non-empty values", () => {
    assert.deepEqual(codesAt([{ name: "e", type: "enum" }]), ["error:input_values@config.inputs.0.values"]);
    assert.deepEqual(codesAt([{ name: "e", type: "enum", values: [] }]), ["error:input_values@config.inputs.0.values"]);
    const fifty = Array.from({ length: 51 }, (_, i) => `v${i}`);
    assert.deepEqual(codesAt([{ name: "e", type: "enum", values: fifty }]), ["error:input_values@config.inputs.0.values"]);
    assert.deepEqual(codesAt([{ name: "e", type: "enum", values: ["a", "a", " "] }]), [
      "error:input_values@config.inputs.0.values.1",
      "error:input_values@config.inputs.0.values.2"
    ]);
  });

  it("values on a non-enum only warn", () => {
    assert.deepEqual(codesAt([{ name: "s", type: "string", values: ["a"] }]), ["warning:input_values_ignored@config.inputs.0.values"]);
  });

  it("the default fits the type and the values exactly", () => {
    assert.deepEqual(codesAt([{ name: "n", type: "number", default: "42" }]), ["error:input_default@config.inputs.0.default"]);
    assert.deepEqual(codesAt([{ name: "b", type: "boolean", default: "true" }]), ["error:input_default@config.inputs.0.default"]);
    assert.deepEqual(codesAt([{ name: "s", type: "string", default: 1 }]), ["error:input_default@config.inputs.0.default"]);
    assert.deepEqual(codesAt([{ ...ENV, default: "dev" }]), ["error:input_default@config.inputs.0.default"]);
    assert.deepEqual(codesAt([{ ...ENV, default: "prd" }, { name: "n", type: "number", default: 0 }, { name: "b", type: "boolean", default: false }]), []);
    const message = inputDeclarationProblems(manual([{ ...ENV, default: "dev" }]))[0]!.message;
    assert.equal(message, 'Manual: input `env`: the default must be one of: stg, prd (it is "dev")');
  });

  it("the description is at most 300 characters", () => {
    assert.deepEqual(codesAt([{ name: "s", type: "string", description: "x".repeat(301) }]), [
      "error:input_description_too_long@config.inputs.0.description"
    ]);
    assert.deepEqual(codesAt([{ name: "s", type: "string", description: "x".repeat(300) }]), []);
  });

  it("only text can be multi-line", () => {
    assert.deepEqual(codesAt([{ name: "n", type: "number", multiline: true }]), ["error:input_multiline@config.inputs.0.multiline"]);
    assert.deepEqual(codesAt([{ name: "n", type: "number", multiline: false }]), []);
  });
});
