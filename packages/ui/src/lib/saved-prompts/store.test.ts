import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  CreateSavedPromptRequest,
  SavedPrompt,
  SavedPromptListResponse,
  UpdateSavedPromptRequest
} from "@orquester/api";

import {
  applySavedPromptEvent,
  createSavedPrompt,
  dismissSavedPromptsNotice,
  loadSavedPrompts,
  markSavedPromptsStale,
  markSavedPromptUsed,
  removeSavedPrompt,
  resetSavedPrompts,
  sanitizeSavedPrompt,
  savedPromptsLoadKey,
  savedPromptsStore,
  setSavedPromptsNotice,
  toggleSavedPromptPin,
  updateSavedPrompt,
  withPinOverride,
  type SavedPromptsApi
} from "./store.ts";

const PROJECT = "/w/acme/app";
const KEY = savedPromptsLoadKey(PROJECT);

function prompt(overrides: Partial<SavedPrompt> & { id: string }): SavedPrompt {
  return {
    title: `Title ${overrides.id}`,
    description: "",
    body: "Body",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask and promise continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fake daemon: `server` is its list; each route can be swapped per test. */
class FakeApi implements SavedPromptsApi {
  connection = { id: "local" };
  server = new Map<string, SavedPrompt>();
  listCalls: (string | null)[] = [];
  nextList: Deferred<SavedPromptListResponse> | null = null;
  failList: unknown = null;
  failMutation: unknown = null;
  updates: { id: string; patch: UpdateSavedPromptRequest }[] = [];
  nextUpdate: Deferred<SavedPrompt> | null = null;
  clock = Date.parse("2026-09-10T00:00:00.000Z");

  stamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  listSavedPrompts(projectPath: string | null): Promise<SavedPromptListResponse> {
    this.listCalls.push(projectPath);
    if (this.failList !== null) return Promise.reject(this.failList);
    if (this.nextList !== null) {
      const pending = this.nextList;
      this.nextList = null;
      return pending.promise;
    }
    const prompts = [...this.server.values()].filter(
      (entry) => entry.projectPath === null || entry.projectPath === projectPath
    );
    return Promise.resolve({ prompts });
  }

  createSavedPrompt(request: CreateSavedPromptRequest): Promise<SavedPrompt> {
    if (this.failMutation !== null) return Promise.reject(this.failMutation);
    const now = this.stamp();
    const created = prompt({
      id: `p${this.server.size + 1}`,
      title: request.title,
      body: request.body,
      description: request.description ?? "",
      tags: request.tags ?? [],
      projectPath: request.projectPath,
      pinned: request.pinned ?? false,
      createdAt: now,
      updatedAt: now
    });
    this.server.set(created.id, created);
    return Promise.resolve(created);
  }

  updateSavedPrompt(id: string, patch: UpdateSavedPromptRequest): Promise<SavedPrompt> {
    this.updates.push({ id, patch });
    if (this.nextUpdate !== null) {
      const pending = this.nextUpdate;
      this.nextUpdate = null;
      return pending.promise;
    }
    if (this.failMutation !== null) return Promise.reject(this.failMutation);
    const current = this.server.get(id);
    if (!current) return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
    const next: SavedPrompt = { ...current, ...patch, updatedAt: this.stamp() } as SavedPrompt;
    this.server.set(id, next);
    return Promise.resolve(next);
  }

  deleteSavedPrompt(id: string): Promise<void> {
    if (this.failMutation !== null) return Promise.reject(this.failMutation);
    this.server.delete(id);
    return Promise.resolve();
  }

  markSavedPromptUsed(id: string): Promise<SavedPrompt> {
    if (this.failMutation !== null) return Promise.reject(this.failMutation);
    const current = this.server.get(id);
    if (!current) return Promise.reject(new Error("not found"));
    const next = { ...current, lastUsedAt: this.stamp(), useCount: current.useCount + 1 };
    this.server.set(id, next);
    return Promise.resolve(next);
  }
}

const state = () => savedPromptsStore.getState();
const held = () => [...state().prompts.keys()].sort();

beforeEach(() => {
  resetSavedPrompts();
});

describe("wire validation", () => {
  it("repairs optional fields and refuses what cannot be trusted", () => {
    assert.deepEqual(sanitizeSavedPrompt({ id: "a", title: "T", body: "B", projectPath: null }), {
      id: "a",
      title: "T",
      description: "",
      body: "B",
      tags: [],
      projectPath: null,
      pinned: false,
      createdAt: "",
      updatedAt: "",
      lastUsedAt: null,
      useCount: 0
    });
    const tags = sanitizeSavedPrompt({ id: "a", title: "T", body: "B", projectPath: "/p", tags: ["x", 3, "", "y"] });
    assert.deepEqual(tags?.tags, ["x", "y"]);
    for (const bad of [
      null,
      "text",
      [],
      { title: "T", body: "B", projectPath: null },
      { id: "", title: "T", body: "B", projectPath: null },
      { id: "a", body: "B", projectPath: null },
      { id: "a", title: "T", projectPath: null },
      { id: "a", title: "T", body: "B" },
      { id: "a", title: "T", body: "B", projectPath: 7 },
      { id: "a", title: "T", body: "B", projectPath: "" }
    ]) {
      assert.equal(sanitizeSavedPrompt(bad), null, JSON.stringify(bad));
    }
  });
});

describe("loads", () => {
  it("loads global + the project's, once, sharing a request between concurrent callers", async () => {
    const api = new FakeApi();
    api.server.set("g", prompt({ id: "g" }));
    api.server.set("p", prompt({ id: "p", projectPath: PROJECT }));
    api.server.set("o", prompt({ id: "o", projectPath: "/w/acme/other" }));
    const first = loadSavedPrompts(api, PROJECT);
    const second = loadSavedPrompts(api, `${PROJECT}/`);
    assert.equal(state().loads[KEY]?.status, "loading");
    await Promise.all([first, second]);
    assert.deepEqual(api.listCalls, [PROJECT], "one request for both callers");
    assert.deepEqual(held(), ["g", "p"]);
    assert.equal(state().loads[KEY]?.status, "loaded");
    await loadSavedPrompts(api, PROJECT);
    assert.equal(api.listCalls.length, 1, "a loaded, fresh scope is not asked again");
    await loadSavedPrompts(api, PROJECT, { force: true });
    assert.equal(api.listCalls.length, 2, "force asks again");
  });

  it("no project loads the global list alone", async () => {
    const api = new FakeApi();
    await loadSavedPrompts(api, null);
    await loadSavedPrompts(api, "");
    assert.deepEqual(api.listCalls, [null]);
    assert.equal(savedPromptsLoadKey(""), savedPromptsLoadKey(null));
  });

  it("a reload replaces exactly its scope: what the daemon dropped goes, another project's stays", async () => {
    const api = new FakeApi();
    api.server.set("g", prompt({ id: "g" }));
    api.server.set("p", prompt({ id: "p", projectPath: PROJECT }));
    await loadSavedPrompts(api, PROJECT);
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({ id: "other", projectPath: "/w/acme/other" })
    });
    // Deleted on the daemon while this client missed the event.
    api.server.delete("g");
    await loadSavedPrompts(api, PROJECT, { force: true });
    assert.deepEqual(held(), ["other", "p"]);
  });

  it("an event that overtakes the load answer it is newer than survives the answer", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    // Created after the daemon read its list, but its event arrives first.
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "new" }) });
    answer.resolve({ prompts: [prompt({ id: "g" })] });
    await load;
    assert.deepEqual(held(), ["g", "new"]);
  });

  it("an answer never brings back a prompt deleted meanwhile, nor overwrites a newer copy", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    applySavedPromptEvent({ type: "savedPrompt.deleted", payload: { id: "gone", projectPath: null } });
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({ id: "edited", title: "New", updatedAt: "2026-09-02T00:00:00.000Z" })
    });
    answer.resolve({
      prompts: [prompt({ id: "gone" }), prompt({ id: "edited", title: "Old" })]
    });
    await load;
    assert.deepEqual(held(), ["edited"]);
    assert.equal(state().prompts.get("edited")?.title, "New");
  });

  it("an id nothing touched during the load takes the answer as-is, even stamped older", async () => {
    const api = new FakeApi();
    // A held copy stamped in the future — a daemon clock that later stepped back.
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({ id: "a", title: "Stale", updatedAt: "2030-01-01T00:00:00.000Z" })
    });
    api.server.set("a", prompt({ id: "a", title: "Truth", updatedAt: "2026-09-01T00:00:00.000Z" }));
    await loadSavedPrompts(api, PROJECT);
    assert.equal(state().prompts.get("a")?.title, "Truth", "a reload repairs it");
  });

  it("a reload that changes nothing keeps every record's object", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, PROJECT);
    const before = state().prompts.get("a");
    await loadSavedPrompts(api, PROJECT, { force: true });
    assert.equal(state().prompts.get("a"), before);
  });

  it("a first load that fails is an error; a failed refresh keeps the rows beside the error", async () => {
    const api = new FakeApi();
    api.failList = Object.assign(new Error("Orquester API GET failed"), { serverMessage: "disk full" });
    await loadSavedPrompts(api, PROJECT);
    assert.deepEqual(state().loads[KEY], { status: "error", error: "disk full", refreshing: false, stale: false });

    api.failList = null;
    api.server.set("g", prompt({ id: "g" }));
    await loadSavedPrompts(api, PROJECT);
    assert.equal(state().loads[KEY]?.status, "loaded", "an error is retried on the next load");

    api.failList = new Error("offline");
    await loadSavedPrompts(api, PROJECT, { force: true });
    assert.deepEqual(held(), ["g"], "the rows stay");
    assert.equal(state().loads[KEY]?.status, "loaded");
    assert.equal(state().loads[KEY]?.error, "offline");
    assert.equal(state().loads[KEY]?.stale, true, "and the next load tries again");
  });

  it("a forced load asked while one is in flight asks again after it — once, for every such call", async () => {
    const api = new FakeApi();
    const first = deferred<SavedPromptListResponse>();
    api.nextList = first;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    const forcedA = loadSavedPrompts(api, PROJECT, { force: true });
    const forcedB = loadSavedPrompts(api, PROJECT, { force: true });
    assert.equal(forcedA, forcedB, "one follow-up, shared");
    assert.notEqual(forcedA, load, "not the load in flight");
    // The answer in flight was read before this prompt existed.
    api.server.set("late", prompt({ id: "late" }));
    first.resolve({ prompts: [] });
    await forcedA;
    assert.deepEqual(api.listCalls, [PROJECT, PROJECT]);
    assert.deepEqual(held(), ["late"]);
    await settle();
    assert.equal(api.listCalls.length, 2, "and no more");
  });

  it("a project list the daemon refuses (400) falls back to the global list, and says why", async () => {
    const api = new FakeApi();
    api.server.set("g", prompt({ id: "g" }));
    const refused = Object.assign(new Error("Orquester API GET /api/saved-prompts failed with status 400"), {
      status: 400,
      serverMessage: "Project directory not found",
      body: { code: "INVALID_PROJECT_PATH", message: "Project directory not found" }
    });
    const listGlobal = api.listSavedPrompts.bind(api);
    api.listSavedPrompts = (projectPath) => {
      if (projectPath === null) return listGlobal(null);
      api.listCalls.push(projectPath);
      return Promise.reject(refused);
    };
    await loadSavedPrompts(api, PROJECT);
    await settle();
    await settle();
    assert.deepEqual(api.listCalls, [PROJECT, null], "then the global list on its own");
    assert.deepEqual(held(), ["g"], "the global prompts stay usable");
    assert.equal(state().loads[KEY]?.status, "error");
    assert.equal(state().loads[KEY]?.error, "Project directory not found — only global prompts are listed.");
    assert.equal(state().loads[savedPromptsLoadKey(null)]?.status, "loaded");
  });

  it("any other failure of a project list does not fall back", async () => {
    const api = new FakeApi();
    api.failList = Object.assign(new Error("boom"), { status: 500 });
    await loadSavedPrompts(api, PROJECT);
    await settle();
    assert.deepEqual(api.listCalls, [PROJECT]);
  });

  it("a daemon without the route says so", async () => {
    const api = new FakeApi();
    api.failList = Object.assign(new Error("404"), { status: 404 });
    await loadSavedPrompts(api, PROJECT);
    assert.match(state().loads[KEY]?.error ?? "", /does not support saved prompts/);
  });

  it("an answer of the wrong shape is a load error, not a crash", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    answer.resolve({ items: [] } as unknown as SavedPromptListResponse);
    await load;
    assert.equal(state().loads[KEY]?.status, "error");
  });

  it("a malformed row is dropped, the rest of the answer kept", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    answer.resolve({ prompts: [prompt({ id: "ok" }), { id: 5 } as unknown as SavedPrompt] });
    await load;
    assert.deepEqual(held(), ["ok"]);
  });

  it("stale marks a reconnect: the rows stay and the next load refreshes in the background", async () => {
    const api = new FakeApi();
    api.server.set("g", prompt({ id: "g" }));
    await loadSavedPrompts(api, PROJECT);
    markSavedPromptsStale();
    assert.equal(state().loads[KEY]?.stale, true);
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const refresh = loadSavedPrompts(api, PROJECT);
    assert.equal(state().loads[KEY]?.status, "loaded", "no loading state over rows");
    assert.equal(state().loads[KEY]?.refreshing, true);
    assert.deepEqual(held(), ["g"]);
    answer.resolve({ prompts: [prompt({ id: "g" }), prompt({ id: "h" })] });
    await refresh;
    assert.deepEqual(state().loads[KEY], { status: "loaded", error: null, refreshing: false, stale: false });
    assert.deepEqual(held(), ["g", "h"]);
  });

  it("a load that crosses a reconnect asks once more, then is fresh", async () => {
    const api = new FakeApi();
    api.server.set("late", prompt({ id: "late" }));
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    markSavedPromptsStale();
    // The reconnect's own load joins the one in flight…
    assert.equal(loadSavedPrompts(api, PROJECT), load);
    answer.resolve({ prompts: [] });
    await load;
    // …so the answer, which may predate the reconnect, is followed by one more.
    await settle();
    assert.deepEqual(api.listCalls, [PROJECT, PROJECT]);
    assert.deepEqual(held(), ["late"]);
    assert.equal(state().loads[KEY]?.stale, false);
    await settle();
    assert.equal(api.listCalls.length, 2, "and no more");
  });

  it("a failed load that crossed a reconnect retries once, not forever", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    markSavedPromptsStale();
    api.failList = new Error("offline");
    answer.reject(new Error("socket hang up"));
    await load;
    await settle();
    await settle();
    assert.deepEqual(api.listCalls, [PROJECT, PROJECT]);
    assert.equal(state().loads[KEY]?.status, "error");
  });
});

