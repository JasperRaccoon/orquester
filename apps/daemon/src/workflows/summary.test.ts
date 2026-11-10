import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkflowSummary } from "./summary.ts";
import { edge, node, workflow } from "./testing/fakes.ts";

const runStore = { latestForWorkflow: () => undefined, activeForWorkflow: () => [] };

test("a manual trigger's declared inputs are on its trigger summary (spec 2026-11-10 §8)", () => {
  const inputs = [{ name: "env", type: "enum" as const, values: ["stg", "prd"], required: true }];
  const summary = buildWorkflowSummary(
    workflow("w1", [node("T", "trigger.manual", { inputs }), node("Plain", "trigger.manual"), node("A", "code")], [edge("T", "A"), edge("Plain", "A")]),
    { runStore }
  );
  assert.deepEqual(summary.triggers.find((trigger) => trigger.nodeId === "T")?.inputs, inputs);
  assert.equal("inputs" in summary.triggers.find((trigger) => trigger.nodeId === "Plain")!, false, "none declared: no inputs key");
  // Only the trigger a run starts from (the first enabled manual one) carries them.
  const off = buildWorkflowSummary(
    workflow("w3", [node("Off", "trigger.manual", { inputs }, { disabled: true }), node("On", "trigger.manual", { inputs })]),
    { runStore }
  );
  assert.deepEqual(off.triggers.map((trigger) => "inputs" in trigger), [false, true]);
  const empty = buildWorkflowSummary(workflow("w2", [node("T", "trigger.manual", { inputs: [] })]), { runStore });
  assert.equal("inputs" in empty.triggers[0]!, false, "an empty list declares nothing");
});
