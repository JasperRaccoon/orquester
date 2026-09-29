import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { WorkLogEntry } from "./contracts";
import {
isStreamedOutputEntry,
liveWorkEntryLabel,
showDestructiveRowStyle,
singleToolCallLabel,
toolGroupAction,
withoutJoinedOutput,
workEntryDisplayIndicatesToolFailure,
workEntryDisplayLabel,
workEntryIndicatesToolFailure,
workEntryIsActiveTurnActivity
} from "./presentation.logic";

const entry = (overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id: overrides.id ?? "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  turnId: overrides.turnId ?? "t1",
  label: overrides.label ?? "Tool",
  tone: overrides.tone ?? "tool",
  ...overrides
});

describe("toolGroupAction", () => {
  it("buckets by the promoted fields alone — nothing branches on the provider", () => {
    assert.equal(toolGroupAction(entry({ requestKind: "file-read" })), "read");
    assert.equal(toolGroupAction(entry({ itemType: "file_change" })), "edit");
    assert.equal(toolGroupAction(entry({ changedFiles: ["/a"] })), "edit");
    assert.equal(toolGroupAction(entry({ command: "ls" })), "command");
    assert.equal(toolGroupAction(entry({ itemType: "web_search" })), "search");
    assert.equal(
      toolGroupAction(entry({ itemType: "web_search", toolTitle: "Grep" })),
      "code-search"
    );
    assert.equal(toolGroupAction(entry({ itemType: "image_view" })), "read");
    assert.equal(toolGroupAction(entry({ tone: "info", label: "note" })), "update");
  });

  it("folds an approval into the update bucket — approvals are never hoisted", () => {
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "approval.requested", tone: "info" })),
      "update"
    );
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "approval.resolved", tone: "info" })),
      "update"
    );
  });
});

describe("a call's streamed output", () => {
  const chunk = (id: string, toolCallId: string, detail: string): WorkLogEntry =>
    entry({ id, toolCallId, detail, label: "Tool output", sourceActivityKind: "tool.output" });

  it("isStreamedOutputEntry names a tool.output chunk, and nothing else", () => {
    assert.equal(isStreamedOutputEntry(chunk("c1", "call-1", "one\n")), true);
    assert.equal(isStreamedOutputEntry(entry({ toolCallId: "call-1", sourceActivityKind: "tool.started" })), false);
    assert.equal(isStreamedOutputEntry(entry({})), false);
  });

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

  it("a chunk's row is headed like its call's own row — its command, else its title — else \"Tool output\", never its text", () => {
    const orphan = chunk("c1", "call-9", "line 1\nline 2\n");
    assert.equal(workEntryDisplayLabel(orphan), "Tool output");
    assert.equal(singleToolCallLabel(orphan), "Tool output");
    assert.equal(liveWorkEntryLabel(orphan, true), "Tool output");
    const titled = { ...orphan, toolTitle: "Background shell" };
    assert.equal(workEntryDisplayLabel(titled), "Background shell");
    const commanded = { ...titled, command: "npm run build" };
    assert.equal(workEntryDisplayLabel(commanded), "npm run build");
    assert.equal(liveWorkEntryLabel(commanded, true), "Running npm");
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

// ---------------------------------------------------------------------------
// Fix-wave regressions (R7-6: this is the ONE presentation resolver)
// ---------------------------------------------------------------------------

describe("R7-6 — arms absorbed from the deleted second resolver", () => {
  it("buckets an answered question as an update, not as a tool call", () => {
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "user-input.requested", tone: "info" })),
      "update"
    );
    assert.equal(
      toolGroupAction(entry({ sourceActivityKind: "user-input.resolved", tone: "info" })),
      "update"
    );
  });

  it("exposes the live-row predicate the activity group needs", () => {
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "inProgress" })),
      true
    );
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ sourceActivityKind: "task.progress", tone: "thinking" })),
      true
    );
    assert.equal(
      workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "completed" })),
      false
    );
  });
});
