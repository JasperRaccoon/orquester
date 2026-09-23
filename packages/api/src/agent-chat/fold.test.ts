/**
 * The shared thread fold (§5.1, §5.5). Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/projector.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
  AGENT_ACTIVITY_RETENTION_LIMIT,
  MESSAGE_RETENTION_LIMIT,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  toThreadSnapshot
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import type { DomainEvent } from "./domain-events.ts";
import type { ThreadActivityItem, ThreadMessageItem } from "./thread.ts";
import { deriveLatestTurn } from "./turn-state.ts";
import { activity, agentTask, created, ev, resetActivityIds, resetSeq, session } from "./test-helpers.ts";

function fold(events: DomainEvent[]): ThreadFoldState {
  return foldThread(events);
}

function messages(state: ThreadFoldState): ThreadMessageItem[] {
  return state.items.filter((item): item is ThreadMessageItem => item.kind === "message");
}

function activities(state: ThreadFoldState): ThreadActivityItem[] {
  return state.items.filter((item): item is ThreadActivityItem => item.kind === "activity");
}

function reset(): void {
  resetSeq();
  resetActivityIds();
}

// --- head ------------------------------------------------------------------

test("an empty fold has no head and is snapshot-refusing", () => {
  const state = createEmptyThreadState();
  assert.equal(state.head, null);
  assert.throws(() => toThreadSnapshot(state), /thread\.created/);
});

test("thread.created builds the head; meta and mode updates patch it", () => {
  reset();
  const state = fold([
    created({ title: "First" }),
    ev("thread.meta-updated", { title: "Renamed", modelSelection: { model: "opus" } }),
    ev("thread.runtime-mode-set", { runtimeMode: "auto" })
  ]);
  const head = state.head!;
  assert.equal(head.id, "thread-1");
  assert.equal(head.title, "Renamed");
  assert.equal(head.modelSelection.model, "opus");
  assert.equal(head.runtimeMode, "auto");
  assert.equal(head.session.status, "idle");
  assert.equal(head.seq, state.seq);
});

test("an event with seq <= the state's is dropped (overlapping replay windows)", () => {
  reset();
  const first = applyDomainEvent(createEmptyThreadState(), created());
  const replay = applyDomainEvent(first, created({ title: "again" }));
  assert.notEqual(replay, first, "a higher seq applies");

  const stale = applyDomainEvent(replay, ev("thread.meta-updated", { title: "old" }, { seq: 1 }));
  assert.equal(stale, replay, "a replayed seq returns the same reference");
});

test("an event for another thread is not this fold's", () => {
  reset();
  const state = applyDomainEvent(createEmptyThreadState(), created());
  const other = applyDomainEvent(
    state,
    ev("thread.meta-updated", { title: "hijack" }, { threadId: "thread-2" })
  );
  assert.equal(other, state);
});

test("thread.deleted marks the fold deleted", () => {
  reset();
  const state = fold([created(), ev("thread.deleted", { deletedAt: "2026-01-01T00:00:00.000Z" })]);
  assert.equal(state.deleted, true);
});

// --- the streaming merge ---------------------------------------------------

test("streaming deltas append; a non-empty completion replaces; an empty one keeps", () => {
  reset();
  const base = created();
  const state = fold([
    base,
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "Hel",
      streaming: true,
      turnId: null
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "lo",
      streaming: true,
      turnId: null
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "",
      streaming: false,
      turnId: null
    })
  ]);
  const message = messages(state)[0]!;
  assert.equal(message.text, "Hello");
  assert.equal(message.streaming, false);

  const replaced = applyDomainEvent(
    state,
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "Final answer",
      streaming: false,
      turnId: null
    })
  );
  assert.equal(messages(replaced)[0]?.text, "Final answer");
});

test("a streaming delta touches only its own row object (structural sharing)", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.message-sent", {
      messageId: "user:1",
      role: "user",
      text: "hi",
      streaming: false,
      turnId: null
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "a",
      streaming: true,
      turnId: null
    })
  ]);
  const before = state.items;
  const pendingBefore = state.pending;
  const rosterBefore = state.roster;
  const turnsBefore = state.turns;
  state = applyDomainEvent(
    state,
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "b",
      streaming: true,
      turnId: null
    })
  );
  assert.equal(state.items[0], before[0], "the untouched user message keeps its identity");
  assert.notEqual(state.items[1], before[1], "the streamed row is a new object");
  // Sub-models a message delta cannot touch must keep their references, or the
  // UI's memoised row layers rebuild the whole timeline per token (§7.2).
  assert.equal(state.pending, pendingBefore, "pending keeps its identity across a delta");
  assert.equal(state.roster, rosterBefore, "roster keeps its identity across a delta");
  assert.equal(state.turns, turnsBefore, "turns keep their identity across a delta");
});

test("reasoning is a sibling message with its own role and id namespace", () => {
  reset();
  const state = fold([
    created(),
    ev("thread.message-sent", {
      messageId: "reasoning:1:summary",
      role: "reasoning",
      text: "thinking",
      streaming: true,
      turnId: "turn-1"
    }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "answer",
      streaming: false,
      turnId: "turn-1"
    })
  ]);
  assert.deepEqual(messages(state).map((message) => message.role), ["reasoning", "assistant"]);
});

// --- turns -----------------------------------------------------------------

test("a /turn opens a pending row that adopts the provider's turn id", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:1",
      interactionMode: "default"
    })
  ]);
  assert.deepEqual(state.turns.map((turn) => [turn.turnId, turn.state]), [[null, "pending"]]);

  state = applyDomainEvent(state, ev("thread.session-set", { session: session("running", "T-7") }));
  assert.deepEqual(state.turns.map((turn) => [turn.turnId, turn.state]), [["T-7", "running"]]);
  assert.ok(state.turns[0]?.startedAt);
});

test("the turn settles from session status, not from a checkpoint", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-7") }),
    ev("thread.session-set", { session: session("ready", null) })
  ]);
  assert.equal(state.turns[0]?.state, "completed");
  const settledAt = state.turns[0]?.completedAt;

  // A late diff arrives after the turn already settled.
  state = applyDomainEvent(
    state,
    ev("thread.turn-diff-completed", {
      turnCount: 1,
      turnId: "T-7",
      ref: "refs/orquester/checkpoints/x/turn/1",
      status: "ready",
      files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      assistantMessageId: "assistant:1",
      completedAt: "2026-02-01T00:00:00.000Z"
    })
  );
  assert.equal(state.turns[0]?.state, "completed");
  assert.equal(state.turns[0]?.completedAt, settledAt, "a late diff never extends the duration");
  assert.equal(state.turns[0]?.turnCount, 1);
  assert.equal(state.head?.turnCount, 1);
});

test("an interrupt settles the turn interrupted and keeps its completedAt", () => {
  reset();
  const state = fold([
    created(),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-7") }),
    ev("thread.turn-interrupt-requested", { turnId: "T-7" }),
    ev("thread.session-set", { session: session("stopped", null) })
  ]);
  assert.equal(state.turns[0]?.state, "interrupted");
  assert.ok(state.turns[0]?.completedAt, "an interrupted turn still records when it ended");
  assert.deepEqual(deriveLatestTurn(state.turns)?.state, "interrupted");
});

test("an error session fails the turn", () => {
  reset();
  const state = fold([
    created(),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.session-set", { session: session("error", null, { lastError: "boom" }) })
  ]);
  assert.equal(state.turns[0]?.state, "failed");
  assert.equal(state.head?.session.lastError, "boom");
});

test("a provider-initiated turn the host never commanded is still recorded", () => {
  reset();
  const state = fold([
    created(),
    ev("thread.session-set", { session: session("running", "T-continuation") })
  ]);
  assert.deepEqual(state.turns.map((turn) => [turn.turnId, turn.state]), [
    ["T-continuation", "running"]
  ]);
});

test("the first assistant message of a turn becomes its anchor", () => {
  reset();
  const state = fold([
    created(),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.message-sent", {
      messageId: "assistant:1",
      role: "assistant",
      text: "hi",
      streaming: true,
      turnId: "T-1"
    }),
    ev("thread.message-sent", {
      messageId: "assistant:2",
      role: "assistant",
      text: "second segment",
      streaming: false,
      turnId: "T-1"
    })
  ]);
  assert.equal(state.turns[0]?.assistantMessageId, "assistant:1");
});

test("a turn records the prompt that opened it, through adoption, settlement and capture", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.message-sent", {
      messageId: "user:1",
      role: "user",
      text: "hi",
      streaming: false,
      turnId: null
    }),
    ev("thread.turn-start-requested", { turnId: null, messageId: "user:1", interactionMode: "default" })
  ]);
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, turn.state, turn.userMessageId]),
    [[null, "pending", "user:1"]]
  );

  // `adoptActiveTurn`: the pending row takes the provider's id and keeps its prompt.
  state = applyDomainEvent(state, ev("thread.session-set", { session: session("running", "T-1") }));
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, turn.state, turn.userMessageId]),
    [["T-1", "running", "user:1"]]
  );

  state = applyDomainEvent(state, ev("thread.session-set", { session: session("ready", null) }));
  state = applyDomainEvent(state, diff(1, "T-1"));
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, turn.state, turn.turnCount, turn.userMessageId]),
    [["T-1", "completed", 1, "user:1"]]
  );
});

test("a turn with no nameable prompt records none", () => {
  reset();
  const state = fold([
    created(),
    // A replayed history turn whose prompt the projection could not name.
    ev("thread.turn-start-requested", {
      turnId: "H-1",
      messageId: "",
      interactionMode: "default",
      settled: { state: "completed", completedAt: "2026-01-01T00:00:00.000Z" }
    }),
    // A turn the host never saw a command for (a compaction, a continuation):
    // the fold synthesises its row from `session-set` alone.
    ev("thread.session-set", { session: session("running", "T-continuation") })
  ]);
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, "userMessageId" in turn]),
    [
      ["H-1", false],
      ["T-continuation", false]
    ]
  );
});

// --- checkpoints -----------------------------------------------------------

function diff(
  turnCount: number,
  turnId: string | null,
  status: "ready" | "missing" | "error" = "ready"
) {
  return ev("thread.turn-diff-completed", {
    turnCount,
    turnId,
    ref: `refs/orquester/checkpoints/x/turn/${turnCount}`,
    status,
    files: [],
    assistantMessageId: null,
    completedAt: `2026-01-0${turnCount}T00:00:00.000Z`
  });
}

test("a missing placeholder never clobbers a captured ready checkpoint", () => {
  reset();
  const state = fold([created(), diff(1, "T-1", "ready"), diff(1, "T-1", "missing")]);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.checkpoints[0]?.status, "ready");
});

test("checkpoints stay sorted by turn count and the head mirrors the highest", () => {
  reset();
  const state = fold([created(), diff(2, "T-2"), diff(1, "T-1")]);
  assert.deepEqual(state.checkpoints.map((entry) => entry.checkpointTurnCount), [1, 2]);
  assert.equal(state.head?.turnCount, 2, "the head never walks backwards");
});

// --- activities, pending and roster ---------------------------------------

test("an activity with a known id is replaced in place, not appended", () => {
  reset();
  const first = activity("tool.updated", { toolUseId: "tu" }, { id: "a1", summary: "running" });
  const second = activity("tool.completed", { toolUseId: "tu" }, { id: "a1", summary: "done" });
  const state = fold([
    created(),
    ev("thread.activity-appended", { activity: first }),
    ev("thread.activity-appended", { activity: second })
  ]);
  assert.equal(activities(state).length, 1);
  assert.equal(activities(state)[0]?.summary, "done");
  assert.equal(state.activities.length, 1);
});

test("pending is re-derived from the activity fold and tombstoned by a resolution", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "r1",
        requestType: "command_execution_approval"
      })
    })
  ]);
  assert.equal(state.pending.approvals.length, 1);
  const pendingBefore = state.pending;

  // An unrelated activity leaves the pending object identical.
  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", { activity: activity("tool.started", { toolUseId: "x" }) })
  );
  assert.equal(state.pending, pendingBefore, "pending keeps its identity when nothing touched it");

  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", {
      activity: activity("approval.resolved", { requestId: "r1", decision: "accept" })
    })
  );
  assert.deepEqual(state.pending.approvals, []);
  assert.ok(state.closedRequestIds.has("r1"));
});

test("a tombstoned request stays closed after its resolution ages out of retention", () => {
  // R5 #4: `closedRequestIds` was computed on both sides and read by neither,
  // so once the closing row fell outside the 500-activity window a replayed
  // `*.requested` reopened a dead approval card and the provider rejected the
  // answer.
  reset();
  const openedRow = activity("approval.requested", {
    requestId: "R1",
    requestType: "command_execution_approval"
  });
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", { activity: openedRow }),
    ev("thread.activity-appended", {
      activity: activity("approval.resolved", { requestId: "R1", decision: "accept" })
    })
  ];
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT + 10; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  let state = fold(events);
  assert.ok(state.closedRequestIds.has("R1"));
  assert.ok(
    !state.activities.some((entry) => entry.activityKind === "approval.resolved"),
    "the closing row really has aged out"
  );

  // A REPLAY of the original request: same row, same stamp. The tombstone
  // outlived the closing row, so it still closes this.
  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", { activity: openedRow })
  );
  assert.deepEqual(state.pending.approvals, [], "a replayed request stays closed");
});

test("an aged-out user-input resolution keeps its question closed too", () => {
  reset();
  const question = {
    requestId: "Q1",
    // NOT `responseMode: "message"`: a native-callback question is not exempt
    // from retention, so its closing row can genuinely age out.
    questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
  };
  const askedRow = activity("user-input.requested", question);
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", { activity: askedRow }),
    ev("thread.activity-appended", {
      activity: activity("user-input.resolved", { requestId: "Q1", answers: {} })
    })
  ];
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT + 10; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  let state = fold(events);
  state = applyDomainEvent(state, ev("thread.activity-appended", { activity: askedRow }));
  assert.deepEqual(state.pending.userInputs, []);
});

test("a RECYCLED request id opens a fresh card even across retention (R2-1)", () => {
  // The other side of the same rule: a provider that reuses an id for a
  // genuinely new request must not have it swallowed by the old tombstone.
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "codex-T-1",
        requestType: "command_execution_approval"
      })
    }),
    ev("thread.activity-appended", {
      activity: activity("approval.resolved", { requestId: "codex-T-1", decision: "accept" })
    })
  ];
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT + 10; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  let state = fold(events);
  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "codex-T-1",
        requestKind: "file-change",
        requestType: "file_change_approval",
        detail: "/w/p/r2-card.txt"
      })
    })
  );
  assert.deepEqual(
    state.pending.approvals.map((entry) => [entry.requestId, entry.requestKind]),
    [["codex-T-1", "file-change"]],
    "a new request stamped after the tombstone must render"
  );
});

test("retention that drops a request row re-derives pending on that very event", () => {
  // R5 #18: `rederivePending`/`rederiveRoster` were decided from the INCOMING
  // row's kind only, so an unrelated append that pushed an open approval out
  // of the window left `pending` referencing a row no longer in the fold.
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "R1",
        requestType: "command_execution_approval"
      })
    })
  ];
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT - 1; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  let state = fold(events);
  assert.equal(state.pending.approvals.length, 1, "still inside the window");

  // One more unrelated row pushes the approval out.
  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", {
      activity: activity("tool.started", { toolUseId: "last" }, { id: "last" })
    })
  );
  assert.ok(
    !state.activities.some((entry) => entry.activityKind === "approval.requested"),
    "the approval row was dropped by retention"
  );
  assert.deepEqual(
    state.pending.approvals,
    [],
    "pending must not keep referencing a row the fold no longer holds"
  );
});

test("the roster re-derives on task rows and interrupts live rows when the session dies", () => {
  reset();
  let state = fold([
    created(),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("t1", { title: "Reviewer" }))
    })
  ]);
  assert.equal(state.roster[0]?.status, "running");

  state = applyDomainEvent(state, ev("thread.session-set", { session: session("stopped", null) }));
  assert.equal(state.roster[0]?.status, "interrupted", "a dead session orphans live agents");
});

// --- retention -------------------------------------------------------------

test("activities are retained at the window, keeping an unresolved async question", () => {
  reset();
  const events: DomainEvent[] = [created()];
  events.push(
    ev("thread.activity-appended", {
      activity: activity(
        "user-input.requested",
        {
          requestId: "q1",
          responseMode: "message",
          questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
        },
        { id: "question" }
      )
    })
  );
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT + 50; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  const state = fold(events);
  assert.equal(state.activities.length, ACTIVITY_RETENTION_LIMIT + 1);
  assert.ok(
    state.activities.some((entry) => entry.id === "question"),
    "a still-open async question is never scrolled out"
  );
  assert.equal(state.pending.userInputs.length, 1);
});

test("a compaction marker never ages out of the window", () => {
  reset();
  // A busy thread writes 500 tool rows in minutes; the marker is where the
  // provider's memory begins, and "rewind to here" withholds everything before
  // it (§5.5) — evicted, every pre-compaction message was offered for a rewind
  // the adapter could only refuse.
  const events: DomainEvent[] = [created()];
  events.push(
    ev("thread.activity-appended", {
      activity: activity(
        "context-compaction",
        { state: "compacted", beforeTokens: 100, afterTokens: 10 },
        { id: "marker", turnId: "T-1" }
      )
    })
  );
  for (let i = 0; i < ACTIVITY_RETENTION_LIMIT + 50; i += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity("tool.started", { toolUseId: `t${i}` }, { id: `noise-${i}` })
      })
    );
  }
  const state = fold(events);
  assert.equal(state.activities.length, ACTIVITY_RETENTION_LIMIT + 1);
  assert.equal(state.activities[0]?.id, "marker", "the marker is kept, ahead of the window");
});

test("messages are retained at their own window, independently of activities", () => {
  reset();
  const events: DomainEvent[] = [created()];
  for (let i = 0; i < MESSAGE_RETENTION_LIMIT + 10; i += 1) {
    events.push(
      ev("thread.message-sent", {
        messageId: `m${i}`,
        role: "user",
        text: `m${i}`,
        streaming: false,
        turnId: null
      })
    );
  }
  const state = fold(events);
  assert.equal(messages(state).length, MESSAGE_RETENTION_LIMIT);
  assert.equal(messages(state)[0]?.id, "m10", "the oldest messages are the ones dropped");
  assert.equal(state.itemIndex.get("m10"), 0, "the index is rebuilt after a prune");
});

// --- revert (§5.5) ---------------------------------------------------------

interface LiveTurnOptions {
  /** The count this turn's checkpoint is captured at; `null` captures none. Default: `n`. */
  checkpoint?: number | null;
  /** Whether `turn-start-requested` names the prompt. Default: true. */
  linkPrompt?: boolean;
  /** A second user message sent while the turn runs (§4.1 steering). */
  steer?: boolean;
}

