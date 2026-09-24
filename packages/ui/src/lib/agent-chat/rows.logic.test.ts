import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { messageStreamingContext, type MessageStreamingContext, type Turn } from "@orquester/api/agent-chat";

import { joinLifecycleDetails } from "../../components/agent-chat/timeline/row-chrome";
import type { AgentChatTimelineRow, WorkLogEntry } from "./contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  type TimelineEntry
} from "./entries.logic";
import {
  liveWorkEntryLabel,
  omitSupersededLifecycleMarkers,
  workEntryDisplayIndicatesToolFailure
} from "./presentation.logic";
import {
  computeStableRows,
  deriveTimelineRows,
  deriveTimelineRowsWithState,
  deriveUnsettledTurnId,
  EMPTY_STABLE_ROWS,
  formatWorkDuration,
  isGroupingEntry,
  isRowUnchanged,
  type TimelineRowsInput
} from "./rows.logic";
import { activity, message, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

const baseInput = (
  timelineEntries: readonly TimelineEntry[],
  overrides: Partial<TimelineRowsInput> = {}
): TimelineRowsInput => ({
  timelineEntries,
  latestTurn: null,
  runningTurnId: null,
  isWorking: false,
  activeTurnStartedAt: null,
  supportsConversationRollback: false,
  ...overrides
});

const entriesFrom = (items: Parameters<typeof deriveTimelineEntriesFromItems>[0]) =>
  deriveTimelineEntriesFromItems(items, EMPTY_TIMELINE_PROJECTION).entries;

const kinds = (rows: readonly AgentChatTimelineRow[]) => rows.map((row) => row.kind);

/** A fold turn row: started once the provider minted its id, pending before. */
const turn = (turnId: string | null, userMessageId?: string): Turn => ({
  turnId,
  state: turnId === null ? "pending" : "completed",
  turnCount: null,
  requestedAt: stamp(0),
  startedAt: turnId === null ? null : stamp(0),
  completedAt: turnId === null ? null : stamp(0),
  assistantMessageId: null,
  ...(userMessageId !== undefined ? { userMessageId } : {})
});

/** Every rendered user bubble's `revertTurnCount`, by message id. */
const revertCounts = (rows: readonly AgentChatTimelineRow[]): Record<string, number | undefined> =>
  Object.fromEntries(
    rows.flatMap((row) =>
      row.kind === "message" && row.message.role === "user"
        ? [[row.message.id, row.revertTurnCount] as const]
        : []
    )
  );

describe("activity-group boundaries", () => {
  it("only reasoning messages and plain tool rows are grouping entries", () => {
    const reasoning: TimelineEntry = {
      kind: "message",
      id: "m1",
      createdAt: stamp(1),
      message: message("reasoning", "thinking", { turnId: "t1" })
    };
    const user: TimelineEntry = {
      kind: "message",
      id: "m2",
      createdAt: stamp(2),
      message: message("user", "go")
    };
    assert.equal(isGroupingEntry(reasoning), true);
    assert.equal(isGroupingEntry(user), false, "a user message ends a group by construction");
  });

  it("hoists an error out of the group rather than hiding it in a summary", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("reasoning", "thinking", { turnId: "t1", createdAt: stamp(1) }),
          activity("tool.completed", { itemType: "command_execution", command: "ls" }, {
            turnId: "t1",
            createdAt: stamp(2)
          }),
          activity("runtime.error", { message: "boom" }, {
            turnId: "t1",
            tone: "error",
            createdAt: stamp(3)
          })
        ]),
        // Nothing folds while the turn is live, which is when traces are watched.
        { isWorking: true, runningTurnId: "t1", activeTurnStartedAt: stamp(1) }
      )
    );
    assert.ok(kinds(rows).includes("activity-group"));
    const errorRow = rows.find(
      (row) => row.kind === "work" && row.groupedEntries.some((e: WorkLogEntry) => e.tone === "error")
    );
    assert.ok(errorRow, "the error is its own row");
  });

  it("hoists a spawn row and an answered question", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("reasoning", "think", { turnId: "t1", createdAt: stamp(1) }),
          activity("task.started", { taskId: "x1", agentKind: "agent" }, {
            turnId: "t1",
            createdAt: stamp(2)
          }),
          activity(
            "user-input.resolved",
            { questionAnswer: { requestId: "r1", answers: {} } },
            { turnId: "t1", createdAt: stamp(3) }
          )
        ]),
        { isWorking: true, runningTurnId: "t1", activeTurnStartedAt: stamp(1) }
      )
    );
    const standalone = rows.filter((row) => row.kind === "work");
    assert.equal(standalone.length, 2, "spawn and question answer are standalone rows");
  });

  it("renders a run with no reasoning row as a plain tool group", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity("tool.completed", { itemType: "command_execution", command: "a" }, {
            turnId: "t1",
            createdAt: stamp(1)
          }),
          activity("tool.completed", { itemType: "command_execution", command: "b" }, {
            turnId: "t1",
            createdAt: stamp(2)
          })
        ]),
        { isWorking: true, runningTurnId: "t1", activeTurnStartedAt: stamp(1) }
      )
    );
    assert.ok(!kinds(rows).includes("activity-group"));
    assert.ok(kinds(rows).includes("work-live") || kinds(rows).includes("work-toggle"));
  });

  it("shows commentary between tool calls while the turn runs", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { createdAt: stamp(1) }),
          message("assistant", "I'll read the file next", {
            turnId: "t1",
            createdAt: stamp(2),
            messageKind: "commentary"
          }),
          activity("tool.completed", { itemType: "command_execution", command: "ls" }, {
            turnId: "t1",
            createdAt: stamp(3)
          }),
          message("assistant", "Here is the answer", {
            turnId: "t1",
            createdAt: stamp(4),
            messageKind: "answer"
          })
        ]),
        { isWorking: true, runningTurnId: "t1", activeTurnStartedAt: stamp(1) }
      )
    );
    const texts = rows.flatMap((row) => row.kind === "message" ? [row.message.text] : []);
    assert.deepEqual(texts, ["go", "I'll read the file next", "Here is the answer"]);
    assert.ok(
      rows.some((row) => row.kind === "work" || row.kind === "work-live"),
      "tool activity remains visible between the two assistant messages"
    );
  });

  it("never treats commentary as the turn's terminal assistant message", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { createdAt: stamp(1) }),
          message("assistant", "answer", { turnId: "t1", createdAt: stamp(2) }),
          message("assistant", "narrating", {
            turnId: "t1",
            createdAt: stamp(3),
            messageKind: "commentary"
          })
        ]),
        {
          latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(1), completedAt: stamp(4) }
        }
      )
    );
    // The metadata closes the ANSWER, never the narration — either inline on
    // the message row, or as the `assistant-meta` row that trails the group
    // when the turn ends with activity after its text.
    const owners = rows.flatMap((row) =>
      (row.kind === "message" && row.showAssistantMeta) || row.kind === "assistant-meta"
        ? [row.message.text]
        : []
    );
    assert.deepEqual(owners, ["answer"]);
  });

  it("breaks a group on a turn-id change", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("reasoning", "a", { turnId: "t1", createdAt: stamp(1) }),
          message("reasoning", "b", { turnId: "t2", createdAt: stamp(2) })
        ]),
        { isWorking: true, runningTurnId: "t2", activeTurnStartedAt: stamp(1) }
      )
    );
    assert.equal(rows.filter((row) => row.kind === "activity-group").length, 2);
  });

  it("folds a settled turn's work behind a 'Worked for …' row", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { createdAt: stamp(1) }),
          activity("tool.completed", { itemType: "command_execution", command: "ls" }, {
            turnId: "t1",
            createdAt: stamp(2)
          }),
          message("assistant", "done", { turnId: "t1", createdAt: stamp(3) })
        ]),
        {
          latestTurn: { turnId: "t1", state: "completed", startedAt: stamp(1), completedAt: stamp(3) }
        }
      )
    );
    const fold = rows.find((row) => row.kind === "turn-fold");
    assert.ok(fold && fold.kind === "turn-fold");
    assert.match(fold.label, /^Worked for /);
    assert.ok(!kinds(rows).includes("work-toggle"), "the tool row is hidden behind the fold");
  });

  it("a settled turn works for its own duration, from the fold's turn row — a row that lands in it late stretches nothing", () => {
    // t1 ran 9 s and launched a background shell. The host died; its successor's first load, 50 h later, closed the
    // shell with a row on t1 — its start's turn — at the end of the log.
    const items = [
      message("user", "build it", { id: "u1", createdAt: stamp(1) }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "c1", command: "npm run build", status: "completed" }, {
        id: "c1-done",
        turnId: "t1",
        createdAt: stamp(4)
      }),
      message("assistant", "Built.", { id: "a1", turnId: "t1", createdAt: stamp(9), updatedAt: stamp(10) }),
      message("user", "and test it", { id: "u2", createdAt: stamp(20) }),
      activity("tool.completed", { itemType: "command_execution", toolUseId: "c2", command: "npm test", status: "completed" }, {
        id: "c2-done",
        turnId: "t2",
        createdAt: stamp(22)
      }),
      message("assistant", "Tested.", { id: "a2", turnId: "t2", createdAt: stamp(29), updatedAt: stamp(30) }),
      activity("task.completed", { taskId: "shell-1", status: "stopped", agentKind: "background", title: "npm run dev" }, {
        id: "shell-stop",
        turnId: "t1",
        tone: "info",
        summary: "Task stopped",
        createdAt: stamp(180_000)
      })
    ];
    const settled = (turnId: string, userMessageId: string, from: number, to: number): Turn => ({
      turnId,
      state: "completed",
      turnCount: null,
      requestedAt: stamp(from),
      startedAt: stamp(from),
      completedAt: stamp(to),
      assistantMessageId: null,
      userMessageId
    });
    const foldLabels = (rows: readonly AgentChatTimelineRow[]) =>
      rows.flatMap((row) => (row.kind === "turn-fold" ? [[row.turnId, row.label]] : []));
    const latestTurn = { turnId: "t2", state: "completed" as const, startedAt: stamp(20), completedAt: stamp(30) };
    assert.deepEqual(
      foldLabels(deriveTimelineRows(baseInput(entriesFrom(items), { latestTurn, turns: [settled("t1", "u1", 1, 10), settled("t2", "u2", 20, 30)] }))),
      [
        ["t1", "Worked for 9.0s"],
        ["t2", "Worked for 10s"]
      ]
    );
  });
});

