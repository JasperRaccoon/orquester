import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { isCompactCommandMessage, joinLifecycleDetails, splitSkillMentions } from "./row-chrome";

function entry(over: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: over.id ?? "a1",
    createdAt: "2026-09-21T10:00:00.000Z",
    turnId: "t1",
    label: "Tool",
    tone: "tool",
    ...over
  };
}

const SKILLS = ["review", "deep-research", "write_tests"];

test("a `/compact` user message is recognised at render time", () => {
  assert.ok(isCompactCommandMessage({ role: "user", text: "/compact" }));
  // The orchestrator persists the raw input, so it arrives untrimmed.
  assert.ok(isCompactCommandMessage({ role: "user", text: "  /COMPACT  " }));
  assert.ok(isCompactCommandMessage({ role: "user", text: "/Compact\n" }));
});

test("only a bare `/compact` from the user, with no attachments, is the command", () => {
  assert.ok(!isCompactCommandMessage({ role: "assistant", text: "/compact" }));
  assert.ok(!isCompactCommandMessage({ role: "user", text: "/compact please" }));
  assert.ok(!isCompactCommandMessage({ role: "user", text: "run /compact" }));
  assert.ok(!isCompactCommandMessage({ role: "user", text: "" }));
  assert.ok(
    !isCompactCommandMessage({ role: "user", text: "/compact", attachments: [{ id: "a" }] })
  );
});

test("the concatenated runs always reproduce the input exactly", () => {
  for (const text of ["$review x", "a $review $write_tests b", "$nope", "", "$review$review"]) {
    assert.equal(
      splitSkillMentions(text, SKILLS)
        .map((run) => run.text)
        .join(""),
      text
    );
  }
});

test("a fileChange approval with no diff borrows it from its own item.started", () => {
  const started = entry({
    id: "s",
    toolCallId: "call-7",
    itemType: "file_change",
    sourceActivityKind: "tool.started",
    detail: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b",
    changedFiles: ["src/x.ts"]
  });
  const approval = entry({
    id: "a",
    toolCallId: "call-7",
    tone: "info",
    label: "Apply patch?",
    sourceActivityKind: "approval.requested",
    requestKind: "file-change"
  });
  const [, joinedApproval] = joinLifecycleDetails([started, approval]);
  assert.equal(joinedApproval?.detail, started.detail);
  assert.deepEqual(joinedApproval?.changedFiles, ["src/x.ts"]);
});

test("several orphan chunks of one call join into ONE row: the first carries all their text, nothing lost", () => {
  const orphan = (id: string, toolCallId: string, detail: string) =>
    entry({ id, toolCallId, sourceActivityKind: "tool.output", label: "Tool output", detail });
  const other = entry({ id: "k", toolCallId: "here", sourceActivityKind: "tool.completed" });
  const joined = joinLifecycleDetails([
    orphan("o1", "gone", "one\n"),
    other,
    orphan("o2", "gone", "  two\n"),
    orphan("p1", "also-gone", "elsewhere\n"),
    orphan("o3", "gone", "\nthree")
  ]);
  assert.deepEqual(
    joined.map((row) => [row.id, row.detail]),
    [
      ["o1", "one\n  two\n\nthree"],
      ["k", undefined],
      ["p1", "elsewhere\n"]
    ],
    "one row per call, at its first chunk; another call's chunks are its own row"
  );
});

test("the row a command's streamed output joins onto says the call streamed, however its rows were built", () => {
  // The background shell's drill-in builds its entries one activity at a time: only the chunks know what they are.
  const started = entry({
    id: "s",
    toolCallId: "c1",
    itemType: "command_execution",
    sourceActivityKind: "tool.started"
  });
  const chunk = (id: string, detail: string, over: Partial<WorkLogEntry> = {}) =>
    entry({ id, toolCallId: "c1", sourceActivityKind: "tool.output", detail, streamedOutput: true, ...over });
  const [row] = joinLifecycleDetails([started, chunk("o1", "one\n")]);
  assert.deepEqual([row?.id, row?.detail, row?.streamedOutput], ["s", "one\n", true]);
  // A file change's result text joins like a command's, and says nothing: it is no command's output.
  const edit = entry({ id: "e", toolCallId: "c2", itemType: "file_change", sourceActivityKind: "tool.completed" });
  const result = entry({ id: "r", toolCallId: "c2", sourceActivityKind: "tool.output", detail: "File created" });
  assert.equal(joinLifecycleDetails([edit, result])[0]?.streamedOutput, undefined);
  // Never a file change's row, whatever its chunks claim.
  assert.equal(
    joinLifecycleDetails([{ ...edit, toolCallId: "c1" }, chunk("o1", "one\n")])[0]?.streamedOutput,
    undefined
  );
  // An orphan call's chunks are one row, its first chunk, which says so itself.
  const [orphan] = joinLifecycleDetails([chunk("o1", "one\n"), chunk("o2", "two\n")]);
  assert.deepEqual([orphan?.id, orphan?.detail, orphan?.streamedOutput], ["o1", "one\ntwo\n", true]);
});

test("the join never overwrites a value the row already has", () => {
  const a = entry({ id: "a", toolCallId: "c", detail: "first", command: "ls" });
  const b = entry({ id: "b", toolCallId: "c", detail: "second" });
  const [joinedA, joinedB] = joinLifecycleDetails([a, b]);
  assert.equal(joinedA?.detail, "first");
  assert.equal(joinedB?.detail, "second");
  assert.equal(joinedB?.command, "ls");
});

test("the join is keyed on toolCallId only — never on a label match", () => {
  const a = entry({ id: "a", toolCallId: "c1", detail: "mine" });
  const b = entry({ id: "b", toolCallId: "c2", label: "Read file" });
  const unkeyed = entry({ id: "u", label: "Read file" });
  const [, joinedB, joinedUnkeyed] = joinLifecycleDetails([a, b, unkeyed]);
  assert.equal(joinedB?.detail, undefined);
  assert.equal(joinedUnkeyed?.detail, undefined);
});