/**
 * One live turn as the host writes it: the prompt is persisted with
 * `turnId: null` (the provider has not minted an id yet), the turn row adopts
 * the provider's id from `session-set`, and a checkpoint lands after the
 * settle.
 */
function liveTurn(n: number, options: LiveTurnOptions = {}): DomainEvent[] {
  const turnId = `T-${n}`;
  const checkpoint = options.checkpoint === undefined ? n : options.checkpoint;
  const events: DomainEvent[] = [
    ev("thread.message-sent", {
      messageId: `user:${n}`,
      role: "user",
      text: `ask ${n}`,
      streaming: false,
      turnId: null
    }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: options.linkPrompt === false ? "" : `user:${n}`,
      interactionMode: "default"
    }),
    ev("thread.session-set", { session: session("running", turnId) }),
    ev("thread.message-sent", {
      messageId: `assistant:${n}`,
      role: "assistant",
      text: `answer ${n}`,
      streaming: false,
      turnId
    })
  ];
  if (options.steer === true) {
    // Sent while the turn runs: it rides the ACTIVE turn's id and opens no
    // turn of its own, so no `turn-start-requested` names it.
    events.push(
      ev("thread.message-sent", {
        messageId: `steer:${n}`,
        role: "user",
        text: `and also ${n}`,
        streaming: false,
        turnId
      })
    );
  }
  events.push(
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: `tu-${n}` }, {
        id: `act-${n}`,
        turnId
      })
    }),
    ev("thread.session-set", { session: session("ready", null) })
  );
  if (checkpoint !== null) {
    events.push(
      ev("thread.turn-diff-completed", {
        turnCount: checkpoint,
        turnId,
        ref: `refs/orquester/checkpoints/x/turn/${checkpoint}`,
        status: "ready",
        files: [],
        assistantMessageId: `assistant:${n}`,
        completedAt: `2026-01-0${n}T00:00:00.000Z`
      })
    );
  }
  return events;
}

