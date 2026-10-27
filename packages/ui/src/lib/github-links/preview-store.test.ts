import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { GitHubLinkPreview, GitHubPreviewTarget } from "@orquester/api";

import { LinkPreviewStore, type LinkPreviewState } from "./preview-store";

afterEach(() => mock.timers.reset());

const TARGET: GitHubPreviewTarget = { kind: "pull", owner: "acme", repo: "app", number: 1 };
const URL = "https://github.com/acme/app/pull/1";

const preview = (title = "t"): GitHubLinkPreview => ({
  kind: "issue",
  owner: "acme",
  repo: "app",
  number: 1,
  url: URL,
  title,
  state: "open",
  stateReason: null,
  author: null,
  createdAt: null,
  updatedAt: null,
  closedAt: null,
  comments: 0
});

/** A fetcher whose answers the test settles by hand, in order. */
function controlled() {
  const calls: Array<{ url: string; projectPath: string | null; resolve: (value: GitHubLinkPreview) => void; reject: (error: unknown) => void }> = [];
  const fetcher = (url: string, projectPath: string | null) =>
    new Promise<GitHubLinkPreview>((resolve, reject) => calls.push({ url, projectPath, resolve, reject }));
  return { calls, fetcher };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("LinkPreviewStore", () => {
  it("reads once per item and project, shares the state, and notifies subscribers", async () => {
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher);
    const key = store.keyOf(TARGET, "/w/ws/app");
    assert.equal(store.keyOf({ ...TARGET, owner: "ACME" }, "/w/ws/app"), key);
    assert.notEqual(store.keyOf(TARGET, "/w/ws/other"), key);
    const seen: LinkPreviewState["status"][] = [];
    store.subscribe(key, () => seen.push(store.get(key).status));
    assert.equal(store.get(key).status, "idle");
    store.request(key, URL, "/w/ws/app");
    store.request(key, URL, "/w/ws/app");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.projectPath, "/w/ws/app");
    assert.equal(store.get(key).status, "loading");
    calls[0]?.resolve(preview("hello"));
    await flush();
    const state = store.get(key);
    assert.ok(state.status === "ready");
    assert.equal(state.preview.title, "hello");
    assert.deepEqual(seen, ["loading", "ready"]);
    store.request(key, URL, "/w/ws/app");
    assert.equal(calls.length, 1, "a fresh preview is not re-read");
  });

  it("re-reads a stale preview in the background and keeps it if the re-read fails", async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher);
    const key = store.keyOf(TARGET, null);
    store.request(key, URL, null);
    calls[0]?.resolve(preview("first"));
    await flush();
    mock.timers.setTime(120_000);
    store.request(key, URL, null);
    assert.equal(calls.length, 2);
    assert.equal(store.get(key).status, "ready", "no loading flash on a re-read");
    calls[1]?.reject({ status: 502 });
    await flush();
    const state = store.get(key);
    assert.ok(state.status === "ready");
    assert.equal(state.preview.title, "first");
  });

  it("remembers failures until their retry time", async () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher);
    const key = store.keyOf(TARGET, null);
    store.request(key, URL, null);
    calls[0]?.reject({ status: 429, body: { retryAfterMs: 60_000 } });
    await flush();
    assert.deepEqual(store.get(key), { status: "unavailable", reason: "rate_limited", retryAt: 60_000 });
    mock.timers.setTime(59_999);
    store.request(key, URL, null);
    assert.equal(calls.length, 1);
    mock.timers.setTime(60_000);
    store.request(key, URL, null);
    assert.equal(calls.length, 2);
    calls[1]?.reject({ status: 404 });
    await flush();
    assert.equal((store.get(key) as { reason: string }).reason, "not_found");

    const secondKey = store.keyOf({ ...TARGET, number: 2 }, null);
    store.request(secondKey, URL, null);
    calls[2]?.reject({ status: 429, retryAfterSeconds: 7 });
    await flush();
    assert.deepEqual(store.get(secondKey), { status: "unavailable", reason: "rate_limited", retryAt: 67_000 });
  });

  it("accepts the three kinds and refuses the rest", async () => {
    const issue = preview();
    for (const answer of [
      issue,
      { ...issue, kind: "pull", state: "merged" },
      { kind: "commit", owner: "a", repo: "b", url: "https://github.com/a/b/commit/abcdef1", title: "t", sha: "abcdef1", body: "" }
    ]) {
      const { calls, fetcher } = controlled();
      const store = new LinkPreviewStore(fetcher);
      const key = store.keyOf(TARGET, null);
      store.request(key, URL, null);
      calls[0]!.resolve(answer as GitHubLinkPreview);
      await flush();
      const state = store.get(key);
      assert.ok(state.status === "ready");
      assert.equal(state.preview.kind, answer.kind);
    }
    for (const answer of [null, { kind: "repo" }, { kind: "issue" }, { ...issue, url: "https://evil.example/x" }, { ...issue, state: "weird" }]) {
      const { calls, fetcher } = controlled();
      const store = new LinkPreviewStore(fetcher);
      const key = store.keyOf(TARGET, null);
      store.request(key, URL, null);
      calls[0]!.resolve(answer as GitHubLinkPreview);
      await flush();
      const state = store.get(key);
      assert.ok(state.status === "unavailable");
      assert.equal(state.reason, "error");
    }
  });

  it("caps concurrent reads and queues the rest", async () => {
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher);
    const keys = [1, 2, 3, 4, 5].map((number) => store.keyOf({ ...TARGET, number }, null));
    keys.forEach((key, index) => store.request(key, `${URL}${index}`, null));
    assert.equal(calls.length, 3);
    assert.ok(keys.every((key) => store.get(key).status === "loading"));
    calls[0]?.resolve(preview());
    await flush();
    assert.equal(calls.length, 4);
    calls[1]?.reject({ status: 500 });
    calls[2]?.resolve(preview());
    await flush();
    assert.equal(calls.length, 5);
  });
});
