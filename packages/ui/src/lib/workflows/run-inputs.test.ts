import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowInputDecl } from "@orquester/api";

import {
  checkRunInputValues,
  initialRunInputValues,
  placeInputErrors,
  runInputFromValues,
  runInputJson,
  runInputValuesFromJson,
  summaryRunInputs
} from "./run-inputs.ts";

const INPUTS: WorkflowInputDecl[] = [
  { name: "env", type: "enum", values: ["stg", "prd"], required: true },
  { name: "count", type: "number", default: 2 },
  { name: "dry", type: "boolean", default: true },
  { name: "title", type: "string", required: true },
  { name: "branch", type: "string", default: "main" },
  { name: "note", type: "string", multiline: true }
];

describe("the Run now form's values", () => {
  it("start from the defaults, else empty", () => {
    assert.deepEqual(initialRunInputValues(INPUTS), { env: undefined, count: 2, dry: true, title: "", branch: "main", note: "" });
    assert.deepEqual(initialRunInputValues([{ name: "b", type: "boolean" }]), { b: false });
  });

  it("send what was set; empty fields are left out for the daemon to default or require", () => {
    const values = initialRunInputValues(INPUTS);
    assert.deepEqual(runInputFromValues(INPUTS, values), { count: 2, dry: true, branch: "main" });
    assert.deepEqual(runInputFromValues(INPUTS, { ...values, env: "prd", title: "Ship", note: "line 1\nline 2", count: undefined }), {
      env: "prd",
      dry: true,
      title: "Ship",
      branch: "main",
      note: "line 1\nline 2"
    });
  });

  it("an emptied text keeps its emptiness when the input has a default", () => {
    assert.equal(runInputFromValues(INPUTS, { ...initialRunInputValues(INPUTS), branch: "" }).branch, "");
  });

  it("are checked as the daemon checks a run", () => {
    const errors = checkRunInputValues(INPUTS, initialRunInputValues(INPUTS));
    assert.deepEqual(errors.map((error) => error.input), ["env", "title"]);
    assert.deepEqual(checkRunInputValues(INPUTS, { ...initialRunInputValues(INPUTS), env: "stg", title: "x" }), []);
  });
});

describe("placeInputErrors", () => {
  it("puts a declared input's error beside its field, without the input's name; the rest above the form", () => {
    const placed = placeInputErrors(INPUTS, [
      { input: "env", message: "input `env` must be one of: stg, prd (got \"dev\")" },
      { input: "env", message: "a second one is not shown" },
      { input: "extra", message: "unknown input `extra`: remove it" },
      { message: "The input must be a JSON object" }
    ]);
    assert.deepEqual(placed.byInput, { env: 'Must be one of: stg, prd (got "dev")' });
    assert.deepEqual(placed.general, ["unknown input `extra`: remove it", "The input must be a JSON object"]);
  });
});

describe("Edit as JSON", () => {
  it("shows the input the form would send", () => {
    const values = { ...initialRunInputValues(INPUTS), env: "stg" };
    assert.equal(runInputJson(INPUTS, values), JSON.stringify({ env: "stg", count: 2, dry: true, branch: "main" }, null, 2));
  });

  it("goes back to the form with the JSON's values, coerced like the daemon does", () => {
    const back = runInputValuesFromJson(INPUTS, '{ "env": "prd", "count": "7", "dry": "false", "title": "T", "note": null }');
    assert.deepEqual(back, { ok: true, values: { env: "prd", count: 7, dry: false, title: "T", branch: "", note: "" } });
    assert.deepEqual(runInputValuesFromJson(INPUTS, ""), { ok: true, values: { env: undefined, count: undefined, dry: false, title: "", branch: "", note: "" } });
    assert.equal(runInputValuesFromJson(INPUTS, "null").ok, true);
  });

  it("refuses what the form cannot show, saying what is in the way", () => {
    assert.deepEqual(runInputValuesFromJson(INPUTS, '{ "env": "dev", "x": 1 }'), {
      ok: false,
      problems: ["“x” is not one of the inputs.", "env must be one of: stg, prd."]
    });
    const broken = runInputValuesFromJson(INPUTS, "{ nope");
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? "" : broken.problems[0]!, /^Not valid JSON/);
    assert.deepEqual(runInputValuesFromJson(INPUTS, "[1]"), { ok: false, problems: ["The input must be a JSON object of named inputs."] });
  });
});

describe("summaryRunInputs", () => {
  it("reads the manual trigger summary that carries inputs", () => {
    assert.equal(summaryRunInputs([{ nodeId: "s", type: "trigger.schedule", text: "Hourly" }]), undefined);
    assert.equal(summaryRunInputs([{ nodeId: "t", type: "trigger.manual", text: "Run now", inputs: [] }]), undefined);
    assert.deepEqual(summaryRunInputs([{ nodeId: "s", type: "trigger.schedule", text: "Hourly" }, { nodeId: "t", type: "trigger.manual", text: "Run now", inputs: INPUTS }]), INPUTS);
  });
});