function threadWithTurns(
  count: number,
  {
    checkpoint,
    ...turnOptions
  }: Omit<LiveTurnOptions, "checkpoint"> & {
    /** The checkpoint count of turn `n`, or `null` for a turn with no capture. */
    checkpoint?: (n: number) => number | null;
  } = {}
): DomainEvent[] {
  const events: DomainEvent[] = [created()];
  for (let n = 1; n <= count; n += 1) {
    events.push(
      ...liveTurn(n, {
        ...turnOptions,
        ...(checkpoint !== undefined ? { checkpoint: checkpoint(n) } : {})
      })
    );
  }
  return events;
}

function threadWithThreeTurns(): DomainEvent[] {
  return threadWithTurns(3);
}

function userMessageIds(state: ThreadFoldState): string[] {
  return messages(state)
    .filter((message) => message.role === "user")
    .map((message) => message.id);
}

test("a revert truncates by retained turn id and recomputes the latest turn", () => {
  reset();
  const state = fold([...threadWithThreeTurns(), ev("thread.reverted", { turnCount: 2 })]);
  assert.deepEqual(state.checkpoints.map((entry) => entry.checkpointTurnCount), [1, 2]);
  assert.deepEqual(messages(state).map((message) => message.id), [
    "user:1",
    "assistant:1",
    "user:2",
    "assistant:2"
  ]);
  assert.deepEqual(activities(state).map((entry) => entry.id), ["act-1", "act-2"]);
  assert.equal(state.head?.turnCount, 2);
  assert.deepEqual(deriveLatestTurn(state.turns), {
    turnId: "T-2",
    state: "completed",
    startedAt: state.turns[state.turns.length - 1]?.startedAt ?? null,
    completedAt: state.turns[state.turns.length - 1]?.completedAt ?? null
  });
});

