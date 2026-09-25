/**
 * The fold snapshot (`state.json`, design 2026-09-23 "thread index and lazy
 * boot", A2): a cached fold as of one `seq`, which a cold load folds the log's
 * tail on top of. The invariant every test here serves: **a snapshot plus the
 * tail folds to exactly what the whole log folds to.**
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { DomainEvent } from "./domain-events.ts";
import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  itemPositionOf,
  itemsDroppedByRetention
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import {
  FOLD_SNAPSHOT_VERSION,
  deserializeFoldState,
  parseFoldSnapshotFile,
  serializeFoldState
} from "./fold-snapshot.ts";
import type { FoldSnapshotFile, SerializedFoldState } from "./fold-snapshot.ts";
import type { ThreadActivityItem } from "./thread.ts";
import {
  activity,
  agentTask,
  created,
  ev,
  resetActivityIds,
  resetSeq,
  session
} from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

/**
 * Two turns of a thread with every part of the fold populated: a prompt with
 * attachments and chips, streamed reasoning and answer text, a tool row updated
 * in place, a subagent with its own rows and message, a background shell, a
 * resolved approval (the tombstone), an open approval, an async question, a
 * compaction marker, a provider goal (goals §4.4), a settled turn with usage,
 * a checkpoint, and a second turn still streaming.
 */
