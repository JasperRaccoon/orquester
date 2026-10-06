import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toWorkflowAgentCatalog, workflowAgentCatalogFromSnapshots } from "./agent-catalog.ts";

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