test("turn-less rows survive a revert", () => {
  reset();
  const state = fold([
    ...threadWithThreeTurns(),
    ev("thread.activity-appended", {
      activity: activity("runtime.warning", { message: "ambient" }, { id: "no-turn" })
    }),
    ev("thread.reverted", { turnCount: 1 })
  ]);
  assert.ok(
    activities(state).some((entry) => entry.id === "no-turn"),
    "an activity with turnId null is never truncated"
  );
  // The prompts carry turnId null by construction; each follows the turn that
  // names it as its `userMessageId`, and the assistant messages follow their
  // turn id — so only turn 1's survive on either side.
  assert.deepEqual(userMessageIds(state), ["user:1"]);
  assert.deepEqual(
    messages(state)
      .filter((message) => message.role === "assistant")
      .map((message) => message.id),
    ["assistant:1"]
  );
});

test("the fallback pass is bounded at `target` per role", () => {
  reset();
  // Three turns whose USER prompts were all persisted before the provider
  // minted a turn id, and which NO turn row names: the first pass sees none of
  // them, so the fallback is what brings the surviving turns' prompts back —
  // and only as many as the revert target. (Set-up changed with the turn-order
  // rewind: a turn now claims its prompt through `userMessageId`, which would
  // restore these without the fallback, so the prompts here are unlinked — a
  // replayed history turn whose prompt came back `""` looks exactly like this.
  // The expectation is unchanged.)
  const state = fold([
    ...threadWithTurns(3, { linkPrompt: false }),
    ev("thread.reverted", { turnCount: 2 })
  ]);
  assert.deepEqual(userMessageIds(state), ["user:1", "user:2"]);
});