function richLog(): DomainEvent[] {
  reset();
  return [
    created(),
    ev("thread.meta-updated", { title: "Snapshot me" }),
    ev("thread.message-sent", {
      messageId: "user:1",
      role: "user",
      text: "fix the bug",
      streaming: false,
      turnId: null,
      attachments: [
        { type: "image", id: "att-1", name: "shot.png", mimeType: "image/png", sizeBytes: 1234 }
      ],
      context: [{ kind: "file", label: "src/a.ts", ref: "/w/p/src/a.ts" }]
    }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:1",
      interactionMode: "default",
      modelSelection: { model: "opus" }
    }),
    ev("thread.session-set", {
      session: session("running", "T-1", {
        providerThreadId: "prov-1",
        resumeCursor: { resume: "prov-1", turnCount: 0 }
      })
    }),
    ev("thread.message-sent", {
      messageId: "reasoning:1",
      role: "reasoning",
      text: "Think",
      streaming: true,
      turnId: "T-1",
      reasoningKind: "summary"
    }),
    ev("thread.message-sent", {
      messageId: "reasoning:1",
      role: "reasoning",
      text: "ing…",
      streaming: true,
      turnId: "T-1"
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "Looking",
      streaming: true,
      turnId: "T-1",
      messageKind: "commentary"
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: " at it.",
      streaming: true,
      turnId: "T-1"
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "",
      streaming: false,
      turnId: "T-1"
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "tool.started",
        { toolUseId: "tu-1", title: "Read" },
        { id: "tool:tu-1", turnId: "T-1", tone: "tool", status: "inProgress" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "tool.completed",
        { toolUseId: "tu-1", title: "Read", detail: "42 lines" },
        { id: "tool:tu-1", turnId: "T-1", tone: "tool", status: "completed" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "task.started",
        agentTask("agent-1", {
          toolUseId: "toolu_agent",
          title: "Reviewer",
          description: "Review the diff"
        }),
        { id: "task:agent-1", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "task.progress",
        agentTask("agent-1", {
          summary: "reading files",
          usage: { totalTokens: 1200, toolUses: 3 }
        }),
        { id: "task-progress:agent-1", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "tool.completed",
        { toolUseId: "tu-sub" },
        { id: "tool:tu-sub", turnId: "T-1", agentId: "agent-1", parentToolUseId: "toolu_agent" }
      )
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1:agent-1",
      role: "assistant",
      text: "Sub says hi",
      streaming: false,
      turnId: "T-1",
      agentId: "agent-1"
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "task.started",
        { taskId: "shell-1", isBackgrounded: true, description: "npm run dev" },
        { id: "task:shell-1", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "approval.requested",
        { requestId: "req-closed", requestType: "command_execution_approval", detail: "rm -rf build" },
        { tone: "approval", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "approval.resolved",
        { requestId: "req-closed", decision: "accept" },
        { tone: "approval", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "approval.requested",
        {
          requestId: "req-open",
          requestKind: "file-change",
          requestType: "file_change_approval",
          detail: "/w/p/a.ts",
          toolUseId: "tu-2",
          options: [
            { decision: "accept", label: "Yes" },
            { decision: "decline", label: "No", warning: "careful" }
          ]
        },
        { tone: "approval", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "user-input.requested",
        {
          requestId: "q-1",
          responseMode: "message",
          questions: [
            {
              id: "Which one?",
              header: "Pick",
              question: "Which one?",
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second", value: "b" }
              ],
              allowCustomAnswer: true
            }
          ]
        },
        { turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "context-compaction",
        { state: "compacted", beforeTokens: 100_000, afterTokens: 20_000 },
        { id: "compaction-1", turnId: "T-1" }
      )
    }),
    ev("thread.activity-appended", {
      activity: activity(
        "goal.updated",
        {
          goal: {
            objective: "Make CI green",
            status: "active",
            rounds: 1,
            lastCheck: "lint still fails",
            tokenBudget: null
          },
          change: "checked"
        },
        { id: "goal-1", turnId: "T-1" }
      )
    }),
    ev("thread.session-set", {
      session: session("ready", null),
      turn: {
        turnId: "T-1",
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 10,
          outputTokens: 20,
          hasSubagents: true
        },
        totalCostUsd: 0.25
      }
    }),
    ev("thread.turn-diff-completed", {
      turnCount: 1,
      turnId: "T-1",
      ref: "refs/orquester/checkpoints/x/turn/1",
      status: "ready",
      files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
      assistantMessageId: "assistant:1",
      completedAt: "2026-01-01T01:00:00.000Z"
    }),
    ev("thread.message-sent", {
      messageId: "user:2",
      role: "user",
      text: "and the tests",
      streaming: false,
      turnId: null
    }),
    ev("thread.turn-start-requested", { turnId: null, messageId: "user:2", interactionMode: "plan" }),
    ev("thread.session-set", { session: session("running", "T-2") }),
    ev("thread.message-sent", {
      messageId: "assistant:2",
      role: "assistant",
      text: "Running",
      streaming: true,
      turnId: "T-2",
      messageKind: "answer"
    })
  ];
}

/** Snapshot `state` the way the store does: serialize, write JSON, read JSON, deserialize. */
function throughDisk(state: ThreadFoldState): ThreadFoldState {
  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
  assert.ok(restored !== null, "a fold state must survive its own snapshot");
  return restored;
}

function foldOnto(state: ThreadFoldState, events: readonly DomainEvent[]): ThreadFoldState {
  let next = state;
  for (const event of events) {
    next = applyDomainEvent(next, event);
  }
  return next;
}

/**
 * For every split point: snapshot the prefix's fold, restore it, fold the
 * tail on top — and compare with folding the whole log. Returns the split
 * points that disagreed.
 */
function splitsThatDiverge(events: readonly DomainEvent[], splits?: Iterable<number>): number[] {
  const whole = foldThread(events);
  const diverged: number[] = [];
  for (const split of splits ?? events.keys()) {
    const restored = throughDisk(foldThread(events.slice(0, split)));
    if (!isDeepStrictEqual(foldOnto(restored, events.slice(split)), whole)) {
      diverged.push(split);
    }
  }
  return diverged;
}

/** A plain JSON copy of the serialized form, to corrupt in the rejection tests. */
function serializedCopy(state: ThreadFoldState): Record<string, any> {
  return JSON.parse(JSON.stringify(serializeFoldState(state)));
}

// --- round trip ------------------------------------------------------------

test("the rich log really populates every part of the fold", () => {
  const state = foldThread(richLog());
  assert.ok(state.head !== null);
  assert.equal(state.head.session.status, "running");
  assert.deepEqual(state.head.session.resumeCursor, { resume: "prov-1", turnCount: 0 });
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, turn.state]),
    [
      ["T-1", "completed"],
      ["T-2", "running"]
    ]
  );
  assert.equal(state.checkpoints.length, 1);
  assert.deepEqual(state.pending.approvals.map((entry) => entry.requestId), ["req-open"]);
  assert.deepEqual(state.pending.userInputs.map((entry) => entry.requestId), ["q-1"]);
  assert.deepEqual(state.roster.map((agent) => agent.id), ["agent-1", "shell-1"]);
  assert.equal(state.roster[0]?.usage?.totalTokens, 1200);
  assert.deepEqual([...state.closedRequestIds], ["req-closed"]);
  assert.equal(state.closedRequestAt?.size, 1);
  assert.equal(state.goal?.objective, "Make CI green");
  assert.equal(state.goal?.tokenBudget, null);
  assert.equal(typeof state.goal?.updatedAt, "string");
  assert.ok(
    state.items.some((item) => item.kind === "message" && item.streaming),
    "a message is mid-stream"
  );
});

test("deserialize(serialize(state)) is the state, Sets and Maps included", () => {
  const state = foldThread(richLog());
  assert.deepEqual(deserializeFoldState(serializeFoldState(state)), state);
  assert.deepEqual(throughDisk(state), state);
});

test("the serialized form is plain JSON: no Map, no Set, no derived list, no cache", () => {
  const state = foldThread(richLog());
  const serialized = serializeFoldState(state);
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), serialized);
  assert.ok(Array.isArray(serialized.closedRequestIds));
  assert.deepEqual(serialized.closedRequestAt, [...state.closedRequestAt!]);
  // The activity list is derived from `items` on load, because it must hold
  // the SAME objects as `items` (below); the fold's caches (the position index,
  // the retention counters, the roster engine) live beside the state and never
  // reach the file.
  assert.deepEqual(Object.keys(serialized).sort(), [
    "checkpoints",
    "closedRequestAt",
    "closedRequestIds",
    "deleted",
    "goal",
    "head",
    "items",
    "pending",
    "roster",
    "seq",
    "turns"
  ]);
});

