import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { KNOWLEDGE_CHANGED_EVENT, KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, type KnowledgeCollectionsResponse, type KnowledgeStatus } from "@orquester/api";

import {
  applyKnowledgeEvent,
  deleteKnowledgeCollection,
  knowledgeStore,
  loadKnowledge,
  loadKnowledgeCollections,
  loadKnowledgeStatus,
  mergeKnowledgeEntries,
  resetKnowledge,
  updateKnowledgeCollection,
  updateKnowledgeEntry,
  type KnowledgeApi
} from "./store.ts";
import { collection, collections, event, flush, status } from "./fixtures.test-helpers.ts";

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

/** A fake whose reads answer from queues of deferreds (or at once with `auto`). */
function fakeApi(id = "c1") {
  const calls: string[] = [];
  const statusReads: Deferred<KnowledgeStatus>[] = [];
  const collectionReads: Deferred<KnowledgeCollectionsResponse>[] = [];
  let auto: { status: KnowledgeStatus; collections: KnowledgeCollectionsResponse } | null = null;
  const api: KnowledgeApi = {
    connection: { id },
    getKnowledgeStatus: () => {
      calls.push("status");
      if (auto) return Promise.resolve(auto.status);
      const d = deferred<KnowledgeStatus>();
      statusReads.push(d);
      return d.promise;
    },
    listKnowledgeCollections: () => {
      calls.push("collections");
      if (auto) return Promise.resolve(auto.collections);
      const d = deferred<KnowledgeCollectionsResponse>();
      collectionReads.push(d);
      return d.promise;
    },
    createKnowledgeCollection: async (req) => (calls.push(`create:${req.name}`), {}),
    updateKnowledgeCollection: async (cid) => (calls.push(`update:${cid}`), {}),
    deleteKnowledgeCollection: async (cid) => (calls.push(`delete:${cid}`), {}),
    updateKnowledgeEntry: async (eid) => (calls.push(`patch:${eid}`), {}),
    deleteKnowledgeEntry: async (eid) => (calls.push(`remove:${eid}`), {}),
    mergeKnowledgeEntries: async (req) => (calls.push(`merge:${req.ids.join(",")}`), {})
  };
  return {
    api,
    calls,
    statusReads,
    collectionReads,
    answerAll(value: { status: KnowledgeStatus; collections: KnowledgeCollectionsResponse }) {
      auto = value;
    }
  };
}

const state = () => knowledgeStore.getState();

beforeEach(() => resetKnowledge());

