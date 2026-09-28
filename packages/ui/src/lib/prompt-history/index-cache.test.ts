import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ThreadPromptEntry,
  ThreadPromptsQuery,
  ThreadPromptsResponse,
  ThreadPromptTextResponse
} from "@orquester/api/agent-chat";

import { ApiError } from "../api-client";
import {
  PromptIndexCache,
  fillWantsOlder,
  searchIsPaging,
  searchWantsOlder,
  type PromptIndexState
} from "./index-cache";

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** A fetcher whose answers the test hands out one by one. */
function harness() {
  const pageCalls: Array<{ sessionId: string; query: ThreadPromptsQuery } & Pending<ThreadPromptsResponse>> = [];
  const textCalls: Array<{ sessionId: string; messageId: string } & Pending<ThreadPromptTextResponse>> = [];
  const cache = new PromptIndexCache({
    page: (sessionId, query) =>
      new Promise((resolve, reject) => pageCalls.push({ sessionId, query, resolve, reject })),
    text: (sessionId, messageId) =>
      new Promise((resolve, reject) => textCalls.push({ sessionId, messageId, resolve, reject }))
  });
  return { cache, pageCalls, textCalls };
}

function entry(messageId: string): ThreadPromptEntry {
  return {
    messageId,
    turnId: null,
    turnOrdinal: null,
    rewindable: null,
    text: messageId,
    truncated: false,
    createdAt: "2026-09-27T10:00:00.000Z",
    seq: 1
  };
}

function page(ids: string[], before: string | null, indexed = true): ThreadPromptsResponse {
  return { threadId: "s1", prompts: ids.map(entry), before, indexed };
}

/** `indexed:false, catchingUp:true`: the host's index is still reading the thread. */
function catchingUp(): ThreadPromptsResponse {
  return { threadId: "s1", prompts: [], before: null, indexed: false, catchingUp: true };
}

/** An error as the daemon answers it: a status and `{code, message}`. */
function apiError(status: number, code?: string): ApiError {
  return new ApiError(status, "GET", "/api/sessions/s1/prompts", {}, code ? { code, message: code } : undefined);
}

