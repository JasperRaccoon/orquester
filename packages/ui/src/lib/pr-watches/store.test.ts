import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { PullRequestWatchListResponse, PullRequestWatchSummary } from "@orquester/api/agent-chat";

import { useAppStore } from "../../store/app.ts";
import {
  applyPullRequestWatchesEvent,
  loadPullRequestWatches,
  pullRequestWatchesOf,
  pullRequestWatchesStore,
  resetPullRequestWatches,
  stopPullRequestWatch,
  type PullRequestWatchesApi
} from "./store.ts";

function watch(id: string, over: Partial<PullRequestWatchSummary> = {}): PullRequestWatchSummary {
  return {
    id,
    sessionId: "s1",
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Add retries",
    startedAt: "2026-10-14T10:00:00.000Z",
    lastCheckedAt: null,
    status: null,
    lastError: null,
    wakePending: false,
    ...over
  };
}

const changed = (sessionId: string, watches: unknown) => ({ type: "pr-watches.changed", payload: { sessionId, watches } });

function fakeApi(answers: { list?: () => Promise<PullRequestWatchListResponse>; stop?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const api: PullRequestWatchesApi = {
    connection: { id: "local" },
    listPullRequestWatches: (sessionId) => {
      calls.push(`list ${sessionId}`);
      return answers.list ? answers.list() : Promise.resolve({ watches: [] });
    },
    stopPullRequestWatch: (sessionId, watchId) => {
      calls.push(`stop ${sessionId} ${watchId}`);
      return answers.stop ? answers.stop() : Promise.resolve({ removed: true });
    }
  };
  return { api, calls };
}

const listOf = (sessionId: string) => pullRequestWatchesOf(pullRequestWatchesStore.getState(), sessionId);

describe("pull request watches store", () => {
  beforeEach(() => resetPullRequestWatches());

  it("a load fills the thread's list, dropping malformed entries", async () => {
    const broken = watch("w2", { status: { state: "open", mergeability: "clean", headSha: null, baseBranch: "main", checks: null } as unknown as PullRequestWatchSummary["status"] });
    const { api } = fakeApi({ list: async () => ({ watches: [watch("w1"), { id: 3 } as unknown as PullRequestWatchSummary, broken] }) });
    await loadPullRequestWatches(api, "s1");
    assert.deepEqual(listOf("s1").map((entry) => entry.id), ["w1"]);
    assert.deepEqual(listOf("other"), []);
  });

  it("an event replaces the list; one that crossed a load wins over its answer; a malformed one is ignored", async () => {
    let answer!: (value: PullRequestWatchListResponse) => void;
    const { api } = fakeApi({ list: () => new Promise((resolve) => (answer = resolve)) });
    const loading = loadPullRequestWatches(api, "s1");
    applyPullRequestWatchesEvent(changed("s1", [watch("w2")]));
    answer({ watches: [watch("w1")] });
    await loading;
    assert.deepEqual(listOf("s1").map((entry) => entry.id), ["w2"]);
    applyPullRequestWatchesEvent(changed("s1", [{ nope: true }]));
    // A summary whose status is not whole never reaches the chip.
    applyPullRequestWatchesEvent(changed("s1", [watch("w9", { status: { state: "open" } as unknown as PullRequestWatchSummary["status"] })]));
    applyPullRequestWatchesEvent({ type: "other", payload: { sessionId: "s1", watches: [] } });
    assert.deepEqual(listOf("s1").map((entry) => entry.id), ["w2"]);
    applyPullRequestWatchesEvent(changed("s1", []));
    assert.deepEqual(listOf("s1"), []);
  });

  it("a stop removes the watch at once; one already gone (404) too; a failure keeps it and says so", async () => {
    applyPullRequestWatchesEvent(changed("s1", [watch("w1"), watch("w2"), watch("w3")]));
    const ok = fakeApi();
    assert.equal(await stopPullRequestWatch(ok.api, "s1", "w1"), true);
    assert.deepEqual(ok.calls, ["stop s1 w1"]);
    const gone = fakeApi({ stop: () => Promise.reject(Object.assign(new Error("404"), { status: 404 })) });
    assert.equal(await stopPullRequestWatch(gone.api, "s1", "w2"), true);
    const broken = fakeApi({ stop: () => Promise.reject(Object.assign(new Error("500"), { status: 500 })) });
    assert.equal(await stopPullRequestWatch(broken.api, "s1", "w3"), false);
    assert.deepEqual(listOf("s1").map((entry) => entry.id), ["w3"]);
    assert.match(pullRequestWatchesStore.getState().errors.get("s1") ?? "", /Couldn't stop/);
    assert.equal(pullRequestWatchesStore.getState().stopping.size, 0);
  });

  it("the app store routes the channel here, and a connection switch forgets everything", () => {
    useAppStore.getState().applyEvent({ id: "e", channel: "pr-watches", type: "pr-watches.changed", createdAt: "", payload: { sessionId: "s1", watches: [watch("w1")] } });
    assert.equal(listOf("s1").length, 1);
    useAppStore.getState().applyEvent({ id: "e", channel: "elsewhere", type: "pr-watches.changed", createdAt: "", payload: { sessionId: "s2", watches: [watch("w2")] } });
    assert.equal(listOf("s2").length, 0);
    resetPullRequestWatches();
    assert.equal(listOf("s1").length, 0);
  });
});
