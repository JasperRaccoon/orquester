/**
 * Rollback alignment (§4.5, §5.5) and the resume cursor (§4.1).
 *
 * The rule under test is "refuse rather than guess": a fork rewrites every
 * uuid, so the retained turns are matched from the truncated end on deep-equal
 * body AND role, and anything that does not line up is a hard error. A rewind
 * that names its cut by turn id resolves that id to exactly one turn start, or
 * refuses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resumeCursorFor } from "../../orchestration/resume.ts";
import {
  buildClaudeResumeCursor,
  claudeTurnBoundariesFromCursor,
  isResumeId,
  readClaudeResumeCursor
} from "./cursor.ts";
import {
  ROLLBACK_BOUNDARY_UNAVAILABLE,
  ROLLBACK_COMPACTED,
  ROLLBACK_HISTORY_UNAVAILABLE,
  conversationIndexForUuid,
  isAnchorReachableAfterCompaction,
  isClaudeHumanTurnStart,
  mergeClaudeTurnBoundaries,
  planClaudeRollback,
  planClaudeRollbackById,
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

describe("claude rollback — by turn id", () => {
  // A transcript as `getSessionMessages` returns it. Resumed from the CLI, so
  // none of its turns is a boundary this adapter recorded.
  const transcript = [
    user("h1", "first"),
    assistant("a1", "ok"),
    user("h2", "second"),
    assistant("a2", "ok"),
    user("h3", "third"),
    assistant("a3", "ok")
  ];
  const turnIds = (boundaries: ReadonlyArray<{ turnId: string }>): string[] =>
    boundaries.map((boundary) => boundary.turnId);

  it("resolves a history turn no cursor recorded by identity — its id IS its uuid", () => {
    const plan = planClaudeRollbackById({
      messages: transcript,
      boundaries: [],
      firstRemovedTurnId: "h2"
    });
    assert.equal(plan.firstRemoved, 2);
    assert.equal(plan.rollbackAt, "a1");
    assert.deepEqual(plan.retained, [{ turnId: "h1", uuid: "h1", index: 0 }]);
    assert.deepEqual(turnIds(plan.dropped), ["h2", "h3"]);
  });

  it("resolves a turn whose uuid a fork rewrote through its recorded pair", () => {
    // After one rewind the session IS the fork, and the fork rewrote every
    // uuid: only the pairs still say which turn `f2` starts.
    const forked = [
      user("f1", "first"),
      assistant("fa1", "ok"),
      user("f2", "second"),
      assistant("fa2", "ok")
    ];
    const boundaries = [
      { turnId: "turn-a", uuid: "f1" },
      { turnId: "turn-b", uuid: "f2" }
    ];
    const plan = planClaudeRollbackById({
      messages: forked,
      boundaries,
      firstRemovedTurnId: "turn-b"
    });
    assert.equal(plan.firstRemoved, 2);
    assert.equal(plan.rollbackAt, "fa1");
    assert.deepEqual(plan.retained, [{ turnId: "turn-a", uuid: "f1", index: 0 }]);
    assert.deepEqual(turnIds(plan.dropped), ["turn-b"]);

    // The pair owns its uuid, so the fork uuid is not also an identity turn.
    assert.deepEqual(turnIds(plan.boundaries), ["turn-a", "turn-b"]);
    assert.throws(
      () => planClaudeRollbackById({ messages: forked, boundaries, firstRemovedTurnId: "f2" }),
      { message: ROLLBACK_BOUNDARY_UNAVAILABLE }
    );
  });

  it("refuses an id the history cannot place, rather than guessing", () => {
    assert.throws(
      () =>
        planClaudeRollbackById({
          messages: transcript,
          boundaries: [{ turnId: "turn-a", uuid: "h1" }],
          firstRemovedTurnId: "turn-unknown"
        }),
      { message: ROLLBACK_BOUNDARY_UNAVAILABLE }
    );
  });

  it("refuses a cut whose anchor a later compaction dropped", () => {
    // `preserved_messages.all_uuids` names only the tail, so `a1` — the entry
    // a rewind to before `h2` would fork at — is gone.
    const preservedUuids = ["a2", "h3", "a3"];
    assert.throws(
      () =>
        planClaudeRollbackById({
          messages: transcript,
          boundaries: [],
          firstRemovedTurnId: "h2",
          preservedUuids
        }),
      { message: ROLLBACK_COMPACTED }
    );
    // An anchor the compaction preserved is still reachable.
    const plan = planClaudeRollbackById({
      messages: transcript,
      boundaries: [],
      firstRemovedTurnId: "h3",
      preservedUuids
    });
    assert.equal(plan.rollbackAt, "a2");
  });

  it("drops a pair whose uuid the transcript no longer holds, so its id is refused", () => {
    const boundaries = [
      { turnId: "turn-gone", uuid: "vanished" },
      { turnId: "turn-1", uuid: "h1" },
      { turnId: "turn-unplaced", uuid: null }
    ];
    assert.deepEqual(mergeClaudeTurnBoundaries(transcript, boundaries), [
      { turnId: "turn-1", uuid: "h1", index: 0 },
      { turnId: "h2", uuid: "h2", index: 2 },
      { turnId: "h3", uuid: "h3", index: 4 }
    ]);
    for (const firstRemovedTurnId of ["turn-gone", "turn-unplaced"]) {
      assert.throws(
        () => planClaudeRollbackById({ messages: transcript, boundaries, firstRemovedTurnId }),
        { message: ROLLBACK_BOUNDARY_UNAVAILABLE },
        firstRemovedTurnId
      );
    }
  });

  it("orders recorded and identity boundaries by transcript index, not by record order", () => {
    // A synthetic turn — background output between prompts — is anchored on
    // the assistant message that opened it.
    const withBackground = [
      user("h1", "first"),
      assistant("a1", "ok"),
      assistant("bg", "background output"),
      user("live-2", "second"),
      assistant("a2", "ok")
    ];
    const boundaries = [
      { turnId: "live-2", uuid: "live-2" },
      { turnId: "synthetic", uuid: "bg" }
    ];
    assert.deepEqual(mergeClaudeTurnBoundaries(withBackground, boundaries), [
      { turnId: "h1", uuid: "h1", index: 0 },
      { turnId: "synthetic", uuid: "bg", index: 2 },
      { turnId: "live-2", uuid: "live-2", index: 3 }
    ]);
    const plan = planClaudeRollbackById({
      messages: withBackground,
      boundaries,
      firstRemovedTurnId: "synthetic"
    });
    assert.equal(plan.rollbackAt, "a1");
    assert.deepEqual(turnIds(plan.retained), ["h1"]);
    assert.deepEqual(turnIds(plan.dropped), ["synthetic", "live-2"]);
  });

  it("removing every turn yields no anchor: a fresh session, never a fork", () => {
    const plan = planClaudeRollbackById({
      messages: transcript,
      boundaries: [],
      firstRemovedTurnId: "h1"
    });
    assert.equal(plan.rollbackAt, undefined);
    assert.deepEqual(plan.retained, []);
    assert.deepEqual(turnIds(plan.dropped), ["h1", "h2", "h3"]);

    // A system notice ahead of the first prompt is not conversation.
    const withNotice = [system("s0"), ...transcript];
    assert.equal(
      planClaudeRollbackById({ messages: withNotice, boundaries: [], firstRemovedTurnId: "h1" })
        .rollbackAt,
      undefined
    );
  });

  it("refuses an empty history", () => {
    assert.throws(
      () => planClaudeRollbackById({ messages: [], boundaries: [], firstRemovedTurnId: "h1" }),
      { message: ROLLBACK_HISTORY_UNAVAILABLE }
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

  it("rejects a cursor that names a different thread", () => {
    const cursor = buildClaudeResumeCursor({
      threadId: "thread-1",
      sessionId,
      turnStartMessageIds: ["t1"]
    });
    // "one live session per thread, a resume cursor must never be advanced by
    // two processes" (§3.1) is what this guard protects.
    assert.equal(readClaudeResumeCursor(cursor, "thread-2"), undefined);
    assert.ok(readClaudeResumeCursor(cursor, "thread-1"));
    // A cursor that names no thread is still usable — the minimal §6.1 form
    // may omit it.
    assert.ok(readClaudeResumeCursor({ resume: sessionId }, "thread-2"));
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

  it("round-trips turnBoundaries next to the legacy list", () => {
    const turnBoundaries = [
      { turnId: "turn-1", uuid: "fork-1" },
      { turnId: "turn-2", uuid: "turn-2" }
    ];
    const cursor = buildClaudeResumeCursor({
      threadId: "thread-1",
      sessionId,
      turnStartMessageIds: ["fork-1", "turn-2"],
      turnBoundaries
    });
    // Through JSON, as `binding.json` stores it.
    const read = readClaudeResumeCursor(JSON.parse(JSON.stringify(cursor)));
    assert.deepEqual(read, {
      threadId: "thread-1",
      resume: sessionId,
      turnCount: 2,
      turnStartMessageIds: ["fork-1", "turn-2"],
      turnBoundaries
    });
    assert.deepEqual(claudeTurnBoundariesFromCursor(read), turnBoundaries);
  });

  it("a legacy cursor without turnBoundaries still reads, and pairs each uuid with itself", () => {
    const legacy = readClaudeResumeCursor({
      threadId: "thread-1",
      resume: sessionId,
      turnCount: 3,
      turnStartMessageIds: ["t1", null, "t3"]
    });
    assert.deepEqual(legacy, {
      threadId: "thread-1",
      resume: sessionId,
      turnCount: 3,
      turnStartMessageIds: ["t1", null, "t3"]
    });
    // For a turn this adapter started the uuid IS the turn id; an unknown
    // boundary pairs with nothing, while the legacy list keeps its place.
    assert.deepEqual(claudeTurnBoundariesFromCursor(legacy), [
      { turnId: "t1", uuid: "t1" },
      { turnId: "t3", uuid: "t3" }
    ]);
    assert.deepEqual(claudeTurnBoundariesFromCursor(readClaudeResumeCursor({ resume: sessionId })), []);
    assert.deepEqual(claudeTurnBoundariesFromCursor(undefined), []);
  });

  it("validates turnBoundaries field-wise, and never fails the cursor over them", () => {
    const cursor = readClaudeResumeCursor({
      resume: sessionId,
      turnStartMessageIds: ["t1"],
      turnBoundaries: [
        { turnId: "t1", uuid: "u1" },
        { turnId: "", uuid: "u2" },
        { uuid: "u3" },
        { turnId: "t4", uuid: 7 },
        { turnId: "t5", uuid: "" },
        { turnId: "t6", uuid: null },
        { turnId: "t7" },
        "t8",
        null,
        ["t9", "u9"]
      ]
    });
    // No turn id names no turn and is dropped; an unusable uuid is a known
    // turn whose start is unknown.
    assert.deepEqual(cursor?.turnBoundaries, [
      { turnId: "t1", uuid: "u1" },
      { turnId: "t4", uuid: null },
      { turnId: "t5", uuid: null },
      { turnId: "t6", uuid: null },
      { turnId: "t7", uuid: null }
    ]);

    // A field that is not an array is absent: the legacy list decides.
    const notAnArray = readClaudeResumeCursor({
      resume: sessionId,
      turnStartMessageIds: ["t1"],
      turnBoundaries: { t1: "u1" }
    });
    assert.equal(notAnArray?.turnBoundaries, undefined);
    assert.deepEqual(claudeTurnBoundariesFromCursor(notAnArray), [{ turnId: "t1", uuid: "t1" }]);
  });
});
