import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { RepoIdentitiesResponse, RepoIdentity, RepoIdentityResponse } from "@orquester/api";

import {
  applyRepoIdentity,
  applyRepoIdentityEvent,
  clearRepoIcon,
  fetchRepoFavicon,
  getRepoIdentity,
  loadRepoIdentities,
  repoIdentitiesStore,
  repoLabelOf,
  resetRepoIdentities,
  sanitizeRepoIdentity,
  setRepoEmoji,
  setRepoLabel,
  type RepoIdentitiesApi
} from "./store.ts";

const KEY = "github.com/jasperraccoon/jasperengine";
const OTHER = "github.com/jasperraccoon/orquester";

function identity(overrides: Partial<RepoIdentity> = {}): RepoIdentity {
  return { repoKey: KEY, label: "Engine", updatedAt: "2026-10-18T10:00:00.000Z", ...overrides };
}

const at = (minute: number) => `2026-10-18T10:${String(minute).padStart(2, "0")}:00.000Z`;

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

/** A fake client: every call waits on a deferred the test settles. */
function fakeApi(connectionId = "c1") {
  const lists: Array<Deferred<RepoIdentitiesResponse>> = [];
  const mutations: Array<{ name: string; args: unknown[]; answer: Deferred<RepoIdentityResponse> }> = [];
  const mutation = (name: string) => (...args: unknown[]) => {
    const answer = deferred<RepoIdentityResponse>();
    mutations.push({ name, args, answer });
    return answer.promise;
  };
  const api: RepoIdentitiesApi = {
    connection: { id: connectionId },
    listRepoIdentities: () => {
      const answer = deferred<RepoIdentitiesResponse>();
      lists.push(answer);
      return answer.promise;
    },
    setRepoLabel: mutation("setRepoLabel"),
    setRepoEmoji: mutation("setRepoEmoji"),
    uploadRepoIcon: mutation("uploadRepoIcon"),
    clearRepoIcon: mutation("clearRepoIcon"),
    fetchRepoFavicon: mutation("fetchRepoFavicon"),
    readRepoIcon: () => Promise.reject(new Error("unused"))
  };
  return { api, lists, mutations };
}

const event = (payload: unknown, type = "repoIdentity.changed") => ({ type, payload });
const held = () => repoIdentitiesStore.getState().identities;

beforeEach(() => resetRepoIdentities());

describe("wire validation", () => {
  it("keeps a well-formed identity and repairs bad fields one by one", () => {
    assert.deepEqual(sanitizeRepoIdentity(identity()), identity());
    assert.deepEqual(
      sanitizeRepoIdentity({ ...identity(), icon: { kind: "sticker" }, extra: 1 }),
      identity()
    );
    assert.deepEqual(sanitizeRepoIdentity({ ...identity({ label: undefined }), label: 5, icon: { kind: "emoji", value: "🦝" } }), {
      repoKey: KEY,
      icon: { kind: "emoji", value: "🦝" },
      updatedAt: identity().updatedAt
    });
    const image = sanitizeRepoIdentity({
      ...identity(),
      icon: { kind: "image", contentType: "image/x-icon", version: "v1", source: { kind: "favicon", domain: "a.com" }, file: "x" }
    });
    assert.deepEqual(image?.icon, { kind: "image", contentType: "image/x-icon", version: "v1", source: { kind: "favicon", domain: "a.com" } });
  });

  it("drops what cannot be trusted", () => {
    assert.equal(sanitizeRepoIdentity(null), null);
    assert.equal(sanitizeRepoIdentity({ ...identity(), repoKey: "/home/me/repo" }), null);
    assert.equal(sanitizeRepoIdentity({ ...identity(), repoKey: "GitHub.com/a/b" }), null);
    assert.equal(sanitizeRepoIdentity({ ...identity(), updatedAt: 5 }), null);
    // Nothing left to show.
    assert.equal(sanitizeRepoIdentity({ repoKey: KEY, label: "  ", updatedAt: at(0) }), null);
    assert.equal(
      sanitizeRepoIdentity({ repoKey: KEY, icon: { kind: "image", contentType: "text/html", version: "v" }, updatedAt: at(0) }),
      null
    );
  });

  it("repoLabelOf falls back to the remote's name", () => {
    const map = new Map([[KEY, identity()]]);
    assert.equal(repoLabelOf(map, KEY, "JasperRaccoon/JasperEngine"), "Engine");
    assert.equal(repoLabelOf(map, OTHER, "JasperRaccoon/orquester"), "JasperRaccoon/orquester");
  });
});