test("a message whose turn was truncated is never restored by the fallback", () => {
  reset();
  // Every message carries a turn id, but NO checkpoint does (and no turn row
  // exists, so this is the legacy checkpoint path), so nothing is in the
  // retained set and the fallback has nothing it is allowed to restore.
  const events: DomainEvent[] = [created()];
  for (let n = 1; n <= 3; n += 1) {
    events.push(
      ev("thread.message-sent", {
        messageId: `user:${n}`,
        role: "user",
        text: `ask ${n}`,
        streaming: false,
        turnId: `T-${n}`
      }),
      ev("thread.turn-diff-completed", {
        turnCount: n,
        turnId: null,
        ref: `refs/orquester/checkpoints/x/turn/${n}`,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: `2026-01-0${n}T00:00:00.000Z`
      })
    );
  }
  events.push(ev("thread.reverted", { turnCount: 2 }));
  assert.deepEqual(messages(fold(events)), []);
});

test("a revert re-derives pending and roster from the surviving activities", () => {
  reset();
  const state = fold([
    ...threadWithThreeTurns(),
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("late-agent"), { id: "task", turnId: "T-3" })
    }),
    ev("thread.reverted", { turnCount: 1 })
  ]);
  assert.deepEqual(state.roster, [], "a roster row owned by a truncated turn is gone");
});

