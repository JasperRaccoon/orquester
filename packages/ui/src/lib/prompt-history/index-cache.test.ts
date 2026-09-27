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
  CATCH_UP_MAX_ATTEMPTS,
  catchUpDelayMs,
  PROMPT_PAGE_LIMIT,
  PromptIndexCache,
  promptListErrorMessage,
  promptTextErrorMessage,
  scheduleCatchUpReask,
  SEARCH_PAGE_LIMIT,
  SEARCH_PROMPT_CAP,
  fillWantsOlder,
  searchIsPaging,
  searchWantsOlder,
  type PromptIndexState,
  type ReaskTimers
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
  let notified = 0;
  cache.subscribe(() => {
    notified += 1;
  });
  return { cache, pageCalls, textCalls, notifications: () => notified };
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
  it("asks once per session, 100 to a page, and holds what it got", async () => {
    const { cache, pageCalls, notifications } = harness();
    cache.ensure("s1");
    cache.ensure("s1");
    assert.equal(pageCalls.length, 1, "a second ensure does not ask again");
    assert.deepEqual(pageCalls[0]!.query, { limit: PROMPT_PAGE_LIMIT });
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
    assert.ok(notifications() >= 2);
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
    assert.match(failed.error ?? "", /can't list/);
    cache.retry("s1");
    assert.equal(pageCalls.length, 2);
    assert.equal(cache.get("s1")?.status, "loading");
    pageCalls[1]!.resolve(page(["u1"], null));
    await settle();
    assert.equal(cache.get("s1")?.status, "ready");
  });

  it("names a failure by the host's code, never a missing route for a missing index", () => {
    assert.match(promptListErrorMessage(apiError(404, "THREAD_NOT_FOUND")), /can't list a chat's prompts/);
    assert.match(promptListErrorMessage(apiError(503, "INDEX_UNAVAILABLE")), /index couldn't answer/);
    assert.match(promptListErrorMessage(apiError(503, "HOST_UNAVAILABLE")), /agent host isn't available/);
    assert.match(promptListErrorMessage(apiError(0)), /Couldn't reach the daemon/);
    assert.equal(promptListErrorMessage(new Error("x"), "Couldn't load older prompts."), "Couldn't load older prompts.");
  });

  it("does not ask twice while the first page is on its way", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.reject(new Error("offline"));
    await settle();
    cache.retry("s1");
    cache.retry("s1");
    cache.loadOlder("s1");
    assert.equal(pageCalls.length, 2, "one retry in flight; nothing older before a first page");
    pageCalls[1]!.resolve(page(["u1"], "c1"));
    await settle();
    assert.deepEqual(
      cache.get("s1")?.prompts.map((prompt) => prompt.messageId),
      ["u1"]
    );
  });
});

describe("PromptIndexCache — an index still catching up", () => {
  it("backs off 3 s, 6 s, 12 s, 24 s, then every 30 s, and gives up after its last attempt", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 12].map(catchUpDelayMs),
      [3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000]
    );
    assert.equal(catchUpDelayMs(CATCH_UP_MAX_ATTEMPTS), 30_000);
    assert.equal(catchUpDelayMs(CATCH_UP_MAX_ATTEMPTS + 1), null, "gave up");
    assert.equal(catchUpDelayMs(0), null, "nothing said it is catching up");
  });

  it("asks again quietly, counting each answer that still says so, until the index answers", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.resolve(catchingUp());
    await settle();
    let state = cache.get("s1")!;
    assert.deepEqual([state.status, state.catchUpAttempts, state.refreshing], ["catchingUp", 1, false]);

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
    assert.deepEqual([state.status, state.catchUpAttempts, state.refreshing], ["catchingUp", 2, false]);

    cache.retry("s1");
    pageCalls[2]!.resolve(page(["u2", "u1"], null));
    await settle();
    state = cache.get("s1")!;
    assert.deepEqual([state.status, state.catchUpAttempts], ["ready", 0], "caught up: the asking stops");
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

  it("starts the backoff over when the user retries after it gave up", async () => {
    const { cache, pageCalls } = harness();
    cache.ensure("s1");
    pageCalls[0]!.resolve(catchingUp());
    await settle();
    // Walk the counter past the last attempt, as the timer would.
    for (let attempt = 1; attempt <= CATCH_UP_MAX_ATTEMPTS; attempt += 1) {
      cache.retry("s1");
      pageCalls.at(-1)!.resolve(catchingUp());
      await settle();
    }
    assert.equal(cache.get("s1")?.catchUpAttempts, CATCH_UP_MAX_ATTEMPTS + 1);
    assert.equal(scheduleCatchUpReask(cache, "s1", cache.get("s1"), fakeTimers().timers), null, "gave up");
    cache.retry("s1");
    pageCalls.at(-1)!.resolve(catchingUp());
    await settle();
    assert.equal(cache.get("s1")?.catchUpAttempts, 1, "asking by itself again");
  });
});