describe("compaction and changed-files rows", () => {
  it("emits a compaction marker carrying the token counts", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity(
            "thread.state.changed",
            { state: "compacted", beforeTokens: 100, afterTokens: 20 },
            { createdAt: stamp(1), summary: "Compacted" }
          )
        ])
      )
    );
    const row = rows.find((candidate) => candidate.kind === "context-compaction");
    assert.ok(row && row.kind === "context-compaction");
    assert.equal(row.beforeTokens, 100);
    assert.equal(row.afterTokens, 20);
  });

  it("carries the provider's summary onto the marker row", () => {
    const summary = "This session is being continued…\n\n- we fixed the composer";
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity(
            "context-compaction",
            { state: "compacted", beforeTokens: 100, afterTokens: 20, summary, truncated: true },
            { createdAt: stamp(1), tone: "info", summary: "Context compacted" }
          )
        ])
      )
    );
    const row = rows.find((candidate) => candidate.kind === "context-compaction");
    assert.ok(row && row.kind === "context-compaction");
    assert.equal(row.summary, summary, "the row is what reveals it");
    assert.equal(row.summaryTruncated, true);
  });

  it("a failed compaction has no summary to reveal", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity(
            "context-compaction",
            { state: "compaction-failed", error: "out of quota" },
            { createdAt: stamp(1), tone: "error", summary: "Context compaction failed" }
          )
        ])
      )
    );
    const row = rows.find((candidate) => candidate.kind === "context-compaction");
    assert.ok(row && row.kind === "context-compaction");
    assert.equal(row.summary, undefined);
    assert.equal(row.failed, true);
  });

  it("puts the changed-files card at the end of the turn it belongs to", () => {
    const assistant = message("assistant", "done", { id: "am1", turnId: "t1", createdAt: stamp(2) });
    const rows = deriveTimelineRows(
      baseInput(entriesFrom([message("user", "go", { createdAt: stamp(1) }), assistant]), {
        checkpoints: [
          {
            turnId: "t1",
            checkpointTurnCount: 1,
            checkpointRef: "refs/x",
            status: "ready",
            files: [{ path: "a.ts", additions: 1, deletions: 0 }],
            assistantMessageId: "am1",
            completedAt: stamp(3)
          }
        ]
      })
    );
    const index = kinds(rows).indexOf("turn-diff");
    assert.ok(index > 0);
    assert.equal(rows[index - 1]?.kind, "message");
  });

  it("offers rewind only where the adapter supports rollback", () => {
    const items = [
      message("user", "go", { id: "um1", createdAt: stamp(1) }),
      message("assistant", "done", { id: "am1", turnId: "t1", createdAt: stamp(2) })
    ];
    const turns = [turn("t1", "um1")];

    const without = deriveTimelineRows(
      baseInput(entriesFrom(items), { turns, supportsConversationRollback: false })
    );
    assert.deepEqual(revertCounts(without), { um1: undefined });

    // No checkpoint anywhere — a non-git project — and the affordance is
    // there anyway: it is numbered by turn order, never by the checkpoints.
    const with_ = deriveTimelineRows(
      baseInput(entriesFrom(items), { turns, supportsConversationRollback: true })
    );
    assert.deepEqual(revertCounts(with_), { um1: 0 });
  });

  it("no longer reads the rewind off the checkpoint list", () => {
    // The old rule: a checkpoint keyed to the assistant reply after a user
    // message numbered that message. With no turn naming the prompt there is
    // nothing to rewind to, whatever the checkpoints say.
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { id: "um1", createdAt: stamp(1) }),
          message("assistant", "done", { id: "am1", turnId: "t1", createdAt: stamp(2) })
        ]),
        {
          supportsConversationRollback: true,
          turns: [turn("t1")],
          checkpoints: [
            {
              turnId: "t1",
              checkpointTurnCount: 2,
              checkpointRef: "refs/x",
              status: "ready",
              files: [],
              assistantMessageId: "am1",
              completedAt: stamp(3)
            }
          ]
        }
      )
    );
    assert.deepEqual(revertCounts(rows), { um1: undefined });
  });
});