describe("events", () => {
  it("an upsert is idempotent: the same record twice changes nothing", () => {
    const record = prompt({ id: "a" });
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: record });
    const after = state();
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: { ...record } });
    assert.equal(state(), after, "no new state for a repeat");
    assert.deepEqual(held(), ["a"]);
  });

  it("an older record never replaces a newer one; a later use does", () => {
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({ id: "a", title: "New", updatedAt: "2026-09-05T00:00:00.000Z" })
    });
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({ id: "a", title: "Old", updatedAt: "2026-09-04T00:00:00.000Z" })
    });
    assert.equal(state().prompts.get("a")?.title, "New");
    applySavedPromptEvent({
      type: "savedPrompt.upserted",
      payload: prompt({
        id: "a",
        title: "New",
        updatedAt: "2026-09-05T00:00:00.000Z",
        lastUsedAt: "2026-09-06T00:00:00.000Z",
        useCount: 1
      })
    });
    assert.equal(state().prompts.get("a")?.useCount, 1);
  });

  it("a delete removes, and nothing brings the id back", () => {
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "a" }) });
    applySavedPromptEvent({ type: "savedPrompt.deleted", payload: { id: "a", projectPath: null } });
    assert.deepEqual(held(), []);
    applySavedPromptEvent({ type: "savedPrompt.deleted", payload: { id: "a", projectPath: null } });
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "a" }) });
    assert.deepEqual(held(), [], "a late upsert of a deleted id is dropped");
  });

  it("malformed payloads and unknown types are ignored without a throw", () => {
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "keep" }) });
    const before = state();
    for (const payload of [null, undefined, 3, "x", [], { id: 1 }, { title: "T" }]) {
      applySavedPromptEvent({ type: "savedPrompt.upserted", payload });
      applySavedPromptEvent({ type: "savedPrompt.deleted", payload });
    }
    applySavedPromptEvent({ type: "savedPrompt.renamed", payload: prompt({ id: "x" }) });
    assert.equal(state(), before);
    assert.deepEqual(held(), ["keep"]);
  });
});

