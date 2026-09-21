import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  deriveTimelineEntriesFromItems,
  deriveWorkLogEntries,
  EMPTY_TIMELINE_PROJECTION,
  isAgentInternalActivity,
  isCompactionActivity,
  itemsForAgent,
  splitThreadItems,
  workLogEntryFromActivity
} from "./entries.logic";
import { activity, message, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("workLogEntryFromActivity", () => {
  it("is memoised by activity identity, so one token changes one object", () => {
    const row = activity("tool.completed", { itemType: "command_execution", command: "ls" });
    assert.equal(workLogEntryFromActivity(row), workLogEntryFromActivity(row));
  });

  it("promotes only the allow-listed payload fields", () => {
    const entry = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "file_change",
        toolUseId: "tu1",
        title: "Edit",
        detail: "3 lines",
        changedFiles: ["/w/p/a.ts", 7],
        taskId: "should-be-ignored",
        secret: "never read"
      })
    );
    assert.equal(entry.itemType, "file_change");
    assert.equal(entry.toolCallId, "tu1");
    assert.equal(entry.toolTitle, "Edit");
    assert.equal(entry.detail, "3 lines");
    assert.deepEqual(entry.changedFiles, ["/w/p/a.ts"]);
    assert.equal(entry.taskId, undefined, "taskId belongs to task rows only");
  });

  it("reads an approval as informational, never as a red row", () => {
    const entry = workLogEntryFromActivity(
      activity("approval.requested", { requestKind: "command" }, { tone: "approval" })
    );
    assert.equal(entry.tone, "info");
  });

  it("carries the compaction token counts for client-side formatting", () => {
    const entry = workLogEntryFromActivity(
      activity("thread.state.changed", { state: "compacted", beforeTokens: 120, afterTokens: 30 })
    );
    assert.deepEqual(entry.compaction, { beforeTokens: 120, afterTokens: 30 });
  });
});

describe("the quiet-timeline guarantee", () => {
  it("treats a tool row owned by an agent as internal", () => {
    assert.equal(
      isAgentInternalActivity(activity("tool.completed", { agentId: "ag1" })),
      true
    );
    assert.equal(isAgentInternalActivity(activity("tool.completed", {})), false);
  });

  it("keeps an agent task row visible so it can anchor a spawn row", () => {
    const row = activity("task.started", { taskId: "t1", agentKind: "agent", agentId: "ag1" });
    assert.equal(isAgentInternalActivity(row), false);
  });

  it("hides a subagent's own background shell", () => {
    const row = activity("task.started", { taskId: "t1", agentKind: "background", agentId: "ag1" });
    assert.equal(isAgentInternalActivity(row), true);
  });

  it("drops agentId-stamped messages from the parent timeline", () => {
    const items = [message("user", "go"), message("assistant", "child", { agentId: "ag1" })];
    assert.equal(splitThreadItems(items).messages.length, 1);
    assert.equal(itemsForAgent(items, "ag1").length, 1);
  });
});

