/**
 * A project created with a setup command (`createProjectWithCommand`) is
 * listed while its folder is still empty, so a typed `git clone` has no repo
 * yet. A typed clone (`followClone`) follows its git status until it shows its
 * repo, and when its setup terminal ends the workspace's project list is
 * reloaded once — the clone then lands in its repo group (spec 2026-10-18 §4).
 * Other setups (templates) are not followed.
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
/** What `listProjects` answers next (a clone gains its repoKey once it landed). */
let answer: ProjectSummary;
/** The open `/events?project=` streams: their event sinks, and whether they were disposed. */
let streams: Array<{ project: string | undefined; push: (event: EventMessage) => void; disposed: boolean }>;

const gitChanged = (isRepo: boolean): EventMessage =>
  ({
    id: `git-${Math.random()}`,
    channel: "projects",
    type: "project.git.changed",
    createdAt: "2026-10-19T00:00:00Z",
    payload: { path: PROJECT.path, status: { isRepo, files: [] } }
  }) as unknown as EventMessage;

const event = (type: string, id: string): EventMessage =>
  ({
    id: `e-${type}-${id}`,
    channel: "sessions",
    type,
    createdAt: "2026-10-19T00:00:00Z",
    payload: { id, kind: "shell", refId: "bash", title: "Setup", projectPath: PROJECT.path } as SessionSummary
  }) as EventMessage;

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const CLONE = { followClone: true };
const LANDED: ProjectSummary = { ...PROJECT, repoKey: "github.com/o/r", repoName: "o/r", cloneUrl: "https://github.com/o/r.git" };

beforeEach(() => {
  listed = [];
  nextSession = 0;
  answer = PROJECT;
  streams = [];
  useAppStore.setState({
    api: {
      createProject: async () => PROJECT,
      listProjects: async (workspace: string) => {
        listed.push(workspace);
        return [answer];
      },
      openEvents: (onEvent: (event: EventMessage) => void, _onEnd: () => void, opts?: { project?: string }) => {
        const stream = { project: opts?.project, push: onEvent, disposed: false };
        streams.push(stream);
        return () => {
          stream.disposed = true;
        };
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
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
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
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    store().applyEvent(event("session.closed", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);
  });

  it("leaves the list alone when another workspace is open by then", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    useAppStore.setState({ currentWorkspace: "elsewhere" });
    store().applyEvent(event("session.exited", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws"]);
  });

  it("follows the project's git status: a landed clone reloads until it shows its repo", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].project, PROJECT.path, "watches the new project's git status");

    streams[0].push(gitChanged(false));
    await settle();
    assert.deepEqual(listed, ["ws"], "still not a repo: nothing to reload");

    // `.git` exists but origin isn't written yet: reload, keep following.
    streams[0].push(gitChanged(true));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);
    assert.equal(streams[0].disposed, false);

    answer = { ...PROJECT, repoKey: "github.com/o/r", repoName: "o/r", cloneUrl: "https://github.com/o/r.git" };
    streams[0].push(gitChanged(true));
    await settle();
    assert.deepEqual(listed, ["ws", "ws", "ws"]);
    assert.equal(streams[0].disposed, true, "stops once the project shows its repo");

    store().applyEvent(event("session.exited", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws", "ws"], "its exit no longer reloads");
  });

  it("a clone that lands before the terminal is open still reloads", async () => {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    useAppStore.setState({
      openTab: async () => {
        await opened;
        return { id: "setup-early" } as SessionSummary;
      }
    });
    const created = store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    await settle();
    await settle();
    assert.equal(streams.length, 1, "subscribed before the terminal opens");
    answer = { ...PROJECT, repoKey: "github.com/o/r", repoName: "o/r", cloneUrl: "https://github.com/o/r.git" };
    streams[0].push(gitChanged(true));
    await settle();
    assert.deepEqual(listed, ["ws"], "no session id yet: held");
    release();
    await created;
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);
    assert.equal(streams[0].disposed, true);
  });

  it("stops following when the terminal exits, and when it never opened", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    store().applyEvent(event("session.closed", "setup-1"));
    await settle();
    assert.equal(streams[0].disposed, true);

    useAppStore.setState({ openTab: async () => undefined });
    await assert.rejects(store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE));
    assert.equal(streams[1].disposed, true, "a setup terminal that never opened stops at once");
  });

  it("while another workspace is open, asks the daemon without touching the store's list", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    const other: ProjectSummary = { name: "Else", workspace: "elsewhere", path: "/w/elsewhere/Else" };
    useAppStore.setState({ currentWorkspace: "elsewhere", projects: [other] });

    streams[0].push(gitChanged(true));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"], "the setup's own workspace");
    assert.deepEqual(store().projects, [other]);
    assert.equal(streams[0].disposed, false, "no repoKey yet: keeps following");

    answer = LANDED;
    streams[0].push(gitChanged(true));
    await settle();
    assert.deepEqual(listed, ["ws", "ws", "ws"]);
    assert.deepEqual(store().projects, [other]);
    assert.equal(streams[0].disposed, true, "stops once the daemon lists its repo");
  });

  it("a template setup is not followed", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "npm create vite@latest .");
    assert.equal(streams.length, 0, "no git status stream");
    store().applyEvent(event("session.exited", "setup-1"));
    await settle();
    assert.deepEqual(listed, ["ws"], "its exit reloads nothing either");
  });

  it("a connection switch stops every follow", async () => {
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    await store().createProjectWithCommand({ source: "empty", name: "Multiplayer" }, "git clone 'u' .", CLONE);
    // One shared, refcounted stream: it ends only once BOTH follows stopped.
    assert.deepEqual(
      streams.map((s) => s.disposed),
      [false]
    );
    const api = store().api;
    // The connection switched to gets an inert injected transport (no socket opens).
    const target = { id: "target", name: "Target", kind: "local", endpoint: "unix:/x", status: "disconnected" } as const;
    useAppStore.setState({ connect: async () => undefined, connectionStatus: "disconnected" });
    await store().initConnections({ localConnection: target, localTransporter: { kind: "stub" } as never, defaultUseTitlebar: false });
    useAppStore.setState({
      api,
      activeConnectionId: "previous",
      connections: [target, { ...target, id: "previous" }],
      currentWorkspace: "ws"
    });
    await store().selectConnection("target");
    assert.deepEqual(
      streams.map((s) => s.disposed),
      [true]
    );

    // The follows are forgotten too: a late change or exit reloads nothing.
    useAppStore.setState({ api, currentWorkspace: "ws" });
    streams[0].push(gitChanged(true));
    store().applyEvent(event("session.exited", "setup-2"));
    await settle();
    assert.deepEqual(listed, ["ws", "ws"]);
  });
});
