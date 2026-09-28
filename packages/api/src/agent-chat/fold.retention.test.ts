/** Retention boundaries and exceptions from the fold-performance and long-call contracts. */

import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "./domain-events.ts";
import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  AGENT_ACTIVITY_RETENTION_LIMIT,
  AGENT_ACTIVITY_RETENTION_SLACK,
  AGENT_ACTIVITY_TOTAL_LIMIT,
  AGENT_ACTIVITY_TOTAL_SLACK,
  MESSAGE_RETENTION_LIMIT,
  MESSAGE_RETENTION_SLACK,
  OPEN_WORK_RETENTION_LIMIT,
  OPEN_WORK_TOTAL_RETENTION_LIMIT,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  itemsDroppedByRetention
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import { deserializeFoldState, serializeFoldState } from "./fold-snapshot.ts";
import type { ThreadActivityItem, ThreadItem } from "./thread.ts";
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

type ActivityAppended = Extract<DomainEvent, { type: "thread.activity-appended" }>;

function parentRow(index: number): ActivityAppended {
  return ev("thread.activity-appended", {
    activity: activity("tool.completed", { toolUseId: `p${index}` }, { id: `p-${index}` })
  });
}

function agentRow(agentId: string, index: number, createdAt?: string): DomainEvent {
  return ev("thread.activity-appended", {
    activity: activity("tool.completed", { toolUseId: `${agentId}-${index}` }, {
      id: `${agentId}-row-${index}`,
      agentId,
      ...(createdAt !== undefined ? { createdAt } : {})
    })
  });
}

function message(index: number): DomainEvent {
  return ev("thread.message-sent", {
    messageId: `m-${index}`,
    role: "assistant",
    text: `m${index}`,
    streaming: false,
    turnId: null
  });
}

/** Folds `events`, returning the state after each one. */
function statesOf(events: readonly DomainEvent[]): ThreadFoldState[] {
  const states: ThreadFoldState[] = [];
  let state = createEmptyThreadState();
  for (const event of events) {
    state = applyDomainEvent(state, event);
    states.push(state);
  }
  return states;
}

test("the parent window grows to its limit plus slack, then one trim cuts it to the limit", () => {
  reset();
  const events: DomainEvent[] = [created()];
  for (let index = 0; index <= ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(parentRow(index));
  }
  const states = statesOf(events);
  const beforeTrim = states.at(-2)!;
  assert.equal(beforeTrim.activities.length, ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK);
  assert.ok(
    states.slice(0, -1).every((state) => itemsDroppedByRetention(state).length === 0),
    "no step before the trigger drops anything"
  );
  assert.equal(beforeTrim.evicted, undefined, "nothing was ever evicted yet");

  const trimmed = states.at(-1)!;
  assert.equal(trimmed.activities.length, ACTIVITY_RETENTION_LIMIT);
  assert.deepEqual(
    itemsDroppedByRetention(trimmed).map((item) => item.id),
    Array.from({ length: ACTIVITY_RETENTION_SLACK + 1 }, (_, index) => `p-${index}`),
    "the oldest rows, in list order"
  );
  assert.equal(trimmed.activities[0]?.id, `p-${ACTIVITY_RETENTION_SLACK + 1}`);
  assert.deepEqual(trimmed.evicted, { activities: true, messages: false });
});

test("an agent's own window trims past 200 + 50 of its rows, keeping its anchors", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("ag"), { id: "anchor-start" })
    }),
    // An anchor the agent owns itself (a nested agent's launch row) is exempt
    // in the agent's window too.
    ev("thread.activity-appended", {
      activity: activity("task.started", agentTask("nested"), { id: "anchor-nested", agentId: "ag" })
    })
  ];
  // Past the gate first, with parent rows that stay under their own trigger.
  for (let index = 0; index < 300; index += 1) events.push(parentRow(index));
  for (let index = 0; index <= AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(agentRow("ag", index));
  }
  const states = statesOf(events);
  const owned = (state: ThreadFoldState): ThreadActivityItem[] =>
    state.activities.filter((row) => row.agentId === "ag");
  assert.equal(owned(states.at(-2)!).length, AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK + 1);
  const trimmed = states.at(-1)!;
  assert.equal(
    owned(trimmed).length,
    AGENT_ACTIVITY_RETENTION_LIMIT + 1,
    "cut to its last 200 rows, plus its own anchor"
  );
  assert.equal(owned(trimmed)[0]?.id, "anchor-nested");
  assert.equal(owned(trimmed)[1]?.id, `ag-row-${AGENT_ACTIVITY_RETENTION_SLACK + 1}`);
  assert.ok(trimmed.activities.some((row) => row.id === "anchor-start"));
  assert.equal(
    trimmed.activities.filter((row) => row.agentId === undefined).length,
    301,
    "the parent rows are untouched: their class never passed its trigger"
  );
});

