import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowApiError } from "./api-client.ts";

test("WorkflowApiError reads an INVALID_INPUT refusal's input errors, entry by entry", () => {
  const body = {
    error: {
      code: "INVALID_INPUT",
      message: "The input does not fit",
      inputErrors: [{ input: "env", message: "input `env` is required" }, { message: "whole input" }, { input: 3, message: "kept without input" }, { input: "x" }, "junk", null]
    }
  };
  const error = new WorkflowApiError(400, "POST", "/api/workflows/w/run", {}, body);
  assert.equal(error.code, "INVALID_INPUT");
  assert.deepEqual(error.inputErrors, [{ input: "env", message: "input `env` is required" }, { message: "whole input" }, { message: "kept without input" }]);
  assert.deepEqual(new WorkflowApiError(400, "POST", "/x", {}, { error: { code: "INVALID_WORKFLOW", message: "x" } }).inputErrors, []);
});
