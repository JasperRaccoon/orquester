import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderModel } from "@orquester/api/agent-chat";
import { agentLabelFor, modelLabelFor, resolveSavedPrompt } from "./variables.ts";

describe("chat variables", () => {
  it("renders both as empty without a target chat", async () => {
    assert.deepEqual(
      await resolveSavedPrompt({
        body: "[{agent}|{model}]", projectPath: "/w/acme/app", sessionId: null,
        agentLabel: "Claude", modelLabel: "Opus",
        api: { gitStatus: async () => { throw new Error("Unexpected git read"); }, gitWorkingDiff: async () => { throw new Error("Unexpected git read"); } }
      }),
      { ok: true, text: "[|]" }
    );
  });

  it("labels an agent by its registry name and a model by its catalogue name, else the raw id", () => {
    assert.equal(agentLabelFor("claude", [{ id: "claude", name: "Claude Code" }]), "Claude Code");
    assert.equal(agentLabelFor("mystery", [{ id: "claude", name: "Claude Code" }]), "mystery");
    const models: ProviderModel[] = [
      { slug: "opus", name: "Claude Opus 4.1", shortName: "Opus 4.1", capabilities: null },
      { slug: "sonnet", name: "Claude Sonnet 4.5", capabilities: null }
    ];
    assert.equal(modelLabelFor(models, "opus"), "Opus 4.1");
    assert.equal(modelLabelFor(models, "sonnet"), "Claude Sonnet 4.5");
    assert.equal(modelLabelFor(models, "gpt-5.1-codex"), "gpt-5.1-codex", "not in the catalogue");
    assert.equal(modelLabelFor(undefined, "gpt-5"), "gpt-5");
    assert.equal(modelLabelFor(models, null), "");
  });
});
