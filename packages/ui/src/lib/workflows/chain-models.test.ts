import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateWorkflow, type AgentChainEntry, type CreateWorkflowRequest } from "@orquester/api";
import { createWorkflowFromRequest } from "@orquester/api";
import type { ProviderModel, ProviderSnapshot } from "@orquester/api/agent-chat";

import {
  editorAgentCatalog,
  liveDefaultNodeConfig,
  modelFamily,
  resolveChainModel,
  resolveChainModels,
  withLiveChainModels
} from "./chain-models.ts";
import { sequentialIds } from "./testing.ts";
import { createFromTemplate, WORKFLOW_TEMPLATES } from "./templates.ts";

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
const REGISTRY = [
  { id: "claude", enabled: true, chat: { adapter: "claude" as const } },
  { id: "codex", enabled: true, chat: { adapter: "codex" as const } }
];

describe("modelFamily", () => {
  it("strips a trailing [variant] only", () => {
    assert.equal(modelFamily("opus[1m]"), "opus");
    assert.equal(modelFamily("opus"), "opus");
    assert.equal(modelFamily("claude-fable-5-1[1m]"), "claude-fable-5-1");
    assert.equal(modelFamily("gpt-5.5"), "gpt-5.5");
    assert.equal(modelFamily("a[x]b"), "a[x]b");
  });
});

describe("resolveChainModel", () => {
  const claude = LIVE[0]!.models;
  it("keeps a listed slug", () => {
    assert.equal(resolveChainModel("default", claude), "default");
    assert.equal(resolveChainModel("opus[1m]", claude), "opus[1m]");
  });
  it("takes a listed slug of the same family", () => {
    assert.equal(resolveChainModel("opus", claude), "opus[1m]");
    assert.equal(resolveChainModel("sonnet[1m]", claude), "sonnet");
  });
  it("falls back to the provider's default, then its first model", () => {
    assert.equal(resolveChainModel("gpt-404", claude), "default");
    assert.equal(resolveChainModel("x", [model("a"), model("b")]), "a");
  });
  it("passes over a legacy model for the default", () => {
    assert.equal(resolveChainModel("gpt-5.5", LIVE[1]!.models), "gpt-6-astra");
  });
  it("leaves the slug as is with no models", () => {
    assert.equal(resolveChainModel("opus", []), "opus");
    assert.equal(resolveChainModel("old", [model("old", { isLegacy: true })]), "old");
  });
  it("matches case exactly (no folding)", () => {
    assert.equal(resolveChainModel("Opus[1m]", claude), "default");
  });
});

describe("resolveChainModels", () => {
  it("resolves each entry against its own agent's loaded catalogue and keeps the rest", () => {
    const chain: AgentChainEntry[] = [
      { agent: "claude", model: "opus", accounts: { strategy: "least-used" } } as AgentChainEntry,
      { agent: "codex", model: "gpt-6-sol", accounts: { strategy: "soonest-reset" } } as AgentChainEntry,
      { agent: "grok", model: "grok-4", accounts: { strategy: "least-used" } } as AgentChainEntry
    ];
    const resolved = resolveChainModels(chain, LIVE);
    assert.deepEqual(
      resolved.map((entry) => [entry.agent, entry.model]),
      [
        ["claude", "opus[1m]"],
        ["codex", "gpt-6-sol"],
        ["grok", "grok-4"]
      ]
    );
    assert.deepEqual(resolved[0]!.accounts, chain[0]!.accounts);
    assert.equal(resolved[1], chain[1], "an unchanged entry is the same object");
  });
  it("never resolves against a list that may be a fallback: pending, degraded or errored", () => {
    const fallback = [model("default", { isDefault: true }), model("opus"), model("sonnet")];
    for (const status of ["unknown", "degraded", "error"] as const) {
      const providers = [snapshot("claude", status, fallback)];
      assert.equal(resolveChainModels([{ agent: "claude", model: "opus[1m]" }], providers)[0]!.model, "opus[1m]", status);
      assert.equal(liveDefaultNodeConfig("agent", providers).chain[0]!.model, "default", status);
    }
  });
});

describe("templates against the live catalogue", () => {
  const catalog = editorAgentCatalog(REGISTRY, LIVE)!;
  const env = () => ({ mintId: sequentialIds(), now: new Date("2026-09-29T10:00:00Z") });

  for (const template of WORKFLOW_TEMPLATES) {
    it(`${template.id}: every agent block names a listed model and validates without a model error`, () => {
      const request = createFromTemplate(template.id, { kind: "existing", projectPath: "/w/ws/app" }, "UTC", LIVE);
      const workflow = createWorkflowFromRequest(request, env());
      const { problems } = validateWorkflow(workflow, { catalog });
      assert.deepEqual(
        problems.filter((problem) => problem.code === "unknown_model" || problem.code === "unknown_agent"),
        [],
        template.id
      );
    });
  }

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
    assert.equal(resolved.nodes?.[0], request.nodes?.[0]);
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

describe("editorAgentCatalog", () => {
  it("is absent until the registry lists a chat agent", () => {
    assert.equal(editorAgentCatalog([], LIVE), undefined);
    assert.equal(editorAgentCatalog([{ id: "aider", enabled: true }], LIVE), undefined);
  });
  it("lists each chat agent with its probed models", () => {
    assert.deepEqual(editorAgentCatalog(REGISTRY, LIVE)?.agents.map((agent) => [agent.id, agent.models?.length ?? null]), [
      ["claude", 6],
      ["codex", 4]
    ]);
  });
});
