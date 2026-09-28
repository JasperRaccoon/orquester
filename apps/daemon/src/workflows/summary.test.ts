import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkflowSummary } from "./summary.ts";
import { node, workflow } from "./testing/fakes.ts";

const runStore = { latestForWorkflow: () => undefined, activeForWorkflow: () => [] };

test("the summary carries settings.notify so open clients honour it", () => {
  const defaults = buildWorkflowSummary(workflow("wf-a", [node("t", "trigger.manual")]), { runStore });
  assert.deepEqual(defaults.notify, { onFailure: true, onSuccess: false });
  const custom = buildWorkflowSummary(
    workflow("wf-b", [node("t", "trigger.manual")], [], { settings: { notify: { onFailure: false, onSuccess: true } } }),
    { runStore }
  );
  assert.deepEqual(custom.notify, { onFailure: false, onSuccess: true });
});
