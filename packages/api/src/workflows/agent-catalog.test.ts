import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { providerModelsAreLive, toWorkflowAgentCatalog, workflowAgentCatalogFromSnapshots, workflowAgentCatalogKey } from "./agent-catalog.ts";
import { testEdge, testNode, testWorkflow } from "./testing.ts";
import { validateWorkflow } from "./validate.ts";

const models = (...slugs: string[]) => slugs.map((slug) => ({ slug, name: slug }));

describe("toWorkflowAgentCatalog", () => {
  it("lists a probed provider's slugs, legacy ones included", () => {
    const legacy = { slug: "old", name: "Old", isLegacy: true };
    assert.deepEqual(
      toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "ready", models: [...models("default", "opus[1m]"), legacy] }]),
      { agents: [{ id: "claude", enabled: true, models: ["default", "opus[1m]", "old"] }] }
    );
  });

  it("reads models as not known while the provider is unknown, missing, or lists none", () => {
    const catalog = toWorkflowAgentCatalog([
      { id: "claude", enabled: true, status: "unknown", models: models("opus") },
      { id: "codex", enabled: true, models: models("gpt-5.5") },
      { id: "grok", enabled: false, status: "error", models: [] },
      { id: "opencode", status: "ready", models: null }
    ]);
    assert.deepEqual(catalog.agents, [
      { id: "claude", enabled: true, models: null },
      { id: "codex", enabled: true, models: null },
      { id: "grok", enabled: false, models: null },
      { id: "opencode", models: null }
    ]);
  });

  it("never counts a list a failed probe left in place: degraded, errored or unrecognised reads as not known", () => {
    // Claude after a failed probe: `degraded`, carrying its bundled fallback list.
    const fallback = models("default", "opus", "sonnet", "haiku", "fable");
    for (const status of ["degraded", "error", "", "probing", null]) {
      assert.equal(toWorkflowAgentCatalog([{ id: "claude", enabled: true, status, models: fallback }]).agents[0]?.models, null, String(status));
    }
    assert.equal(providerModelsAreLive("ready"), true);
    assert.equal(providerModelsAreLive("degraded"), false);
    assert.equal(providerModelsAreLive(undefined), false);
  });
});

describe("workflowAgentCatalogFromSnapshots", () => {
  it("joins chat registry entries to their adapter's snapshot and skips non-chat entries", () => {
    const catalog = workflowAgentCatalogFromSnapshots(
      [
        { id: "claude", enabled: true, chat: { adapter: "claude" } },
        { id: "aider", enabled: true },
        { id: "codex", enabled: false, chat: { adapter: "codex" } },
        { id: "opencode", enabled: true, chat: { adapter: "opencode" } }
      ],
      [
        { id: "claude", refIds: ["claude"], status: "ready", models: models("default", "opus[1m]") },
        { id: "codex", refIds: ["codex"], status: "unknown", models: models("gpt-5.5") }
      ]
    );
    assert.deepEqual(catalog.agents, [
      { id: "claude", enabled: true, models: ["default", "opus[1m]"] },
      { id: "codex", enabled: false, models: null },
      { id: "opencode", enabled: true, models: null }
    ]);
  });

  it("falls back to the snapshot that lists the entry among its refIds", () => {
    const catalog = workflowAgentCatalogFromSnapshots(
      [{ id: "claude-alt", enabled: true, chat: { adapter: "anthropic" } }],
      [{ id: "claude", refIds: ["claude", "claude-alt"], status: "ready", models: models("default") }]
    );
    assert.deepEqual(catalog.agents, [{ id: "claude-alt", enabled: true, models: ["default"] }]);
  });
});

describe("workflowAgentCatalogKey", () => {
  it("is stable across agent order and moves with models, loading and enabling", () => {
    const a = toWorkflowAgentCatalog([
      { id: "claude", enabled: true, status: "ready", models: models("default", "opus[1m]") },
      { id: "codex", enabled: true, status: "ready", models: models("gpt-6") }
    ]);
    const b = { agents: [...a.agents].reverse() };
    assert.equal(workflowAgentCatalogKey(a), workflowAgentCatalogKey(b));
    assert.equal(workflowAgentCatalogKey(undefined), "-");
    const variants = [
      toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "ready", models: models("default") }]),
      toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "unknown", models: models("default") }]),
      toWorkflowAgentCatalog([{ id: "claude", enabled: false, status: "ready", models: models("default") }]),
      toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "ready", models: models("default", "opus[1m]") }])
    ];
    assert.equal(new Set(variants.map(workflowAgentCatalogKey)).size, variants.length);
  });
});

describe("validation over a failed probe's fallback list", () => {
  it("a live slug the fallback list lacks is only a warning, so enabling is not refused", () => {
    const workflow = testWorkflow(
      [
        testNode("t", "trigger.manual", {}, { name: "Manual" }),
        testNode("a", "agent", { prompt: { kind: "text", text: "Go" }, chain: [{ agent: "claude", model: "opus[1m]", accounts: {} }] }, { name: "A" })
      ],
      [testEdge("t", "a")]
    );
    const degraded = toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "degraded", models: models("default", "opus", "sonnet", "haiku", "fable") }]);
    const problems = validateWorkflow(workflow, { catalog: degraded }).problems.filter((problem) => problem.code === "unknown_model");
    assert.deepEqual(problems.map((problem) => problem.severity), ["warning"]);
    const ready = toWorkflowAgentCatalog([{ id: "claude", enabled: true, status: "ready", models: models("default", "opus", "sonnet") }]);
    assert.deepEqual(
      validateWorkflow(workflow, { catalog: ready }).problems.filter((problem) => problem.code === "unknown_model").map((problem) => problem.severity),
      ["error"]
    );
  });
});
