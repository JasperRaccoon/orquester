import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { KNOWLEDGE_CHANGED_EVENT, KNOWLEDGE_CHANNEL } from "@orquester/api";

import {
  checkKnowledgeCitation,
  knowledgeCitationAnswer,
  knowledgeCitationPending,
  type KnowledgeCitationsApi
} from "./citations.ts";
import { applyKnowledgeEvent, resetKnowledge } from "./store.ts";
import { entry, event, flush } from "./fixtures.test-helpers.ts";

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
      return new Promise<unknown>((resolve, reject) => pending.push({ resolve: () => resolve({ kind: "entry", entry: { entry: entry(), concepts: [], related: [], citation: "" } }), reject }));
    }
  };
  return { api, reads, pending };
}

describe("knowledge citation answers", () => {
  beforeEach(() => {
    resetKnowledge();
  });

  it("are forgotten when the knowledge store resets, even before any entry changed", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    one.pending.shift()!.resolve();
    await asked;
    assert.equal(knowledgeCitationAnswer(ID)?.state, "exists");

    // A connection switch or the plugin turning off (the app store calls this).
    resetKnowledge();
    assert.equal(knowledgeCitationAnswer(ID)?.state, undefined);
  });

  it("a connection switch forgets the old answer and refreshes through the new client", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    one.pending.shift()!.resolve();
    await asked;

    const two = fakeApi("c2");
    const switched = checkKnowledgeCitation(two.api, ID);
    assert.deepEqual(two.reads, [ID], "the other connection must read its own entry");
    two.pending.shift()!.reject(notFound);
    await switched;
    assert.equal(knowledgeCitationAnswer(ID)?.state, "deleted", "the old connection's cached answer is gone");

    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [ID] }));
    assert.deepEqual(one.reads, [ID], "the old connection's client is not asked again");
    assert.deepEqual(two.reads, [ID, ID], "a change refreshes through the current client");
    two.pending.shift()!.resolve();
    await flush();
  });

  it("drop an answer from before a reset that lands after it", async () => {
    const one = fakeApi("c1");
    const asked = checkKnowledgeCitation(one.api, ID);
    resetKnowledge();
    one.pending.shift()!.resolve();
    await asked;
    assert.equal(knowledgeCitationAnswer(ID)?.state, undefined);
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
    assert.equal(knowledgeCitationAnswer(ID)?.state, "deleted");
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
    assert.equal(knowledgeCitationAnswer(ID)?.state, "deleted");
  });
});

describe("knowledge citation summaries (the hover card)", () => {
  beforeEach(() => {
    resetKnowledge();
  });

  const detail = (body: string) => ({
    kind: "entry",
    entry: {
      entry: { ...entry({ body }), collections: ["kc_seo", "kc_ads"] },
      concepts: [],
      related: [],
      citation: ""
    }
  });

  /** A fake answering every read with `answer` (or its error), counting the reads. */
  function answering(answer: () => unknown) {
    const reads: string[] = [];
    const api: KnowledgeCitationsApi = {
      connection: { id: "c1" },
      getKnowledgeItem: async (entryId) => {
        reads.push(entryId);
        return answer();
      }
    };
    return { api, reads };
  }

  it("are read only when asked, once for every chip of the entry, and keep no body", async () => {
    const body = `## Title\n\n> quoted **bold**\n- item \`code\`\n1. step\n\`\`\`js\nfence();\n\`\`\`\n![alt](x.png) end\n${"More text. ".repeat(40)}END_FULL_BODY`;
    const { api, reads } = answering(() => detail(body));
    assert.equal(knowledgeCitationAnswer(ID), undefined);
    assert.deepEqual(reads, [], "nothing is read before a chip asks");

    const first = checkKnowledgeCitation(api, ID);
    assert.equal(knowledgeCitationPending(ID), true);
    const second = checkKnowledgeCitation(api, ID);
    await Promise.all([first, second]);
    await checkKnowledgeCitation(api, ID);
    assert.deepEqual(reads, [ID], "one read, shared");
    assert.equal(knowledgeCitationPending(ID), false);

    const answer = knowledgeCitationAnswer(ID);
    assert.equal(answer?.state, "exists");
    assert.ok(answer?.state === "exists" && answer.summary);
    const summary = answer.summary;
    assert.equal(summary.title, "Alternatives pages");
    assert.equal(summary.author, "Hridoy");
    assert.equal(summary.handle, "hridoyreh");
    assert.equal(summary.postedAt, "2026-10-11");
    assert.deepEqual(summary.collections, ["kc_seo", "kc_ads"]);
    assert.match(summary.snippet, /^Title quoted bold item code step fence\(\); alt end More text\./);
    assert.ok(!summary.snippet.includes("END_FULL_BODY"), "a short excerpt does not retain the whole body");
    assert.equal("body" in summary, false, "the whole body is not kept");
    assert.equal(knowledgeCitationAnswer(ID), answer, "the same object until it changes");
  });

  it("leave an entry unknown after another failure, and ask again next time", async () => {
    let fail = true;
    const { api, reads } = answering(() => {
      if (fail) throw new Error("offline");
      return detail("Back");
    });
    await checkKnowledgeCitation(api, ID);
    assert.equal(knowledgeCitationAnswer(ID), undefined);
    fail = false;
    await checkKnowledgeCitation(api, ID);
    assert.deepEqual(reads, [ID, ID]);
    const answer = knowledgeCitationAnswer(ID);
    assert.equal(answer?.state === "exists" && answer.summary?.snippet, "Back");
  });

  it("are read again when the entry changes, with the new summary", async () => {
    let title = "Before";
    const { api, reads } = answering(() => {
      const value = detail("Text");
      value.entry.entry.title = title;
      return value;
    });
    await checkKnowledgeCitation(api, ID);
    title = "After";
    applyKnowledgeEvent(event(KNOWLEDGE_CHANNEL, KNOWLEDGE_CHANGED_EVENT, { entryIds: [ID] }));
    await flush();
    assert.deepEqual(reads, [ID, ID]);
    const answer = knowledgeCitationAnswer(ID);
    assert.equal(answer?.state === "exists" && answer.summary?.title, "After");
  });
});