test("the gate: 400 activities of one agent fold losslessly — a history page never trims", () => {
  reset();
  // A history page folds up to 400 activities (`HISTORY_PAGE_ACTIVITIES`) and
  // must be lossless. One agent's 400 rows are far past that agent's own
  // trigger, but nothing may trim while the list holds at most 500 rows.
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", { activity: activity("task.started", agentTask("solo"), { id: "anchor" }) })
  ];
  for (let index = 0; index < 400; index += 1) events.push(agentRow("solo", index));
  for (let index = 0; index < 99; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  assert.ok(states.every((state) => itemsDroppedByRetention(state).length === 0));
  const last = states.at(-1)!;
  assert.equal(last.activities.length, ACTIVITY_RETENTION_LIMIT, "400 + 99 + the anchor, all kept");
  assert.equal(last.evicted, undefined);

  // One row more opens the gate, and the agent's window trims at once.
  const opened = applyDomainEvent(last, parentRow(99));
  assert.equal(
    opened.activities.filter((row) => row.agentId === "solo").length,
    AGENT_ACTIVITY_RETENTION_LIMIT
  );
  assert.equal(itemsDroppedByRetention(opened).length, 400 - AGENT_ACTIVITY_RETENTION_LIMIT);
});

test("the ceiling across agents trims past 2 000 + 200 of their rows, oldest first, ties in list order", () => {
  reset();
  const events: DomainEvent[] = [created()];
  const agents = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  for (const id of agents) {
    events.push(ev("thread.activity-appended", { activity: activity("task.started", agentTask(id), { id: `start-${id}` }) }));
  }
  // Round robin, every agent's row of one round stamped with the same instant:
  // the ceiling sorts by `createdAt`, and a tie must keep the list's order.
  let round = 0;
  while (events.length < 1 + agents.length + AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK + 1) {
    const stamp = new Date(Date.UTC(2026, 5, 1) + round * 1000).toISOString();
    for (const id of agents) events.push(agentRow(id, round, stamp));
    round += 1;
  }
  const states = statesOf(events);
  const trimStep = states.findIndex((state) => itemsDroppedByRetention(state).length > 0);
  assert.notEqual(trimStep, -1);
  const agentRows = (state: ThreadFoldState): number =>
    state.activities.filter((row) => row.agentId !== undefined).length;
  assert.equal(agentRows(states[trimStep - 1]!), AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK);
  assert.equal(agentRows(states[trimStep]!), AGENT_ACTIVITY_TOTAL_LIMIT, "cut to exactly the ceiling");
  // The dropped rows are the oldest rounds, and within the last round cut the
  // agents in list order.
  const dropped = itemsDroppedByRetention(states[trimStep]!).map((item) => item.id);
  const expected: string[] = [];
  for (let r = 0; expected.length < AGENT_ACTIVITY_TOTAL_SLACK + 1; r += 1) {
    for (const id of agents) {
      if (expected.length < AGENT_ACTIVITY_TOTAL_SLACK + 1) expected.push(`${id}-row-${r}`);
    }
  }
  assert.deepEqual([...dropped].sort(), [...expected].sort());
  assert.ok(
    states[trimStep]!.activities.every((row) => row.agentId !== undefined || row.id.startsWith("start-")),
    "the anchors all stay"
  );
});

test("messages trim past 2 000 + 200 without touching the activities, pending or roster", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.activity-appended", { activity: activity("task.started", agentTask("ag"), { id: "anchor" }) }),
    ev("thread.activity-appended", {
      activity: activity("approval.requested", { requestId: "r1", requestType: "command_execution_approval" })
    })
  ];
  for (let index = 0; index < MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK; index += 1) {
    events.push(message(index));
  }
  const before = foldThread(events);
  const after = applyDomainEvent(before, message(MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK));
  assert.equal(after.items.length - after.activities.length, MESSAGE_RETENTION_LIMIT);
  assert.equal(itemsDroppedByRetention(after).length, MESSAGE_RETENTION_SLACK + 1);
  assert.ok(itemsDroppedByRetention(after).every((item) => item.kind === "message"));
  assert.deepEqual(after.activities.map((row) => row.activityKind), ["task.started", "approval.requested"]);
  assert.deepEqual(after.pending.approvals.map((entry) => entry.requestId), ["r1"]);
  assert.deepEqual(after.roster.map((agent) => [agent.id, agent.status]), [["ag", "running"]]);
  assert.equal(after.items.find((item) => item.kind === "message")?.id, "m-201");
  assert.deepEqual(after.evicted, { activities: false, messages: true });
});

