import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

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

  it("demotes an assistant message marked `commentary` into the group", () => {
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
    const messageRows = rows.filter((row) => row.kind === "message");
    const texts = messageRows.map((row) => (row.kind === "message" ? row.message.text : ""));
    assert.ok(!texts.includes("I'll read the file next"), "commentary never gets its own row");
    assert.ok(texts.includes("Here is the answer"));
    assert.ok(texts.includes("go"));

    const group = rows.find((row) => row.kind === "activity-group");
    assert.ok(group && group.kind === "activity-group");
    assert.ok(
      group.entries.some((entry) => entry.detail === "I'll read the file next"),
      "it folds into the surrounding activity group"
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
    const assistant = message("assistant", "done", { id: "am1", turnId: "t1", createdAt: stamp(2) });
    const checkpoints = [
      {
        turnId: "t1",
        checkpointTurnCount: 2,
        checkpointRef: "refs/x",
        status: "ready" as const,
        files: [],
        assistantMessageId: "am1",
        completedAt: stamp(3)
      }
    ];
    const items = [message("user", "go", { id: "um1", createdAt: stamp(1) }), assistant];
    const without = deriveTimelineRows(
      baseInput(entriesFrom(items), { checkpoints, supportsConversationRollback: false })
    );
    const userRow = without.find((row) => row.kind === "message" && row.message.role === "user");
    assert.ok(userRow && userRow.kind === "message");
    assert.equal(userRow.revertTurnCount, undefined);

    const with_ = deriveTimelineRows(
      baseInput(entriesFrom(items), { checkpoints, supportsConversationRollback: true })
    );
    const userRow2 = with_.find((row) => row.kind === "message" && row.message.role === "user");
    assert.ok(userRow2 && userRow2.kind === "message");
    assert.equal(userRow2.revertTurnCount, 1);
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
