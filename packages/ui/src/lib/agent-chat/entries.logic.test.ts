import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { slimActivityPayload } from "@orquester/api/agent-chat";

import {
  deriveTimelineEntriesFromItems,
  deriveWorkLogEntries,
  EMPTY_TIMELINE_PROJECTION,
  compactionMarkerState,
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

  it("shows Grok command output instead of repeating its command", () => {
    const grok = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "command_execution",
        title: "echo hi",
        detail: "echo hi",
        data: { kind: "execute", command: "echo hi", rawOutput: { content: "hi" } }
      })
    );
    assert.equal(grok.command, "echo hi");
    assert.equal(grok.detail, "hi");

    const noOutput = workLogEntryFromActivity(
      activity("tool.updated", {
        itemType: "command_execution",
        detail: "echo hi",
        data: { kind: "execute", command: "echo hi" }
      })
    );
    assert.equal(noOutput.command, "echo hi");
    assert.equal(noOutput.detail, undefined, "the expanded row must not repeat an echo");

    const longCommand = `echo ${"x".repeat(200)}`;
    const truncatedEcho = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "command_execution",
        detail: `${longCommand.slice(0, 80)}…`,
        data: { kind: "execute", command: longCommand, rawOutput: { content: "done" } }
      })
    );
    assert.equal(truncatedEcho.detail, "done", "a truncated command echo cannot mask output");
  });

  it("shows ACP output after the wire projection used by live snapshots", () => {
    const payload = slimActivityPayload({
      itemType: "command_execution",
      title: "echo hi",
      detail: "echo hi",
      data: {
        kind: "execute",
        command: "echo hi",
        content: [{ type: "content", content: { type: "text", text: "hi from ACP" } }]
      }
    });
    const entry = workLogEntryFromActivity(activity("tool.completed", payload));
    assert.equal(entry.detail, "hi from ACP");
  });

  it("keeps provider output in detail when it is already the fuller answer", () => {
    const openCode = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "command_execution",
        detail: "first line\nsecond line",
        data: { command: "cat file", result: "first line" }
      })
    );
    assert.equal(openCode.command, "cat file");
    assert.equal(openCode.detail, "first line\nsecond line");

    const codex = workLogEntryFromActivity(
      activity("tool.completed", {
        itemType: "command_execution",
        detail: "2 passed",
        data: { command: "pnpm test" }
      })
    );
    assert.equal(codex.command, "pnpm test");
    assert.equal(codex.detail, "2 passed");
  });

  it("reads an approval as informational, never as a red row", () => {
    const entry = workLogEntryFromActivity(
      activity("approval.requested", { requestKind: "command" }, { tone: "approval" })
    );
    assert.equal(entry.tone, "info");
  });

  it("carries `truncated`, which gates the row's Load full output", () => {
    assert.equal(
      workLogEntryFromActivity(activity("tool.completed", { detail: "a", truncated: true }))
        .truncated,
      true
    );
    assert.equal(
      workLogEntryFromActivity(activity("tool.completed", { detail: "a" })).truncated,
      undefined
    );
  });

  it("carries the compaction token counts for client-side formatting", () => {
    const entry = workLogEntryFromActivity(
      activity("thread.state.changed", { state: "compacted", beforeTokens: 120, afterTokens: 30 })
    );
    assert.deepEqual(entry.compaction, {
      state: "compacted",
      beforeTokens: 120,
      afterTokens: 30
    });
  });

  it("carries the compaction summary, which is all that survives of what it dropped", () => {
    const summary = "This session is being continued…\n\n1. Fixed the composer.";
    const entry = workLogEntryFromActivity(
      activity("context-compaction", { state: "compacted", summary, truncated: true })
    );
    assert.equal(entry.compaction?.summary, summary);
    assert.equal(
      entry.compaction?.summaryTruncated,
      true,
      "a summary over the wire cap says so, so the row can offer the full read"
    );
    assert.equal(
      workLogEntryFromActivity(activity("context-compaction", { state: "compacted" })).compaction
        ?.summary,
      undefined,
      "a failed or older compaction has none"
    );
  });

  it("carries the compaction PHASE, so the in-flight marker is not a divider", () => {
    assert.deepEqual(
      workLogEntryFromActivity(activity("context-compaction", { state: "compacting" })).compaction,
      { state: "compacting" }
    );
    assert.deepEqual(
      workLogEntryFromActivity(
        activity("context-compaction", { state: "compaction-failed", error: "out of quota" })
      ).compaction,
      { state: "compaction-failed", error: "out of quota" }
    );
  });

  it("promotes the §3.4 account switch as IDS, never a label", () => {
    assert.deepEqual(
      workLogEntryFromActivity(
        activity("session.identity-changed", {
          accountId: "acc-2",
          home: "account",
          previousAccountId: "acc-1"
        })
      ).accountSwitch,
      { accountId: "acc-2", previousAccountId: "acc-1" }
    );
    // The system identity is an EMPTY id, not an absent one.
    assert.deepEqual(
      workLogEntryFromActivity(
        activity("session.identity-changed", { accountId: "", home: "system" })
      ).accountSwitch,
      { accountId: "" }
    );
    // A payload from a build that did not carry the field leaves the row bare
    // rather than inventing one.
    assert.equal(
      workLogEntryFromActivity(activity("session.identity-changed", {})).accountSwitch,
      undefined
    );
    assert.equal(
      workLogEntryFromActivity(activity("tool.completed", { accountId: "acc-2" })).accountSwitch,
      undefined
    );
  });

  it("reads an old marker with no state as `compacted` — the only thing old logs hold", () => {
    assert.deepEqual(
      workLogEntryFromActivity(activity("context-compaction", { beforeTokens: 9 })).compaction,
      { state: "compacted", beforeTokens: 9 }
    );
    assert.equal(compactionMarkerState(activity("context-compaction", {})), "compacted");
    assert.equal(compactionMarkerState(activity("context-compaction", { state: "wat" })), "compacted");
    assert.equal(
      compactionMarkerState(activity("thread.state.changed", { state: "compacted" })),
      "compacted"
    );
    assert.equal(
      compactionMarkerState(activity("context-compaction", { state: "compacting" })),
      "compacting"
    );
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

  it("hides routine hooks but keeps failed and cancelled hooks", () => {
    const entries = deriveWorkLogEntries([
      activity("hook.started", { hookId: "h1", hookName: "hooks.json" }, { tone: "info" }),
      activity("hook.progress", { hookId: "h1" }, { tone: "info" }),
      activity("hook.completed", { hookId: "h1", outcome: "success" }, { tone: "info" }),
      activity("hook.completed", { hookId: "h2", outcome: "error", stderr: "failed" }, { tone: "error" }),
      activity("hook.completed", { hookId: "h3", outcome: "cancelled" }, { tone: "info" })
    ]);
    assert.deepEqual(entries.map((entry) => entry.sourceActivityKind), [
      "hook.completed",
      "hook.completed"
    ]);
    assert.equal(entries[0]?.tone, "error");
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

describe("drill-in ownership and streamed output", () => {
  it("keeps the rows the drill-in's own agent owns and still drops every other agent's", () => {
    const mine = activity("tool.completed", { toolUseId: "t1", itemType: "command_execution", agentId: "ag1" });
    const theirs = activity("tool.completed", { toolUseId: "t2", itemType: "command_execution", agentId: "ag2" });
    const parent = activity("tool.completed", { toolUseId: "t3", itemType: "command_execution" });
    assert.deepEqual(
      deriveWorkLogEntries([mine, theirs, parent]).map((entry) => entry.id),
      [parent.id],
      "the parent timeline stays quiet"
    );
    assert.deepEqual(
      deriveWorkLogEntries([mine, theirs, parent], { ownerAgentId: "ag1" }).map((entry) => entry.id),
      [mine.id, parent.id],
      "inside ag1's own view its rows are the point"
    );
  });

  it("a tool.output chunk becomes the entry's detail, untrimmed", () => {
    const chunk = activity("tool.output", { toolUseId: "t1", streamKind: "command_output", delta: "  two\n" });
    assert.equal(workLogEntryFromActivity(chunk).detail, "  two\n");
  });

  it("the projection recomputes its work entries when the owner changes, and reuses them otherwise", () => {
    const mine = activity("tool.completed", { toolUseId: "t1", itemType: "command_execution", agentId: "ag1" });
    const items = [mine];
    const parentView = deriveTimelineEntriesFromItems(items);
    assert.equal(parentView.workEntries.length, 0);
    const drill = deriveTimelineEntriesFromItems(items, parentView, { ownerAgentId: "ag1" });
    assert.equal(drill.workEntries.length, 1);
    assert.equal(drill.ownerAgentId, "ag1");
    assert.equal(
      deriveTimelineEntriesFromItems(items, drill, { ownerAgentId: "ag1" }),
      drill,
      "same items and owner reuse the projection"
    );
  });
});

describe("a subagent's own messages in its drill-in (§7.6)", () => {
  const items = [
    message("user", "go"),
    message("assistant", "parent answer"),
    message("reasoning", "child thinking", { agentId: "ag1", id: "m-child-reason" }),
    message("assistant", "child answer", { agentId: "ag1", id: "m-child-answer" }),
    activity("tool.completed", { itemType: "command_execution", command: "ls" }, { agentId: "ag1" })
  ];

  it("keeps the owner's messages inside the drill-in", () => {
    // The parent's view drops them (they are the child's), and for a long
    // time so did the child's — `splitThreadItems` dropped every
    // agent-stamped message unconditionally, so a drill-in showed the
    // agent's tools with none of its words.
    const own = splitThreadItems(itemsForAgent(items, "ag1"), "ag1");
    assert.deepEqual(
      own.messages.map((row) => row.text),
      ["child thinking", "child answer"]
    );
  });

  it("still drops them from the parent's view", () => {
    assert.deepEqual(
      splitThreadItems(items).messages.map((row) => row.text),
      ["go", "parent answer"]
    );
  });

  it("drops another agent's message from this agent's view", () => {
    const own = splitThreadItems([...items, message("assistant", "other", { agentId: "ag2" })], "ag1");
    assert.equal(
      own.messages.some((row) => row.text === "other"),
      false
    );
  });

  it("derives the agent's assistant row in its entries and never in the parent's", () => {
    const drillIn = deriveTimelineEntriesFromItems(itemsForAgent(items, "ag1"), null, {
      ownerAgentId: "ag1"
    });
    const drillInMessages = drillIn.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => (entry.kind === "message" ? entry.message.text : ""));
    assert.deepEqual(drillInMessages, ["child thinking", "child answer"]);
    assert.ok(
      drillIn.entries.some((entry) => entry.kind === "work"),
      "its tool rows are still there too"
    );

    const parent = deriveTimelineEntriesFromItems(items, null);
    const parentMessages = parent.entries
      .filter((entry) => entry.kind === "message")
      .map((entry) => (entry.kind === "message" ? entry.message.text : ""));
    assert.deepEqual(parentMessages, ["go", "parent answer"]);
  });
});
