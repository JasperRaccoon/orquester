/**
 * Rollback alignment (§4.5, §5.5) and the resume cursor (§4.1).
 *
 * The rule under test is "refuse rather than guess": a fork rewrites every
 * uuid, so the retained turns are matched from the truncated end on deep-equal
 * body AND role, and anything that does not line up is a hard error.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resumeCursorFor } from "../../orchestration/resume.ts";
import { buildClaudeResumeCursor, isResumeId, readClaudeResumeCursor } from "./cursor.ts";
import {
  ROLLBACK_BOUNDARY_UNAVAILABLE,
  ROLLBACK_HISTORY_UNAVAILABLE,
  conversationIndexForUuid,
  isAnchorReachableAfterCompaction,
  isClaudeHumanTurnStart,
  planClaudeRollback,
  remapClaudeForkTurnBoundaries,
  type ClaudeHistoryMessage
} from "./rollback.ts";

const user = (uuid: string, text: string): ClaudeHistoryMessage => ({
  type: "user",
  uuid,
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "text", text }] }
});

const toolResult = (uuid: string, id: string): ClaudeHistoryMessage => ({
  type: "user",
  uuid,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }]
  }
});

const assistant = (uuid: string, text: string): ClaudeHistoryMessage => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "text", text }] }
});

const system = (uuid: string): ClaudeHistoryMessage => ({
  type: "system",
  uuid,
  message: { notice: "compaction" }
});

describe("claude rollback — turn starts", () => {
  it("counts only human prompts, never tool results or meta notices", () => {
    assert.equal(isClaudeHumanTurnStart(user("u1", "hello")), true);
    assert.equal(isClaudeHumanTurnStart(toolResult("u2", "toolu_1")), false);
    assert.equal(isClaudeHumanTurnStart(assistant("a1", "hi")), false);
    assert.equal(isClaudeHumanTurnStart({ ...user("u3", "x"), isMeta: true }), false);
    assert.equal(
      isClaudeHumanTurnStart({ ...user("u4", "x"), parent_tool_use_id: "toolu_9" }),
      false
    );
    assert.equal(
      isClaudeHumanTurnStart({
        type: "user",
        uuid: "u5",
        parent_tool_use_id: null,
        message: { role: "user", content: "a plain string, post compaction" }
      }),
      true
    );
  });

  it("indexes conversation messages, skipping system notices", () => {
    const messages = [user("u1", "a"), system("s1"), assistant("a1", "b"), user("u2", "c")];
    assert.equal(conversationIndexForUuid(messages, "u1"), 0);
    assert.equal(conversationIndexForUuid(messages, "a1"), 1);
    assert.equal(conversationIndexForUuid(messages, "u2"), 2);
    assert.equal(conversationIndexForUuid(messages, "s1"), -1);
  });
});

describe("claude rollback — planning", () => {
  const messages = [
    user("t1", "first"),
    assistant("a1", "ok"),
    user("t2", "second"),
    assistant("a2", "ok"),
    user("t3", "third"),
    assistant("a3", "ok")
  ];

  it("keeps the turns before the removed one and anchors on the last kept entry", () => {
    const plan = planClaudeRollback({
      messages,
      boundaries: ["t1", "t2", "t3"],
      numTurns: 1
    });
    assert.equal(plan.retainedCount, 2);
    assert.deepEqual(plan.retainedBoundaries, ["t1", "t2"]);
    assert.equal(plan.rollbackAt, "a2");
    assert.equal(plan.firstRemoved, 4);
  });

  it("infers boundaries from history only when the turn counts agree", () => {
    const plan = planClaudeRollback({
      messages,
      boundaries: [null, null, null],
      numTurns: 1
    });
    assert.deepEqual(plan.retainedBoundaries, ["t1", "t2"]);

    assert.throws(
      () => planClaudeRollback({ messages, boundaries: [null, null], numTurns: 1 }),
      /turn boundary is unavailable/
    );
  });

  it("refuses when a boundary is missing from the history", () => {
    assert.throws(
      () => planClaudeRollback({ messages, boundaries: ["t1", "gone"], numTurns: 1 }),
      new RegExp(ROLLBACK_BOUNDARY_UNAVAILABLE.slice(0, 40))
    );
  });

  it("refuses an empty history", () => {
    assert.throws(
      () => planClaudeRollback({ messages: [], boundaries: ["t1"], numTurns: 1 }),
      new RegExp(ROLLBACK_HISTORY_UNAVAILABLE)
    );
  });

  it("returns no anchor when every turn is removed", () => {
    const plan = planClaudeRollback({ messages, boundaries: ["t1", "t2", "t3"], numTurns: 3 });
    assert.equal(plan.retainedCount, 0);
    assert.equal(plan.rollbackAt, undefined);
  });
});

describe("claude rollback — fork remapping", () => {
  const messages = [user("t1", "first"), assistant("a1", "ok"), user("t2", "second")];

  it("remaps onto the fork's rewritten uuids", () => {
    const fork = [
      system("fs0"),
      user("f1", "first"),
      assistant("f2", "ok")
    ];
    const remapped = remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]);
    assert.deepEqual(remapped, ["f1"]);
  });

  it("refuses when a retained body differs — role matching alone is not enough", () => {
    const fork = [user("f1", "DIFFERENT"), assistant("f2", "ok")];
    assert.equal(remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]), undefined);
  });

  it("refuses when the fork dropped a retained message", () => {
    const fork = [assistant("f2", "ok")];
    assert.equal(remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]), undefined);
  });

  it("aligns from the truncated end, so a leading system notice is harmless", () => {
    const fork = [system("x1"), system("x2"), user("f1", "first"), assistant("f2", "ok")];
    assert.deepEqual(remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]), ["f1"]);
  });

  it("a compaction makes an anchor outside the preserved set unreachable", () => {
    assert.equal(
      isAnchorReachableAfterCompaction({ anchorUuid: "a1", preservedUuids: ["a1", "a2"] }),
      true
    );
    assert.equal(
      isAnchorReachableAfterCompaction({ anchorUuid: "gone", preservedUuids: ["a1"] }),
      false
    );
    // No compaction metadata means nothing is known to be lost.
    assert.equal(
      isAnchorReachableAfterCompaction({ anchorUuid: "a1", preservedUuids: undefined }),
      true
    );
  });
});

describe("claude resume cursor — a bad cursor means no resume, never an error", () => {
  const sessionId = "b46b654b-57bb-40e4-8c82-d3536bd06a28";

  it("round-trips", () => {
    const cursor = buildClaudeResumeCursor({
      threadId: "thread-1",
      sessionId,
      turnStartMessageIds: ["t1", "t2"]
    });
    assert.deepEqual(readClaudeResumeCursor(cursor), {
      threadId: "thread-1",
      resume: sessionId,
      turnCount: 2,
      turnStartMessageIds: ["t1", "t2"]
    });
  });

  it("accepts the minimal {threadId, resume} the §6.1 resume picker builds", () => {
    // The host builds this shape in `orchestration/resume.ts`; a uuid-only
    // rule here would silently degrade a real resume into a fresh session.
    const built = resumeCursorFor("claude", "thread-1", sessionId);
    assert.deepEqual(readClaudeResumeCursor(built), { threadId: "thread-1", resume: sessionId });

    // The picker's ids are not guaranteed to be uuids, only usable.
    assert.deepEqual(readClaudeResumeCursor({ threadId: "t", resume: "conv_2026-09-21.01" }), {
      threadId: "t",
      resume: "conv_2026-09-21.01"
    });
  });

  it("accepts every id the host's own resume rule accepts", () => {
    for (const id of [sessionId, "conv_2026-09-21.01", "a", "a/b/c", "x.y-z_0"]) {
      assert.equal(isResumeId(id), true, id);
      assert.equal(readClaudeResumeCursor({ resume: id })?.resume, id, id);
    }
  });

  it("rejects an unusable resume, without throwing", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "a string",
      {},
      { resume: "" },
      { resume: "a string with spaces" },
      // A leading `-` could arrive at the CLI as a flag.
      { resume: "-rf" },
      { resume: "../../etc/passwd" },
      { resume: "a\nb" },
      { resume: "x".repeat(257) },
      { resume: 7 }
    ]) {
      assert.equal(readClaudeResumeCursor(bad), undefined, JSON.stringify(bad));
    }
  });

  it("keeps a rollback anchor and normalises unknown boundaries to null", () => {
    const cursor = readClaudeResumeCursor({
      resume: sessionId,
      resumeSessionAt: "a8a2167c-1111-2222-3333-444444444444",
      turnStartMessageIds: ["t1", 5, "", null]
    });
    assert.equal(cursor?.resumeSessionAt, "a8a2167c-1111-2222-3333-444444444444");
    assert.deepEqual(cursor?.turnStartMessageIds, ["t1", null, null, null]);
  });
});