test("a trim cuts every class at once, whichever one tripped it", () => {
  reset();
  // Messages past their LIMIT but inside their slack, parent rows past their
  // LIMIT but inside theirs: the parent trigger fires, and the one trim cuts
  // both back to their limits.
  const events: DomainEvent[] = [created()];
  for (let index = 0; index < MESSAGE_RETENTION_LIMIT + 100; index += 1) events.push(message(index));
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(parentRow(index));
  }
  const before = foldThread(events);
  assert.equal(before.evicted, undefined, "no class passed its slack yet");
  const last = parentRow(ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK);
  const after = applyDomainEvent(before, last);
  assert.equal(after.activities.length, ACTIVITY_RETENTION_LIMIT);
  assert.equal(after.items.length - after.activities.length, MESSAGE_RETENTION_LIMIT);
  assert.deepEqual(after.evicted, { activities: true, messages: true });
});

test("more open questions than the slack keep the trigger on without dropping them — time, never correctness", () => {
  reset();
  const events: DomainEvent[] = [created()];
  // 60 open message-mode questions, then enough rows to pass the trigger.
  for (let index = 0; index < ACTIVITY_RETENTION_SLACK + 10; index += 1) {
    events.push(
      ev("thread.activity-appended", {
        activity: activity(
          "user-input.requested",
          {
            requestId: `q-${index}`,
            responseMode: "message",
            questions: [{ id: "a", header: "h", question: "q", options: [{ label: "yes" }] }]
          },
          { id: `ask-${index}` }
        )
      })
    );
  }
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  const last = states.at(-1)!;
  // The questions count toward the trigger (60 + 500 > 550) but the trim keeps
  // them, and it finds nothing else old enough to drop: the arrays stay shared
  // and nothing reads as evicted.
  assert.ok(states.every((state) => itemsDroppedByRetention(state).length === 0));
  assert.equal(last.activities.length, ACTIVITY_RETENTION_SLACK + 10 + ACTIVITY_RETENTION_LIMIT);
  assert.equal(last.evicted, undefined);
  assert.equal(last.pending.userInputs.length, ACTIVITY_RETENTION_SLACK + 10);
  const next = applyDomainEvent(last, parentRow(ACTIVITY_RETENTION_LIMIT));
  assert.deepEqual(
    itemsDroppedByRetention(next).map((item) => item.id),
    ["p-0"],
    "each further row now trims the oldest droppable one, exactly as per-event retention did"
  );
  assert.equal(next.pending.userInputs.length, ACTIVITY_RETENTION_SLACK + 10);
});

test("compaction markers are exempt in the parent window only", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.activity-appended", {
      activity: activity("context-compaction", { state: "compacted" }, { id: "parent-marker" })
    }),
    ev("thread.activity-appended", {
      activity: activity("context-compaction", { state: "compacted" }, { id: "agent-marker", agentId: "ag" })
    })
  ];
  for (let index = 0; index < 300; index += 1) events.push(parentRow(index));
  for (let index = 0; index <= AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK - 1; index += 1) {
    events.push(agentRow("ag", index));
  }
  const state = foldThread(events);
  assert.ok(state.activities.some((row) => row.id === "parent-marker"), "the parent's marker stays");
  assert.ok(
    !state.activities.some((row) => row.id === "agent-marker"),
    "an agent-owned marker is an ordinary row of its agent's window"
  );
});