describe("rewind to here — numbered by turn order (§5.5)", () => {
  const threeTurns = () => [
    message("user", "one", { id: "u1", createdAt: stamp(1) }),
    message("assistant", "a", { id: "a1", turnId: "t1", createdAt: stamp(2) }),
    message("user", "two", { id: "u2", createdAt: stamp(3) }),
    message("assistant", "b", { id: "a2", turnId: "t2", createdAt: stamp(4) }),
    message("user", "three", { id: "u3", createdAt: stamp(5) }),
    message("assistant", "c", { id: "a3", turnId: "t3", createdAt: stamp(6) })
  ];

  it("is the index of the turn a message opened, among the started turns", () => {
    const rows = deriveTimelineRows(
      baseInput(entriesFrom(threeTurns()), {
        supportsConversationRollback: true,
        turns: [turn("t1", "u1"), turn("t2", "u2"), turn("t3", "u3")]
      })
    );
    // Turns KEPT: rewinding to a message drops its own turn and every later one.
    assert.deepEqual(revertCounts(rows), { u1: 0, u2: 1, u3: 2 });
  });

  it("counts a promptless turn in its place, and a replayed duplicate once", () => {
    const rows = deriveTimelineRows(
      baseInput(entriesFrom(threeTurns()), {
        supportsConversationRollback: true,
        turns: [
          turn("t1", "u1"),
          // A continuation after a restart: a real turn, no prompt of its own.
          turn("tx"),
          turn("t2", "u2"),
          turn("t2", "u2"),
          turn("t3", "u3")
        ]
      })
    );
    assert.deepEqual(revertCounts(rows), { u1: 0, u2: 2, u3: 3 });
  });

  it("withholds it from a message that opened no turn", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { id: "u1", createdAt: stamp(1) }),
          // A steer rides the running turn and has no turn of its own.
          message("user", "also this", { id: "steer", turnId: "t1", createdAt: stamp(2) }),
          message("assistant", "ok", { id: "a1", turnId: "t1", createdAt: stamp(3) }),
          // A resumed history turn whose prompt the projection could not name.
          message("user", "from history", { id: "u2", createdAt: stamp(4) }),
          message("assistant", "old", { id: "a2", turnId: "t2", createdAt: stamp(5) })
        ]),
        { supportsConversationRollback: true, turns: [turn("t1", "u1"), turn("t2")] }
      )
    );
    assert.deepEqual(revertCounts(rows), { u1: 0, steer: undefined, u2: undefined });
  });

  it("never offers it on the verbatim /compact, which renders as no bubble at all", () => {
    const attachment = { type: "file" as const, id: "/att/a", name: "a", sizeBytes: 1 };
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { id: "u1", createdAt: stamp(1) }),
          message("user", "/compact", { id: "c1", createdAt: stamp(2) }),
          // With an attachment it is not the command — an ordinary prompt.
          message("user", "/compact", { id: "c2", createdAt: stamp(3), attachments: [attachment] })
        ]),
        {
          supportsConversationRollback: true,
          turns: [turn("t1", "u1"), turn("t2", "c1"), turn("t3", "c2")]
        }
      )
    );
    assert.deepEqual(revertCounts(rows), { u1: 0, c2: 2 });
  });

  it("never offers it on a user row the provider's transcript wrote itself", () => {
    // A resumed Claude history replays the CLI's own bookkeeping as user-role
    // turn starts. Rewinding to one would put "<task-notification>…" in the
    // composer as the user's prompt.
    const internal = [
      "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
      "  <local-command-stdout>Compacted </local-command-stdout>",
      "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
      "<local-command-caveat>Caveat: …</local-command-caveat>",
      "<system-reminder>…</system-reminder>"
    ];
    const items = [
      message("user", "go", { id: "u0", createdAt: stamp(0) }),
      ...internal.map((text, index) =>
        message("user", text, { id: `i${index}`, createdAt: stamp(index + 1) })
      ),
      // Text that merely MENTIONS a tag is the user's.
      message("user", "why does <task-notification> show up?", { id: "u9", createdAt: stamp(9) })
    ];
    const rows = deriveTimelineRows(
      baseInput(entriesFrom(items), {
        supportsConversationRollback: true,
        turns: [
          turn("t0", "u0"),
          ...internal.map((_, index) => turn(`ti${index}`, `i${index}`)),
          turn("t9", "u9")
        ]
      })
    );
    assert.deepEqual(revertCounts(rows), {
      u0: 0,
      i0: undefined,
      i1: undefined,
      i2: undefined,
      i3: undefined,
      i4: undefined,
      u9: 6
    });
  });

  it("gives a pending turn's prompt none until the provider starts it", () => {
    const entries = entriesFrom([
      message("user", "one", { id: "u1", createdAt: stamp(1) }),
      message("assistant", "a", { id: "a1", turnId: "t1", createdAt: stamp(2) }),
      message("user", "two", { id: "u2", createdAt: stamp(3) })
    ]);
    const pending = deriveTimelineRowsWithState(
      baseInput(entries, {
        supportsConversationRollback: true,
        turns: [turn("t1", "u1"), turn(null, "u2")]
      })
    );
    assert.deepEqual(revertCounts(pending.rows), { u1: 0, u2: undefined });

    // Nothing in the timeline moves when the provider mints the id — only the
    // turns do — so the streaming fast path must not hand back the old rows.
    const started = deriveTimelineRowsWithState(
      baseInput(entries, {
        supportsConversationRollback: true,
        turns: [turn("t1", "u1"), turn("t2", "u2")]
      }),
      pending
    );
    assert.deepEqual(revertCounts(started.rows), { u1: 0, u2: 1 });
  });

  it("withholds every message before the last settled compaction, and only those", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "one", { id: "u1", createdAt: stamp(1) }),
          message("assistant", "a", { id: "a1", turnId: "t1", createdAt: stamp(2) }),
          message("user", "two", { id: "u2", createdAt: stamp(3) }),
          activity(
            "context-compaction",
            { state: "compacted", beforeTokens: 900, afterTokens: 90 },
            { tone: "info", summary: "Context compacted", createdAt: stamp(4) }
          ),
          message("user", "three", { id: "u3", createdAt: stamp(5) }),
          message("assistant", "c", { id: "a3", turnId: "t3", createdAt: stamp(6) })
        ]),
        {
          supportsConversationRollback: true,
          turns: [turn("t1", "u1"), turn("t2", "u2"), turn("t3", "u3")]
        }
      )
    );
    // The provider no longer holds u1 and u2, so the adapter would refuse.
    assert.deepEqual(revertCounts(rows), { u1: undefined, u2: undefined, u3: 2 });
  });

  it("treats the legacy settled marker as a compaction too", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "one", { id: "u1", createdAt: stamp(1) }),
          activity("thread.state.changed", { state: "compacted" }, { createdAt: stamp(2) }),
          message("user", "two", { id: "u2", createdAt: stamp(3) })
        ]),
        { supportsConversationRollback: true, turns: [turn("t1", "u1"), turn("t2", "u2")] }
      )
    );
    assert.deepEqual(revertCounts(rows), { u1: undefined, u2: 1 });
  });

  it("is not withheld by a compaction that failed or is still running — neither dropped anything", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "one", { id: "u1", createdAt: stamp(1) }),
          activity("context-compaction", { state: "compaction-failed", error: "quota" }, {
            tone: "error",
            summary: "Context compaction failed",
            createdAt: stamp(2)
          }),
          message("user", "two", { id: "u2", createdAt: stamp(3) }),
          activity("context-compaction", { state: "compacting" }, {
            tone: "info",
            summary: "Compacting context",
            createdAt: stamp(4)
          })
        ]),
        { supportsConversationRollback: true, turns: [turn("t1", "u1"), turn("t2", "u2")] }
      )
    );
    assert.deepEqual(revertCounts(rows), { u1: 0, u2: 1 });
  });

  it("offers none in the drill-in, which rolls back no turn of its own", () => {
    const entries = entriesFrom(threeTurns());
    const turns = [turn("t1", "u1"), turn("t2", "u2"), turn("t3", "u3")];
    // The capability off, as `useAgentChatDrillIn` passes it…
    assert.deepEqual(revertCounts(deriveTimelineRows(baseInput(entries, { turns }))), {
      u1: undefined,
      u2: undefined,
      u3: undefined
    });
    // …and no turns at all, which is what it hands in besides.
    assert.deepEqual(
      revertCounts(deriveTimelineRows(baseInput(entries, { supportsConversationRollback: true }))),
      { u1: undefined, u2: undefined, u3: undefined }
    );
  });
});