test("a restored state's activity list holds the very objects in its items", () => {
  // The fold replaces an activity in place by finding the old object in
  // `activities` (`indexOf`) and drops retained-out rows from both lists by
  // identity. Two separately parsed copies would break both: an in-place update
  // would append a duplicate row, and retention would drop a row from one list
  // but not the other.
  const restored = throughDisk(foldThread(richLog()));
  const activityItems = restored.items.filter(
    (item): item is ThreadActivityItem => item.kind === "activity"
  );
  assert.equal(restored.activities.length, activityItems.length);
  restored.activities.forEach((row, index) => {
    assert.equal(row, activityItems[index], `activities[${index}] is the items' own object`);
  });
});

test("a restored state finds each id at its LAST position, as the fold does", () => {
  reset();
  // A message and an activity may share an id; the fold's index then points
  // at whichever row came last, and a later delta starts a new message. A
  // restored state rebuilds that index from `items` on first use.
  const events = [
    created(),
    ev("thread.message-sent", { messageId: "dup", role: "user", text: "m", streaming: false, turnId: null }),
    ev("thread.activity-appended", { activity: activity("tool.started", { toolUseId: "t" }, { id: "dup" }) }),
    ev("thread.message-sent", { messageId: "dup", role: "assistant", text: "x", streaming: true, turnId: null }),
    ev("thread.message-sent", { messageId: "dup", role: "assistant", text: "y", streaming: true, turnId: null })
  ];
  const state = foldThread(events);
  assert.equal(itemPositionOf(state, "dup"), 2);
  const restored = throughDisk(foldThread(events.slice(0, 4)));
  assert.equal(itemPositionOf(restored, "dup"), 2);
  assert.deepEqual(foldOnto(restored, events.slice(4)), state);
});

test("the empty state and a headless state round-trip", () => {
  const empty = createEmptyThreadState();
  assert.deepEqual(throughDisk(empty), empty);

  reset();
  // A log whose first line was lost: rows fold, but there is no head.
  const headless = foldThread([
    ev("thread.message-sent", { messageId: "m", role: "user", text: "hi", streaming: false, turnId: null }, { seq: 5 })
  ]);
  assert.equal(headless.head, null);
  assert.deepEqual(throughDisk(headless), headless);
});

test("a state built before the tombstone stamps existed keeps closedRequestAt absent", () => {
  const { closedRequestAt: _dropped, ...legacy } = foldThread(richLog());
  const serialized = serializeFoldState(legacy);
  assert.equal("closedRequestAt" in serialized, false);
  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(restored, legacy);
  assert.equal(restored !== null && "closedRequestAt" in restored, false);
});

