import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowRun } from "@orquester/api";

import { previewExpressions } from "./expression-preview.ts";
import { edge, node, workflow } from "./testing/fakes.ts";

test("expression preview: {{ loop.* }} reads the block's pass and feedback in the run; a loop edge is never an input", async () => {
  const back = { ...edge("Check", "Fix", "false", "back"), loop: { maxLoops: 2, session: "continue" as const } };
  const wf = workflow("w1", [node("T", "trigger.manual"), node("Fix", "code"), node("Check", "if")], [edge("T", "Fix"), edge("Fix", "Check"), back]);
  const run: WorkflowRun = {
    id: "run-1",
    workflowId: "w1",
    workflowName: wf.name,
    status: "succeeded",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: "2026-09-28T10:00:00.000Z",
    definition: wf,
    triggerPayload: { kind: "manual", input: { task: "x" } },
    blocks: {
      T: { nodeId: "T", name: "T", type: "trigger.manual", status: "succeeded", attempt: 1, output: { kind: "manual", input: { task: "x" } } },
      Fix: { nodeId: "Fix", name: "Fix", type: "code", status: "succeeded", attempt: 1, pass: 2, loopFeedback: "add tests for TOKEN-VALUE", output: 2 },
      Check: { nodeId: "Check", name: "Check", type: "if", status: "succeeded", attempt: 1, handle: "true", pass: 2, output: 2 }
    },
    takenEdges: [],
    deadEdges: [],
    loopCounters: { back: 1 }
  };
  const result = await previewExpressions({
    workflow: wf,
    request: { templates: ["{{ loop.pass }}: {{ loop.feedback }}", "{{ input.kind }}"], node: "Fix" },
    node: wf.nodes.find((candidate) => candidate.id === "Fix")!,
    source: { run, how: "requested", output: async (id) => run.blocks[id]!.output },
    secrets: { TOKEN: "TOKEN-VALUE" },
    now: new Date("2026-09-28T12:00:00.000Z")
  });
  assert.equal(result.results[0]!.text, "2: add tests for «secret:TOKEN»", "the feedback is redacted like every value");
  assert.equal(result.results[1]!.text, "manual", "Fix's input is its forward input (the trigger), never Check through the loop edge");
  assert.deepEqual(result.available.loop, { pass: 2, feedback: { type: "string" } });
  const check = await previewExpressions({
    workflow: wf,
    request: { templates: ["{{ loop.pass }}"], node: "T" },
    node: wf.nodes[0]!,
    source: null,
    secrets: {},
    now: new Date("2026-09-28T12:00:00.000Z")
  });
  assert.equal(check.results[0]!.text, "1", "outside a run, pass 1");
});