describe("the live rows", () => {
  it("never represents a running turn by an empty timeline", () => {
    const rows = deriveTimelineRows(
      baseInput([], { isWorking: true, activeTurnStartedAt: stamp(1) })
    );
    assert.ok(kinds(rows).includes("working"));
    assert.ok(kinds(rows).includes("thinking"));
  });

  it("appends every queued message as a ghost bubble, oldest first", () => {
    const rows = deriveTimelineRows(
      baseInput([], {
        queuedMessages: [
          {
            id: "q1",
            text: "one",
            attachments: [],
            context: [],
            interactionMode: "default",
            queuedAfterToolActivityId: null,
            holdUntilUserAction: false,
            queuedAt: stamp(1)
          },
          {
            id: "q2",
            text: "two",
            attachments: [],
            context: [],
            interactionMode: "default",
            queuedAfterToolActivityId: null,
            holdUntilUserAction: false,
            queuedAt: stamp(2)
          }
        ]
      })
    );
    const queued = rows.filter((row) => row.kind === "queued-message");
    assert.equal(queued.length, 2);
    assert.equal(queued[0]?.kind === "queued-message" && queued[0].isNext, true);
    assert.equal(queued[1]?.kind === "queued-message" && queued[1].isNext, false);
  });
});

describe("a command's streamed output is the inside of its row", () => {
  // A Codex command as ingestion writes it: its start, then one `tool.output` row per flush of its output, then —
  // once it exits — its completion. No update comes in between.
  const prompt = () => message("user", "build it", { id: "u1", createdAt: stamp(1) });
  const call = (activityKind: string, id: string, at: number, status: string) =>
    activity(
      activityKind,
      { itemType: "command_execution", toolUseId: "call-1", title: "npm run build", command: "npm run build", status },
      { id, turnId: "t1", createdAt: stamp(at) }
    );
  const chunk = (n: number, delta = `line ${n}\n`) =>
    activity("tool.output", { toolUseId: "call-1", streamKind: "command_output", delta }, {
      id: `c${n}`,
      turnId: "t1",
      summary: "Tool output",
      createdAt: stamp(2 + n)
    });
  const running = {
    isWorking: true,
    runningTurnId: "t1",
    latestTurn: { turnId: "t1", state: "running" as const, startedAt: stamp(1), completedAt: null },
    activeTurnStartedAt: stamp(1)
  };
  const liveRows = (rows: readonly AgentChatTimelineRow[]) =>
    rows.flatMap((row) => (row.kind === "work-live" ? [row] : []));

  it("a running command and its N chunks are ONE live row, labelled with the command", () => {
    const chunks = Array.from({ length: 40 }, (_, index) => chunk(index + 1));
    const rows = deriveTimelineRows(baseInput(entriesFrom([prompt(), call("tool.started", "start", 2, "inProgress"), ...chunks]), running));
    assert.deepEqual(kinds(rows), ["message", "working", "work-live"]);
    const [live] = liveRows(rows);
    assert.equal(liveWorkEntryLabel(live!.entry, live!.active), "Running npm", "never the text of its latest chunk");
    assert.equal(live!.active, true);
    // The row still carries every chunk: expanded, they are its output.
    assert.equal(live!.groupedEntries.length, 41);
    assert.deepEqual(
      joinLifecycleDetails(live!.groupedEntries).map((entry) => [entry.id, entry.detail]),
      [["start", chunks.map((row) => (row.payload as { delta: string }).delta).join("")]]
    );
  });

  it("a chunk that reads like a failure neither splits the run nor marks it failed", () => {
    for (const failingAt of [2, 3]) {
      const chunks = [1, 2, 3].map((n) => chunk(n, n === failingAt ? "cat: x: No such file or directory\n" : `line ${n}\n`));
      const rows = deriveTimelineRows(baseInput(entriesFrom([prompt(), call("tool.started", "start", 2, "inProgress"), ...chunks]), running));
      assert.deepEqual(kinds(rows), ["message", "working", "work-live"], `failing chunk ${failingAt}: one run`);
      const [live] = liveRows(rows);
      assert.equal(live!.entry.id, "start");
      assert.equal(workEntryDisplayIndicatesToolFailure(live!.entry), false, `failing chunk ${failingAt}: not failed`);
      assert.equal(live!.groupedEntries.length, 4);
    }
  });

  it("a settled call and its chunks render exactly as the call would without them — its row, labelled with its command", () => {
    const settled = {
      latestTurn: { turnId: "t1", state: "completed" as const, startedAt: stamp(1), completedAt: stamp(10) },
      expandedTurnIds: new Set(["t1"])
    };
    const withoutChunks = [
      prompt(),
      call("tool.started", "start", 2, "inProgress"),
      call("tool.completed", "done", 9, "completed"),
      message("assistant", "Built.", { id: "a1", turnId: "t1", createdAt: stamp(10) })
    ];
    const withChunks = [...withoutChunks.slice(0, 2), chunk(1), chunk(2), chunk(3), ...withoutChunks.slice(2)];
    const callRow = (items: Parameters<typeof entriesFrom>[0]) => {
      const rows = deriveTimelineRows(baseInput(entriesFrom(items), settled));
      assert.ok(!kinds(rows).includes("work-toggle"), "no \"Ran 1 command\" toggle hiding its one row");
      const row = rows.find((candidate) => candidate.kind === "work");
      assert.ok(row?.kind === "work");
      return row;
    };
    const plain = callRow(withoutChunks);
    const streamed = callRow(withChunks);
    assert.deepEqual([streamed.displayLabel, streamed.isExpandedToolGroup], [plain.displayLabel, false]);
    assert.equal(streamed.displayLabel, "npm run build");
    // The row still carries every chunk: open, they are its output.
    assert.deepEqual(
      joinLifecycleDetails(omitSupersededLifecycleMarkers(streamed.groupedEntries, (entry) => entry)).map((entry) => [entry.id, entry.detail]),
      [["done", "line 1\nline 2\nline 3\n"]]
    );
  });

  it("a Claude call whose input is still streaming reads its tool's name live, never \"Bash: {}\"", () => {
    const claudeStart = activity(
      "tool.started",
      { itemType: "command_execution", toolUseId: "toolu_1", title: "Command run", detail: "Bash: {}", status: "inProgress", data: { toolName: "Bash", input: {} } },
      { id: "start", turnId: "t1", createdAt: stamp(2) }
    );
    const rows = deriveTimelineRows(baseInput(entriesFrom([prompt(), claudeStart]), running));
    assert.deepEqual(kinds(rows), ["message", "working", "work-live"]);
    const [live] = liveRows(rows);
    assert.equal(liveWorkEntryLabel(live!.entry, live!.active), "Bash");
  });

  it("a woken parent call is its synthetic turn's live row; what a rewind of that turn leaves of it renders nothing", () => {
    // What a Claude parent call emits before the synthetic turn its own message opens stays turnless: its start and an
    // early input update. The turn that opens adopts it with one update on that turn, its first row the live run holds.
    const row = (activityKind: string, id: string, at: number, turnId: string | null) =>
      activity(activityKind, { itemType: "command_execution", toolUseId: "call-w", title: "Command run", status: "inProgress", data: { command: "cat out.txt" } }, { id, turnId, createdAt: stamp(at) });
    const turnless = [row("tool.started", "ws", 3, null), row("tool.updated", "wu", 4, null)];
    const earlier = [prompt(), message("assistant", "Done.", { id: "a1", turnId: "t1", createdAt: stamp(2) })];
    const woken = {
      isWorking: true,
      runningTurnId: "t2",
      latestTurn: { turnId: "t2", state: "running" as const, startedAt: stamp(5), completedAt: null },
      activeTurnStartedAt: stamp(5)
    };
    const live = liveRows(deriveTimelineRows(baseInput(entriesFrom([...earlier, ...turnless, row("tool.updated", "wa", 6, "t2")]), woken)));
    assert.deepEqual(live.map((entry) => [entry.entry.id, liveWorkEntryLabel(entry.entry, entry.active), entry.active]), [["wa", "Running cat", true]]);
    // A rewind of the synthetic turn takes the adopting update with it. The start is superseded; the update, still in
    // progress, is a neutral row a group hides.
    for (const [name, input] of [["settled", {}], ["running", running]] as const) {
      const rows = deriveTimelineRows(baseInput(entriesFrom([...earlier, ...turnless]), input));
      assert.ok(!rows.some((candidate) => candidate.kind === "work" || candidate.kind === "work-live" || candidate.kind === "work-toggle"), `${name}: ${kinds(rows).join(", ")}`);
    }
  });

  it("an orphan call — its chunks with no row of the call in the group — counts once, headed \"Tool output\"", () => {
    // Retention kept the chunks and not the call's opening row (past its cap): they are its only trace here.
    const orphan = (n: number) =>
      activity("tool.output", { toolUseId: "call-9", streamKind: "command_output", delta: `orphan ${n}\n` }, {
        id: `o${n}`,
        turnId: "t1",
        summary: "Tool output",
        createdAt: stamp(2 + n)
      });
    const settled = {
      latestTurn: { turnId: "t1", state: "completed" as const, startedAt: stamp(1), completedAt: stamp(10) },
      expandedTurnIds: new Set(["t1"])
    };
    const items = [prompt(), orphan(1), orphan(2), orphan(3), call("tool.completed", "done", 8, "completed"), message("assistant", "Built.", { id: "a1", turnId: "t1", createdAt: stamp(10) })];
    const toggle = deriveTimelineRows(baseInput(entriesFrom(items), settled)).find((row) => row.kind === "work-toggle");
    assert.ok(toggle?.kind === "work-toggle");
    assert.deepEqual([toggle.hiddenCount, toggle.summary], [2, "Used 1 tool and ran 1 command"]);
    // Live, an orphan call's row is headed as a call, never with its latest line.
    const live = liveRows(deriveTimelineRows(baseInput(entriesFrom([prompt(), orphan(1), orphan(2)]), running)));
    assert.equal(live.length, 1);
    assert.equal(liveWorkEntryLabel(live[0]!.entry, live[0]!.active), "Tool output");
  });
});

