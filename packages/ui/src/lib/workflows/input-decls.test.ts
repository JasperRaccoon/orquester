import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowInputDecl } from "@orquester/api";

import {
  addInputDecl,
  freeInputName,
  inputDeclSummary,
  moveInputDecl,
  patchInputDecl,
  removeInputDecl,
  retypeInputDecl,
  valuesFromLines,
  withEnumValues,
  withInputs
} from "./input-decls.ts";

const A: WorkflowInputDecl = { name: "a", type: "string" };
const B: WorkflowInputDecl = { name: "b", type: "number", default: 3 };
const C: WorkflowInputDecl = { name: "c", type: "boolean" };

describe("the inputs list", () => {
  it("adds an input under a free name", () => {
    assert.equal(freeInputName([]), "input1");
    assert.equal(freeInputName([{ name: "input2", type: "string" }]), "input3");
    assert.equal(freeInputName([A, { name: "input3", type: "string" }]), "input4");
    assert.deepEqual(addInputDecl([A]), [A, { name: "input2", type: "string" }]);
  });

  it("moves and removes", () => {
    assert.deepEqual(moveInputDecl([A, B, C], 0, 1), [B, A, C]);
    assert.deepEqual(moveInputDecl([A, B, C], 2, -1), [A, C, B]);
    assert.deepEqual(moveInputDecl([A, B, C], 0, -1), [A, B, C], "out of range: unchanged");
    assert.deepEqual(removeInputDecl([A, B, C], 1), [A, C]);
  });

  it("an emptied list removes `inputs` from the config", () => {
    assert.deepEqual(withInputs({ inputExample: "{}", inputs: [A] }, []), { inputExample: "{}" });
    assert.deepEqual(withInputs({}, [A]), { inputs: [A] });
  });
});

describe("one input", () => {
  it("patch sets and removes fields", () => {
    assert.deepEqual(patchInputDecl(B, { required: true, default: undefined }), { name: "b", type: "number", required: true });
  });

  it("a new type keeps what still fits", () => {
    assert.deepEqual(retypeInputDecl({ name: "x", type: "string", multiline: true, default: "42" }, "number"), { name: "x", type: "number", default: 42 });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "string", default: "abc" }, "number"), { name: "x", type: "number" });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "number", default: 7 }, "string"), { name: "x", type: "string", default: "7" });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "string", default: "true" }, "boolean"), { name: "x", type: "boolean", default: true });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "string", default: "stg" }, "enum"), { name: "x", type: "enum", values: ["stg"], default: "stg" });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "enum", values: ["a", "b"], default: "a", required: true }, "string"), {
      name: "x",
      type: "string",
      default: "a",
      required: true
    });
    assert.deepEqual(retypeInputDecl({ name: "x", type: "boolean" }, "enum"), { name: "x", type: "enum", values: [] });
    assert.equal(retypeInputDecl(A, "string"), A, "the same type: unchanged");
  });

  it("an enum's values come one per line; a default no longer among them is dropped", () => {
    assert.deepEqual(valuesFromLines(" stg \n\nprd\n  \n"), ["stg", "prd"]);
    const decl: WorkflowInputDecl = { name: "env", type: "enum", values: ["stg", "prd"], default: "prd" };
    assert.deepEqual(withEnumValues(decl, ["stg", "prd", "dev"]), { ...decl, values: ["stg", "prd", "dev"] });
    assert.deepEqual(withEnumValues(decl, ["stg"]), { name: "env", type: "enum", values: ["stg"] });
  });

  it("summarises a collapsed input", () => {
    assert.equal(inputDeclSummary({ name: "env", type: "enum", values: ["a", "b"], required: true, default: "a" }), "Choice (2) · required · default “a”");
    assert.equal(inputDeclSummary({ name: "n", type: "string", multiline: true }), "Text · multi-line");
    assert.equal(inputDeclSummary(B), "Number · default 3");
  });
});
