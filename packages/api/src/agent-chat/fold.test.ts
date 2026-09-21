/**
 * The shared thread fold (§5.1, §5.5). Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/projector.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_RETENTION_LIMIT,
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
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "R1",
        requestType: "command_execution_approval"
      })
    }),
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

  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", {
      activity: activity("approval.requested", {
        requestId: "R1",
        requestType: "command_execution_approval"
      })
    })
  );
  assert.deepEqual(state.pending.approvals, [], "a tombstoned request can never reopen");
});

test("an aged-out user-input resolution keeps its question closed too", () => {
  reset();
  const question = {
    requestId: "Q1",
    // NOT `responseMode: "message"`: a native-callback question is not exempt
    // from retention, so its closing row can genuinely age out.
    questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
  };
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", { activity: activity("user-input.requested", question) }),
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
  state = applyDomainEvent(
    state,
    ev("thread.activity-appended", { activity: activity("user-input.requested", question) })
  );
  assert.deepEqual(state.pending.userInputs, []);
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

function threadWithThreeTurns(): DomainEvent[] {
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
      ev("thread.turn-start-requested", {
        turnId: null,
        messageId: `user:${n}`,
        interactionMode: "default"
      }),
      ev("thread.session-set", { session: session("running", `T-${n}`) }),
      ev("thread.message-sent", {
        messageId: `assistant:${n}`,
        role: "assistant",
        text: `answer ${n}`,
        streaming: false,
        turnId: `T-${n}`
      }),
      ev("thread.activity-appended", {
        activity: activity("tool.completed", { toolUseId: `tu-${n}` }, {
          id: `act-${n}`,
          turnId: `T-${n}`
        })
      }),
      ev("thread.session-set", { session: session("ready", null) }),
      ev("thread.turn-diff-completed", {
        turnCount: n,
        turnId: `T-${n}`,
        ref: `refs/orquester/checkpoints/x/turn/${n}`,
        status: "ready",
        files: [],
        assistantMessageId: `assistant:${n}`,
        completedAt: `2026-01-0${n}T00:00:00.000Z`
      })
    );
  }
  return events;
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
  // The user messages carry turnId null by construction, so all three survive
  // the turn-id pass — the fallback is what bounds the assistant side.
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
  // minted a turn id (the normal case): the turn-id pass sees none of them, so
  // the fallback is what brings the surviving turns' prompts back — and only
  // as many as the revert target.
  const state = fold([...threadWithThreeTurns(), ev("thread.reverted", { turnCount: 2 })]);
  assert.deepEqual(
    messages(state)
      .filter((message) => message.role === "user")
      .map((message) => message.id),
    ["user:1", "user:2"]
  );
});

test("a message whose turn was truncated is never restored by the fallback", () => {
  reset();
  // Every message carries a turn id, but NO checkpoint does, so nothing is in
  // the retained set and the fallback has nothing it is allowed to restore.
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

test("foldThread equals a left reduce of applyDomainEvent", () => {
  reset();
  const events = threadWithThreeTurns();
  let manual = createEmptyThreadState();
  for (const event of events) {
    manual = applyDomainEvent(manual, event);
  }
  assert.deepEqual(toThreadSnapshot(foldThread(events)), toThreadSnapshot(manual));
});