describe("a timeline split into the history and the window (design 2026-09-23)", () => {
  /** Turn tR, still running: its prompt, a word from the agent, a call still in flight. */
  const running = () =>
    entriesFrom([
      message("user", "go", { id: "uR", createdAt: stamp(1) }),
      message("assistant", "on it", { id: "aR", turnId: "tR", createdAt: stamp(2) }),
      activity("tool.updated", { toolUseId: "call-1", status: "inProgress" }, {
        id: "xR",
        turnId: "tR",
        summary: "Read src/a.ts",
        createdAt: stamp(3)
      })
    ]);
  const live = (overrides: Partial<TimelineRowsInput> = {}) =>
    baseInput(running(), {
      isWorking: true,
      runningTurnId: "tR",
      activeTurnStartedAt: stamp(1),
      ...overrides
    });

  it("renders a running turn live in a projection the timeline continues below — the tail is the window's", () => {
    const whole = deriveTimelineRows(live());
    const above = deriveTimelineRows(live({ continuesBelow: true }));

    assert.deepEqual(kinds(above), kinds(whole), "the same rows: unfolded, live, header after the prompt");
    assert.ok(!kinds(above).includes("turn-fold"));
    const answer = above.find((row) => row.kind === "message" && row.id === "aR");
    assert.equal(answer?.kind === "message" ? answer.showAssistantMeta : null, false);
    const call = above.find((row) => row.kind === "work-live");
    assert.equal(call?.kind === "work-live" ? call.active : null, true, "the call in flight is live");
  });

  it("leaves the thinking placeholder to the projection that ends the timeline", () => {
    const quiet = entriesFrom([message("user", "go", { id: "uR", createdAt: stamp(1) })]);
    const input = baseInput(quiet, { isWorking: true, runningTurnId: "tR", activeTurnStartedAt: stamp(1) });
    assert.deepEqual(kinds(deriveTimelineRows(input)), ["message", "working", "thinking"]);
    assert.deepEqual(kinds(deriveTimelineRows({ ...input, continuesBelow: true })), ["message", "working"]);
  });

  it("puts the running turn's header where the timeline's last prompt is", () => {
    const below = deriveTimelineRows(live({ continuesBelow: true, activeTurnHeader: "below" }));
    assert.ok(!kinds(below).includes("working"), "the prompt is further down");
    assert.ok(!kinds(below).includes("turn-fold"), "the running turn still never folds");

    const window = entriesFrom([
      activity("tool.completed", { toolUseId: "call-2", status: "failed" }, {
        id: "xR2",
        turnId: "tR",
        tone: "error",
        createdAt: stamp(4)
      })
    ]);
    const after = deriveTimelineRows(
      baseInput(window, {
        isWorking: true,
        runningTurnId: "tR",
        activeTurnStartedAt: stamp(1),
        activeTurnHeader: "above"
      })
    );
    assert.deepEqual(kinds(after), ["work", "thinking"], "no second header: it is above");
  });

  it("needs no placeholder when a live row above shows the turn working, and reports its own", () => {
    const window = entriesFrom([
      activity("tool.completed", { toolUseId: "call-2", status: "failed" }, {
        id: "xR2",
        turnId: "tR",
        tone: "error",
        createdAt: stamp(4)
      })
    ]);
    const input = baseInput(window, {
      isWorking: true,
      runningTurnId: "tR",
      activeTurnStartedAt: stamp(1),
      activeTurnHeader: "above" as const
    });
    assert.ok(!kinds(deriveTimelineRows({ ...input, liveActivityAbove: true })).includes("thinking"));

    assert.equal(deriveTimelineRowsWithState(live({ continuesBelow: true })).hasActivityRow, true);
    assert.equal(deriveTimelineRowsWithState(input).hasActivityRow, false);
  });
});

