import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkLogEntry } from "../../../lib/agent-chat/contracts";
import { omitSupersededLifecycleMarkers } from "../../../lib/agent-chat/presentation.logic";
import {
  findFirstVisibleIndex,
  findFirstVisibleRowIndex,
  offsetWithinRow,
  type RowMetric
} from "./anchor";
import {
  isCompactCommandMessage,
  isToolOutputRow,
  joinLifecycleDetails,
  showDestructiveRowStyle,
  splitSkillMentions,
  summaryKindIconName,
  workEntryIsActiveTurnActivity,
  workEntryIsRerouteNotice
} from "./row-chrome";

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

// ---------------------------------------------------------------------------
// Q2-6 — the anchor search is O(log rows), not O(rows)
// ---------------------------------------------------------------------------

function metrics(heights: readonly number[]): RowMetric[] {
  let top = 0;
  return heights.map((height) => {
    const row = { top, height };
    top += height;
    return row;
  });
}

test("the anchor is the first row whose bottom edge is past the scroll offset", () => {
  const rows = metrics([100, 100, 100, 100]);
  assert.equal(findFirstVisibleRowIndex(rows, 0), 0);
  assert.equal(findFirstVisibleRowIndex(rows, 99), 0);
  assert.equal(findFirstVisibleRowIndex(rows, 100), 1);
  assert.equal(findFirstVisibleRowIndex(rows, 250), 2);
});

test("an empty list has no anchor, and a scroll past the end anchors on the last row", () => {
  assert.equal(findFirstVisibleRowIndex([], 0), -1);
  assert.equal(findFirstVisibleRowIndex(metrics([50, 50]), 10_000), 1);
});

test("rows of uneven height still resolve exactly", () => {
  const rows = metrics([10, 500, 3, 40]);
  assert.equal(findFirstVisibleRowIndex(rows, 9), 0);
  assert.equal(findFirstVisibleRowIndex(rows, 10), 1);
  assert.equal(findFirstVisibleRowIndex(rows, 509), 1);
  assert.equal(findFirstVisibleRowIndex(rows, 510), 2);
  assert.equal(findFirstVisibleRowIndex(rows, 513), 3);
});

test("a zero-height row is never chosen over the row that follows it", () => {
  // A row skipped by `content-visibility` can measure 0 before it materialises.
  const rows = metrics([100, 0, 100]);
  assert.equal(findFirstVisibleRowIndex(rows, 100), 2);
});

test("THE FIX: the search probes O(log n) rows, not all of them", () => {
  // This is the regression: the previous implementation called
  // `getBoundingClientRect()` on every row above the viewport, once per scroll
  // event. 2 500 rows must cost ~12 probes, not 2 500.
  const rows = metrics(new Array(2500).fill(40) as number[]);
  let probes = 0;
  const index = findFirstVisibleIndex(
    rows.length,
    (at) => {
      probes += 1;
      return rows[at] as RowMetric;
    },
    99_000
  );
  assert.equal(index, 2475);
  assert.ok(probes <= 12, `expected a binary search, probed ${probes} rows`);
});

test("offsetWithinRow is the distance into the anchor row, never negative", () => {
  assert.equal(offsetWithinRow({ top: 100, height: 50 }, 130), 30);
  assert.equal(offsetWithinRow({ top: 100, height: 50 }, 100), 0);
  assert.equal(offsetWithinRow({ top: 100, height: 50 }, 40), 0);
});

// ---------------------------------------------------------------------------
// R2-4 — `/compact` is a marker, not a bubble
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// R2-8 — `$skill` mentions are re-chipped from the stored text
// ---------------------------------------------------------------------------

const SKILLS = ["review", "deep-research", "write_tests"];

test("a known skill mention becomes its own run", () => {
  assert.deepEqual(splitSkillMentions("please $review this", SKILLS), [
    { text: "please " },
    { text: "$review", skill: "review" },
    { text: " this" }
  ]);
});

test("a mention at the very start and at the very end both chip", () => {
  assert.deepEqual(splitSkillMentions("$review", SKILLS), [{ text: "$review", skill: "review" }]);
  assert.deepEqual(splitSkillMentions("run $review", SKILLS), [
    { text: "run " },
    { text: "$review", skill: "review" }
  ]);
});

test("several mentions in one message all chip, in order", () => {
  const runs = splitSkillMentions("$review then $write_tests", SKILLS);
  assert.deepEqual(
    runs.filter((run) => run.skill !== undefined).map((run) => run.skill),
    ["review", "write_tests"]
  );
  assert.equal(runs.map((run) => run.text).join(""), "$review then $write_tests");
});

test("kebab and snake names survive intact", () => {
  assert.deepEqual(splitSkillMentions("$deep-research", SKILLS), [
    { text: "$deep-research", skill: "deep-research" }
  ]);
});

test("an UNKNOWN name stays plain text — the catalog decides, not the syntax", () => {
  assert.deepEqual(splitSkillMentions("$nope here", SKILLS), [{ text: "$nope here" }]);
  assert.deepEqual(splitSkillMentions("$review", []), [{ text: "$review" }]);
});

test("shell and currency `$` are never mistaken for mentions", () => {
  // `$PATH` is not in the catalog; `$5` and `a$review` are not mentions at all.
  assert.deepEqual(splitSkillMentions("echo $PATH", SKILLS), [{ text: "echo $PATH" }]);
  assert.deepEqual(splitSkillMentions("costs $5", SKILLS), [{ text: "costs $5" }]);
  assert.deepEqual(splitSkillMentions("a$review", SKILLS), [{ text: "a$review" }]);
  assert.deepEqual(splitSkillMentions("$$review", SKILLS), [{ text: "$$review" }]);
});