describe("deriveWorkLogEntries", () => {
  it("drops the kinds that have their own surfaces", () => {
    const entries = deriveWorkLogEntries([
      activity("context-window.updated", { usedTokens: 10 }),
      activity("turn.plan.updated", { plan: [] }),
      activity("tool.started", { itemType: "command_execution" }),
      activity("task.updated", { taskId: "t1" }),
      activity("tool.completed", { itemType: "command_execution", command: "ls" })
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.command, "ls");
  });

  it("collapses one tool call's in-progress and completed updates into one row", () => {
    const entries = deriveWorkLogEntries([
      activity("tool.updated", {
        itemType: "command_execution",
        toolUseId: "tu1",
        command: "pnpm test",
        status: "running"
      }, { turnId: "t1" }),
      activity("tool.completed", {
        itemType: "command_execution",
        toolUseId: "tu1",
        command: "pnpm test",
        detail: "ok",
        status: "completed"
      }, { turnId: "t1" })
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.toolLifecycleStatus, "completed");
    assert.equal(entries[0]?.detail, "ok");
  });

  it("collapses a spawn batch into ONE row anchored at the spawn point", () => {
    const rows = [
      activity("task.started", { taskId: "t1", agentKind: "agent" }, { turnId: "turn-1" }),
      activity("task.started", { taskId: "t2", agentKind: "agent" }, { turnId: "turn-1" }),
      activity("task.progress", { taskId: "t1", agentKind: "agent", summary: "reading" }, { turnId: "turn-1" }),
      activity("task.completed", { taskId: "t2", agentKind: "agent", status: "completed" }, { turnId: "turn-9" })
    ];
    const entries = deriveWorkLogEntries(rows);
    assert.equal(entries.length, 1, "a batch is one narrative event");
    assert.equal(entries[0]?.id, rows[0]?.id, "the row keeps the ANCHOR identity");
    assert.deepEqual(entries[0]?.agentSpawn?.agentTaskIds, ["t1", "t2"]);
  });

  it("hides a launch tool row once its task row replaces it", () => {
    const entries = deriveWorkLogEntries([
      activity("task.started", { taskId: "t1", agentKind: "agent", toolUseId: "tu9" }, { turnId: "x" }),
      activity(
        "tool.completed",
        { itemType: "collab_agent_tool_call", toolUseId: "tu9", status: "completed" },
        { turnId: "x" }
      )
    ]);
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.agentSpawn);
  });

  it("keeps a failed launch visible — the only terminal signal must not vanish", () => {
    const entries = deriveWorkLogEntries([
      activity("task.started", { taskId: "t1", agentKind: "agent", toolUseId: "tu9" }, { turnId: "x" }),
      activity(
        "tool.completed",
        { itemType: "collab_agent_tool_call", toolUseId: "tu9", status: "failed" },
        { turnId: "x", tone: "error" }
      )
    ]);
    assert.equal(entries.length, 2);
  });
});

describe("compaction classification", () => {
  it("recognises both spellings", () => {
    assert.equal(isCompactionActivity(activity("context-compaction", {})), true);
    assert.equal(
      isCompactionActivity(activity("thread.state.changed", { state: "compacted" })),
      true
    );
    assert.equal(isCompactionActivity(activity("thread.state.changed", { state: "idle" })), false);
  });
});

describe("deriveTimelineEntriesFromItems", () => {
  it("returns the same projection when the items array did not change", () => {
    const items = [message("user", "hi")];
    const first = deriveTimelineEntriesFromItems(items, EMPTY_TIMELINE_PROJECTION);
    assert.equal(deriveTimelineEntriesFromItems(items, first), first);
  });

  it("preserves every other entry object when one message streams", () => {
    const a = message("user", "hi", { createdAt: stamp(1) });
    const streaming = message("assistant", "par", {
      createdAt: stamp(2),
      streaming: true,
      turnId: "t1"
    });
    const first = deriveTimelineEntriesFromItems([a, streaming], EMPTY_TIMELINE_PROJECTION);
    const grown = { ...streaming, text: "partial", updatedAt: stamp(3) };
    const second = deriveTimelineEntriesFromItems([a, grown], first);

    assert.equal(second.entries[0], first.entries[0], "the untouched row keeps its identity");
    assert.notEqual(second.entries[1], first.entries[1]);
    assert.equal(
      (second.entries[1] as { message: { text: string } }).message.text,
      "partial"
    );
  });

  it("appends without rebuilding when a row is added at the end", () => {
    const a = message("user", "hi", { createdAt: stamp(1) });
    const first = deriveTimelineEntriesFromItems([a], EMPTY_TIMELINE_PROJECTION);
    const b = message("assistant", "there", { createdAt: stamp(2) });
    const second = deriveTimelineEntriesFromItems([a, b], first);
    assert.equal(second.entries[0], first.entries[0]);
    assert.equal(second.entries.length, 2);
  });

  it("folds an answered question out of the message list", () => {
    const answer = message("user", "Yes", { id: "async-answer:r1", createdAt: stamp(2) });
    const answered = activity(
      "user-input.resolved",
      { questionAnswer: { requestId: "r1", answers: { q1: "Yes" } } },
      { createdAt: stamp(3) }
    );
    const projection = deriveTimelineEntriesFromItems(
      [message("user", "go", { createdAt: stamp(1) }), answer, answered],
      EMPTY_TIMELINE_PROJECTION
    );
    const messageIds = projection.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.id);
    assert.ok(!messageIds.includes("async-answer:r1"), "the answer renders as an activity row");
  });

  it("folds a proposed plan out of the activity stream into its own entry", () => {
    const projection = deriveTimelineEntriesFromItems(
      [
        activity("turn.proposed.delta", { delta: "# Plan\n" }, { turnId: "t1", createdAt: stamp(1) }),
        activity("turn.proposed.completed", {}, { turnId: "t1", createdAt: stamp(2) })
      ],
      EMPTY_TIMELINE_PROJECTION
    );
    assert.equal(projection.proposedPlans.length, 1);
    assert.equal(projection.proposedPlans[0]?.planMarkdown, "# Plan");
    assert.equal(projection.proposedPlans[0]?.implementedAt, null);
  });

  it("retires a proposal by the turn that implements it, not by a click", () => {
    const projection = deriveTimelineEntriesFromItems(
      [
        activity("turn.proposed.completed", { planMarkdown: "# Plan" }, { createdAt: stamp(1) }),
        message("user", "PLEASE IMPLEMENT THIS PLAN:\n# Plan", { createdAt: stamp(2) })
      ],
      EMPTY_TIMELINE_PROJECTION
    );
    assert.equal(projection.proposedPlans[0]?.implementedAt, stamp(2));
  });
});