describe("deriveUnsettledTurnId", () => {
  it("prefers the session's running turn over a lagging latest turn", () => {
    assert.equal(
      deriveUnsettledTurnId({ turnId: "old", state: "completed", startedAt: null, completedAt: stamp(1) }, "new"),
      "new"
    );
  });

  it("treats a completed turn as settled", () => {
    assert.equal(
      deriveUnsettledTurnId(
        { turnId: "t1", state: "completed", startedAt: stamp(1), completedAt: stamp(2) },
        null
      ),
      null
    );
  });
});

describe("stable rows", () => {
  it("keeps every unchanged row object across a streamed token", () => {
    const a = message("user", "hi", { createdAt: stamp(1) });
    const streaming = message("assistant", "par", {
      createdAt: stamp(2),
      streaming: true,
      turnId: "t1"
    });
    const first = deriveTimelineEntriesFromItems([a, streaming], EMPTY_TIMELINE_PROJECTION);
    const firstRows = deriveTimelineRowsWithState(baseInput(first.entries));
    const firstStable = computeStableRows(firstRows.rows, EMPTY_STABLE_ROWS);

    const grown = { ...streaming, text: "partial", updatedAt: stamp(3) };
    const second = deriveTimelineEntriesFromItems([a, grown], first);
    const secondRows = deriveTimelineRowsWithState(baseInput(second.entries), firstRows);
    const secondStable = computeStableRows(secondRows.rows, firstStable);

    assert.equal(secondStable.result[0], firstStable.result[0], "one token changes one row");
    assert.notEqual(secondStable.result[1], firstStable.result[1]);
  });

  it("returns the same state object when nothing changed at all", () => {
    const rows = deriveTimelineRows(baseInput(entriesFrom([message("user", "hi")])));
    const first = computeStableRows(rows, EMPTY_STABLE_ROWS);
    const second = computeStableRows(deriveTimelineRows(baseInput(entriesFrom([message("user", "hi")]))), first);
    assert.equal(second.result.length, first.result.length);
  });

  it("isRowUnchanged compares per variant and never across kinds", () => {
    const a: AgentChatTimelineRow = { kind: "working", id: "w", createdAt: stamp(1) };
    const b: AgentChatTimelineRow = { kind: "thinking", id: "w", createdAt: stamp(1) };
    assert.equal(isRowUnchanged(a, b), false);
    assert.equal(isRowUnchanged(a, { ...a }), true);
    assert.equal(isRowUnchanged(a, { ...a, createdAt: stamp(2) }), false);
  });
});

describe("the plan card row (§7.3)", () => {
  it("carries the wire's cut (§5.6), so Copy and Download know to read the whole plan back", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity(
            "turn.proposed.completed",
            { planMarkdown: "# Cut\n\nstep 1…", truncated: true },
            { id: "p-cut", createdAt: stamp(1) }
          ),
          activity("turn.proposed.completed", { planMarkdown: "# Whole" }, { id: "p-whole", createdAt: stamp(2) })
        ])
      )
    );
    const plans = rows.flatMap((row) => (row.kind === "proposed-plan" ? [row] : []));
    assert.deepEqual(
      plans.map((row) => [row.id, row.truncated]),
      [
        ["p-cut", true],
        ["p-whole", undefined]
      ]
    );
    assert.equal("truncated" in plans[1]!, false, "an intact plan's row carries no flag at all");
  });

  it("makes the cut part of the row's identity check", () => {
    const plan: AgentChatTimelineRow = {
      kind: "proposed-plan",
      id: "p",
      createdAt: stamp(1),
      planMarkdown: "# Plan",
      implementedAt: null
    };
    assert.equal(isRowUnchanged(plan, { ...plan }), true);
    assert.equal(isRowUnchanged(plan, { ...plan, truncated: true }), false);
  });
});

describe("formatWorkDuration", () => {
  it("matches T3's shape at every boundary", () => {
    assert.equal(formatWorkDuration(0), "1ms");
    assert.equal(formatWorkDuration(999), "999ms");
    assert.equal(formatWorkDuration(1500), "1.5s");
    assert.equal(formatWorkDuration(9_950), "10s");
    assert.equal(formatWorkDuration(45_000), "45s");
    assert.equal(formatWorkDuration(3_661_000), "1h 1m 1s");
    assert.equal(formatWorkDuration(Number.NaN), "0ms");
  });
});

// ---------------------------------------------------------------------------
// The compaction phase (§7.3)
// ---------------------------------------------------------------------------