test("a head carrying the §3.3 continuation marker round-trips", () => {
  const state = foldThread(richLog());
  const marked: ThreadFoldState = {
    ...state,
    head: { ...state.head!, continueAfterRestart: { turnId: "T-2", prepared: true } }
  };
  assert.deepEqual(throughDisk(marked), marked);
});

test("a head carrying the goals §5.5 resume marker round-trips", () => {
  const state = foldThread(richLog());
  const marked: ThreadFoldState = {
    ...state,
    head: { ...state.head!, resumeGoalAfterRestart: true }
  };
  assert.deepEqual(throughDisk(marked), marked);
  // A head without one — every head an older build wrote — still restores.
  assert.equal(throughDisk(state)?.head?.resumeGoalAfterRestart, undefined);
});

test("a head carrying the goals §5.7 hold marker round-trips", () => {
  const state = foldThread(richLog());
  const held: ThreadFoldState = {
    ...state,
    head: { ...state.head!, goalHeldForHandover: true }
  };
  assert.deepEqual(throughDisk(held), held);
  const both: ThreadFoldState = {
    ...state,
    head: { ...state.head!, resumeGoalAfterRestart: true, goalHeldForHandover: true }
  };
  assert.deepEqual(throughDisk(both), both);
  assert.equal(throughDisk(state)?.head?.goalHeldForHandover, undefined);
});

// --- snapshot + tail ≡ the whole log -----------------------------------------

test("a snapshot at ANY point plus the tail folds to exactly the whole log", () => {
  assert.deepEqual(splitsThatDiverge(richLog()), []);
});

