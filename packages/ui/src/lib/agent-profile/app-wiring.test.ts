/**
 * The app store's two hooks into the agent-profile store: `/events` messages
 * of the `agent-profile` channel reach it, and a sign-out or a connection
 * switch empties it (another daemon's profiles must never show).
 *
 * The routing runs for real — `applyEvent` on the actual app store, with a
 * fake client bound through a load. The resets are pinned in the source, as
 * `lib/saved-prompts/app-wiring.test.ts` does: driving `signOut` /
 * `selectConnection` under node would build a real `ApiClient`. What the
 * reset itself does is `store.test.ts`'s.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_PROFILE_CHANNEL, type AgentProfileAgentId, type AgentProfileSnapshot } from "@orquester/api";

import { useAppStore } from "../../store/app.ts";
import { agentProfileEntry, loadAgentProfile, resetAgentProfile, type AgentProfileApi } from "./store.ts";

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
    assert.equal(agentProfileEntry("claude").snapshot?.revision, "r2");
  });

  it("the same message on another channel does not", async () => {
    resetAgentProfile();
    const api = fakeApi();
    await loadAgentProfile(api, "claude");
    useAppStore.getState().applyEvent(event("elsewhere", "agentProfile.changed", { agent: "claude", revision: "r2" }));
    await settle();
    assert.deepEqual(api.gets, ["claude"]);
  });

  it("a malformed payload is ignored without a throw", () => {
    resetAgentProfile();
    assert.doesNotThrow(() => {
      useAppStore.getState().applyEvent(event(AGENT_PROFILE_CHANNEL, "agentProfile.changed", null));
      useAppStore.getState().applyEvent(event(AGENT_PROFILE_CHANNEL, "agentProfile.changed", 7));
    });
  });
});

describe("a sign-out and a connection switch reset the agent profiles", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Comments stripped, so a commented-out call never passes for a live one.
  const source = readFileSync(join(here, "..", "..", "store", "app.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");

  /** The body of the store method `name` (its implementation, not its type), up to the next method. */
  function methodBody(name: string): string {
    const store = source.indexOf("create<AppState>(");
    assert.ok(store >= 0, "app.ts still creates its store with create<AppState>(");
    const start = source.indexOf(`\n  ${name}: `, store);
    assert.ok(start >= 0, `app.ts still has ${name}`);
    const next = source.slice(start + 1).search(/\n {2}[A-Za-z]\w*: /);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  for (const name of ["signOut", "selectConnection"]) {
    it(`${name} resets them before it switches the client`, () => {
      const body = methodBody(name);
      const reset = body.indexOf("resetAgentProfile();");
      assert.ok(reset >= 0, `${name} calls resetAgentProfile()`);
      assert.ok(reset < body.indexOf("set({"), "before the new client is installed");
    });
  }
});