describe("the compaction phase", () => {
  const compactingMarker = () =>
    activity("context-compaction", { state: "compacting" }, {
      tone: "info",
      summary: "Compacting context",
      turnId: "t1",
      createdAt: stamp(2)
    });

  const runningCompaction = (
    entries: readonly TimelineEntry[],
    overrides: Partial<TimelineRowsInput> = {}
  ) =>
    deriveTimelineRows(
      baseInput(entries, {
        isWorking: true,
        isCompacting: true,
        runningTurnId: "t1",
        latestTurn: { turnId: "t1", state: "running", startedAt: stamp(1), completedAt: null },
        activeTurnStartedAt: stamp(1),
        ...overrides
      })
    );

  it("never renders the in-flight marker as a divider — it is a phase, not an event", () => {
    const rows = runningCompaction(
      entriesFrom([message("user", "/compact", { createdAt: stamp(1) }), compactingMarker()])
    );
    assert.ok(
      !kinds(rows).includes("context-compaction"),
      "a `Context compacted \u00b7 \u2026` hairline would claim a compaction that has not happened"
    );
  });

  it("keeps the settled marker exactly as it was", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity("context-compaction", { state: "compacted", beforeTokens: 800_000, afterTokens: 11_000 }, {
            summary: "Context compacted",
            createdAt: stamp(1)
          })
        ])
      )
    );
    const row = rows.find((candidate) => candidate.kind === "context-compaction");
    assert.ok(row && row.kind === "context-compaction");
    assert.equal(row.label, "Context compacted");
    assert.equal(row.beforeTokens, 800_000);
    assert.equal(row.afterTokens, 11_000);
    assert.equal(row.failed, undefined, "a successful compaction is not a failure row");
    assert.equal(row.detail, undefined);
  });

  it("renders a failed compaction as its own divider, carrying the reason", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          activity("context-compaction", { state: "compaction-failed", error: "context window exhausted" }, {
            tone: "error",
            summary: "Context compaction failed",
            createdAt: stamp(1)
          })
        ])
      )
    );
    const row = rows.find((candidate) => candidate.kind === "context-compaction");
    assert.ok(row && row.kind === "context-compaction");
    assert.equal(row.label, "Context compaction failed");
    assert.equal(row.failed, true);
    assert.equal(row.detail, "context window exhausted");
  });

  it("stamps the working row, which is the placeholder the user is looking at", () => {
    const rows = runningCompaction(
      entriesFrom([message("user", "/compact", { createdAt: stamp(1) }), compactingMarker()])
    );
    const working = rows.find((row) => row.kind === "working");
    assert.ok(working && working.kind === "working");
    assert.equal(working.compacting, true);
  });

  it("stamps the thinking placeholder and the live activity-group header too", () => {
    const thinking = runningCompaction(
      entriesFrom([message("user", "/compact", { createdAt: stamp(1) }), compactingMarker()])
    ).find((row) => row.kind === "thinking");
    assert.ok(thinking && thinking.kind === "thinking");
    assert.equal(thinking.compacting, true);

    // A reasoning block that lands after the compaction started keeps the
    // group live, and then the group header is the live placeholder.
    const group = runningCompaction(
      entriesFrom([
        message("user", "go", { createdAt: stamp(1) }),
        compactingMarker(),
        message("reasoning", "hmm", { turnId: "t1", createdAt: stamp(3) })
      ])
    ).find((row) => row.kind === "activity-group");
    assert.ok(group && group.kind === "activity-group");
    assert.equal(group.active, true, "only a LIVE group has a label to replace");
    assert.equal(group.compacting, true);
  });

  it("stamps nothing once the phase is over", () => {
    const rows = runningCompaction(
      entriesFrom([message("user", "/compact", { createdAt: stamp(1) })]),
      { isCompacting: false }
    );
    for (const row of rows) {
      if (row.kind === "working" || row.kind === "thinking" || row.kind === "activity-group") {
        assert.equal(row.compacting, undefined, row.kind);
      }
    }
  });

  it("re-derives when only the phase moved — the streaming fast path must not swallow it", () => {
    const entries = entriesFrom([
      message("user", "/compact", { createdAt: stamp(1) }),
      compactingMarker()
    ]);
    const before = deriveTimelineRowsWithState(
      baseInput(entries, {
        isWorking: true,
        isCompacting: true,
        runningTurnId: "t1",
        activeTurnStartedAt: stamp(1)
      })
    );
    const after = deriveTimelineRowsWithState(
      baseInput(entries, {
        isWorking: true,
        isCompacting: false,
        runningTurnId: "t1",
        activeTurnStartedAt: stamp(1)
      }),
      before
    );
    const working = after.rows.find((row) => row.kind === "working");
    assert.ok(working && working.kind === "working");
    assert.equal(working.compacting, undefined);
  });

  it("is part of every affected row's identity check", () => {
    const working = { kind: "working", id: "w", createdAt: stamp(1) } as const;
    assert.equal(isRowUnchanged(working, { ...working, compacting: true }), false);
    const thinking = { kind: "thinking", id: "t", createdAt: stamp(1) } as const;
    assert.equal(isRowUnchanged(thinking, { ...thinking, compacting: true }), false);
    const marker = {
      kind: "context-compaction",
      id: "c",
      createdAt: stamp(1),
      label: "Context compaction failed"
    } as const;
    assert.equal(isRowUnchanged(marker, { ...marker, failed: true }), false);
    assert.equal(isRowUnchanged(marker, { ...marker, detail: "why" }), false);
    assert.equal(isRowUnchanged(marker, { ...marker }), true);
  });
});

// ---------------------------------------------------------------------------
// Fix-wave regressions
// ---------------------------------------------------------------------------

describe("R2-4 — /compact renders as the marker, not a bubble", () => {
  it("drops the verbatim user message the host persisted", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "go", { createdAt: stamp(1) }),
          message("user", "  /COMPACT  ", { createdAt: stamp(2) }),
          activity(
            "thread.state.changed",
            { state: "compacted", beforeTokens: 100, afterTokens: 20 },
            { createdAt: stamp(3), summary: "Compacted" }
          )
        ])
      )
    );
    const texts = rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []));
    assert.deepEqual(texts, ["go"], "the /compact bubble is gone");
    assert.ok(kinds(rows).includes("context-compaction"), "the marker is what the user sees");
  });

  it("keeps a /compact message that carries attachments — it is not the command", () => {
    const rows = deriveTimelineRows(
      baseInput(
        entriesFrom([
          message("user", "/compact", {
            createdAt: stamp(1),
            attachments: [{ type: "file", id: "/a", name: "a", sizeBytes: 1 }]
          })
        ])
      )
    );
    assert.equal(rows.filter((row) => row.kind === "message").length, 1);
  });
});

describe("R7-12 — stable rows survive a duplicate row id", () => {
  it("keeps reusing the rows that do NOT share an id", () => {
    const duplicate: AgentChatTimelineRow[] = [
      { kind: "working", id: "dup", createdAt: stamp(1) },
      { kind: "thinking", id: "dup", createdAt: stamp(1) },
      { kind: "turn-fold", id: "f", createdAt: stamp(1), turnId: "t1", label: "Worked", expanded: false }
    ];
    const first = computeStableRows(duplicate, EMPTY_STABLE_ROWS);
    const second = computeStableRows(
      duplicate.map((row) => ({ ...row })) as AgentChatTimelineRow[],
      first
    );
    // The colliding pair cannot be reused (one id, two rows) — but the row
    // that does not collide must still keep its identity. Seeding `anyChanged`
    // from `byId.size` made the map smaller than the array, which pinned it
    // true forever and disabled reuse for EVERY row (fix-wave R7-12).
    assert.equal(second.result[2], first.result[2]);
  });

  it("returns the previous state object when no ids collide", () => {
    const rows: AgentChatTimelineRow[] = [
      { kind: "working", id: "w", createdAt: stamp(1) },
      { kind: "turn-fold", id: "f", createdAt: stamp(1), turnId: "t1", label: "Worked", expanded: false }
    ];
    const first = computeStableRows(rows, EMPTY_STABLE_ROWS);
    const second = computeStableRows(rows.map((row) => ({ ...row })) as AgentChatTimelineRow[], first);
    assert.equal(second, first);
  });
});

