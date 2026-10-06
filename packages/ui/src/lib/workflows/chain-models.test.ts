import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AgentChainEntry, CreateWorkflowRequest } from "@orquester/api";
import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

import { providersStore } from "../agent-chat/providers.ts";

import { liveDefaultNodeConfig, withLiveChainModels } from "./chain-models.ts";

const model = (slug: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ slug, name: slug, capabilities: null, ...extra });

function snapshot(id: string, status: ProviderSnapshot["status"], models: ProviderModel[]): ProviderSnapshot {
  return {
    id,
    refIds: [id],
    installed: true,
    version: null,
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-09-29T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: []
  } as unknown as ProviderSnapshot;
}

/** Shaped like the live host's catalogue (2026-09): no bare `opus`; gpt-5.5 kept only as legacy. */
const LIVE: ProviderSnapshot[] = [
  snapshot("claude", "ready", [
    model("default", { isDefault: true }),
    model("opus[1m]"),
    model("claude-fable-5[1m]"),
    model("claude-fable-5-1[1m]"),
    model("sonnet"),
    model("haiku")
  ]),
  snapshot("codex", "ready", [model("gpt-6-astra", { isDefault: true }), model("gpt-6-sol"), model("gpt-5.6-sol"), model("gpt-5.5", { isLegacy: true })])
];

beforeEach(() => providersStore.setState({ providers: LIVE }));

describe("creation requests against provider catalogues", () => {
  it("resolves each entry against its own agent's loaded catalogue and keeps the rest", () => {
    const chain: AgentChainEntry[] = [
      { agent: "claude", model: "opus", accounts: { strategy: "least-used" } } as AgentChainEntry,
      { agent: "codex", model: "gpt-6-sol", accounts: { strategy: "soonest-reset" } } as AgentChainEntry,
      { agent: "grok", model: "grok-4", accounts: { strategy: "least-used" } } as AgentChainEntry
    ];
    const request: CreateWorkflowRequest = { name: "W", project: { kind: "existing", projectPath: "/w" }, nodes: [{ type: "agent", config: { chain } }] };
    const resolved = (withLiveChainModels(request).nodes![0]!.config as { chain: AgentChainEntry[] }).chain;
    assert.deepEqual(
      resolved.map((entry) => [entry.agent, entry.model]),
      [
        ["claude", "opus[1m]"],
        ["codex", "gpt-6-sol"],
        ["grok", "grok-4"]
      ]
    );
    assert.deepEqual(resolved[0]!.accounts, chain[0]!.accounts);
    assert.deepEqual(resolved[1], chain[1]);
  });
  it("never resolves against a list that may be a fallback: pending, degraded or errored", () => {
    const fallback = [model("default", { isDefault: true }), model("opus"), model("sonnet")];
    for (const status of ["unknown", "degraded", "error"] as const) {
      const providers = [snapshot("claude", status, fallback)];
      const request: CreateWorkflowRequest = { name: "W", project: { kind: "existing", projectPath: "/w" }, nodes: [{ type: "agent", config: { chain: [{ agent: "claude", model: "opus[1m]" }] } }] };
      providersStore.setState({ providers });
      const resolved = withLiveChainModels(request);
      assert.equal((resolved.nodes![0]!.config as { chain: AgentChainEntry[] }).chain[0]!.model, "opus[1m]", status);
      assert.equal(liveDefaultNodeConfig("agent").chain[0]!.model, "default", status);
    }
  });
});

describe("liveDefaultNodeConfig", () => {
  it("a fresh agent block names a listed model; other blocks are their defaults", () => {
    const config = liveDefaultNodeConfig("agent");
    assert.equal(config.chain[0]!.model, "default");
    const other = [snapshot("claude", "ready", [model("opus[1m]"), model("sonnet", { isDefault: true })])];
    providersStore.setState({ providers: other });
    assert.equal(liveDefaultNodeConfig("agent").chain[0]!.model, "sonnet");
    assert.deepEqual(liveDefaultNodeConfig("trigger.manual"), {});
  });
});
