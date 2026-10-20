import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubLinkPreview, GitHubPreviewTarget } from "@orquester/api";

import {
  ERROR_RETRY_MS,
  LinkPreviewStore,
  NOT_FOUND_RETRY_MS,
  PREVIEW_FRESH_MS,
  classifyPreviewError,
  isGitHubLinkPreview,
  type LinkPreviewState
} from "./preview-store";

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

describe("classifyPreviewError", () => {
  it("reads statuses and the daemon's wait", () => {
    assert.deepEqual(classifyPreviewError({ status: 404 }, 0), { reason: "not_found", retryAt: NOT_FOUND_RETRY_MS });
    assert.deepEqual(classifyPreviewError({ status: 400 }, 0), { reason: "not_found", retryAt: NOT_FOUND_RETRY_MS });
    assert.deepEqual(classifyPreviewError({ status: 429, body: { retryAfterMs: 5_000 } }, 10), { reason: "rate_limited", retryAt: 5_010 });
    assert.deepEqual(classifyPreviewError({ status: 429, retryAfterSeconds: 7 }, 0), { reason: "rate_limited", retryAt: 7_000 });
    assert.equal(classifyPreviewError({ status: 429 }, 0).reason, "rate_limited");
    assert.deepEqual(classifyPreviewError({ status: 502 }, 0), { reason: "error", retryAt: ERROR_RETRY_MS });
    assert.deepEqual(classifyPreviewError(new TypeError("offline"), 0), { reason: "error", retryAt: ERROR_RETRY_MS });
  });
});

describe("isGitHubLinkPreview", () => {
  it("accepts the three kinds and refuses the rest", () => {
    assert.equal(isGitHubLinkPreview(preview()), true);
    assert.equal(isGitHubLinkPreview({ ...preview(), url: "https://evil.example/x" }), false);
    assert.equal(isGitHubLinkPreview({ ...preview(), state: "weird" }), false);
    assert.equal(isGitHubLinkPreview({ ...preview(), kind: "pull", state: "merged" }), true);
    assert.equal(isGitHubLinkPreview({ kind: "commit", owner: "a", repo: "b", url: "https://github.com/a", title: "t", sha: "x", body: "" }), true);
    assert.equal(isGitHubLinkPreview(null), false);
    assert.equal(isGitHubLinkPreview({ kind: "repo" }), false);
  });
});

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
    let now = 0;
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher, { now: () => now });
    const key = store.keyOf(TARGET, null);
    store.request(key, URL, null);
    calls[0]?.resolve(preview("first"));
    await flush();
    now += PREVIEW_FRESH_MS;
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
    let now = 0;
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher, { now: () => now });
    const key = store.keyOf(TARGET, null);
    store.request(key, URL, null);
    calls[0]?.reject({ status: 429, body: { retryAfterMs: 60_000 } });
    await flush();
    assert.deepEqual(store.get(key), { status: "unavailable", reason: "rate_limited", retryAt: 60_000 });
    now = 59_999;
    store.request(key, URL, null);
    assert.equal(calls.length, 1);
    now = 60_000;
    store.request(key, URL, null);
    assert.equal(calls.length, 2);
    calls[1]?.reject({ status: 404 });
    await flush();
    assert.equal((store.get(key) as { reason: string }).reason, "not_found");
  });

  it("treats a malformed answer as an error", async () => {
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher);
    const key = store.keyOf(TARGET, null);
    store.request(key, URL, null);
    calls[0]?.resolve({ kind: "issue" } as unknown as GitHubLinkPreview);
    await flush();
    assert.equal((store.get(key) as { reason: string }).reason, "error");
  });

  it("caps concurrent reads and queues the rest", async () => {
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher, { maxConcurrent: 2 });
    const keys = [1, 2, 3, 4, 5].map((number) => store.keyOf({ ...TARGET, number }, null));
    keys.forEach((key, index) => store.request(key, `${URL}${index}`, null));
    assert.equal(calls.length, 2);
    assert.ok(keys.every((key) => store.get(key).status === "loading"));
    calls[0]?.resolve(preview());
    await flush();
    assert.equal(calls.length, 3);
    calls[1]?.reject({ status: 500 });
    calls[2]?.resolve(preview());
    await flush();
    assert.equal(calls.length, 5);
  });

  it("evicts the oldest unwatched entries past its cap", async () => {
    const { calls, fetcher } = controlled();
    const store = new LinkPreviewStore(fetcher, { maxEntries: 2 });
    const [a, b, c] = [1, 2, 3].map((number) => store.keyOf({ ...TARGET, number }, null)) as [string, string, string];
    const unsubscribe = store.subscribe(a, () => undefined);
    store.request(b, URL, null);
    calls[0]?.resolve(preview());
    await flush();
    store.request(c, URL, null);
    // `a` is watched, `c` is in flight: `b` goes.
    assert.equal(store.get(b).status, "idle");
    assert.equal(store.get(c).status, "loading");
    unsubscribe();
  });
});
