/**
 * A thread's head (`thread-head.ts`): the one derivation the host serves from its fold and the
 * daemon applies to an older host's snapshot.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { activity } from "./test-helpers.ts";
import {
  THREAD_HEAD_LOOKUP_MAX,
  THREAD_HEAD_RECENT_TURNS,
  THREAD_HEAD_REPLY_MAX_CHARS,
  lastReplyOf,
  threadHeadOf,
  threadHeadQueryOf,
  threadHeadQueryParams,
  threadHeadReplyChars,
  type ThreadHeadSource
} from "./thread-head.ts";
import type { ThreadHead, ThreadItem, ThreadMessageItem, Turn } from "./thread.ts";

let counter = 0;

function message(role: ThreadMessageItem["role"], text: string, extra: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  counter += 1;
  return { kind: "message", id: `m${counter}`, role, text, turnId: null, streaming: false, createdAt: "t", updatedAt: "t", ...extra };
}

function turn(turnId: string | null, state: Turn["state"], extra: Partial<Turn> = {}): Turn {
  return { turnId, state, turnCount: null, requestedAt: "t", startedAt: "t", completedAt: state === "running" ? null : "t-done", assistantMessageId: null, ...extra };
}

function source(turns: Turn[], items: ThreadItem[] = [], extra: Partial<ThreadHeadSource> = {}): ThreadHeadSource {
  const head = {
    id: "th",
    adapter: "claude",
    runtimeMode: "auto",
    session: { status: "ready", activeTurnId: null, lastError: null }
  } as unknown as ThreadHead;
  return { head, turns, items, pending: { approvals: [], userInputs: [] }, seq: 42, goal: null, ...extra };
}

test("carries the head, its sequence, the turn counts and the running and settled turns", () => {
  const turns = [turn("t1", "completed"), turn("t1", "completed"), turn("t2", "failed", { errorMessage: "boom" }), turn(null, "pending")];
  const head = threadHeadOf(source(turns));
  assert.equal(head.seq, 42);
  assert.equal(head.head.id, "th");
  assert.equal(head.startedTurnCount, 2, "a duplicate id counts once, a pending turn not at all");
  assert.deepEqual(head.recentTurns, turns);
  assert.equal(head.olderTurnCount, 0);
  assert.equal(head.runningTurn, turns[3], "the latest unsettled turn");
  assert.deepEqual(head.lastSettledTurn, { turn: turns[2], ordinal: 2 });
  assert.equal(head.goal, null);
  assert.equal(head.interactionMode, "default");
  assert.equal("lastReply" in head, false, "no reply unless asked");
  assert.equal("matchedTurns" in head, false, "no lookup unless asked");
});

test("the running turn is the active one, and the interaction mode is the latest steer's", () => {
  const turns = [turn("t1", "running", { interactionMode: "default" }), turn("t2", "completed")];
  const items = [message("user", "plan this", { turnId: "t1", interactionMode: "plan" })];
  const s = source(turns, items);
  s.head = { ...s.head, session: { ...s.head.session, activeTurnId: "t1" } };
  const head = threadHeadOf(s);
  assert.equal(head.runningTurn, turns[0]);
  assert.equal(head.interactionMode, "plan");
});

test("recentTurns is bounded and says how many older turns the window holds", () => {
  const turns = Array.from({ length: THREAD_HEAD_RECENT_TURNS + 9 }, (_, i) => turn(`t${i}`, "completed"));
  const head = threadHeadOf(source(turns));
  assert.equal(head.recentTurns.length, THREAD_HEAD_RECENT_TURNS);
  assert.equal(head.recentTurns.at(-1), turns.at(-1));
  assert.equal(head.olderTurnCount, 9);
  assert.equal(head.startedTurnCount, turns.length);
  assert.deepEqual(head.lastSettledTurn, { turn: turns.at(-1), ordinal: turns.length });
});

test("the last reply leaves out a re-emitted Claude copy, joins the answer and is cut by code points", () => {
  const items = [
    message("assistant", "Opening.", { turnId: "t1" }),
    message("assistant", "Answer 😀 tail", { turnId: "t1" }),
    message("assistant", "Opening.", { turnId: "t1" }),
    activity("tool.completed", { itemType: "command_execution" }, { turnId: "t1" })
  ];
  const turns = [turn("t1", "completed")];
  assert.deepEqual(threadHeadOf(source(turns, items), { replyChars: 1000 }).lastReply, {
    turnId: "t1",
    text: "Opening.\n\nAnswer 😀 tail",
    truncated: false,
    completedAt: "t-done"
  });
  // 18 code points: "Opening.\n\nAnswer 😀" — the emoji kept whole.
  const cut = threadHeadOf(source(turns, items), { replyChars: 18 }).lastReply;
  assert.deepEqual(cut, { turnId: "t1", text: "Opening.\n\nAnswer 😀", truncated: true, completedAt: "t-done" });
  // A Codex thread keeps its repeats.
  const codex = source(turns, items);
  codex.head = { ...codex.head, adapter: "codex" };
  assert.equal(lastReplyOf(codex, 1000)?.text, "Opening.\n\nAnswer 😀 tail\n\nOpening.");
  assert.equal(threadHeadOf(source([turn("t1", "running")], items), { replyChars: 10 }).lastReply, null);
});

test("matchedTurns finds what turns.find finds over the whole window, by turn id or opening message", () => {
  const older = Array.from({ length: THREAD_HEAD_RECENT_TURNS + 4 }, (_, i) => turn(`old-${i}`, "completed"));
  const first = turn("dup", "completed", { userMessageId: "msg-a" });
  const replayed = turn("dup", "pending", { userMessageId: "msg-a" });
  const live = turn("live", "running", { userMessageId: "msg-b" });
  const turns = [first, ...older, replayed, live];
  const head = threadHeadOf(source(turns), { turnIds: ["dup", "missing"], messageIds: ["msg-b", "msg-a"] });
  const matched = head.matchedTurns!;
  assert.deepEqual(matched, [first, live], "each id's FIRST turn of the window, in window order");
  assert.equal(matched.find((t) => t.turnId === "dup"), turns.find((t) => t.turnId === "dup"));
  assert.equal(matched.find((t) => t.userMessageId === "msg-a"), turns.find((t) => t.userMessageId === "msg-a"));
  assert.equal(matched.find((t) => t.turnId === "missing"), undefined);
});

test("the query crosses the wire and back; malformed parts name nothing, lists and replies are bounded", () => {
  const query = { replyChars: 500, turnIds: ["a,b", "c d"], messageIds: ["m/1"] };
  assert.deepEqual(threadHeadQueryOf(threadHeadQueryParams(query)), query);
  assert.deepEqual(threadHeadQueryParams({}), {});
  assert.deepEqual(threadHeadQueryOf({ replyChars: "0", turnIds: "%E0%A4%A,,ok", messageIds: "" }), { turnIds: ["ok"] });
  assert.equal(threadHeadReplyChars("12x"), undefined);
  assert.equal(threadHeadReplyChars(String(THREAD_HEAD_REPLY_MAX_CHARS + 1)), THREAD_HEAD_REPLY_MAX_CHARS);
  const many = Array.from({ length: THREAD_HEAD_LOOKUP_MAX + 5 }, (_, i) => `t${i}`).join(",");
  assert.equal(threadHeadQueryOf({ turnIds: many }).turnIds?.length, THREAD_HEAD_LOOKUP_MAX);
});

test("a head's size does not grow with the window: no item and no older turn rides it", () => {
  const sized = (n: number): number => {
    const turns = Array.from({ length: n }, (_, i) => turn(`t${i}`, "completed"));
    const items: ThreadItem[] = turns.flatMap((t) => [
      message("user", "x".repeat(2_000), { turnId: t.turnId }),
      message("assistant", "y".repeat(2_000), { turnId: t.turnId })
    ]);
    return JSON.stringify(threadHeadOf(source(turns, items), { replyChars: 4_000 })).length;
  };
  // Turn ids grow by a digit; nothing else does.
  assert.ok(Math.abs(sized(2_000) - sized(100)) < 200);
});