describe("mutations", () => {
  it("a create applies the daemon's record at once; its own event later changes nothing", async () => {
    const api = new FakeApi();
    const result = await createSavedPrompt(api, { title: "New", body: "Go", projectPath: PROJECT });
    assert.equal(result.ok, true);
    const created = result.ok ? result.prompt : null;
    assert.ok(created !== null);
    assert.deepEqual(held(), [created.id]);
    const after = state();
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: { ...created } });
    assert.equal(state(), after);
  });

  it("an update applies its answer; a delete removes and tombstones", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    const updated = await updateSavedPrompt(api, "a", { title: "Renamed" });
    assert.equal(updated.ok, true);
    assert.equal(state().prompts.get("a")?.title, "Renamed");
    const removed = await removeSavedPrompt(api, "a");
    assert.deepEqual(removed, { ok: true, prompt: null });
    assert.deepEqual(held(), []);
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "a" }) });
    assert.deepEqual(held(), []);
  });

  it("a failed change becomes the notice and reloads every loaded scope", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, PROJECT);
    api.failMutation = Object.assign(new Error("x"), { serverMessage: "Prompt not found" });
    const result = await removeSavedPrompt(api, "a");
    assert.deepEqual(result, { ok: false, error: "Prompt not found" });
    assert.equal(state().notice, "Couldn't delete the prompt: Prompt not found");
    await settle();
    assert.deepEqual(api.listCalls, [PROJECT, PROJECT], "reloaded with the path it was loaded with");
    dismissSavedPromptsNotice();
    assert.equal(state().notice, null);
  });

  it("a notice can come from outside — an editor closed while it saved — and be dismissed", () => {
    setSavedPromptsNotice("Couldn't save the prompt: full");
    assert.equal(state().notice, "Couldn't save the prompt: full");
    dismissSavedPromptsNotice();
    assert.equal(state().notice, null);
  });

  it("a quiet failure leaves the notice to the caller", async () => {
    const api = new FakeApi();
    api.failMutation = new Error("Title is required");
    const result = await createSavedPrompt(api, { title: "", body: "x", projectPath: null }, { quiet: true });
    assert.deepEqual(result, { ok: false, error: "Title is required" });
    assert.equal(state().notice, null);
  });

  it("a pin shows at once, then carries the daemon's record", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    const answer = deferred<SavedPrompt>();
    api.nextUpdate = answer;
    const pinning = toggleSavedPromptPin(api, "a");
    assert.equal(state().pinOverrides.get("a"), true);
    const shown = withPinOverride(state().prompts.get("a")!, state().pinOverrides);
    assert.equal(shown.pinned, true, "shown pinned before the daemon answers");
    assert.deepEqual(api.updates, [{ id: "a", patch: { pinned: true } }]);
    answer.resolve(prompt({ id: "a", pinned: true, updatedAt: "2026-09-11T00:00:00.000Z" }));
    await pinning;
    assert.equal(state().pinOverrides.size, 0);
    assert.equal(state().prompts.get("a")?.pinned, true);
  });

  it("a refused pin falls back to the held value, with the notice", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    api.failMutation = new Error("read-only");
    const result = await toggleSavedPromptPin(api, "a");
    assert.equal(result.ok, false);
    assert.equal(state().pinOverrides.size, 0);
    assert.equal(state().prompts.get("a")?.pinned, false);
    assert.equal(state().notice, "Couldn't pin the prompt: read-only");
  });

  it("two quick flips: only the latest answer clears the flip", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    const first = deferred<SavedPrompt>();
    api.nextUpdate = first;
    const pin = toggleSavedPromptPin(api, "a");
    const second = deferred<SavedPrompt>();
    api.nextUpdate = second;
    const unpin = toggleSavedPromptPin(api, "a");
    assert.deepEqual(
      api.updates.map((entry) => entry.patch),
      [{ pinned: true }, { pinned: false }]
    );
    first.resolve(prompt({ id: "a", pinned: true, updatedAt: "2026-09-11T00:00:00.000Z" }));
    await pin;
    assert.equal(state().pinOverrides.get("a"), false, "still shows the second flip");
    second.resolve(prompt({ id: "a", pinned: false, updatedAt: "2026-09-12T00:00:00.000Z" }));
    await unpin;
    assert.equal(state().pinOverrides.size, 0);
    assert.equal(state().prompts.get("a")?.pinned, false);
  });

  it("a use bumps the record; a failed bump is silent and reloads nothing", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    await markSavedPromptUsed(api, "a");
    assert.equal(state().prompts.get("a")?.useCount, 1);
    api.failMutation = new Error("down");
    const result = await markSavedPromptUsed(api, "a");
    assert.equal(result.ok, false);
    await settle();
    assert.equal(state().notice, null);
    assert.equal(api.listCalls.length, 1);
  });
});

