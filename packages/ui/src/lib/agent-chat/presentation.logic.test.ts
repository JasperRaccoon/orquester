import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { WorkLogEntry } from "./contracts";
import {
showDestructiveRowStyle,
withoutJoinedOutput,
workEntryDisplayIndicatesToolFailure,
workEntryIndicatesToolFailure
} from "./presentation.logic";

const entry = (overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id: overrides.id ?? "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  turnId: overrides.turnId ?? "t1",
  label: overrides.label ?? "Tool",
  tone: overrides.tone ?? "tool",
  ...overrides
});

describe("a call's streamed output", () => {
  const chunk = (id: string, toolCallId: string, detail: string): WorkLogEntry =>
    entry({ id, toolCallId, detail, label: "Tool output", sourceActivityKind: "tool.output" });

  it("withoutJoinedOutput keeps the rows a list renders: a chunk its call's row absorbs goes, an orphan call's first chunk stays", () => {
    const start = entry({ id: "s", toolCallId: "call-1", command: "npm test", sourceActivityKind: "tool.started" });
    const completion = entry({ id: "d", toolCallId: "call-2", command: "make", sourceActivityKind: "tool.completed" });
    const rows = [
      start,
      chunk("c1", "call-1", "one\n"),
      chunk("c2", "call-2", "two\n"),
      completion,
      chunk("c3", "call-9", "orphan\n"),
      chunk("c4", "call-1", "No such file or directory\n"),
      chunk("c5", "call-9", "more orphan\n"),
      chunk("c6", "call-8", "another orphan call\n")
    ];
    // An orphan call — no row of its own in the list — renders as ONE row, its first chunk carrying the rest
    // (`joinLifecycleDetails`), so it counts once.
    assert.deepEqual(
      withoutJoinedOutput(rows, (row) => row).map((row) => row.id),
      ["s", "d", "c3", "c6"]
    );
    // Any list shape, through the accessor.
    const wrapped = rows.map((row) => ({ entry: row }));
    assert.deepEqual(
      withoutJoinedOutput(wrapped, (row) => row.entry).map((row) => row.entry.id),
      ["s", "d", "c3", "c6"]
    );
  });

});

describe("the output heuristic never judges a call still in progress", () => {
  // A running command's row carries its output so far once its chunks are joined into it: a line that merely prints
  // "No such file or directory" is not the call failing. It is judged when it completes.
  const running = entry({
    command: "npm run build",
    itemType: "command_execution",
    sourceActivityKind: "tool.started",
    toolLifecycleStatus: "inProgress",
    detail: "compiling\ncat: x: No such file or directory\nstill going\n"
  });

  it("an in-progress call is not failed by its output, however it reads", () => {
    assert.equal(workEntryDisplayIndicatesToolFailure(running), false);
    assert.equal(workEntryIndicatesToolFailure(running), false);
    assert.equal(showDestructiveRowStyle(running), false);
  });

  it("the same output on a completed call still reads as a failure, and an explicit failure always does", () => {
    const completed = { ...running, sourceActivityKind: "tool.completed", toolLifecycleStatus: "completed" as const };
    assert.equal(workEntryDisplayIndicatesToolFailure(completed), true);
    assert.equal(workEntryDisplayIndicatesToolFailure({ ...running, toolLifecycleStatus: "failed" }), true);
    assert.equal(workEntryDisplayIndicatesToolFailure({ ...running, tone: "error" }), true);
  });
});