test("the legacy compaction marker is kept whatever its age, as context-compaction is; any other thread.state.changed is an ordinary row", () => {
  reset();
  const stateRow = (id: string, payload: unknown, agentId?: string): DomainEvent =>
    ev("thread.activity-appended", {
      activity: activity("thread.state.changed", payload, {
        id,
        ...(agentId !== undefined ? { agentId } : {})
      })
    });
  const events: DomainEvent[] = [
    created(),
    // What an older log wrote for a settled compaction — the oldest row of all.
    stateRow("legacy-marker", { state: "compacted", beforeTokens: 90_000, afterTokens: 9_000 }),
    // The same kind saying anything else is no marker (`compaction.ts`).
    stateRow("state-running", { state: "running" }),
    stateRow("state-compacting", { state: "compacting" }),
    stateRow("state-none", {}),
    // A subagent's own legacy marker is an ordinary row of its agent's window.
    stateRow("agent-legacy-marker", { state: "compacted" }, "ag")
  ];
  for (let index = 0; index < AGENT_ACTIVITY_RETENTION_LIMIT; index += 1) {
    events.push(agentRow("ag", index));
  }
  // The marker counts in no class: beside the three other state rows, this
  // fills the parent with exactly its limit plus slack of droppable rows.
  const fill = ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK - 3;
  for (let index = 0; index < fill; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  assert.ok(
    states.every((state) => itemsDroppedByRetention(state).length === 0),
    "the legacy marker is no droppable row: the parent has not passed its trigger"
  );
  const before = states.at(-1)!;
  assert.equal(before.evicted, undefined);

  // One row more: one trim cuts every class back to its limit.
  const last = parentRow(fill);
  const after = applyDomainEvent(before, last);
  assert.deepEqual(
    itemsDroppedByRetention(after).map((item) => item.id),
    [
      "state-running",
      "state-compacting",
      "state-none",
      "agent-legacy-marker",
      ...Array.from({ length: ACTIVITY_RETENTION_SLACK - 2 }, (_, index) => `p-${index}`)
    ],
    "the other states go with the oldest parent rows, the agent's marker with its agent's window"
  );
  assert.equal(after.activities[0]?.id, "legacy-marker", "the parent's legacy marker stays, still the oldest row");
  assert.equal(
    after.activities.filter((row) => row.agentId === undefined).length,
    ACTIVITY_RETENTION_LIMIT + 1,
    "the parent's last 500 rows, plus its marker"
  );
  // However many trims follow.
  let state = after;
  let trims = 0;
  for (let index = fill + 1; index <= fill + 3 * (ACTIVITY_RETENTION_SLACK + 1); index += 1) {
    state = applyDomainEvent(state, parentRow(index));
    if (itemsDroppedByRetention(state).length > 0) trims += 1;
  }
  assert.equal(trims, 3);
  assert.equal(state.activities[0]?.id, "legacy-marker");
});

// ---------------------------------------------------------------------------
// Running work keeps its opening row (`FOLD_SNAPSHOT_VERSION` 4)
// ---------------------------------------------------------------------------

const appended = (row: ThreadActivityItem): DomainEvent => ev("thread.activity-appended", { activity: row });

/** A lifecycle row of the call `toolUseId` (its start, an update, its end). */
function callRow(kind: string, toolUseId: string, id: string, agentId?: string): ThreadActivityItem {
  return activity(kind, { itemType: "command_execution", toolUseId, title: "npm run build" }, {
    id,
    tone: "tool",
    ...(agentId !== undefined ? { agentId } : {})
  });
}

/** Output chunk `index` of the call `toolUseId`: one `tool.output` row per ingestion flush, a fresh id each. */
function chunkRow(toolUseId: string, index: number, agentId?: string): DomainEvent {
  return appended(
    activity("tool.output", { toolUseId, streamKind: "command_output", delta: `line ${index}\n` }, {
      id: `${toolUseId}-chunk-${index}`,
      tone: "tool",
      summary: "Tool output",
      ...(agentId !== undefined ? { agentId } : {})
    })
  );
}

const running = (): DomainEvent => ev("thread.session-set", { session: session("running", "T-1") });

/** The first step at or after `from` whose state no longer holds `row`, or -1. */
function lostAt(states: readonly ThreadFoldState[], row: ThreadActivityItem, from: number): number {
  return states.findIndex((state, step) => step >= from && !state.activities.some((entry) => entry.id === row.id));
}

test("a running parent call keeps its opening row through 1 200 of its own chunks, and the window stays bounded", () => {
  reset();
  const opening = callRow("tool.started", "build", "build-start");
  const events: DomainEvent[] = [created(), running(), appended(opening)];
  for (let index = 1; index <= 1_200; index += 1) events.push(chunkRow("build", index));
  const states = statesOf(events);
  const lost = lostAt(states, opening, 2);
  assert.equal(lost, -1, `the opening row was dropped on chunk ${lost - 2}`);
  assert.ok(states.every((state) => state.activities.length <= 552), "the limit, its slack and the kept row");
  const trims = states.filter((state) => itemsDroppedByRetention(state).length > 0).length;
  assert.ok(trims >= 12, `trims: ${trims}`);
  const last = states.at(-1)!;
  assert.equal(last.activities[0]?.id, "build-start", "still the oldest row");
});

test("a running agent-owned call keeps its opening row through 1 200 of its own chunks in a busy thread", () => {
  reset();
  const events: DomainEvent[] = [created(), running()];
  // Past the gate first: the agent's own window trims from its 251st row.
  for (let index = 0; index < 520; index += 1) events.push(parentRow(index));
  const opening = callRow("tool.started", "bgshell:sh1", "shell-call", "sh1");
  const from = events.push(appended(opening)) - 1;
  for (let index = 1; index <= 1_200; index += 1) events.push(chunkRow("bgshell:sh1", index, "sh1"));
  const states = statesOf(events);
  const lost = lostAt(states, opening, from);
  assert.equal(lost, -1, `the opening row was dropped on chunk ${lost - from}`);
  const owned = (state: ThreadFoldState): number => state.activities.filter((row) => row.agentId === "sh1").length;
  assert.ok(
    states.every((state) => owned(state) <= AGENT_ACTIVITY_RETENTION_LIMIT + AGENT_ACTIVITY_RETENTION_SLACK),
    "the agent's window stays within its limit and slack"
  );
  assert.ok(states.filter((state) => itemsDroppedByRetention(state).length > 0).length >= 15);
});

test("a running agent-owned call keeps its opening row under the ceiling across agents, where its older chunk goes", () => {
  reset();
  const opening = callRow("tool.started", "bgshell:sh1", "shell-call", "sh1");
  const events: DomainEvent[] = [created(), running(), appended(opening), chunkRow("bgshell:sh1", 1, "sh1")];
  // Twelve agents, each inside its own window, together past the ceiling.
  const agents = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  for (let round = 0; round < AGENT_ACTIVITY_RETENTION_LIMIT; round += 1) {
    for (const id of agents) events.push(agentRow(id, round));
  }
  const states = statesOf(events);
  const lost = lostAt(states, opening, 2);
  assert.equal(lost, -1, `the opening row was dropped at step ${lost}`);
  const firstTrim = states.findIndex((state) => itemsDroppedByRetention(state).length > 0);
  assert.ok(firstTrim > 0, "the ceiling trims");
  assert.ok(
    itemsDroppedByRetention(states[firstTrim]!).some((item) => item.id === "bgshell:sh1-chunk-1"),
    "the ceiling reached past the opening row: the call's own chunk, the next oldest row, went"
  );
  const agentRows = (state: ThreadFoldState): number => state.activities.filter((row) => row.agentId !== undefined).length;
  assert.ok(states.every((state) => agentRows(state) <= AGENT_ACTIVITY_TOTAL_LIMIT + AGENT_ACTIVITY_TOTAL_SLACK));
});

for (const closer of ["tool.completed", "tool.denied"] as const) {
  test(`once a ${closer} closes the call, the next trim drops its opening row, and no trim before it did`, () => {
    reset();
    const opening = callRow("tool.started", "build", "build-start");
    const events: DomainEvent[] = [created(), running(), appended(opening)];
    for (let index = 1; index <= 700; index += 1) events.push(chunkRow("build", index));
    const closedAt = events.push(appended(callRow(closer, "build", "build-end"))) - 1;
    for (let index = 0; index < ACTIVITY_RETENTION_SLACK + 10; index += 1) events.push(parentRow(index));
    const states = statesOf(events);
    const trimSteps = states.flatMap((state, step) => (itemsDroppedByRetention(state).length > 0 ? [step] : []));
    assert.ok(trimSteps.filter((step) => step < closedAt).length >= 3, "trims reached past it while it ran");
    const droppedAt = states.findIndex((state) => itemsDroppedByRetention(state).some((item) => item.id === opening.id));
    assert.equal(droppedAt, trimSteps.find((step) => step >= closedAt), "dropped by the first trim once it closed");
    assert.equal(lostAt(states, opening, 2), droppedAt, "and held until then");
  });
}

for (const window of ["parent", "agent"] as const) {
  test(`the ${window} window keeps the openings of the 16 most recently active open calls behind its cut: a streaming call outranks 40 opened after it and left quiet, and every trim frees its slack minus 16`, () => {
    reset();
    const agentId = window === "agent" ? "ag" : undefined;
    const [limit, slack] =
      window === "parent"
        ? [ACTIVITY_RETENTION_LIMIT, ACTIVITY_RETENTION_SLACK]
        : [AGENT_ACTIVITY_RETENTION_LIMIT, AGENT_ACTIVITY_RETENTION_SLACK];
    const events: DomainEvent[] = [created(), running()];
    if (agentId !== undefined) {
      for (let index = 0; index < 520; index += 1) events.push(parentRow(index));
    }
    // The streaming call opened FIRST: ranked by its opening it would be the
    // first pushed out; ranked by its last activity it is the one kept.
    const stream = callRow("tool.started", "stream", "stream-start", agentId);
    const from = events.push(appended(stream)) - 1;
    const quiet: ThreadActivityItem[] = [];
    for (let index = 0; index < 40; index += 1) {
      const row = callRow("tool.started", `quiet-${index}`, `quiet-start-${index}`, agentId);
      quiet.push(row);
      events.push(appended(row));
    }
    for (let index = 1; index <= 1_200; index += 1) events.push(chunkRow("stream", index, agentId));
    const states = statesOf(events);
    const lost = lostAt(states, stream, from);
    assert.equal(lost, -1, `the streaming call's opening row was dropped at step ${lost}`);
    const rowsOf = (state: ThreadFoldState): ThreadActivityItem[] =>
      state.activities.filter((row) => row.agentId === agentId);
    let trims = 0;
    let previousTrim = Number.NEGATIVE_INFINITY;
    states.forEach((state, step) => {
      const dropped = itemsDroppedByRetention(state).filter((item) => item.kind === "activity" && item.agentId === agentId);
      if (dropped.length === 0) return;
      trims += 1;
      assert.ok(dropped.length >= slack - OPEN_WORK_RETENTION_LIMIT, `step ${step}: the trim freed ${dropped.length} rows`);
      assert.ok(step - previousTrim >= slack - OPEN_WORK_RETENTION_LIMIT, `step ${step}: a trim ${step - previousTrim} steps after the last`);
      previousTrim = step;
      // All the trim kept past the window's newest rows: at most 16 openings.
      const rows = rowsOf(state);
      const keptPast = rows.slice(0, rows.length - limit);
      assert.ok(keptPast.length <= OPEN_WORK_RETENTION_LIMIT, `step ${step}: ${keptPast.length} rows kept past the window`);
      assert.ok(keptPast.every((row) => row.activityKind === "tool.started"), `step ${step}: only openings`);
    });
    assert.ok(trims >= 15, `trims: ${trims}`);
    assert.deepEqual(
      rowsOf(states.at(-1)!)
        .filter((row) => row.activityKind === "tool.started")
        .map((row) => row.id),
      ["stream-start", ...quiet.slice(-15).map((row) => row.id)],
      "the openings kept: the streaming call's, then those of the 15 quiet calls opened last"
    );
  });
}

test("a burst of calls in flight inside the window takes no slot from an old quiet shell's start: a window's cap ranks only the openings its cut would drop", () => {
  reset();
  // A dev server started first and went quiet; its start is a parent row.
  const shellStart = activity(
    "task.started",
    { taskId: "sh1", agentKind: "background", taskType: "local_bash", isBackgrounded: true, description: "npm run dev" },
    { id: "shell-start" }
  );
  const events: DomainEvent[] = [created(), running(), appended(shellStart)];
  for (let index = 0; index < 520; index += 1) events.push(parentRow(index));
  // Twenty calls in flight at once, each more recently active than the shell.
  const burst: ThreadActivityItem[] = [];
  for (let index = 0; index < 20; index += 1) {
    const row = callRow("tool.started", `burst-${index}`, `burst-start-${index}`);
    burst.push(row);
    events.push(appended(row));
  }
  // Enough rows to take the parent past its limit plus slack once, the burst inside its newest 500.
  for (let index = 520; index < 530; index += 1) events.push(parentRow(index));
  const states = statesOf(events);
  const trimAt = states.findIndex((state) => itemsDroppedByRetention(state).length > 0);
  assert.equal(trimAt, events.length - 1, "one trim, at the last row");
  const trimmed = states[trimAt]!;
  assert.ok(trimmed.activities.some((row) => row.id === "shell-start"), "the shell's start is kept: the one opening the cut would drop");
  assert.ok(burst.every((row) => trimmed.activities.some((entry) => entry.id === row.id)), "the burst is inside the window anyway");
  assert.deepEqual(trimmed.roster.map((row) => row.id), ["sh1"], "the shell stays on the roster");
});

test("the ceiling's slots go to openings that survived their own window: those an agent's own cap dropped take none", () => {
  reset();
  const events: DomainEvent[] = [created(), running()];
  // Sixty calls four agents opened first and left open, each inside its own window: the oldest rows the ceiling reaches.
  const quiet: ThreadActivityItem[] = [];
  for (const agentId of ["b0", "b1", "b2", "b3"]) {
    for (let index = 0; index < 15; index += 1) {
      const row = callRow("tool.started", `${agentId}-call-${index}`, `${agentId}-start-${index}`, agentId);
      quiet.push(row);
      events.push(appended(row));
    }
  }
  // Thirty calls agent `a` opened next, all more recently active than the quiet ones by the end.
  const busy: ThreadActivityItem[] = [];
  for (let index = 0; index < 30; index += 1) {
    const row = callRow("tool.started", `a-call-${index}`, `a-start-${index}`, "a");
    busy.push(row);
    events.push(appended(row));
  }
  // Twelve more agents, each inside its own window.
  const others = Array.from({ length: 12 }, (_, index) => `c${index}`);
  for (let round = 0; round < 150; round += 1) {
    for (const id of others) events.push(agentRow(id, round));
  }
  // Agent `a`'s own rows put its thirty openings behind its newest 200; then its calls print, and its 251st row trims
  // its window — its cap keeps sixteen openings — with the rows across agents past the ceiling.
  for (let index = 0; index < AGENT_ACTIVITY_RETENTION_LIMIT; index += 1) events.push(agentRow("a", 1_000 + index));
  for (let index = 0; index < 21; index += 1) events.push(chunkRow(`a-call-${index}`, index, "a"));
  const states = statesOf(events);
  const trimAt = states.findIndex((state) => itemsDroppedByRetention(state).length > 0);
  assert.equal(trimAt, events.length - 1, "one trim, at the last row");
  const trimmed = states[trimAt]!;
  const held = (rows: readonly ThreadActivityItem[]): number => rows.filter((row) => trimmed.activities.some((entry) => entry.id === row.id)).length;
  assert.equal(held(busy), OPEN_WORK_RETENTION_LIMIT, "agent a's own cap kept sixteen of its thirty openings");
  assert.equal(
    held(quiet),
    OPEN_WORK_TOTAL_RETENTION_LIMIT - OPEN_WORK_RETENTION_LIMIT,
    "the ceiling's other 48 slots went to the quiet agents' openings, not to the fourteen agent a's cap dropped"
  );
});

test("a running background shell keeps its task.started through 600 parent rows, so the roster keeps it; once it ends, a trim drops it", () => {
  reset();
  const start = activity(
    "task.started",
    { taskId: "sh1", agentKind: "background", taskType: "local_bash", isBackgrounded: true, description: "npm run dev" },
    { id: "shell-start" }
  );
  const call = callRow("tool.started", "bgshell:sh1", "shell-call", "sh1");
  const events: DomainEvent[] = [created(), running(), appended(start), appended(call)];
  for (let index = 0; index < 600; index += 1) {
    events.push(parentRow(index));
    // The shell's own output, in its own window.
    if (index % 10 === 0) events.push(chunkRow("bgshell:sh1", index, "sh1"));
  }
  const states = statesOf(events);
  assert.ok(states.filter((state) => itemsDroppedByRetention(state).length > 0).length >= 1, "the parent window trims");
  const rosterLost = states.findIndex((state, step) => step >= 2 && !state.roster.some((row) => row.id === "sh1"));
  assert.equal(rosterLost, -1, `the roster lost the shell at step ${rosterLost}`);
  assert.equal(lostAt(states, start, 2), -1);
  assert.equal(lostAt(states, call, 3), -1);
  const whileRunning = states.at(-1)!;
  assert.deepEqual(
    whileRunning.roster.map((row) => [row.id, row.agentKind, row.status]),
    [["sh1", "background", "running"]]
  );

  // Ended, its start is an ordinary row again: the next trim drops it, and the roster reads the end.
  let state = applyDomainEvent(
    whileRunning,
    appended(activity("task.completed", { taskId: "sh1", agentKind: "background", status: "completed" }, { id: "shell-end" }))
  );
  state = applyDomainEvent(state, appended(callRow("tool.completed", "bgshell:sh1", "shell-call-end", "sh1")));
  let droppedStart = false;
  for (let index = 600; index < 600 + ACTIVITY_RETENTION_SLACK + 10; index += 1) {
    state = applyDomainEvent(state, parentRow(index));
    if (itemsDroppedByRetention(state).some((row) => row.id === "shell-start")) droppedStart = true;
  }
  assert.ok(droppedStart, "a trim dropped the ended shell's start");
  assert.deepEqual(state.roster.map((row) => [row.id, row.status]), [["sh1", "completed"]]);
});

// ---------------------------------------------------------------------------
// `evicted` and `itemsDroppedByRetention`
// ---------------------------------------------------------------------------

test("evicted: absent until a trim drops something, then only ever grows, and survives a rewind", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ev("thread.message-sent", { messageId: "u1", role: "user", text: "go", streaming: false, turnId: null }),
    ev("thread.turn-start-requested", { turnId: null, messageId: "u1", interactionMode: "default" }),
    ev("thread.session-set", { session: session("running", "T-1") })
  ];
  // Rows of the running turn, so the rewind below has something to remove.
  const turnRow = (index: number): DomainEvent =>
    ev("thread.activity-appended", {
      activity: activity("tool.completed", { toolUseId: `p${index}` }, { id: `p-${index}`, turnId: "T-1" })
    });
  for (let index = 0; index <= ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK; index += 1) {
    events.push(turnRow(index));
  }
  const states = statesOf(events);
  assert.equal(createEmptyThreadState().evicted, undefined);
  assert.ok(states.slice(0, -1).every((state) => state.evicted === undefined));
  const evicted = states.at(-1)!.evicted;
  assert.deepEqual(evicted, { activities: true, messages: false });

  // A later activity trim preserves flags; a message trim adds its flag.
  let state = states.at(-1)!;
  for (let index = 0; index <= ACTIVITY_RETENTION_SLACK; index += 1) {
    state = applyDomainEvent(state, turnRow(1_000 + index));
  }
  assert.ok(itemsDroppedByRetention(state).length > 0, "a second trim ran");
  assert.deepEqual(state.evicted, { activities: true, messages: false });
  for (let index = 0; index <= MESSAGE_RETENTION_LIMIT + MESSAGE_RETENTION_SLACK; index += 1) {
    state = applyDomainEvent(state, message(index));
  }
  assert.deepEqual(state.evicted, { activities: true, messages: true });

  // A rewind removes rows, but it is not retention: nothing reads as dropped by
  // it, and what retention evicted stays evicted.
  const rewound = applyDomainEvent(state, ev("thread.reverted", { turnCount: 0 }));
  assert.ok(rewound.activities.length < state.activities.length, "the rewind removed rows");
  assert.deepEqual(itemsDroppedByRetention(rewound), []);
  assert.deepEqual(rewound.evicted, { activities: true, messages: true });

  // It rides the snapshot; the side table does not.
  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
  assert.deepEqual(restored?.evicted, { activities: true, messages: true });
  assert.deepEqual(itemsDroppedByRetention(restored!), []);
});

