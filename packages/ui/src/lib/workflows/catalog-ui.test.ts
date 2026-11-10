import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowNode } from "@orquester/api";

import { nodeSummary } from "./catalog-ui.ts";

const testNode = (id: string, type: "trigger.manual", config: Record<string, unknown> = {}): WorkflowNode =>
  ({ id, name: "Manual", type, position: { x: 0, y: 0 }, config }) as WorkflowNode;

test("a manual trigger's line names its typed inputs, else says whether it has an example", () => {
  assert.equal(nodeSummary(testNode("t", "trigger.manual")), "Run now");
  assert.equal(nodeSummary(testNode("t", "trigger.manual", { inputExample: "{}" })), "Run now · with input");
  assert.equal(nodeSummary(testNode("t", "trigger.manual", { inputs: [{ name: "env", type: "string" }] })), "Run now · 1 input: env");
  const four = ["a", "b", "c", "d"].map((name) => ({ name, type: "string" }));
  assert.equal(nodeSummary(testNode("t", "trigger.manual", { inputs: four, inputExample: "{}" })), "Run now · 4 inputs: a, b, c, …");
});