describe("events", () => {
  it("apply a change and a delete; ignore malformed and unknown ones", () => {
    applyRepoIdentityEvent(event({ identity: identity() }));
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
    applyRepoIdentityEvent(event({ identity: { ...identity(), repoKey: 7 } }));
    applyRepoIdentityEvent(event({ repoKey: KEY, deleted: "yes" }));
    applyRepoIdentityEvent(event({ repoKey: KEY, deleted: true }, "repoIdentity.other"));
    applyRepoIdentityEvent(event("nonsense"));
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
    applyRepoIdentityEvent(event({ repoKey: KEY, deleted: true }));
    assert.equal(getRepoIdentity(KEY), undefined);
  });

  it("never go backwards by updatedAt", () => {
    applyRepoIdentityEvent(event({ identity: identity({ label: "New", updatedAt: at(5) }) }));
    applyRepoIdentityEvent(event({ identity: identity({ label: "Old", updatedAt: at(1) }) }));
    assert.equal(getRepoIdentity(KEY)?.label, "New");
    applyRepoIdentityEvent(event({ identity: identity({ label: "Newer", updatedAt: at(6) }) }));
    assert.equal(getRepoIdentity(KEY)?.label, "Newer");
  });

  it("a stale answer does not bring a deleted identity back; a newer one does", () => {
    applyRepoIdentityEvent(event({ identity: identity({ updatedAt: at(5) }) }));
    applyRepoIdentityEvent(event({ repoKey: KEY, deleted: true }));
    applyRepoIdentity(KEY, identity({ updatedAt: at(5) }));
    assert.equal(getRepoIdentity(KEY), undefined);
    applyRepoIdentity(KEY, identity({ label: "Again", updatedAt: at(7) }));
    assert.equal(getRepoIdentity(KEY)?.label, "Again");
  });

  it("the same record keeps the map unchanged (no re-render)", () => {
    applyRepoIdentityEvent(event({ identity: identity() }));
    const before = held();
    applyRepoIdentityEvent(event({ identity: identity() }));
    assert.equal(held(), before);
  });

  it("applyRepoIdentity ignores an identity for another repo", () => {
    applyRepoIdentity(OTHER, identity());
    assert.equal(held().size, 0);
  });
});

describe("loads", () => {
  it("replace the map with the validated list", async () => {
    const { api, lists } = fakeApi();
    applyRepoIdentityEvent(event({ identity: identity({ repoKey: OTHER }) }));
    const load = loadRepoIdentities(api);
    lists[0].resolve({ identities: [identity(), { repoKey: "bad" } as unknown as RepoIdentity] });
    await load;
    assert.deepEqual([...held().keys()], [KEY]);
    assert.equal(repoIdentitiesStore.getState().loads, 1);
  });

  it("reject on a broken outer shape and keep what is held", async () => {
    const { api, lists } = fakeApi();
    applyRepoIdentityEvent(event({ identity: identity() }));
    const load = loadRepoIdentities(api);
    lists[0].resolve({ nope: true } as unknown as RepoIdentitiesResponse);
    await assert.rejects(load);
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
  });

  it("an answer never undoes a change that landed while it was in flight", async () => {
    const { api, lists, mutations } = fakeApi();
    const load = loadRepoIdentities(api);
    // A mutation answers, and an event deletes another repo, while the list is out.
    const emoji = setRepoEmoji(api, KEY, "🦝");
    mutations[0].answer.resolve({ identity: identity({ icon: { kind: "emoji", value: "🦝" }, updatedAt: at(9) }) });
    await emoji;
    applyRepoIdentityEvent(event({ identity: identity({ repoKey: OTHER, updatedAt: at(1) }) }));
    applyRepoIdentityEvent(event({ repoKey: OTHER, deleted: true }));
    // The list predates both.
    lists[0].resolve({ identities: [identity({ updatedAt: at(0) }), identity({ repoKey: OTHER, updatedAt: at(1) })] });
    await load;
    assert.deepEqual(getRepoIdentity(KEY)?.icon, { kind: "emoji", value: "🦝" });
    assert.equal(getRepoIdentity(OTHER), undefined);
  });

  it("an untouched repo takes the list as it is (a reload repairs it)", async () => {
    const { api, lists } = fakeApi();
    applyRepoIdentityEvent(event({ identity: identity({ label: "Future", updatedAt: "2099-01-01T00:00:00.000Z" }) }));
    const load = loadRepoIdentities(api);
    lists[0].resolve({ identities: [identity({ label: "Real" })] });
    await load;
    assert.equal(getRepoIdentity(KEY)?.label, "Real");
  });

  it("an older load answering after a newer one is dropped", async () => {
    const { api, lists } = fakeApi();
    const first = loadRepoIdentities(api);
    const second = loadRepoIdentities(api);
    lists[1].resolve({ identities: [identity({ label: "Second" })] });
    await second;
    lists[0].resolve({ identities: [] });
    await first;
    assert.equal(getRepoIdentity(KEY)?.label, "Second");
  });
});

