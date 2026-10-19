/**
 * A project created with a setup command (`createProjectWithCommand`) is
 * listed while its folder is still empty, so a typed `git clone` has no repo
 * yet. When its setup terminal ends, the workspace's project list is reloaded
 * once — the clone then lands in its repo group (spec 2026-10-18 §4).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { EventMessage, ProjectSummary, SessionSummary } from "@orquester/api";

import type { ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
};

const store = () => useAppStore.getState();
const PROJECT: ProjectSummary = { name: "Multiplayer", workspace: "ws", path: "/w/ws/Multiplayer" };

let listed: string[];
let nextSession: number;

const event = (type: string, id: string): EventMessage =>
  ({
    id: `e-${type}-${id}`,
    channel: "sessions",
    type,
    createdAt: "2026-10-19T00:00:00Z",
    payload: { id, kind: "shell", refId: "bash", title: "Setup", projectPath: PROJECT.path } as SessionSummary
  }) as EventMessage;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  listed = [];
  nextSession = 0;
  useAppStore.setState({
    api: {
      createProject: async () => PROJECT,
      listProjects: async (workspace: string) => {
        listed.push(workspace);
        return [PROJECT];
      }
    } as unknown as ApiClient,
    currentWorkspace: "ws",
    currentProject: null,
    sessions: [],
    activityById: {},
    registry: { ...store().registry, shells: [{ id: "bash", enabled: true }] } as never,
    openProject: () => undefined,
    openTab: async () => ({ id: `setup-${(nextSession += 1)}` }) as SessionSummary
  });
});

describe("the setup terminal of a new project", () => {
  it("reloads the workspace's projects once when it exits or closes", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .");
    assert.deepEqual(listed, ["ws"], "listed once on create");

    store().applyEvent(event("session.exited", "other"));
    await settle();
    assert.deepEqual(listed, ["ws"], "another session's exit changes nothing");

    store().applyEvent(event("session.exited", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);

    store().applyEvent(event("session.closed", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"], "only once");
  });

  it("closing the tab of a running setup also reloads", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .");
    store().applyEvent(event("session.closed", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);
  });

  it("leaves the list alone when another workspace is open by then", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .");
    useAppStore.setState({ currentWorkspace: "elsewhere" });
    store().applyEvent(event("session.exited", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws"]);
  });
});