const keyOf = (item: ThreadItem): string => `${item.kind}:${item.id}`;

test("itemsDroppedByRetention: exactly the rows the step's trim removed, in list order, and stable", () => {
  reset();
  // Every row is appended once and never updated, so each one must either be
  // in the final window or have been dropped by exactly one step — the
  // dropped rows, step by step, then the window, are the whole log in order.
  const events: DomainEvent[] = [created()];
  const appended: string[] = [];
  for (let index = 0; index < 1_400; index += 1) {
    if (index % 3 === 0) {
      events.push(message(index));
      appended.push(`message:m-${index}`);
    } else {
      events.push(parentRow(index));
      appended.push(`activity:p-${index}`);
    }
  }
  const dropped: string[] = [];
  let state = createEmptyThreadState();
  for (const event of events) {
    const next = applyDomainEvent(state, event);
    const rows = itemsDroppedByRetention(next);
    if (rows.length > 0) {
      // Every dropped row was in the previous window, and is gone now.
      for (const item of rows) {
        assert.ok(state.items.some((row) => keyOf(row) === keyOf(item)), "a dropped row comes from the window it left");
        assert.ok(!next.items.some((row) => keyOf(row) === keyOf(item)));
      }
    }
    dropped.push(...rows.map(keyOf));
    state = next;
  }
  assert.ok(dropped.length > 0);
  const activitiesDropped = dropped.filter((key) => key.startsWith("activity:"));
  const messagesKept = state.items.filter((item) => item.kind === "message").map(keyOf);
  // Activities leave oldest first, and so, separately, do messages.
  assert.deepEqual(
    [...activitiesDropped, ...state.activities.map(keyOf)],
    appended.filter((key) => key.startsWith("activity:"))
  );
  assert.deepEqual(
    [...dropped.filter((key) => key.startsWith("message:")), ...messagesKept],
    appended.filter((key) => key.startsWith("message:"))
  );
  assert.deepEqual(itemsDroppedByRetention(createEmptyThreadState()), []);
});