// A revert's `turnCount` is the number of STARTED turns kept (`turns.ts`),
// never a checkpoint count: the checkpoint list is empty, sparse or densely
// renumbered exactly where a rewind matters.

test("a revert on a thread with no checkpoints keeps exactly the first `target` turns", () => {
  reset();
  // A non-git project captures nothing (§5.4).
  const state = fold([
    ...threadWithTurns(4, { checkpoint: () => null }),
    ev("thread.reverted", { turnCount: 2 })
  ]);
  assert.deepEqual(state.checkpoints, []);
  assert.deepEqual(messages(state).map((message) => message.id), [
    "user:1",
    "assistant:1",
    "user:2",
    "assistant:2"
  ]);
  assert.deepEqual(activities(state).map((entry) => entry.id), ["act-1", "act-2"]);
  assert.deepEqual(state.turns.map((turn) => turn.turnId), ["T-1", "T-2"]);
  assert.equal(state.head?.turnCount, 2);
  assert.equal(deriveLatestTurn(state.turns)?.turnId, "T-2");
});

test("densely numbered checkpoints go with their turns, not with their counts", () => {
  reset();
  // An older host numbered the checkpoint list densely: counts 1 and 2 belong
  // to the 3rd and 4th turns. Keeping two turns keeps turns 1–2 and drops
  // 3–4 together with both of their checkpoints.
  const state = fold([
    ...threadWithTurns(4, { checkpoint: (n) => (n >= 3 ? n - 2 : null) }),
    ev("thread.reverted", { turnCount: 2 })
  ]);
  assert.deepEqual(state.checkpoints, []);
  assert.deepEqual(messages(state).map((message) => message.id), [
    "user:1",
    "assistant:1",
    "user:2",
    "assistant:2"
  ]);
  assert.deepEqual(activities(state).map((entry) => entry.id), ["act-1", "act-2"]);
  assert.deepEqual(state.turns.map((turn) => turn.turnId), ["T-1", "T-2"]);
  assert.equal(state.head?.turnCount, 2);
});

test("a sparse checkpoint list never reorders the retained turns", () => {
  reset();
  // Only turn 2 was captured. Its checkpoint survives with its turn, but it is
  // not the latest turn: turn 3 is, and the rows stay in start order with
  // their own fields — a revert must not move turn 2's row to the end, or
  // every later ordinal is off by one.
  const state = fold([
    ...threadWithTurns(4, { checkpoint: (n) => (n === 2 ? 1 : null) }),
    ev("thread.reverted", { turnCount: 3 })
  ]);
  assert.deepEqual(
    state.turns.map((turn) => [turn.turnId, turn.userMessageId, turn.state]),
    [
      ["T-1", "user:1", "completed"],
      ["T-2", "user:2", "completed"],
      ["T-3", "user:3", "completed"]
    ]
  );
  assert.deepEqual(state.checkpoints.map((entry) => entry.turnId), ["T-2"]);
  assert.equal(deriveLatestTurn(state.turns)?.turnId, "T-3");
  assert.deepEqual(userMessageIds(state), ["user:1", "user:2", "user:3"]);
});