describe("reset", () => {
  it("forgets everything, and an answer from before it is dropped", async () => {
    const api = new FakeApi();
    api.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(api, null);
    applySavedPromptEvent({ type: "savedPrompt.deleted", payload: { id: "t", projectPath: null } });
    const answer = deferred<SavedPromptListResponse>();
    api.nextList = answer;
    const load = loadSavedPrompts(api, PROJECT);
    await settle();
    resetSavedPrompts();
    assert.equal(state().prompts.size, 0);
    assert.deepEqual(state().loads, {});
    answer.resolve({ prompts: [prompt({ id: "late" })] });
    await load;
    assert.equal(state().prompts.size, 0, "the pre-reset answer is not applied");
    assert.deepEqual(state().loads, {}, "nor its load state");
    applySavedPromptEvent({ type: "savedPrompt.upserted", payload: prompt({ id: "t" }) });
    assert.deepEqual(held(), ["t"], "tombstones are per connection too");
  });

  it("a reset before the request left sends nothing", async () => {
    const api = new FakeApi();
    const load = loadSavedPrompts(api, PROJECT);
    resetSavedPrompts();
    await load;
    assert.deepEqual(api.listCalls, []);
    assert.deepEqual(state().loads, {});
  });

  it("a client of another connection starts over", async () => {
    const local = new FakeApi();
    local.server.set("a", prompt({ id: "a" }));
    await loadSavedPrompts(local, null);
    const remote = new FakeApi();
    remote.connection = { id: "vps" };
    remote.server.set("b", prompt({ id: "b" }));
    await loadSavedPrompts(remote, null);
    assert.deepEqual(held(), ["b"]);
  });

  it("a mutation answered after a reset is not applied", async () => {
    const api = new FakeApi();
    const answer = deferred<SavedPrompt>();
    api.nextUpdate = answer;
    const update = updateSavedPrompt(api, "a", { title: "x" });
    resetSavedPrompts();
    answer.resolve(prompt({ id: "a" }));
    const result = await update;
    assert.equal(result.ok, false);
    assert.equal(state().prompts.size, 0);
  });
});