/** A clock the test turns by hand. */
function fakeTimers(): { timers: ReaskTimers; pending: Map<number, { run: () => void; ms: number }> } {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    timers: {
      set: (run, ms) => {
        next += 1;
        pending.set(next, { run, ms });
        return next;
      },
      clear: (handle) => {
        pending.delete(handle as number);
      }
    }
  };
}

describe("scheduleCatchUpReask — the effect behind the asking", () => {
  const base: PromptIndexState = {
    status: "catchingUp",
    prompts: [],
    before: null,
    loadingOlder: false,
    olderError: null,
    error: null,
    catchUpAttempts: 3,
    refreshing: false
  };

  it("arms one re-ask at the backoff's delay, and its cleanup disarms it (the panel went)", () => {
    const retried: string[] = [];
    const { timers, pending } = fakeTimers();
    const cancel = scheduleCatchUpReask({ retry: (id) => retried.push(id) }, "s1", base, timers);
    assert.ok(cancel !== null);
    assert.deepEqual([...pending.values()].map((timer) => timer.ms), [12_000]);
    cancel();
    assert.equal(pending.size, 0, "unmounted: nothing fires");
    assert.equal(retried.length, 0);

    scheduleCatchUpReask({ retry: (id) => retried.push(id) }, "s1", base, timers);
    for (const timer of pending.values()) timer.run();
    assert.deepEqual(retried, ["s1"], "it fires the cache's quiet re-ask");
  });

  it("arms nothing unless the session is catching up and not already asking", () => {
    const { timers, pending } = fakeTimers();
    const cache = { retry: () => undefined };
    for (const state of [
      undefined,
      { ...base, status: "ready" as const },
      { ...base, status: "unindexed" as const },
      { ...base, status: "failed" as const },
      { ...base, refreshing: true },
      { ...base, catchUpAttempts: CATCH_UP_MAX_ATTEMPTS + 1 }
    ]) {
      assert.equal(scheduleCatchUpReask(cache, "s1", state, timers), null);
    }
    assert.equal(pending.size, 0);
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
    assert.deepEqual(pageCalls[1]!.query, { before: "c1", limit: PROMPT_PAGE_LIMIT });
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
    assert.match(state.olderError ?? "", /unavailable/);
    cache.retry("s1");
    assert.equal(pageCalls.length, 3);
    assert.deepEqual(pageCalls[2]!.query, { before: "c1", limit: PROMPT_PAGE_LIMIT });
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

  it("stops at the cap, leaving the rest to Load older prompts", () => {
    const many = Array.from({ length: SEARCH_PROMPT_CAP }, (_, i) => entry(`u${i}`));
    assert.equal(searchWantsOlder(ready({ prompts: many })), false);
    assert.equal(searchWantsOlder(ready({ prompts: many.slice(1) })), true);
    assert.equal(searchWantsOlder(ready({ prompts: many.slice(0, 3) }), 3), false, "a cap of its own");
  });

  it("reads as paging while a page is on its way or the next one is due", () => {
    assert.equal(searchIsPaging(ready()), true);
    assert.equal(searchIsPaging(ready({ loadingOlder: true })), true);
    assert.equal(searchIsPaging(ready({ before: null })), false);
    assert.equal(searchIsPaging(ready({ olderError: "down" })), false);
    assert.equal(searchIsPaging(undefined), false);
  });

  /**
   * The pager as `useSearchLoadsOlder` runs it: every time the state changes,
   * ask for the next page while `searchWantsOlder` says so. The host is a
   * script of answers; the loop must end on its own.
   */
  async function runPager(
    answers: Array<ThreadPromptsResponse | Error>,
    cap: number = SEARCH_PROMPT_CAP
  ): Promise<{ state: PromptIndexState; asked: number }> {
    const setup = harness();
    setup.cache.ensure("s1");
    setup.pageCalls[0]!.resolve(page(["p0"], "c0"));
    await settle();
    let asked = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      if (!searchWantsOlder(setup.cache.get("s1"), cap)) break;
      setup.cache.loadOlder("s1", SEARCH_PAGE_LIMIT);
      const call = setup.pageCalls.at(-1)!;
      assert.equal(call.query.limit, SEARCH_PAGE_LIMIT);
      const answer = answers[asked] ?? page([], null);
      asked += 1;
      if (answer instanceof Error) call.reject(answer);
      else call.resolve(answer);
      await settle();
    }
    return { state: setup.cache.get("s1")!, asked };
  }

  it("pages until the thread's first prompt, and stops", async () => {
    const { state, asked } = await runPager([page(["p1"], "c1"), page(["p2"], "c2"), page(["p3"], null)]);
    assert.equal(asked, 3);
    assert.equal(state.before, null);
    assert.equal(state.prompts.length, 4);
    assert.equal(searchIsPaging(state), false);
  });

  it("stops at the cap, leaving the rest to Load older prompts", async () => {
    const { state, asked } = await runPager(
      [page(["p1", "p2"], "c1"), page(["p3", "p4"], "c2"), page(["p5"], "c3")],
      4
    );
    assert.equal(asked, 2, "4 held: no third page");
    assert.equal(state.before, "c2", "there is older history, the user's to load");
    assert.equal(searchIsPaging(state, 4), false);
  });

  it("stops on a failed page, which waits for the user's Retry", async () => {
    const { state, asked } = await runPager([page(["p1"], "c1"), apiError(503, "INDEX_UNAVAILABLE")]);
    assert.equal(asked, 2);
    assert.notEqual(state.olderError, null);
    assert.equal(searchIsPaging(state), false);
  });

  it("asks a search's pages at the host's maximum size", async () => {
    const setup = harness();
    setup.cache.ensure("s1");
    setup.pageCalls[0]!.resolve(page(["u9"], "c1"));
    await settle();
    setup.cache.loadOlder("s1", SEARCH_PAGE_LIMIT);
    assert.deepEqual(setup.pageCalls[1]!.query, { before: "c1", limit: SEARCH_PAGE_LIMIT });
  });
});

describe("PromptIndexCache — whole texts", () => {
  it("names a text read's failure by the host's code", async () => {
    assert.equal(promptTextErrorMessage(apiError(404, "PROMPT_NOT_FOUND")), "That prompt is no longer in this chat.");
    assert.doesNotMatch(promptTextErrorMessage(apiError(404, "PROMPT_NOT_FOUND")), /can't list/);
    assert.match(promptTextErrorMessage(apiError(503, "INDEX_UNAVAILABLE")), /try again in a moment/);
    assert.match(promptTextErrorMessage(apiError(404, "THREAD_NOT_FOUND")), /no longer available/);
    assert.match(promptTextErrorMessage(apiError(0)), /Couldn't reach the daemon/);

    const { cache, textCalls } = harness();
    cache.ensureText("s1", "gone");
    textCalls[0]!.reject(apiError(404, "PROMPT_NOT_FOUND"));
    await settle();
    assert.deepEqual(cache.text("s1", "gone"), {
      status: "failed",
      error: "That prompt is no longer in this chat."
    });
  });

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
    assert.equal(fillWantsOlder(readyWith(PROMPT_PAGE_LIMIT - 1, "c1")), true);
  });

  it("stops at a page's worth, at the thread's first prompt, on a failure, one page at a time", () => {
    assert.equal(fillWantsOlder(readyWith(PROMPT_PAGE_LIMIT, "c1")), false);
    assert.equal(fillWantsOlder(readyWith(3, null)), false);
    assert.equal(fillWantsOlder({ ...readyWith(3, "c1"), olderError: "down" }), false);
    assert.equal(fillWantsOlder({ ...readyWith(3, "c1"), loadingOlder: true }), false);
    assert.equal(fillWantsOlder(undefined), false);
  });
});