describe("the knowledge store", () => {
  it("loads the status and the collections", async () => {
    const fake = fakeApi();
    fake.answerAll({ status: status(), collections: collections() });
    await loadKnowledge(fake.api);
    assert.equal(state().status?.entries, 2);
    assert.deepEqual(state().collections?.collections.map((c) => c.id), ["kc_seo", "kc_ads"]);
  });

  it("a status event replaces the status, and a read in flight from before it is dropped", async () => {
    const fake = fakeApi();
    const read = loadKnowledgeStatus(fake.api);
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status({ entries: 9 })));
    assert.equal(state().status?.entries, 9);
    fake.statusReads[0]!.resolve(status({ entries: 1 }));
    await read;
    assert.equal(state().status?.entries, 9);
  });

  it("ignores a malformed status event", () => {
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, status({ entries: 4 })));
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_STATUS_EVENT, { entries: 7 }));
    assert.equal(state().status?.entries, 4);
  });

  it("keeps a failed read's error, and clears it with the next good one", async () => {
    const fake = fakeApi();
    const read = loadKnowledgeStatus(fake.api);
    fake.statusReads[0]!.reject(new Error("down"));
    await assert.rejects(read, /down/);
    assert.match(String(state().statusError), /down/);
    const again = loadKnowledgeStatus(fake.api);
    fake.statusReads[1]!.resolve(status());
    await again;
    assert.equal(state().statusError, null);
  });

  it("coalesces collection reads asked for while one is in flight into one more", async () => {
    const fake = fakeApi();
    const first = loadKnowledgeCollections(fake.api);
    void loadKnowledgeCollections(fake.api);
    void loadKnowledgeCollections(fake.api);
    assert.equal(fake.collectionReads.length, 1);
    fake.collectionReads[0]!.resolve(collections([collection({ name: "old" })]));
    await flush();
    assert.equal(fake.collectionReads.length, 2, "one more read, for the calls made meanwhile");
    fake.collectionReads[1]!.resolve(collections([collection({ name: "new" })]));
    await first;
    assert.equal(state().collections?.collections[0]?.name, "new");
    assert.equal(fake.collectionReads.length, 2);
  });

  it("a change event naming entries bumps the entries revision and refetches the collections (their counts)", async () => {
    const fake = fakeApi();
    fake.answerAll({ status: status(), collections: collections() });
    await loadKnowledge(fake.api);
    const before = fake.calls.length;
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: ["ke_1"] }));
    assert.equal(state().entriesRevision, 1);
    assert.deepEqual(state().changedEntryIds, ["ke_1"]);
    assert.equal(state().graphRevision, 0);
    await flush();
    assert.deepEqual(fake.calls.slice(before), ["collections"]);
  });

  it("a graph change bumps only the graph revision; a collections change only refetches them", async () => {
    const fake = fakeApi();
    fake.answerAll({ status: status(), collections: collections() });
    await loadKnowledge(fake.api);
    const before = fake.calls.length;
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { graph: true }));
    assert.equal(state().graphRevision, 1);
    assert.equal(state().entriesRevision, 0);
    await flush();
    assert.equal(fake.calls.length, before, "no refetch for a graph change");
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { collections: true }));
    await flush();
    assert.deepEqual(fake.calls.slice(before), ["collections"]);
    assert.equal(state().entriesRevision, 0);
  });

  it("entries relabelled or deleted elsewhere (entry ids with collections) recolour the graph at once", () => {
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: ["ke_1"], collections: true }));
    assert.equal(state().entriesRevision, 1);
    assert.equal(state().graphRevision, 1, "as this client's own relabel or delete does");
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: ["ke_1"] }));
    assert.equal(state().graphRevision, 1, "a text edit re-links later");
  });

  it("an entries change with no ids means any entry", () => {
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [] }));
    assert.equal(state().changedEntryIds, null);
  });

  it("mutations refetch instead of applying anything, and say what changed", async () => {
    const fake = fakeApi();
    fake.answerAll({ status: status(), collections: collections() });
    await updateKnowledgeEntry(fake.api, "ke_1", { title: "New" });
    assert.deepEqual(fake.calls, ["patch:ke_1", "collections"]);
    assert.equal(state().entriesRevision, 1);
    assert.deepEqual(state().changedEntryIds, ["ke_1"]);
    assert.equal(state().graphRevision, 0, "a text edit re-links later; the graph has not changed yet");

    await updateKnowledgeEntry(fake.api, "ke_1", { collections: ["kc_ads"] });
    assert.equal(state().graphRevision, 1, "a relabel recolours at once");

    await deleteKnowledgeCollection(fake.api, "kc_seo");
    assert.equal(state().changedEntryIds, null, "every entry may have lost the label");
    assert.equal(state().graphRevision, 2);

    await mergeKnowledgeEntries(fake.api, { ids: ["ke_1", "ke_2"], keep: "ke_1" });
    assert.equal(fake.calls.at(-2), "merge:ke_1,ke_2");
    assert.deepEqual(state().changedEntryIds, ["ke_1", "ke_2"], "the kept entry and the deleted one");
    assert.equal(state().graphRevision, 3, "a deleted entry's concepts go at once");
  });

  it("a refused mutation rejects and refetches nothing", async () => {
    const fake = fakeApi();
    fake.api.updateKnowledgeCollection = async () => {
      throw Object.assign(new Error("exists"), { body: { code: "KNOWLEDGE_COLLECTION_EXISTS", message: "Taken" } });
    };
    await assert.rejects(updateKnowledgeCollection(fake.api, "kc_seo", { name: "Ads" }), /exists/);
    assert.deepEqual(fake.calls, []);
  });

  it("a reset drops answers still in flight, and another connection's client resets first", async () => {
    const fake = fakeApi("c1");
    const read = loadKnowledgeStatus(fake.api);
    resetKnowledge();
    fake.statusReads[0]!.resolve(status());
    await read;
    assert.equal(state().status, null);

    const other = fakeApi("c2");
    other.answerAll({ status: status({ entries: 5 }), collections: collections() });
    fake.answerAll({ status: status({ entries: 1 }), collections: collections() });
    await loadKnowledge(fake.api);
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: ["x"] }));
    assert.equal(state().entriesRevision, 1);
    await loadKnowledgeStatus(other.api);
    assert.equal(state().entriesRevision, 0, "the switch reset the store");
    assert.equal(state().status?.entries, 5);
  });
});
