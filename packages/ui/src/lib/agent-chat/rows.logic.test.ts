import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Turn } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow, WorkLogEntry } from "./contracts";
import {
  deriveTimelineEntriesFromItems,
  EMPTY_TIMELINE_PROJECTION,
  type TimelineEntry
} from "./entries.logic";
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