test("text with no `$` at all allocates exactly one run", () => {
  const runs = splitSkillMentions("nothing to chip", SKILLS);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.skill, undefined);
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

// ---------------------------------------------------------------------------
// Row chrome kept out of the shared resolver
// ---------------------------------------------------------------------------

test("a non-zero command exit is a failure but NOT the destructive style", () => {
  const exited = entry({
    itemType: "command_execution",
    command: "npm test",
    detail: "<exited with exit code 1>",
    toolLifecycleStatus: "completed",
    sourceActivityKind: "tool.completed"
  });
  assert.ok(!showDestructiveRowStyle(exited));
});

test("a runtime.error and a *.failed lifecycle DO get the destructive style", () => {
  assert.ok(showDestructiveRowStyle(entry({ tone: "error", sourceActivityKind: "runtime.error" })));
  assert.ok(
    showDestructiveRowStyle(entry({ tone: "error", sourceActivityKind: "provider.turn.start.failed" }))
  );
});

test("a failure on a row that is not tool-like is destructive too", () => {
  // The arm `workEntrySeverity` drops: it is not a tool that failed.
  const notToolLike = entry({ tone: "info", detail: "ENOENT: no such file or directory" });
  assert.ok(!showDestructiveRowStyle(notToolLike), "an info row with no failure signal is calm");
  const failedInfo = entry({ tone: "info", toolLifecycleStatus: "failed" });
  assert.ok(showDestructiveRowStyle(failedInfo));
});

test("workEntryIsActiveTurnActivity", () => {
  assert.ok(workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "inProgress" })));
  assert.ok(workEntryIsActiveTurnActivity(entry({ sourceActivityKind: "task.progress" })));
  assert.ok(!workEntryIsActiveTurnActivity(entry({ toolLifecycleStatus: "completed" })));
});

test("workEntryIsRerouteNotice and isToolOutputRow", () => {
  assert.ok(workEntryIsRerouteNotice(entry({ sourceActivityKind: "model.rerouted" })));
  assert.ok(!workEntryIsRerouteNotice(entry({ sourceActivityKind: "tool.completed" })));
  assert.ok(isToolOutputRow(entry({ sourceActivityKind: "tool.output" })));
  assert.ok(!isToolOutputRow(entry({ sourceActivityKind: "tool.completed" })));
});

test("summaryKindIconName maps the contract's five kinds", () => {
  assert.equal(summaryKindIconName("read"), "eye");
  assert.equal(summaryKindIconName("edit"), "square-pen");
  assert.equal(summaryKindIconName("command"), "terminal");
  assert.equal(summaryKindIconName("search"), "globe");
  assert.equal(summaryKindIconName("other"), "wrench");
});

// ---------------------------------------------------------------------------
// joinLifecycleDetails
// ---------------------------------------------------------------------------

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

test("streamed tool.output chunks fold into the owning row, in order", () => {
  const started = entry({
    id: "s",
    toolCallId: "call-1",
    itemType: "command_execution",
    command: "npm test",
    sourceActivityKind: "tool.started"
  });
  const chunkA = entry({ id: "c1", toolCallId: "call-1", sourceActivityKind: "tool.output", detail: "one\n" });
  const chunkB = entry({ id: "c2", toolCallId: "call-1", sourceActivityKind: "tool.output", detail: "two\n" });
  const completed = entry({
    id: "d",
    toolCallId: "call-1",
    itemType: "command_execution",
    sourceActivityKind: "tool.completed",
    toolLifecycleStatus: "completed",
    detail: "2 lines"
  });
  const joined = joinLifecycleDetails([started, chunkA, chunkB, completed]);
  assert.equal(joined.length, 2, "the chunks are not rows of their own");
  assert.equal(joined[1]?.detail, "one\ntwo\n", "whitespace between chunks is preserved");
});

test("streamed output survives the start frame being dropped as superseded", () => {
  const started = entry({ id: "s", toolCallId: "c", sourceActivityKind: "tool.started" });
  const chunk = entry({ id: "c1", toolCallId: "c", sourceActivityKind: "tool.output", detail: "hello" });
  const completed = entry({
    id: "d",
    toolCallId: "c",
    sourceActivityKind: "tool.completed",
    toolLifecycleStatus: "completed"
  });
  const joined = joinLifecycleDetails([started, chunk, completed]);
  const kept = omitSupersededLifecycleMarkers(joined, (value) => value);
  assert.equal(kept.at(-1)?.detail, "hello");
});

test("an orphan output chunk is kept as its own row rather than vanishing", () => {
  const orphan = entry({ id: "o", toolCallId: "gone", sourceActivityKind: "tool.output", detail: "x" });
  const other = entry({ id: "k", toolCallId: "here", sourceActivityKind: "tool.completed" });
  assert.equal(joinLifecycleDetails([orphan, other]).length, 2);
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

test("the join returns the same references when nothing is filled", () => {
  // The row memo must not break on every render of a settled group.
  const rows = [entry({ id: "a", toolCallId: "c", detail: "x" }), entry({ id: "b", label: "plain" })];
  const joined = joinLifecycleDetails(rows);
  assert.equal(joined[0], rows[0]);
  assert.equal(joined[1], rows[1]);
});