test("a revert to zero turns keeps only the thread's turn-less rows", () => {
  reset();
  const state = fold([
    ...threadWithThreeTurns(),
    ev("thread.activity-appended", {
      activity: activity("runtime.warning", { message: "ambient" }, { id: "no-turn" })
    }),
    ev("thread.reverted", { turnCount: 0 })
  ]);
  assert.deepEqual(messages(state), []);
  assert.deepEqual(activities(state).map((entry) => entry.id), ["no-turn"]);
  assert.deepEqual(state.turns, []);
  assert.deepEqual(state.checkpoints, []);
  assert.equal(state.head?.turnCount, 0);
});

test("a steer follows the turn it was steered into", () => {
  reset();
  const events = [
    created(),
    ...liveTurn(1),
    ...liveTurn(2, { steer: true }),
    ...liveTurn(3)
  ];
  const kept = fold([...events, ev("thread.reverted", { turnCount: 2 })]);
  assert.deepEqual(userMessageIds(kept), ["user:1", "user:2", "steer:2"]);

  const dropped = fold([...events, ev("thread.reverted", { turnCount: 1 })]);
  assert.deepEqual(userMessageIds(dropped), ["user:1"]);
});

test("a retained turn whose prompt no turn row names still keeps it (a /compact turn)", () => {
  reset();
  // `/compact` is persisted with no `turn-start-requested`; the compaction
  // reaches the fold only as the session's turn id, so the fold synthesises
  // that turn's row with no prompt to name. The bounded fallback restores it.
  const state = fold([
    created(),
    ...liveTurn(1),
    ev("thread.message-sent", {
      messageId: "user:compact",
      role: "user",
      text: "/compact",
      streaming: false,
      turnId: null
    }),
    ev("thread.session-set", { session: session("running", "T-compact") }),
    ev("thread.session-set", { session: session("ready", null) }),
    ...liveTurn(3),
    ev("thread.reverted", { turnCount: 2 })
  ]);
  assert.deepEqual(state.turns.map((turn) => turn.turnId), ["T-1", "T-compact"]);
  assert.deepEqual(userMessageIds(state), ["user:1", "user:compact"]);
  assert.deepEqual(state.checkpoints.map((entry) => entry.turnId), ["T-1"]);
});

test("a prompt a dropped turn claims is never resurrected by the fallback", () => {
  reset();
  // A replayed history turn whose prompt could not be named (`""`) and which
  // has no user message at all, then one live turn. Keeping the history turn
  // leaves the fallback one user message short — and the only turn-less
  // prompt left belongs to the turn the revert drops.
  const state = fold([
    created(),
    ev("thread.message-sent", {
      messageId: "history:assistant",
      role: "assistant",
      text: "an old answer",
      streaming: false,
      turnId: "H-1"
    }),
    ev("thread.turn-start-requested", {
      turnId: "H-1",
      messageId: "",
      interactionMode: "default",
      settled: {
        state: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
        assistantMessageId: "history:assistant"
      }
    }),
    ...liveTurn(2, { checkpoint: null }),
    ev("thread.reverted", { turnCount: 1 })
  ]);
  assert.deepEqual(messages(state).map((message) => message.id), ["history:assistant"]);
  assert.deepEqual(state.turns.map((turn) => turn.turnId), ["H-1"]);
});

test("the legacy fallback: with no started turn, a revert still truncates by checkpoint count", () => {
  reset();
  // A log written before turns were recorded: checkpoints, but an empty
  // `turns[]`. The checkpoints at or below the target name the retained turns.
  const events: DomainEvent[] = [created()];
  for (let n = 1; n <= 3; n += 1) {
    events.push(
      ev("thread.message-sent", {
        messageId: `user:${n}`,
        role: "user",
        text: `ask ${n}`,
        streaming: false,
        turnId: null
      }),
      ev("thread.message-sent", {
        messageId: `assistant:${n}`,
        role: "assistant",
        text: `answer ${n}`,
        streaming: false,
        turnId: `T-${n}`
      }),
      diff(n, `T-${n}`)
    );
  }
  const before = fold(events);
  assert.deepEqual(before.turns, [], "no turn was ever recorded");

  const state = fold([...events, ev("thread.reverted", { turnCount: 2 })]);
  assert.deepEqual(state.checkpoints.map((entry) => entry.checkpointTurnCount), [1, 2]);
  assert.deepEqual(messages(state).map((message) => message.id), [
    "user:1",
    "assistant:1",
    "user:2",
    "assistant:2"
  ]);
  // The latest turn is synthesised from the last surviving checkpoint.
  assert.deepEqual(state.turns.map((turn) => [turn.turnId, turn.state]), [["T-2", "completed"]]);
  assert.equal(state.head?.turnCount, 2);
});

// --- snapshot --------------------------------------------------------------