/** Let the cache's `.then` handlers run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("PromptIndexCache — the first page", () => {
  it("coalesces a session's first page and caches its prompts", async () => {
    const { cache, pageCalls } = harness();
    let published: PromptIndexState | undefined;
    cache.subscribe(() => { published = cache.get("s1"); });
    cache.ensure("s1");
    cache.ensure("s1");
    assert.equal(pageCalls.length, 1, "a second ensure does not ask again");
    assert.equal(cache.get("s1")?.status, "loading");
    pageCalls[0]!.resolve(page(["u3", "u2"], "cursor-1"));
    await settle();
    const state = cache.get("s1")!;
    assert.equal(state.status, "ready");
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.messageId),
      ["u3", "u2"]
    );
    assert.equal(state.before, "cursor-1");
    assert.equal(published?.status, "ready", "subscribers can render the completed request");
    cache.ensure("s1");
    assert.equal(pageCalls.length, 1, "a cached session is not asked again");
    assert.equal(cache.get("s2"), undefined);
  });

  it("falls back for a host without an index, and does not ask it again", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.resolve(page([], null, false));
    await settle();
    assert.equal(cache.get("s1")?.status, "unindexed");
    cache.retry("s1");
    assert.equal(pageCalls.length, 1);
  });

  it("asks a host without an index once more when the thread says its history is indexed", async () => {
    const { cache, pageCalls } = harness();
    cache.recheckUnindexed("s1");
    assert.equal(pageCalls.length, 0, "nothing asked yet: nothing to recheck");
    cache.ensure("s1");
    cache.recheckUnindexed("s1");
    assert.equal(pageCalls.length, 1, "a first page on its way is not asked twice");
    pageCalls[0]!.resolve(page([], null, false));
    await settle();
    cache.recheckUnindexed("s1");
    assert.equal(pageCalls.length, 2, "asked once more");
    pageCalls[1]!.resolve(page(["u1"], null));
    await settle();
    assert.equal(cache.get("s1")?.status, "ready");
    cache.recheckUnindexed("s1");
    assert.equal(pageCalls.length, 2, "a ready session is left alone");
  });

  it("falls back on a failure, says why, and retries on request", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.reject(new ApiError(404, "GET", "/api/sessions/s1/prompts"));
    await settle();
    const failed = cache.get("s1")!;
    assert.equal(failed.status, "failed");
    assert.ok(failed.error);
    cache.retry("s1");
    assert.equal(pageCalls.length, 2);
    assert.equal(cache.get("s1")?.status, "loading");
    pageCalls[1]!.resolve(page(["u1"], null));
    await settle();
    assert.equal(cache.get("s1")?.status, "ready");
  });
});

describe("PromptIndexCache — an index still catching up", () => {
  it("keeps catching-up state during retries until the index answers", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.resolve(catchingUp());
    await settle();
    let state = cache.get("s1")!;
    assert.deepEqual([state.status, state.refreshing], ["catchingUp", false]);

    cache.retry("s1");
    state = cache.get("s1")!;
    assert.deepEqual(
      [state.status, state.refreshing],
      ["catchingUp", true],
      "the note stays up while it asks — no flash back to loading"
    );
    cache.retry("s1");
    assert.equal(pageCalls.length, 2, "one re-ask at a time");
    pageCalls[1]!.resolve(catchingUp());
    await settle();
    state = cache.get("s1")!;
    assert.deepEqual([state.status, state.refreshing], ["catchingUp", false]);

    cache.retry("s1");
    pageCalls[2]!.resolve(page(["u2", "u1"], null));
    await settle();
    state = cache.get("s1")!;
    assert.equal(state.status, "ready", "caught up: the asking stops");
  });

  it("turns a failed re-ask into a failure the user can retry, and a terminal answer into no index", async () => {
    const failing = harness();
    failing.cache.ensure("s1");
    failing.pageCalls[0]!.resolve(catchingUp());
    await settle();
    failing.cache.retry("s1");
    failing.pageCalls[1]!.reject(apiError(503, "INDEX_UNAVAILABLE"));
    await settle();
    assert.equal(failing.cache.get("s1")?.status, "failed");

    const terminal = harness();
    terminal.cache.ensure("s1");
    terminal.pageCalls[0]!.resolve(catchingUp());
    await settle();
    terminal.cache.retry("s1");
    terminal.pageCalls[1]!.resolve(page([], null, false));
    await settle();
    assert.equal(terminal.cache.get("s1")?.status, "unindexed");
  });
});

describe("PromptIndexCache — older pages", () => {
  async function readyWith(ids: string[], before: string | null) {
    const setup = harness();
    setup.cache.ensure("s1");
    setup.pageCalls[0]!.resolve(page(ids, before));
    await settle();
    return setup;
  }

  it("appends the next page once per message and moves the cursor", async () => {
    const { cache, pageCalls } = await readyWith(["u5", "u4"], "c1");
    cache.loadOlder("s1");
    cache.loadOlder("s1");
    assert.equal(pageCalls.length, 2, "one request in flight at a time");
    assert.equal(pageCalls[1]!.query.before, "c1");
    assert.equal(cache.get("s1")?.loadingOlder, true);
    pageCalls[1]!.resolve(page(["u4", "u3", "u2"], null));
    await settle();
    const state = cache.get("s1")!;
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.messageId),
      ["u5", "u4", "u3", "u2"]
    );
    assert.equal(state.before, null);
    assert.equal(state.loadingOlder, false);
    cache.loadOlder("s1");
    assert.equal(pageCalls.length, 2, "nothing older: nothing asked");
  });

  it("keeps what it has when an older page fails, and retries it", async () => {
    const { cache, pageCalls } = await readyWith(["u2"], "c1");
    cache.loadOlder("s1");
    pageCalls[1]!.reject(new ApiError(503, "GET", "/api/sessions/s1/prompts"));
    await settle();
    let state = cache.get("s1")!;
    assert.equal(state.status, "ready");
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.messageId),
      ["u2"]
    );
    assert.ok(state.olderError);
    cache.retry("s1");
    assert.equal(pageCalls.length, 3);
    assert.equal(pageCalls[2]!.query.before, "c1");
    pageCalls[2]!.resolve(page(["u1"], null));
    await settle();
    state = cache.get("s1")!;
    assert.equal(state.olderError, null);
    assert.deepEqual(
      state.prompts.map((prompt) => prompt.messageId),
      ["u2", "u1"]
    );
  });
});

describe("PromptIndexCache — a search reaches the whole thread", () => {
  const ready = (over: Partial<PromptIndexState> = {}): PromptIndexState => ({
    status: "ready",
    prompts: [entry("u2")],
    before: "c1",
    loadingOlder: false,
    olderError: null,
    error: null,
    catchUpAttempts: 0,
    refreshing: false,
    ...over
  });

  it("wants the next older page only when one exists and nothing is in the way", () => {
    assert.equal(searchWantsOlder(ready()), true);
    assert.equal(searchWantsOlder(undefined), false);
    assert.equal(searchWantsOlder(ready({ before: null })), false, "the thread's first prompt is held");
    assert.equal(searchWantsOlder(ready({ loadingOlder: true })), false, "one page at a time");
    assert.equal(searchWantsOlder(ready({ olderError: "down" })), false, "a failure waits for Retry");
    assert.equal(searchWantsOlder({ ...ready(), status: "unindexed" }), false);
    assert.equal(searchWantsOlder({ ...ready(), status: "failed" }), false);
  });

  it("reads as paging while a page is on its way or the next one is due", () => {
    assert.equal(searchIsPaging(ready()), true);
    assert.equal(searchIsPaging(ready({ loadingOlder: true })), true);
    assert.equal(searchIsPaging(ready({ before: null })), false);
    assert.equal(searchIsPaging(ready({ olderError: "down" })), false);
    assert.equal(searchIsPaging(undefined), false);
  });
});

describe("PromptIndexCache — whole texts", () => {

  it("reads a cut prompt once, and again only after a failure", async () => {
    const { cache, textCalls } = harness();
    assert.equal(cache.text("s1", "u1"), undefined);
    cache.ensureText("s1", "u1");
    cache.ensureText("s1", "u1");
    assert.equal(textCalls.length, 1);
    assert.deepEqual(cache.text("s1", "u1"), { status: "loading" });
    textCalls[0]!.reject(new Error("offline"));
    await settle();
    assert.equal(cache.text("s1", "u1")?.status, "failed");
    cache.ensureText("s1", "u1");
    assert.equal(textCalls.length, 2);
    textCalls[1]!.resolve({ messageId: "u1", text: "the whole prompt", truncated: false });
    await settle();
    assert.deepEqual(cache.text("s1", "u1"), { status: "ready", text: "the whole prompt", truncated: false });
    cache.ensureText("s1", "u1");
    assert.equal(textCalls.length, 2);
    assert.equal(cache.text("s2", "u1"), undefined, "per session");
  });
});

describe("PromptIndexCache — a short page with more behind it is filled", () => {
  const readyWith = (count: number, before: string | null): PromptIndexState => ({
    status: "ready",
    prompts: Array.from({ length: count }, (_, i) => entry(`u${i}`)),
    before,
    loadingOlder: false,
    olderError: null,
    error: null,
    catchUpAttempts: 0,
    refreshing: false
  });

  it("keeps asking while the list holds less than a page and the host has more", () => {
    // The host walks a bounded number of rows per request: an EMPTY page with
    // a cursor means "more behind", never "no prompts".
    assert.equal(fillWantsOlder(readyWith(0, "c1")), true);
    assert.equal(fillWantsOlder(readyWith(3, "c1")), true);
  });
});
