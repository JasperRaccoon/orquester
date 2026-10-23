import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { KNOWLEDGE_CHANGED_EVENT, KNOWLEDGE_CHANNEL } from "@orquester/api";

import { checkKnowledgeCitation, knowledgeCitationState, resetKnowledgeCitations, type KnowledgeCitationsApi } from "./citations.ts";
import { applyKnowledgeEvent, resetKnowledge } from "./store.ts";
import { event, flush } from "./fixtures.test-helpers.ts";

const ID = "ke_aaaaaaaaaaaa";
const notFound = Object.assign(new Error("No such entry."), { body: { code: "KNOWLEDGE_NOT_FOUND", message: "No such entry." } });

/** A fake whose reads answer from a queue of resolvers (FIFO). */
function fakeApi(id: string) {
  const reads: string[] = [];
  const pending: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  const api: KnowledgeCitationsApi = {
    connection: { id },
    getKnowledgeItem: (entryId) => {
      reads.push(entryId);
      return new Promise<unknown>((resolve, reject) => pending.push({ resolve: () => resolve({ kind: "entry" }), reject }));
    }
  };
  return { api, reads, pending };
}

describe("knowledge citation answers", () => {
  beforeEach(() => {
    resetKnowledge();
    resetKnowledgeCitations();
  });

  it("are forgotten when the knowledge store resets, even before any entry changed", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    one.pending.shift()!.resolve();
    await asked;
    assert.equal(knowledgeCitationState(ID), "exists");

    // A connection switch or the plugin turning off (the app store calls this).
    resetKnowledge();
    assert.equal(knowledgeCitationState(ID), "unknown");
  });

  it("never re-ask through the client of a connection that was reset", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    one.pending.shift()!.resolve();
    await asked;

    resetKnowledge();
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [ID] }));
    await flush();
    assert.deepEqual(one.reads, [ID], "the old connection's client is not asked again");
  });

  it("drop an answer from before a reset that lands after it", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    resetKnowledge();
    one.pending.shift()!.resolve();
    await asked;
    assert.equal(knowledgeCitationState(ID), "unknown");
  });

  it("ask again when the entry changes while its first read is in flight", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    // Deleted (here or elsewhere) while the first read is on its way.
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [ID] }));
    assert.deepEqual(one.reads, [ID, ID], "asked again");
    one.pending.shift()!.resolve(); // the stale "exists"
    one.pending.shift()!.reject(notFound);
    await asked;
    await flush();
    assert.equal(knowledgeCitationState(ID), "deleted");
  });

  it("keep the newest answer when an older read settles last", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [ID] }));
    const [stale, fresh] = [one.pending.shift()!, one.pending.shift()!];
    fresh.reject(notFound);
    await flush();
    stale.resolve();
    await asked;
    await flush();
    assert.equal(knowledgeCitationState(ID), "deleted");
  });
});