test("toThreadSnapshot projects the §6.3 read shape", () => {
  reset();
  const state = fold(threadWithThreeTurns());
  const snapshot = toThreadSnapshot(state);
  assert.equal(snapshot.head.id, "thread-1");
  assert.equal(snapshot.seq, state.seq);
  assert.equal(snapshot.items, state.items);
  assert.equal(snapshot.checkpoints.length, 3);
  assert.deepEqual(snapshot.pending, { approvals: [], userInputs: [] });
});

test("toThreadSnapshot carries each turn's prompt through, before and after a revert", () => {
  reset();
  const events = threadWithThreeTurns();
  assert.deepEqual(
    toThreadSnapshot(fold(events)).turns.map((turn) => turn.userMessageId),
    ["user:1", "user:2", "user:3"]
  );
  const reverted = fold([...events, ev("thread.reverted", { turnCount: 2 })]);
  assert.deepEqual(
    toThreadSnapshot(reverted).turns.map((turn) => turn.userMessageId),
    ["user:1", "user:2"]
  );
});

test("foldThread equals a left reduce of applyDomainEvent", () => {
  reset();
  const events = threadWithThreeTurns();
  let manual = createEmptyThreadState();
  for (const event of events) {
    manual = applyDomainEvent(manual, event);
  }
  assert.deepEqual(toThreadSnapshot(foldThread(events)), toThreadSnapshot(manual));
});

test("fold — the resume cursor outlives a session block that omits it (kept across a settle, replaced only explicitly)", () => {
    const base = {
      threadId: "t",
      seq: 0,
      occurredAt: "2026-09-22T05:00:00.000Z"
    };
    const created: DomainEvent = {
      ...base,
      seq: 1,
      type: "thread.created",
      payload: {
        head: {
          id: "t",
          projectPath: "/p",
          cwd: "/p",
          title: "t",
          adapter: "claude",
          refId: "claude",
          accountId: "",
          home: "system",
          modelSelection: { model: "default" },
          runtimeMode: "full-access",
          session: { status: "idle", activeTurnId: null },
          turnCount: 0,
          seq: 1,
          createdAt: base.occurredAt,
          updatedAt: base.occurredAt
        }
      }
    } as unknown as DomainEvent;
    const withCursor: DomainEvent = {
      ...base,
      seq: 2,
      type: "thread.session-set",
      payload: {
        session: {
          status: "starting",
          activeTurnId: null,
          providerThreadId: "e5914086",
          resumeCursor: { resume: "e5914086", turnCount: 0 }
        }
      }
    } as unknown as DomainEvent;
    const settled: DomainEvent = {
      ...base,
      seq: 3,
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } }
    } as unknown as DomainEvent;
    const replaced: DomainEvent = {
      ...base,
      seq: 4,
      type: "thread.session-set",
      payload: {
        session: {
          status: "starting",
          activeTurnId: null,
          providerThreadId: "new",
          resumeCursor: { resume: "new", turnCount: 1 }
        }
      }
    } as unknown as DomainEvent;
    let state = foldThread([created, withCursor, settled]);
    assert.deepEqual(state.head?.session.resumeCursor, { resume: "e5914086", turnCount: 0 });
    assert.equal(state.head?.session.providerThreadId, "e5914086");
    assert.equal(state.head?.session.status, "ready");
    state = foldThread([created, withCursor, settled, replaced]);
    assert.deepEqual(state.head?.session.resumeCursor, { resume: "new", turnCount: 1 });
    assert.equal(state.head?.session.providerThreadId, "new");
});

test("retention: an agent's rows have their own window and its anchors never age out", () => {
  reset();
  const events: DomainEvent[] = [created()];
  const anchor = activity("task.started", agentTask("ag1", { toolUseId: "toolu_1" }));
  events.push(ev("thread.activity-appended", { activity: anchor }));
  for (let index = 0; index < 300; index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: { ...activity("tool.completed", { toolUseId: `t${index}` }), agentId: "ag1" }
      })
    );
  }
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + 20; index += 1) {
    events.push(ev("thread.activity-appended", { activity: activity("tool.completed", { toolUseId: `p${index}` }) }));
  }
  const state = fold(events);
  const parentRows = state.activities.filter((row) => row.agentId === undefined);
  const ownedRows = state.activities.filter((row) => row.agentId === "ag1");
  assert.equal(ownedRows.length, AGENT_ACTIVITY_RETENTION_LIMIT, "the agent keeps its newest rows only");
  assert.equal(ownedRows[0]?.payload && (ownedRows[0].payload as { toolUseId: string }).toolUseId, "t100");
  assert.equal(
    parentRows.length,
    ACTIVITY_RETENTION_LIMIT + 1,
    "the parent window is not consumed by the agent's rows, and the launch row survives"
  );
  assert.ok(parentRows.some((row) => row.id === anchor.id), "the agent's launch row is never evicted");
  assert.equal((parentRows[1]?.payload as { toolUseId: string }).toolUseId, "p20");
});
