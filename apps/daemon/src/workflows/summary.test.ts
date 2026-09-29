import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkflowSummary, validationKey } from "./summary.ts";
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

const edgeTo = (target: string) => edge("t", target);

function nightly(model: string, extraNodes = 0) {
  const nodes = [
    node("t", "trigger.manual"),
    node("a", "agent", { prompt: { kind: "text", text: "Go" }, chain: [{ agent: "claude", model, accounts: { strategy: "least-used" } }] }, { name: "NightlyTask" }),
    ...Array.from({ length: extraNodes }, (_, i) => node(`e${i}`, "agent", { prompt: { kind: "text", text: " " } }, { name: `Empty${i}` }))
  ];
  return workflow("wf-n", nodes, [edgeTo("a"), ...Array.from({ length: extraNodes }, (_, i) => edgeTo(`e${i}`))]);
}

const liveCatalog = { agents: [{ id: "claude", enabled: true, models: ["default", "opus[1m]", "sonnet", "haiku"] }] };

test("the summary lists the errors it counts, so the rail can say what they are", () => {
  const summary = buildWorkflowSummary(nightly("opus"), { runStore, validation: { catalog: liveCatalog } });
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.errors?.length, 1);
  assert.equal(summary.errors?.[0]?.code, "unknown_model");
  assert.equal(summary.errors?.[0]?.nodeId, "a");
  assert.equal(summary.errors?.[0]?.field, "config.chain.0.model");
  assert.match(summary.errors?.[0]?.message ?? "", /NightlyTask: claude has no model "opus"/);
  assert.equal(summary.errorsOmitted, undefined);

  const clean = buildWorkflowSummary(nightly("opus[1m]"), { runStore, validation: { catalog: liveCatalog } });
  assert.equal(clean.errorCount, 0);
  assert.equal("errors" in clean, false);
  assert.equal("errorsOmitted" in clean, false);
});

test("the summary caps its error list and counts the rest", () => {
  const summary = buildWorkflowSummary(nightly("opus", 6), { runStore, validation: { catalog: liveCatalog } });
  assert.equal(summary.errorCount, 7);
  assert.equal(summary.errors?.length, 5);
  assert.equal(summary.errorsOmitted, 2);
});

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

test("the validation key moves with the catalogue and nothing else of it", () => {
  const definition = nightly("opus");
  const a = validationKey(definition, { catalog: liveCatalog });
  assert.equal(a, validationKey(definition, { catalog: { agents: [...liveCatalog.agents] } }));
  assert.notEqual(a, validationKey(definition, {}));
  assert.notEqual(a, validationKey(definition, { catalog: { agents: [{ ...liveCatalog.agents[0]!, models: ["default"] }] } }));
});