test("snapshot + tail stays exact across the retention window and in-place updates", () => {
  reset();
  // Enough rows for batch retention to trim three times (design
  // `2026-09-23-fold-performance-design.md`, B: a trim fires once more than
  // LIMIT + SLACK droppable parent rows pile up and cuts back to LIMIT), a row
  // updated in place while it waits in the part of the window the next trim
  // cuts, a resolution aging out, and messages streamed across a split.
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "old",
        requestType: "command_execution_approval"
      })
    }),
    ev("thread.activity-appended", {
      activity: activity("approval.resolved", { requestId: "old", decision: "accept" })
    })
  ];
  const rows = ACTIVITY_RETENTION_LIMIT + 3 * ACTIVITY_RETENTION_SLACK + 20;
  for (let index = 0; index < rows; index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${index}` }, { id: `row-${index}` })
      })
    );
    if (index % 100 === 0) {
      events.push(
        ev("thread.message-sent", {
          messageId: `stream-${index}`,
          role: "assistant",
          text: "a",
          streaming: true,
          turnId: null
        }),
        ev("thread.message-sent", {
          messageId: `stream-${index}`,
          role: "assistant",
          text: "b",
          streaming: true,
          turnId: null
        })
      );
    }
    if (index === rows - 40) {
      // Row 110 is still in the window, in the slack the third trim takes: it
      // is replaced where it stands, and then leaves with that trim.
      events.push(
        ev("thread.activity-appended", {
          activity: activity("tool.updated", { toolUseId: "t110" }, { id: "row-110" })
        })
      );
    }
  }
  // Row 200 is inside the window when it is updated, and stays there to the
  // end; rows 5 and 110 are gone, so their updates are new rows.
  events.push(
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: "t200" }, { id: "row-200" })
    }),
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: "t5" }, { id: "row-5" })
    }),
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: "t110" }, { id: "row-110" })
    })
  );
  for (let index = 0; index < 10; index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `late${index}` }, { id: `late-${index}` })
      })
    );
  }
  // A replay of the resolved request: its tombstone outlived its closing row.
  events.push(
    ev("thread.activity-appended", {
      activity: activity(
        "approval.requested",
        { requestId: "old", requestType: "command_execution_approval" },
        { createdAt: "2026-01-01T00:00:01.000Z" }
      )
    })
  );

  // The steps that trimmed, from a one-event-at-a-time fold.
  const trimSteps: number[] = [];
  let state = createEmptyThreadState();
  events.forEach((event, index) => {
    state = applyDomainEvent(state, event);
    if (itemsDroppedByRetention(state).length > 0) trimSteps.push(index);
  });
  assert.equal(trimSteps.length, 3, "the window trimmed three times");

  const whole = foldThread(events);
  assert.deepEqual(whole, state);
  const kindsOf = (id: string): string[] =>
    whole.activities.filter((row) => row.id === id).map((row) => row.activityKind);
  assert.deepEqual(kindsOf("row-5"), ["tool.completed"], "a long-gone row's update is a new row");
  assert.deepEqual(kindsOf("row-200"), ["tool.completed"], "the in-place update replaced its row");
  assert.deepEqual(kindsOf("row-110"), ["tool.completed"], "the replaced row left with the trim");
  assert.equal(whole.activities.at(-12)?.id, "row-110", "…and its next update came back at the end");
  assert.deepEqual(whole.pending.approvals, [], "the replayed request stays closed");

  const splits = new Set<number>();
  for (let split = 0; split <= events.length; split += 5) splits.add(split);
  for (const step of trimSteps) {
    for (let split = step - 2; split <= step + 2; split += 1) splits.add(split);
  }
  for (let split = events.length - 16; split <= events.length; split += 1) splits.add(split);
  assert.deepEqual(splitsThatDiverge(events, splits), []);
});

// --- deserializeFoldState never trusts the file ------------------------------

test("anything that is not a serialized fold state deserializes to null", () => {
  for (const value of [null, undefined, 42, "state", [], true]) {
    assert.equal(deserializeFoldState(value), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("a missing top-level field is rejected; only closedRequestAt is optional", () => {
  const state = foldThread(richLog());
  for (const key of Object.keys(serializeFoldState(state))) {
    const copy = serializedCopy(state);
    delete copy[key];
    if (key === "closedRequestAt") {
      assert.notEqual(deserializeFoldState(copy), null, "closedRequestAt may be absent");
    } else {
      assert.equal(deserializeFoldState(copy), null, `missing ${key} must be rejected`);
    }
  }
});

test("a field of the wrong shape anywhere in the state is rejected", () => {
  const state = foldThread(richLog());
  const messageAt = state.items.findIndex((item) => item.kind === "message");
  const activityAt = state.items.findIndex((item) => item.kind === "activity");
  const corruptions: Array<[string, (copy: Record<string, any>) => void]> = [
    ["items is not an array", (copy) => (copy.items = {})],
    ["an item of an unknown kind", (copy) => (copy.items[messageAt].kind = "note")],
    ["a message without text", (copy) => delete copy.items[messageAt].text],
    ["a message whose streaming flag is not a boolean", (copy) => (copy.items[messageAt].streaming = "yes")],
    ["a message whose attachments are not a list", (copy) => (copy.items[0].attachments = "shot.png")],
    ["an activity without a summary", (copy) => delete copy.items[activityAt].summary],
    ["an activity without a turnId", (copy) => delete copy.items[activityAt].turnId],
    ["a turn whose state is not a string", (copy) => (copy.turns[0].state = 7)],
    ["a turn without a turnId", (copy) => delete copy.turns[0].turnId],
    ["a turn whose usage is not a record", (copy) => (copy.turns[0].tokenUsage = 12)],
    ["checkpoint files that are not a list", (copy) => (copy.checkpoints[0].files = "none")],
    ["a checkpoint file count that is a string", (copy) => (copy.checkpoints[0].files[0].additions = "3")],
    ["pending approvals that are not a list", (copy) => (copy.pending.approvals = null)],
    ["a question whose options are not a list", (copy) => (copy.pending.userInputs[0].questions[0].options = {})],
    ["a pending question without dismissible", (copy) => delete copy.pending.userInputs[0].dismissible],
    ["a roster row without a status", (copy) => (copy.roster[0].status = null)],
    ["a roster row whose recent activity is not a list", (copy) => (copy.roster[0].recentActivity = "x")],
    ["a roster row whose usage has no total", (copy) => delete copy.roster[0].usage.totalTokens],
    ["a non-string tombstone", (copy) => (copy.closedRequestIds = ["a", 1])],
    ["a tombstone stamp that is not a pair", (copy) => (copy.closedRequestAt = [["a"]])],
    ["tombstone stamps that are not a list", (copy) => (copy.closedRequestAt = {})],
    ["a negative seq", (copy) => (copy.seq = -1)],
    ["a fractional seq", (copy) => (copy.seq = 1.5)],
    ["a string seq", (copy) => (copy.seq = String(copy.seq))],
    ["a deleted flag that is not a boolean", (copy) => (copy.deleted = "no")],
    ["a head without a session", (copy) => delete copy.head.session],
    ["a session without activeTurnId", (copy) => delete copy.head.session.activeTurnId],
    ["a model selection without a model", (copy) => (copy.head.modelSelection.model = 1)],
    ["a malformed continuation marker", (copy) => (copy.head.continueAfterRestart = { prepared: true })],
    ["a goal-resume marker that is not `true`", (copy) => (copy.head.resumeGoalAfterRestart = false)],
    ["a goal-hold marker that is not `true`", (copy) => (copy.head.goalHeldForHandover = "yes")],
    ["a head folded to another seq than the state", (copy) => (copy.head.seq = copy.seq + 1)]
  ];
  for (const [label, corrupt] of corruptions) {
    const copy = serializedCopy(state);
    corrupt(copy);
    assert.equal(deserializeFoldState(copy), null, label);
  }
});

test("what the fold copies through untouched is not second-guessed", () => {
  const state = foldThread(richLog());
  const activityAt = state.items.findIndex((item) => item.kind === "activity");
  const copy = serializedCopy(state);
  // An activity payload and a resume cursor are provider-shaped: any JSON.
  copy.items[activityAt].payload = "a plain string payload";
  copy.head.session.resumeCursor = ["opaque", 1];
  // A field this build does not know (a newer build's additive field) is carried.
  copy.items[activityAt].addedLater = { flag: true };
  const restored = deserializeFoldState(copy);
  assert.ok(restored !== null);
  assert.equal((restored.items[activityAt] as ThreadActivityItem).payload, "a plain string payload");
  assert.deepEqual(restored.head?.session.resumeCursor, ["opaque", 1]);
  assert.deepEqual(
    (restored.items[activityAt] as unknown as Record<string, unknown>).addedLater,
    { flag: true },
    "an additive field a newer build wrote rides through by reference"
  );
});

// --- parseFoldSnapshotFile -------------------------------------------------------

const THREAD_ID = "thread-1";

function snapshotFile(state: ThreadFoldState, extra: Partial<FoldSnapshotFile> = {}): FoldSnapshotFile {
  return {
    version: FOLD_SNAPSHOT_VERSION,
    threadId: THREAD_ID,
    seq: state.seq,
    logBytes: 48_213,
    writtenAt: "2026-09-23T12:00:00.000Z",
    state: serializeFoldState(state),
    ...extra
  };
}

function onDisk(file: unknown): Record<string, any> {
  return JSON.parse(JSON.stringify(file));
}

test("a well-formed snapshot file parses, and its state restores the fold", () => {
  const state = foldThread(richLog());
  const file = snapshotFile(state, { extras: { revertedTo: 2, titleManual: true } });
  const parsed = parseFoldSnapshotFile(onDisk(file), THREAD_ID);
  assert.ok(parsed !== null);
  assert.equal(parsed.version, FOLD_SNAPSHOT_VERSION);
  assert.equal(parsed.threadId, THREAD_ID);
  assert.equal(parsed.seq, state.seq);
  assert.equal(parsed.logBytes, 48_213);
  assert.equal(parsed.writtenAt, "2026-09-23T12:00:00.000Z");
  assert.deepEqual(parsed.extras, { revertedTo: 2, titleManual: true });
  assert.deepEqual(deserializeFoldState(parsed.state), state);
});

test("a snapshot file without extras parses without an extras key", () => {
  const parsed = parseFoldSnapshotFile(onDisk(snapshotFile(foldThread(richLog()))), THREAD_ID);
  assert.ok(parsed !== null);
  assert.equal("extras" in parsed, false);
});

test("a snapshot file of another version, another thread or a bad shape is rejected", () => {
  const state = foldThread(richLog());
  const good = onDisk(snapshotFile(state));
  const rejects: Array<[string, (file: Record<string, any>) => void]> = [
    ["an older version", (file) => (file.version = FOLD_SNAPSHOT_VERSION - 1)],
    ["a newer version", (file) => (file.version = FOLD_SNAPSHOT_VERSION + 1)],
    ["a version spelled as a string", (file) => (file.version = String(FOLD_SNAPSHOT_VERSION))],
    ["no version", (file) => delete file.version],
    ["another thread's file", (file) => (file.threadId = "thread-2")],
    ["a negative seq", (file) => (file.seq = -1)],
    ["a fractional logBytes", (file) => (file.logBytes = 10.5)],
    ["a string logBytes", (file) => (file.logBytes = "10")],
    ["no writtenAt", (file) => delete file.writtenAt],
    ["extras that are a list", (file) => (file.extras = ["revertedTo"])],
    ["extras that are a string", (file) => (file.extras = "none")],
    ["a state that is not a fold state", (file) => (file.state = { seq: file.seq })],
    ["a file seq that disagrees with its state", (file) => (file.seq = file.seq - 1)],
    ["another thread's state under this thread's name", (file) => (file.state.head.id = "thread-2")]
  ];
  for (const [label, corrupt] of rejects) {
    const file = structuredClone(good);
    corrupt(file);
    assert.equal(parseFoldSnapshotFile(file, THREAD_ID), null, label);
  }
  for (const value of [null, 42, "state.json", []]) {
    assert.equal(parseFoldSnapshotFile(value, THREAD_ID), null);
  }
  assert.notEqual(parseFoldSnapshotFile(good, THREAD_ID), null, "the untouched file still parses");
});

test("a state.json folded by version 2, whose retention evicted the legacy compaction marker, is discarded, never folded forward", () => {
  reset();
  // An older log's settled compaction, then parent rows enough for three trims.
  const marker = activity("thread.state.changed", { state: "compacted" }, { id: "legacy-marker" });
  const events: DomainEvent[] = [created(), ev("thread.activity-appended", { activity: marker })];
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 3 * (ACTIVITY_RETENTION_SLACK + 1); index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.completed", { toolUseId: `t${index}` }, { id: `row-${index}` })
      })
    );
  }
  const whole = foldThread(events);
  assert.equal(whole.activities[0]?.id, "legacy-marker", "this build keeps the marker whatever its age");

  // Version 2 read the marker as an ordinary parent row. The same log with
  // that row in any other state is therefore exactly what version 2 folded:
  // the row in the same class, so the same trims, and gone with the first.
  const asVersion2Read = events.map((event) =>
    event.type === "thread.activity-appended" && event.payload.activity === marker
      ? { ...event, payload: { activity: { ...marker, payload: { state: "running" } } } }
      : event
  );
  let probe = createEmptyThreadState();
  const firstTrim = asVersion2Read.findIndex((event) => {
    probe = applyDomainEvent(probe, event);
    return itemsDroppedByRetention(probe).length > 0;
  });
  assert.ok(firstTrim > 0);
  const split = firstTrim + 10;
  const version2State = foldThread(asVersion2Read.slice(0, split));
  assert.ok(!version2State.items.some((item) => item.id === "legacy-marker"), "version 2 had evicted it");

  // Trusted, that snapshot would carry the eviction forward for good.
  const trusted = foldOnto(throughDisk(version2State), events.slice(split));
  assert.ok(!trusted.activities.some((row) => row.id === "legacy-marker"));
  assert.notDeepEqual(trusted, whole);

  // It is not: a file stamped version 2 never parses, whatever it holds, so
  // the store folds the whole log — which keeps the marker.
  assert.ok(FOLD_SNAPSHOT_VERSION > 2, "the retention that keeps the legacy marker is a new version");
  const file = onDisk(snapshotFile(version2State, { version: 2 }));
  assert.equal(parseFoldSnapshotFile(file, THREAD_ID), null);
  assert.notEqual(
    parseFoldSnapshotFile({ ...file, version: FOLD_SNAPSHOT_VERSION }, THREAD_ID),
    null,
    "the stamp is all that refuses it: the same file under this build's version would parse"
  );
  // This build's own snapshot of the same prefix folds forward to the whole log.
  assert.deepEqual(foldOnto(throughDisk(foldThread(events.slice(0, split))), events.slice(split)), whole);
});

test("a snapshot of an empty, headless fold is a valid file", () => {
  const empty = createEmptyThreadState();
  const parsed = parseFoldSnapshotFile(onDisk(snapshotFile(empty, { logBytes: 0 })), THREAD_ID);
  assert.ok(parsed !== null);
  assert.deepEqual(deserializeFoldState(parsed.state), empty);
});

test("the serialized state type is what serializeFoldState returns", () => {
  // Compile-time pin: the file's `state` is exactly the serializer's output.
  const state: SerializedFoldState = serializeFoldState(foldThread(richLog()));
  assert.equal(state.seq, foldThread(richLog()).seq);
});

// --- the goal (goals §4.4) -------------------------------------------------------
//
// The goal is the provider's state, derived by the fold; a stored goal the fold
// could not have written is doubt, and doubt is a cache miss: the host refolds
// from `events.ndjson` (AGENTS.md, "the fold snapshot and the thread index are
// caches, never authorities").

test("a valid goal round-trips exactly, through the file too", () => {
  const state = foldThread(richLog());
  assert.ok(state.goal !== null && state.goal !== undefined, "the rich log sets a goal");
  const restored = throughDisk(state);
  assert.deepEqual(restored.goal, state.goal);
  // Byte for byte, key order included: the determinism suites compare files.
  assert.equal(
    JSON.stringify(serializeFoldState(restored)),
    JSON.stringify(serializeFoldState(state))
  );
  const parsed = parseFoldSnapshotFile(onDisk(snapshotFile(state)), THREAD_ID);
  assert.ok(parsed !== null);
  assert.deepEqual(deserializeFoldState(parsed.state)?.goal, state.goal);
});

test("goal: null is a thread with no goal — accepted, and written for every state that has none", () => {
  reset();
  const none = foldThread([created()]);
  assert.equal(none.goal, null);
  assert.equal(serializeFoldState(none).goal, null);
  assert.equal(throughDisk(none).goal, null);
  assert.notEqual(parseFoldSnapshotFile(onDisk(snapshotFile(none)), THREAD_ID), null);

  // A state built before goals has no field at all: the file still says null,
  // so every file this build writes carries the key.
  const { goal: _goal, ...legacy } = foldThread(richLog());
  const serialized = serializeFoldState(legacy);
  assert.equal(serialized.goal, null);
  assert.equal(throughDisk(legacy).goal, null);
});

test("a missing goal key rejects the snapshot: a cache miss", () => {
  const state = foldThread(richLog());
  const copy = serializedCopy(state);
  delete copy.goal;
  assert.equal(deserializeFoldState(copy), null);
  const file = onDisk(snapshotFile(state));
  delete file.state.goal;
  assert.equal(parseFoldSnapshotFile(file, THREAD_ID), null, "no file this build writes lacks it");
});

test("a stored goal that is neither null nor a valid ThreadGoal rejects the snapshot: a cache miss", () => {
  const state = foldThread(richLog());
  const corruptions: Array<[string, (goal: Record<string, any>) => void]> = [
    ["an unknown status", (goal) => (goal.status = "done")],
    ["a provider's own status spelling", (goal) => (goal.status = "budgetLimited")],
    ["an empty objective", (goal) => (goal.objective = "")],
    ["a numeric objective", (goal) => (goal.objective = 5)],
    ["no objective", (goal) => delete goal.objective],
    ["no updatedAt", (goal) => delete goal.updatedAt],
    ["a numeric updatedAt", (goal) => (goal.updatedAt = 5)],
    // Values the fold's parser drops: a goal the fold never writes.
    ["a negative round count", (goal) => (goal.rounds = -1)],
    ["a round count spelled as a string", (goal) => (goal.rounds = "1")],
    ["a budget spelled as a string", (goal) => (goal.tokenBudget = "100")],
    ["an empty last check", (goal) => (goal.lastCheck = "")],
    ["a field the goal does not have", (goal) => (goal.verdict = "achieved")]
  ];
  for (const [label, corrupt] of corruptions) {
    const copy = serializedCopy(state);
    corrupt(copy.goal);
    assert.equal(deserializeFoldState(copy), null, label);
    const file = onDisk(snapshotFile(state));
    corrupt(file.state.goal);
    assert.equal(parseFoldSnapshotFile(file, THREAD_ID), null, `${label} (the file)`);
  }
  for (const value of ["Make CI green", 5, true, [], {}, { updatedAt: "2026-09-24T00:00:00.000Z" }]) {
    const copy = serializedCopy(state);
    copy.goal = value;
    assert.equal(deserializeFoldState(copy), null, JSON.stringify(value));
  }
});
