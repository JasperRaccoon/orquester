/**
 * `loadProjects` calls can overlap (a setup follow, an event, a workspace
 * switch): only the newest call's answer is applied, and `projectsLoading`
 * stays on until that one settles.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ProjectSummary } from "@orquester/api";

import type { ApiClient } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
};

const store = () => useAppStore.getState();
const project = (name: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  name,
  workspace: "ws",
  path: `/w/ws/${name}`,
  ...extra
});

/** Pending `listProjects` answers, in call order. */
let pending: Array<{ resolve: (list: ProjectSummary[]) => void; reject: (error: Error) => void }>;

beforeEach(() => {
  pending = [];
  useAppStore.setState({
    api: {
      listProjects: () =>
        new Promise<ProjectSummary[]>((resolve, reject) => {
          pending.push({ resolve, reject });
        })
    } as unknown as ApiClient,
    currentWorkspace: "ws",
    projects: [],
    projectsLoading: false
  });
});

describe("loadProjects", () => {
  it("an older listing answering last does not overwrite the newer one", async () => {
    const older = store().loadProjects();
    const newer = store().loadProjects();
    const landed = project("Multiplayer", { repoKey: "github.com/o/r" });

    pending[1].resolve([landed]);
    await newer;
    assert.deepEqual(store().projects, [landed]);
    assert.equal(store().projectsLoading, false);

    pending[0].resolve([project("Multiplayer")]);
    await older;
    assert.deepEqual(store().projects, [landed], "the stale answer is dropped");
    assert.equal(store().projectsLoading, false);
  });

  it("stays loading until the newest call settles, whatever the older one does", async () => {
    const older = store().loadProjects();
    const newer = store().loadProjects();

    pending[0].reject(new Error("gone"));
    await older;
    assert.equal(store().projectsLoading, true, "the newest call is still in flight");

    pending[1].resolve([project("A")]);
    await newer;
    assert.equal(store().projectsLoading, false);
    assert.deepEqual(store().projects, [project("A")]);
  });

  it("a listing that lands after the workspace closed is dropped", async () => {
    const load = store().loadProjects();
    store().closeWorkspace();
    pending[0].resolve([project("A")]);
    await load;
    assert.deepEqual(store().projects, []);
    assert.equal(store().projectsLoading, false);
  });
});
