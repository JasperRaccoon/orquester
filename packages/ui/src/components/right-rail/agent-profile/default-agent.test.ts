import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentProfileAgentId } from "@orquester/api";

import { agentForRefId, defaultAgentProfileAgent } from "./default-agent.ts";

const PROVIDERS = [
  { id: "claude", refIds: ["claude", "claude-chat"] },
  { id: "codex", refIds: ["codex"] }
];
const REGISTRY_AGENTS = [
  { id: "grok", chat: { adapter: "grok" } },
  { id: "opencode-chat", chat: { adapter: "opencode" } },
  { id: "deepseek" }
];

describe("the chat tab's agent", () => {
  it("is the provider serving the tab's refId", () => {
    assert.equal(agentForRefId("claude-chat", PROVIDERS, REGISTRY_AGENTS), "claude");
    assert.equal(agentForRefId("codex", PROVIDERS, REGISTRY_AGENTS), "codex");
  });

  it("falls back to the registry's chat adapter while the providers have not loaded", () => {
    assert.equal(agentForRefId("opencode-chat", [], REGISTRY_AGENTS), "opencode");
    assert.equal(agentForRefId("grok", [], REGISTRY_AGENTS), "grok");
  });

  it("is none for no tab, or an agent this panel has no profile for", () => {
    assert.equal(agentForRefId(null, PROVIDERS, REGISTRY_AGENTS), null);
    assert.equal(agentForRefId("", PROVIDERS, REGISTRY_AGENTS), null);
    assert.equal(agentForRefId("deepseek", PROVIDERS, REGISTRY_AGENTS), null);
    assert.equal(agentForRefId("bash", PROVIDERS, REGISTRY_AGENTS), null);
  });
});

describe("the agent shown before a pick", () => {
  const all = () => true;
  const unknown = () => null;

  it("is the visible chat tab's agent first", () => {
    assert.equal(defaultAgentProfileAgent({ chatAgent: "codex", remembered: "grok", installed: all }), "codex");
  });

  it("else the one last picked", () => {
    assert.equal(defaultAgentProfileAgent({ chatAgent: null, remembered: "grok", installed: all }), "grok");
    assert.equal(defaultAgentProfileAgent({ chatAgent: null, remembered: "grok", installed: unknown }), "grok", "not passed over while unknown");
  });

  it("else the first installed one", () => {
    const installed = (agent: AgentProfileAgentId) => agent === "opencode" || agent === "grok";
    assert.equal(defaultAgentProfileAgent({ chatAgent: null, remembered: null, installed }), "grok");
  });

  it("passes over an agent known not to be installed", () => {
    const installed = (agent: AgentProfileAgentId) => agent !== "codex";
    assert.equal(defaultAgentProfileAgent({ chatAgent: "codex", remembered: null, installed }), "claude");
    assert.equal(defaultAgentProfileAgent({ chatAgent: "codex", remembered: "opencode", installed }), "opencode");
  });

  it("is Claude when nothing is known at all", () => {
    assert.equal(defaultAgentProfileAgent({ chatAgent: null, remembered: null, installed: unknown }), "claude");
    assert.equal(defaultAgentProfileAgent({ chatAgent: null, remembered: null, installed: () => false }), "claude");
  });
});
