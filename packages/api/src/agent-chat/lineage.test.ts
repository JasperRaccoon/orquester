/**
 * Thread lineage (spec 2026-10-14 §6): the tolerant read, the fold's head,
 * the snapshot round trip (old logs without lineage still load), and the
 * merge-back message both ways.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldThread } from "./fold.ts";
import { deserializeFoldState, serializeFoldState } from "./fold-snapshot.ts";
import {
  buildMergeBackMessage,
  forkTitle,
  parseMergeBackMessage,
  parseThreadLineage,
  type ThreadLineage
} from "./lineage.ts";
import { created, resetSeq } from "./test-helpers.ts";

const LINEAGE: ThreadLineage = {
  parentThreadId: "parent-1",
  relation: "fork",
  forkedFrom: { messageId: "msg-1", turnId: "turn-1" },
  createdAt: "2026-10-14T00:00:00.000Z"
};

describe("parseThreadLineage", () => {
  it("reads a lineage field-wise", () => {
    assert.deepEqual(parseThreadLineage(LINEAGE), LINEAGE);
    assert.deepEqual(parseThreadLineage({ parentThreadId: "p", relation: "delegate", createdAt: "x" }), {
      parentThreadId: "p",
      relation: "delegate",
      createdAt: "x"
    });
  });

  it("drops what does not read, and a bad fork point on its own", () => {
    for (const bad of [null, "x", [], {}, { parentThreadId: "", relation: "fork" }, { parentThreadId: "p", relation: "adopt" }, { parentThreadId: " ", relation: "fork" }]) {
      assert.equal(parseThreadLineage(bad), undefined, JSON.stringify(bad));
    }
    assert.deepEqual(
      parseThreadLineage({ parentThreadId: "p", relation: "fork", forkedFrom: { messageId: 3 }, createdAt: 7 }),
      { parentThreadId: "p", relation: "fork", createdAt: "" }
    );
  });
});

describe("lineage in the fold", () => {
  it("reaches the head from thread.created, and survives a snapshot round trip", () => {
    resetSeq();
    const state = foldThread([created({ lineage: LINEAGE })]);
    assert.deepEqual(state.head?.lineage, LINEAGE);
    const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
    assert.deepEqual(restored?.head?.lineage, LINEAGE);
  });

  it("an old log without lineage folds to a head without one", () => {
    resetSeq();
    const state = foldThread([created()]);
    assert.equal(state.head?.lineage, undefined);
    assert.ok(deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state)))));
  });

  it("a lineage that does not read is no lineage, never an unreadable thread", () => {
    resetSeq();
    const state = foldThread([created({ lineage: { relation: "weird" } as unknown as ThreadLineage })]);
    assert.ok(state.head);
    assert.equal(state.head?.lineage, undefined);
  });
});

describe("the merge-back message", () => {
  it("round-trips the child's title, relation and result", () => {
    const text = buildMergeBackMessage({
      childTitle: 'Try "B" \\ approach\nsecond line',
      relation: "fork",
      text: "  The answer is 42.\n\nDetails…  "
    });
    assert.match(text, /^\[Merged back from fork "Try \\"B\\" \\\\ approach second line"\]\n/);
    assert.deepEqual(parseMergeBackMessage(text), {
      relation: "fork",
      childTitle: 'Try "B" \\ approach second line',
      body: "The answer is 42.\n\nDetails…"
    });
  });

  it("names a delegated task as such", () => {
    const parsed = parseMergeBackMessage(
      buildMergeBackMessage({ childTitle: "Task", relation: "delegate", text: "done" })
    );
    assert.equal(parsed?.relation, "delegate");
    assert.equal(parsed?.body, "done");
  });

  it("is null for any other message", () => {
    assert.equal(parseMergeBackMessage("hello"), null);
    assert.equal(parseMergeBackMessage("[Merged back from fork no quotes]\nx"), null);
  });

  it("titles a fork after its parent once", () => {
    assert.equal(forkTitle("Refactor"), "Refactor (fork)");
    assert.equal(forkTitle("Refactor (fork)"), "Refactor (fork)");
    assert.equal(forkTitle("  "), "Chat (fork)");
  });
});

describe("opened chats and agent-created children (unified MCP design 2026-10-15 §4.1, §13 c)", () => {
  it("reads `opened` and `agentCreated: true`; any other agentCreated value is dropped on its own", () => {
    const opened = { parentThreadId: "p", relation: "opened", createdAt: "x", delegationDepth: 1, agentCreated: true };
    assert.deepEqual(parseThreadLineage(opened), opened);
    for (const bad of [false, "true", 1]) {
      assert.deepEqual(parseThreadLineage({ ...opened, agentCreated: bad }), { parentThreadId: "p", relation: "opened", createdAt: "x", delegationDepth: 1 });
    }
  });

  it("an opened chat's merge-back message round-trips", () => {
    const text = buildMergeBackMessage({ childTitle: "Review", relation: "opened", text: "Done." });
    assert.deepEqual(parseMergeBackMessage(text), { relation: "opened", childTitle: "Review", body: "Done." });
  });
});
