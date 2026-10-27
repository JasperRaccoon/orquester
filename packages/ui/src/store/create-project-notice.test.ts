/**
 * A clone whose SSH key was refused falls back to HTTPS on the daemon (`clone.transport:
 * "https"` with a notice); creating the project then says so in the shared toast stack.
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
const BASE: ProjectSummary = { name: "repo", workspace: "ws", path: "/w/ws/repo" };

function answering(project: ProjectSummary): void {
  useAppStore.setState({
    api: { createProject: async () => project, listProjects: async () => [project] } as unknown as ApiClient,
    currentWorkspace: "ws",
    notice: null
  });
}

describe("creating a project that cloned", () => {
  beforeEach(() => useAppStore.setState({ notice: null }));

  it("says so when the SSH key was refused and the clone went over HTTPS", async () => {
    const notice = "The SSH key was refused, so the repository was cloned over HTTPS instead.";
    answering({ ...BASE, clone: { transport: "https", notice } });
    await store().createProject({ source: "clone", url: "o/r" } as never);
    assert.equal(store().notice?.message, notice);
  });

  it("stays quiet for a clone over its first transport, and for a daemon that sends no report", async () => {
    answering({ ...BASE, clone: { transport: "ssh" } });
    await store().createProject({ source: "clone", url: "o/r" } as never);
    assert.equal(store().notice, null);
    answering({ ...BASE, clone: { transport: "https" } });
    await store().createProject({ source: "clone", url: "o/r" } as never);
    assert.equal(store().notice, null, "an HTTPS clone with no fallback notice is just an HTTPS clone");
    answering(BASE);
    await store().createProject({ source: "clone", url: "o/r" } as never);
    assert.equal(store().notice, null);
  });
});
