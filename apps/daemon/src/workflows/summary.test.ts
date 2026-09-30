import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkflowSummary } from "./summary.ts";
import { edge, node, workflow } from "./testing/fakes.ts";

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

function nightly(model: string) {
  const nodes = [
    node("t", "trigger.manual"),
    node("a", "agent", { prompt: { kind: "text", text: "Go" }, chain: [{ agent: "claude", model, accounts: { strategy: "least-used" } }] }, { name: "NightlyTask" })
  ];
  return workflow("wf-n", nodes, [edge("t", "a")]);
}

const liveCatalog = { agents: [{ id: "claude", enabled: true, models: ["default", "opus[1m]", "sonnet", "haiku"] }] };

test("a changed agent catalogue re-judges a cached definition", () => {
  const definition = nightly("opus");
  // No catalogue read yet: nothing is checked.
  assert.equal(buildWorkflowSummary(definition, { runStore, validation: {} }).errorCount, 0);
  // The live catalogue: the same definition object now has an error.
  assert.equal(buildWorkflowSummary(definition, { runStore, validation: { catalog: liveCatalog } }).errorCount, 1);
  // Still probing (models not known): a warning only.
  const pending = { agents: [{ id: "claude", enabled: true, models: null }] };
  assert.equal(buildWorkflowSummary(definition, { runStore, validation: { catalog: pending } }).errorCount, 0);
  // A catalogue that lists it.
  const fallback = { agents: [{ id: "claude", enabled: true, models: ["default", "opus"] }] };
  assert.equal(buildWorkflowSummary(definition, { runStore, validation: { catalog: fallback } }).errorCount, 0);
  assert.equal(buildWorkflowSummary(definition, { runStore, validation: { catalog: liveCatalog } }).errorCount, 1);
});
