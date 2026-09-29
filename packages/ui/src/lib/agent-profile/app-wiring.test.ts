/** App-store channel routing; store.test.ts owns cache/reset behavior. */

import assert from "node:assert/strict";

import { describe, it } from "node:test";

import { AGENT_PROFILE_CHANNEL, type AgentProfileAgentId, type AgentProfileSnapshot } from "@orquester/api";

import { useAppStore } from "../../store/app.ts";
import { agentProfileStore, loadAgentProfile, resetAgentProfile, type AgentProfileApi } from "./store.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function snapshot(revision: string): AgentProfileSnapshot {
  return {
    agent: "claude",
    installed: true,
    revision,
    instructions: { path: "/h/.claude/CLAUDE.md", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] },
    items: [],
    fileErrors: [],
    readAt: "2026-09-28T00:00:00.000Z"
  };
}

function fakeApi(): AgentProfileApi & { gets: AgentProfileAgentId[]; revision: string } {
  const api = {
    connection: { id: "local" },
    gets: [] as AgentProfileAgentId[],
    revision: "r1",
    async getAgentProfile(agent: AgentProfileAgentId) {
      api.gets.push(agent);
      return snapshot(api.revision);
    },
    getAgentProfileOverview: async () => ({ agents: [] }),
    setAgentProfileItemEnabled: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
    deleteAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
    copyAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] }),
    trustAgentProfileItem: async () => ({ snapshot: snapshot(api.revision), itemIds: [], notes: [] })
  };
  return api;
}

const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:${type}`,
  channel,
  type,
  createdAt: "2026-09-28T00:00:00.000Z",
  payload
});

describe("the app store routes agent-profile events", () => {
  it("agentProfile.changed on the agent-profile channel refetches the loaded agent", async () => {
    resetAgentProfile();
    const api = fakeApi();
    await loadAgentProfile(api, "claude");
    api.revision = "r2";
    useAppStore.getState().applyEvent(event(AGENT_PROFILE_CHANNEL, "agentProfile.changed", { agent: "claude", revision: "r2" }));
    await settle();
    await settle();
    assert.deepEqual(api.gets, ["claude", "claude"]);
    assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, "r2");
  });

  it("the same message on another channel does not", async () => {
    resetAgentProfile();
    const api = fakeApi();
    await loadAgentProfile(api, "claude");
    useAppStore.getState().applyEvent(event("elsewhere", "agentProfile.changed", { agent: "claude", revision: "r2" }));
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
  });

});