describe("per connection", () => {
  it("a reset drops the map and every answer in flight", async () => {
    const { api, lists, mutations } = fakeApi();
    applyRepoIdentityEvent(event({ identity: identity() }));
    const load = loadRepoIdentities(api);
    const label = setRepoLabel(api, OTHER, "x");
    resetRepoIdentities();
    assert.equal(held().size, 0);
    lists[0].resolve({ identities: [identity()] });
    mutations[0].answer.resolve({ identity: identity({ repoKey: OTHER, label: "x" }) });
    await load;
    await label;
    assert.equal(held().size, 0);
  });

  it("a load through another connection's client resets first", async () => {
    const one = fakeApi("c1");
    const two = fakeApi("c2");
    const first = loadRepoIdentities(one.api);
    one.lists[0].resolve({ identities: [identity()] });
    await first;
    const second = loadRepoIdentities(two.api);
    assert.equal(held().size, 0);
    // The first connection's late answer would be dropped too.
    two.lists[0].resolve({ identities: [identity({ repoKey: OTHER })] });
    await second;
    assert.deepEqual([...held().keys()], [OTHER]);
  });

  it("a reset also forgets deletions", () => {
    applyRepoIdentityEvent(event({ identity: identity({ updatedAt: at(5) }) }));
    applyRepoIdentityEvent(event({ repoKey: KEY, deleted: true }));
    resetRepoIdentities();
    applyRepoIdentityEvent(event({ identity: identity({ updatedAt: at(5) }) }));
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
  });
});

describe("mutations", () => {
  it("apply and return the answered identity; null removes it", async () => {
    const { api, mutations } = fakeApi();
    const favicon = fetchRepoFavicon(api, KEY, "matssmile.com");
    assert.deepEqual(mutations[0].args, [{ repoKey: KEY, domain: "matssmile.com" }]);
    const answered = identity({ icon: { kind: "image", contentType: "image/png", version: "v1", source: { kind: "favicon", domain: "matssmile.com" } } });
    mutations[0].answer.resolve({ identity: answered });
    assert.deepEqual(await favicon, answered);
    assert.deepEqual(getRepoIdentity(KEY), answered);

    const clear = clearRepoIcon(api, KEY);
    mutations[1].answer.resolve({ identity: null });
    assert.equal(await clear, null);
    assert.equal(getRepoIdentity(KEY), undefined);
  });

  it("reject with the daemon's error and change nothing", async () => {
    const { api, mutations } = fakeApi();
    applyRepoIdentityEvent(event({ identity: identity() }));
    const emoji = setRepoEmoji(api, KEY, "nope");
    const refusal = Object.assign(new Error("refused"), { status: 400, body: { code: "INVALID_EMOJI" } });
    mutations[0].answer.reject(refusal);
    await assert.rejects(emoji, refusal);
    assert.equal(getRepoIdentity(KEY)?.label, "Engine");
  });

  it("an answer that does not parse reloads the list", async () => {
    const { api, lists, mutations } = fakeApi();
    const emoji = setRepoEmoji(api, KEY, "🦝");
    mutations[0].answer.resolve({ identity: { repoKey: OTHER, updatedAt: at(0), label: "wrong repo" } });
    assert.equal(await emoji, null);
    assert.equal(lists.length, 1);
    lists[0].resolve({ identities: [] });
  });
});
