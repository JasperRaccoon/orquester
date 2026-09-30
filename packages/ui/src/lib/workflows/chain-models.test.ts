import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentChainEntry, CreateWorkflowRequest } from "@orquester/api";
import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

import { liveDefaultNodeConfig, withLiveChainModels } from "./chain-models.ts";
import { createFromTemplate } from "./templates.ts";

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

describe("creation requests against provider catalogues", () => {
  it("resolves each entry against its own agent's loaded catalogue and keeps the rest", () => {
    const chain: AgentChainEntry[] = [
      { agent: "claude", model: "opus", accounts: { strategy: "least-used" } } as AgentChainEntry,
      { agent: "codex", model: "gpt-6-sol", accounts: { strategy: "soonest-reset" } } as AgentChainEntry,
      { agent: "grok", model: "grok-4", accounts: { strategy: "least-used" } } as AgentChainEntry
    ];
    const request: CreateWorkflowRequest = { name: "W", project: { kind: "existing", projectPath: "/w" }, nodes: [{ type: "agent", config: { chain } }] };
    const resolved = (withLiveChainModels(request, LIVE).nodes![0]!.config as { chain: AgentChainEntry[] }).chain;
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
      const resolved = withLiveChainModels(request, providers);
      assert.equal((resolved.nodes![0]!.config as { chain: AgentChainEntry[] }).chain[0]!.model, "opus[1m]", status);
      assert.equal(liveDefaultNodeConfig("agent", providers).chain[0]!.model, "default", status);
    }
  });
});

describe("templates against the live catalogue", () => {
  it("the Codex reviewer keeps the current default, gpt-6-astra", () => {
    const request = createFromTemplate("release-tag-reviewer", { kind: "existing", projectPath: "/w/ws/app" }, "UTC", LIVE);
    const agent = request.nodes?.find((node) => node.type === "agent");
    assert.equal((agent?.config as { chain: AgentChainEntry[] }).chain[0]!.model, "gpt-6-astra");
  });

  it("an old static `opus` resolves to `opus[1m]`", () => {
    const request: CreateWorkflowRequest = {
      name: "W",
      project: { kind: "existing", projectPath: "/w" },
      nodes: [
        { type: "trigger.manual", config: {} },
        { type: "agent", name: "A", config: { chain: [{ agent: "claude", model: "opus" }] } }
      ]
    };
    const resolved = withLiveChainModels(request, LIVE);
    assert.deepEqual((resolved.nodes?.[1]?.config as { chain: AgentChainEntry[] }).chain, [{ agent: "claude", model: "opus[1m]" }]);
    assert.deepEqual(resolved.nodes?.[0], { type: "trigger.manual", config: {} });
  });

  it("without a catalogue the request is untouched", () => {
    const request = createFromTemplate("nightly-agent-task", { kind: "existing", projectPath: "/w/ws/app" }, "UTC", []);
    const agent = request.nodes?.find((node) => node.type === "agent");
    assert.equal((agent?.config as { chain: AgentChainEntry[] }).chain[0]!.model, "default");
  });
});

describe("liveDefaultNodeConfig", () => {
  it("a fresh agent block names a listed model; other blocks are their defaults", () => {
    const config = liveDefaultNodeConfig("agent", LIVE);
    assert.equal(config.chain[0]!.model, "default");
    const other = [snapshot("claude", "ready", [model("opus[1m]"), model("sonnet", { isDefault: true })])];
    assert.equal(liveDefaultNodeConfig("agent", other).chain[0]!.model, "sonnet");
    assert.deepEqual(liveDefaultNodeConfig("trigger.manual", LIVE), {});
  });
});