describe("a message's liveness is the rule's, never its bare flag (isMessageStreaming)", () => {
  type MessageRow = Extract<AgentChatTimelineRow, { kind: "message" }>;
  const messageRow = (rows: readonly AgentChatTimelineRow[], id: string): MessageRow => {
    const row = rows.find((candidate): candidate is MessageRow => candidate.kind === "message" && candidate.id === id);
    assert.ok(row, `a message row ${id}`);
    return row;
  };
  const running = (activeTurnId: string | null): MessageStreamingContext =>
    messageStreamingContext({ head: { session: { status: "running", activeTurnId } }, roster: [] });

  /**
   * Turn `t1` settled long ago with its answer still flagged: the host that was
   * streaming it was killed. Turn `t2` is running and streaming its own.
   */
  const items = () => [
    message("user", "first", { id: "u1", createdAt: stamp(1) }),
    activity(
      "tool.completed",
      { itemType: "command_execution", toolUseId: "call-1", title: "ls", command: "ls", status: "completed" },
      { id: "ls", turnId: "t1", createdAt: stamp(2) }
    ),
    message("assistant", "Half an answer", { id: "stuck", turnId: "t1", streaming: true, createdAt: stamp(3) }),
    message("user", "second", { id: "u2", createdAt: stamp(4) }),
    message("assistant", "Now answer", { id: "live", turnId: "t2", streaming: true, createdAt: stamp(5) })
  ];
  const t2Running = {
    latestTurn: { turnId: "t2", state: "running" as const, startedAt: stamp(4), completedAt: null },
    runningTurnId: "t2",
    isWorking: true,
    activeTurnStartedAt: stamp(4)
  };

  it("the running turn's answer streams; a settled turn's stuck answer reads settled and its turn folds", () => {
    const rows = deriveTimelineRows(
      baseInput(entriesFrom(items()), { ...t2Running, messageStreaming: running("t2") })
    );
    assert.equal(messageRow(rows, "live").streaming, true);
    assert.equal(messageRow(rows, "stuck").streaming, undefined);
    assert.ok(
      rows.some((row) => row.kind === "turn-fold" && row.turnId === "t1"),
      `the stuck answer no longer holds t1's fold open: ${kinds(rows).join(", ")}`
    );
  });

  it("a streaming answer holds its turn's fold open while it can still be written", () => {
    // `isWorking: false`, so only the answer's own liveness keeps `t1` unfolded.
    const live = deriveTimelineRows(
      baseInput(entriesFrom(items()), { messageStreaming: running("t1") })
    );
    assert.equal(messageRow(live, "stuck").streaming, true);
    assert.ok(!live.some((row) => row.kind === "turn-fold" && row.turnId === "t1"));
  });

  it("nothing streams without a context — a caller that names no live session", () => {
    const rows = deriveTimelineRows(baseInput(entriesFrom(items()), t2Running));
    assert.equal(messageRow(rows, "live").streaming, undefined);
    assert.equal(messageRow(rows, "stuck").streaming, undefined);
  });

  it("a moved context re-derives: the streamed-text fast path never keeps a stale streaming row", () => {
    const entries = entriesFrom(items());
    const first = deriveTimelineRowsWithState(baseInput(entries, { messageStreaming: running("t2") }));
    assert.equal(messageRow(first.rows, "live").streaming, true);
    // The session died under the same entries: only the context moved.
    const dead = messageStreamingContext({
      head: { session: { status: "stopped", activeTurnId: null } },
      roster: []
    });
    const second = deriveTimelineRowsWithState(baseInput(entries, { messageStreaming: dead }), first);
    assert.equal(messageRow(second.rows, "live").streaming, undefined);

    const stable = computeStableRows(second.rows, computeStableRows(first.rows, EMPTY_STABLE_ROWS));
    assert.equal(messageRow(stable.result, "live").streaming, undefined, "the stable layer takes the new row");
  });

  it("a streamed token keeps the row's liveness through the fast path", () => {
    const context = running("t2");
    const base = items();
    const first = deriveTimelineEntriesFromItems(base, EMPTY_TIMELINE_PROJECTION);
    const firstRows = deriveTimelineRowsWithState(baseInput(first.entries, { messageStreaming: context }));
    const grown = base.map((item) =>
      item.id === "live" && item.kind === "message" ? { ...item, text: "Now answering", updatedAt: stamp(6) } : item
    );
    const second = deriveTimelineEntriesFromItems(grown, first);
    const secondRows = deriveTimelineRowsWithState(baseInput(second.entries, { messageStreaming: context }), firstRows);
    assert.equal(secondRows.rows[0], firstRows.rows[0], "the fast path took it: the untouched rows are the same objects");
    const row = messageRow(secondRows.rows, "live");
    assert.equal(row.message.text, "Now answering");
    assert.equal(row.streaming, true);
  });

  it("a delta on an answer that reads settled rebuilds: its turn's fold is timed by it", () => {
    const context = running("t2");
    const base = items();
    const first = deriveTimelineEntriesFromItems(base, EMPTY_TIMELINE_PROJECTION);
    const firstRows = deriveTimelineRowsWithState(baseInput(first.entries, { messageStreaming: context }));
    const label = (rows: readonly AgentChatTimelineRow[]) =>
      rows.flatMap((row) => (row.kind === "turn-fold" && row.turnId === "t1" ? [row.label] : []));
    assert.deepEqual(label(firstRows.rows), ["Worked for 2.0s"], "from the prompt to the answer's last write");
    // A late write to the stuck answer (flagged, of a turn no longer running).
    const late = base.map((item) =>
      item.id === "stuck" && item.kind === "message" ? { ...item, text: "Half an answer, late", updatedAt: stamp(9) } : item
    );
    const second = deriveTimelineEntriesFromItems(late, first);
    const secondRows = deriveTimelineRowsWithState(baseInput(second.entries, { messageStreaming: context }), firstRows);
    assert.deepEqual(label(secondRows.rows), ["Worked for 8.0s"], "never the fast path's stale label");
  });

  it("isRowUnchanged sees a message row's liveness", () => {
    const row = messageRow(
      deriveTimelineRows(baseInput(entriesFrom(items()), { ...t2Running, messageStreaming: running("t2") })),
      "live"
    );
    assert.equal(isRowUnchanged(row, { ...row }), true);
    const { streaming: _live, ...settled } = row;
    assert.equal(isRowUnchanged(row, settled), false);
  });
});
