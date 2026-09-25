/**
 * Re-emitted assistant copies in an old Claude log (spec §7.3): the one rule
 * the GUI's timeline and the Orquester MCP both apply.
 *
 * Hosts before the pre-turn-stream fix flushed a CLI-started Claude turn's
 * opening paragraph AGAIN at `result`, under a new message id (live thread
 * 19976137, seq 38664/38963). `events.ndjson` is never rewritten, so those
 * logs keep the copy.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { reEmittedAssistantCopies, repairsReEmittedAssistantCopies } from "./re-emitted.ts";
import { activity } from "./test-helpers.ts";
import type { ThreadMessageItem } from "./thread.ts";

let counter = 0;

function message(
  role: ThreadMessageItem["role"],
  text: string,
  extra: Partial<ThreadMessageItem> = {}
): ThreadMessageItem {
  counter += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString();
  return {
    kind: "message",
    id: `m${counter}`,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: at,
    updatedAt: at,
    ...extra
  };
}

const opening = "All checks are now clean. I'll close out the ledger.";

test("the turn's last message is a copy when it repeats the turn's opening one, word for word", () => {
  const items = [
    message("user", "go"),
    message("assistant", opening, { turnId: "t1", id: "m-open" }),
    activity("tool.completed", { itemType: "command_execution", command: "ls" }, { turnId: "t1" }),
    message("assistant", "Goal tracking is built.", { turnId: "t1", id: "m-final" }),
    message("assistant", opening, { turnId: "t1", id: "m-copy" })
  ];
  assert.deepEqual(
    [...reEmittedAssistantCopies(items)],
    ["m-copy"],
    "the first occurrence stays where it was said; the copy is the one found"
  );
});

test("the same words in another turn are no copy, and neither is a repeat still streaming", () => {
  const items = [
    message("assistant", "Done.", { turnId: "t1", id: "m-a" }),
    message("assistant", "Done.", { turnId: "t2", id: "m-b" }),
    message("assistant", "Done.", { turnId: "t2", id: "m-c", streaming: true })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(items)], []);
});

test("only a copy of the turn's OPENING message, at its end: a goal run's rounds may end on the same words", () => {
  // A Claude goal run is one turn of many rounds; two of them can end "All checks pass." Taking
  // the later one would make the round before it the turn's answer. Only the opening paragraph was
  // ever re-emitted, and its copy still goes.
  const items = [
    message("assistant", "Working through the failing checks.", { turnId: "t1", id: "m-open" }),
    message("assistant", "All checks pass.", { turnId: "t1", id: "m-round-1" }),
    activity("goal.updated", { goal: { objective: "Make CI green", status: "active", rounds: 1 }, change: "checked" }, { turnId: "t1" }),
    message("assistant", "All checks pass.", { turnId: "t1", id: "m-round-2" }),
    message("assistant", "Working through the failing checks.", { turnId: "t1", id: "m-copy" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(items)], ["m-copy"]);
});

test("a repeat of the opening that is not the turn's last message is the agent's own words", () => {
  // The copy was flushed at `result`: nothing of its turn ever follows it.
  const items = [
    message("assistant", "Running the tests again.", { turnId: "t1", id: "m-first-in-view" }),
    activity("tool.completed", { itemType: "command_execution", command: "npm test" }, { turnId: "t1" }),
    message("assistant", "Running the tests again.", { turnId: "t1", id: "m-again" }),
    message("assistant", "All green: 212 passing.", { turnId: "t1", id: "m-answer" }),
    message("assistant", "Running the tests again.", { turnId: "t2", id: "m-next-turn" }),
    message("assistant", "Running the tests again.", { turnId: "t2", id: "m-streaming", streaming: true })
  ];
  assert.deepEqual(
    [...reEmittedAssistantCopies(items)],
    [],
    "a repeat followed by more of its turn stays, and so does one whose turn is still streaming"
  );
  // Only the LAST message is a candidate: three times the opening's words, and only the third goes.
  const thrice = [
    message("assistant", "Looking.", { turnId: "t1", id: "m-1" }),
    message("assistant", "Looking.", { turnId: "t1", id: "m-2" }),
    message("assistant", "Looking.", { turnId: "t1", id: "m-3" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(thrice)], ["m-3"]);
});

test("word for word is the exact text, and the opening is the first FINISHED message with any text", () => {
  // A whitespace difference is not the same words.
  assert.deepEqual(
    [...reEmittedAssistantCopies([
      message("assistant", "Done.", { turnId: "t1" }),
      message("assistant", "Done.\n", { turnId: "t1" })
    ])],
    []
  );
  // A blank message opens nothing: the turn's opening is the first one that says something.
  assert.deepEqual(
    [...reEmittedAssistantCopies([
      message("assistant", "  \n", { turnId: "t1", id: "m-blank" }),
      message("assistant", "Reading the brief.", { turnId: "t1", id: "m-open" }),
      message("assistant", "Here is the plan.", { turnId: "t1", id: "m-answer" }),
      message("assistant", "Reading the brief.", { turnId: "t1", id: "m-copy" })
    ])],
    ["m-copy"]
  );
  // A message still streaming opens nothing either; a turn's only finished message is never its own copy.
  assert.deepEqual(
    [...reEmittedAssistantCopies([
      message("assistant", "Done.", { turnId: "t1", id: "m-live", streaming: true }),
      message("assistant", "Done.", { turnId: "t1", id: "m-only" })
    ])],
    []
  );
});

test("only the assistant's own messages with a turn count: a user or reasoning row, or a turnless row, is never one", () => {
  const items = [
    message("assistant", "Checking.", { turnId: "t1", id: "m-open" }),
    message("reasoning", "Checking.", { turnId: "t1", id: "m-reasoning" }),
    message("user", "Checking.", { turnId: "t1", id: "m-user" }),
    message("assistant", "Checking.", { id: "m-turnless" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(items)], []);
});

test("one author's messages only, in the view asked for: the parent's, or one subagent's", () => {
  const items = [
    message("assistant", "Reading the brief.", { turnId: "t1", id: "m-parent" }),
    message("assistant", "Reading the brief.", { turnId: "t1", id: "m-child", agentId: "ag1" }),
    message("assistant", "Found it.", { turnId: "t1", id: "m-child-answer", agentId: "ag1" }),
    message("assistant", "Reading the brief.", { turnId: "t1", id: "m-child-copy", agentId: "ag1" })
  ];
  // A subagent saying the parent's words is not a copy of them: the parent's view holds one message.
  assert.deepEqual([...reEmittedAssistantCopies(items)], []);
  assert.deepEqual([...reEmittedAssistantCopies(items, undefined)], []);
  // The rule itself reads any author's view: the subagent's own repeat of its opening, at its end.
  assert.deepEqual([...reEmittedAssistantCopies(items, "ag1")], ["m-child-copy"]);
  assert.deepEqual([...reEmittedAssistantCopies(items, "ag2")], []);
  // An empty agentId is the parent's own, as everywhere else.
  const blankOwner = [
    message("assistant", opening, { turnId: "t1", id: "m-open", agentId: "" }),
    message("assistant", "Done.", { turnId: "t1", id: "m-final" }),
    message("assistant", opening, { turnId: "t1", id: "m-copy", agentId: "" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(blankOwner)], ["m-copy"]);
});

test("counted in the view handed in: a view that starts mid-turn compares with its own first message", () => {
  const items = [
    message("assistant", "Evicted opening.", { turnId: "t1", id: "m-evicted" }),
    message("assistant", "Running the suite.", { turnId: "t1", id: "m-first-in-view" }),
    message("assistant", "All green.", { turnId: "t1", id: "m-answer" }),
    message("assistant", "Running the suite.", { turnId: "t1", id: "m-last" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(items)], [], "the whole turn's opening is another message");
  assert.deepEqual([...reEmittedAssistantCopies(items.slice(1))], ["m-last"], "the view's own first message");
});

test("a copy is found per turn, in each turn it closes", () => {
  const items = [
    message("assistant", "Picking up the subagent's result.", { turnId: "t1", id: "t1-open" }),
    message("assistant", "Merged.", { turnId: "t1", id: "t1-answer" }),
    message("assistant", "Picking up the subagent's result.", { turnId: "t1", id: "t1-copy" }),
    message("assistant", "Another result came in.", { turnId: "t2", id: "t2-open" }),
    message("assistant", "Filed.", { turnId: "t2", id: "t2-answer" }),
    message("assistant", "Another result came in.", { turnId: "t2", id: "t2-copy" })
  ];
  assert.deepEqual([...reEmittedAssistantCopies(items)].sort(), ["t1-copy", "t2-copy"]);
});

test("the repair is a Claude thread's alone: exactly the claude adapter", () => {
  assert.equal(repairsReEmittedAssistantCopies("claude"), true);
  for (const adapter of ["codex", "opencode", "grok"] as const) {
    assert.equal(repairsReEmittedAssistantCopies(adapter), false, adapter);
  }
  assert.equal(repairsReEmittedAssistantCopies(undefined), false, "no head yet: nothing is second-guessed");
  // An ADAPTER id, never a registry id: a claudex or claudemix thread's head names the claude adapter.
  assert.equal(repairsReEmittedAssistantCopies("claudex"), false);
  assert.equal(repairsReEmittedAssistantCopies(""), false);
});
