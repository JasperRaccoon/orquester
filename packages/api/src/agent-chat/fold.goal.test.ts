/**
 * The fold's goal (goals §4.4): the last `goal.updated` row that parses wins,
 * a row that does not is still appended but moves nothing, and nothing else —
 * not retention, not a rewind — ever touches it: it is the provider's state,
 * not the conversation's. It rides the §6.3 snapshot, and a snapshot plus the
 * tail folds to the whole log's goal. How `state.json` stores and checks it is
 * `fold-snapshot.test.ts`'s.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "./domain-events.ts";
import {
  ACTIVITY_RETENTION_LIMIT,
  ACTIVITY_RETENTION_SLACK,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  toThreadSnapshot
} from "./fold.ts";
import { splitDivergences } from "./fold-logs.test-support.ts";
import { FOLD_SNAPSHOT_VERSION } from "./fold-snapshot.ts";
import { GOAL_ACTIVITY_KIND } from "./goal.ts";
import type { AgentGoal, GoalUpdatedPayload } from "./goal.ts";
import type { ThreadActivityItem } from "./thread.ts";
import { activity, created, ev, resetActivityIds, resetSeq, session } from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

const SHIP: AgentGoal = {
  objective: "Ship the release",
  status: "active",
  rounds: 0,
  setAt: "2026-09-24T10:00:00.000Z"
};

/** One `goal.updated` row as ingestion writes it (goals §4.3). */
function goalRow(
  payload: GoalUpdatedPayload | unknown,
  overrides: Partial<ThreadActivityItem> = {}
): Extract<DomainEvent, { type: "thread.activity-appended" }> {
  return ev("thread.activity-appended", {
    activity: activity(GOAL_ACTIVITY_KIND, payload, overrides)
  });
}

function toolRow(index: number): DomainEvent {
  return ev("thread.activity-appended", {
    activity: activity("tool.completed", { toolUseId: `tu-${index}` }, { id: `tool-${index}` })
  });
}

function prompt(turn: number): DomainEvent[] {
  return [
    ev("thread.message-sent", {
      messageId: `user:${turn}`,
      role: "user",
      text: `ask ${turn}`,
      streaming: false,
      turnId: null
    }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: `user:${turn}`,
      interactionMode: "default"
    }),
    ev("thread.session-set", { session: session("running", `T-${turn}`) })
  ];
}

// --- derivation ------------------------------------------------------------------

test("a fresh fold has no goal, and neither does a thread that never set one", () => {
  assert.equal(createEmptyThreadState().goal, null);
  reset();
  const state = foldThread([created(), ...prompt(1)]);
  assert.equal(state.goal, null);
  assert.equal(toThreadSnapshot(state).goal, null);
});

test("a goal.updated row sets the goal, stamped with the ROW's updatedAt, and is appended as usual", () => {
  reset();
  const head = created();
  const set = goalRow(
    { goal: SHIP, change: "set" },
    {
      id: "goal-1",
      turnId: "T-1",
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:05.000Z"
    }
  );
  const state = foldThread([head, set]);
  assert.deepEqual(state.goal, { ...SHIP, updatedAt: "2026-09-24T10:00:05.000Z" });
  assert.deepEqual(
    state.items.map((item) => item.id),
    ["goal-1"],
    "the row itself is an ordinary activity"
  );
  assert.equal(state.activities[0], set.payload.activity);
});

test("the last row wins, a null goal clears it, and a cleared thread can set another", () => {
  reset();
  const checked: AgentGoal = { ...SHIP, rounds: 1, lastCheck: "tests still fail" };
  let state = foldThread([
    created(),
    goalRow({ goal: SHIP, change: "set" }),
    goalRow({ goal: checked, change: "checked" })
  ]);
  const { updatedAt: _stamp, ...folded } = state.goal!;
  assert.deepEqual(folded, checked);

  state = applyDomainEvent(
    state,
    goalRow({ goal: null, change: "achieved", previous: { ...checked, status: "complete" } })
  );
  assert.equal(state.goal, null);

  state = applyDomainEvent(
    state,
    goalRow({ goal: { objective: "Write the changelog", status: "active" }, change: "set" })
  );
  assert.equal(state.goal?.objective, "Write the changelog");
  assert.equal(state.goal?.status, "active");
});

test("a row that does not parse leaves the goal as it was — and is still appended", () => {
  reset();
  const before = foldThread([created(), goalRow({ goal: SHIP, change: "set" })]);
  const unparseable = [
    goalRow({ goal: { objective: "", status: "active" }, change: "set" }),
    goalRow({ goal: SHIP, change: "exploded" }),
    goalRow({ goal: { objective: "x", status: "done" }, change: "set" }),
    goalRow({ change: "cleared" }),
    goalRow("not a payload"),
    goalRow(null)
  ];
  let state = before;
  for (const event of unparseable) {
    state = applyDomainEvent(state, event);
    assert.equal(state.goal, before.goal, "kept, by identity");
  }
  assert.equal(state.items.length, before.items.length + unparseable.length);
  assert.equal(state.activities.length, before.activities.length + unparseable.length);
});

test("only a goal.updated row moves the goal", () => {
  reset();
  const before = foldThread([created(), goalRow({ goal: SHIP, change: "set" })]);
  const other = { goal: { objective: "Something else", status: "paused" }, change: "set" };
  let state = before;
  for (const event of [
    ev("thread.activity-appended", { activity: activity("goal.status", other) }),
    ev("thread.activity-appended", { activity: activity("goal.command.failed", other) }),
    ev("thread.activity-appended", { activity: activity("runtime.warning", other) }),
    ev("thread.message-sent", {
      messageId: "m-goal",
      role: "user",
      text: "/goal Something else",
      streaming: false,
      turnId: null
    }),
    ev("thread.session-set", { session: session("stopped", null) })
  ]) {
    state = applyDomainEvent(state, event);
    assert.equal(state.goal, before.goal, event.type);
  }
});

test("the fold keeps the PARSED goal: bad optional fields and unknown keys never reach it", () => {
  reset();
  const head = created();
  const row = goalRow({ goal: { ...SHIP, rounds: -1, junk: true }, change: "set", extra: 1 });
  const state = foldThread([head, row]);
  const { rounds: _rounds, ...clean } = SHIP;
  assert.deepEqual(state.goal, { ...clean, updatedAt: row.payload.activity.updatedAt });
  // The row keeps what it was given; only the derived state is cleaned.
  assert.deepEqual(state.items[0], row.payload.activity);
});

test("a goal row replaced in place still decides the goal", () => {
  reset();
  const head = created();
  const first = goalRow({ goal: SHIP, change: "set" }, { id: "goal-row" });
  const again = goalRow({ goal: { ...SHIP, status: "paused" }, change: "paused" }, { id: "goal-row" });
  const state = foldThread([head, first, again]);
  assert.equal(state.items.length, 1, "one row, replaced");
  assert.equal(state.goal?.status, "paused");
});

// --- what never touches it ------------------------------------------------------

test("retention never drops the goal, even once its row has aged out of the window", () => {
  reset();
  const events: DomainEvent[] = [created()];
  const set = goalRow({ goal: SHIP, change: "set" }, { id: "goal-1" });
  events.push(set);
  for (let index = 0; index < ACTIVITY_RETENTION_LIMIT + ACTIVITY_RETENTION_SLACK + 10; index += 1) {
    events.push(toolRow(index));
  }
  const state = foldThread(events);
  assert.ok(!state.items.some((item) => item.id === "goal-1"), "the row itself aged out");
  assert.equal(state.evicted?.activities, true);
  assert.deepEqual(state.goal, { ...SHIP, updatedAt: set.payload.activity.updatedAt });
});

test("a rewind never touches the goal, even when it removes the row that set it", () => {
  reset();
  const events: DomainEvent[] = [
    created(),
    ...prompt(1),
    ev("thread.session-set", { session: session("ready", null) }),
    ...prompt(2)
  ];
  const set = goalRow({ goal: SHIP, change: "set" }, { id: "goal-1", turnId: "T-2" });
  events.push(
    set,
    ev("thread.session-set", { session: session("ready", null) }),
    ev("thread.reverted", { turnCount: 1 })
  );
  const state = foldThread(events);
  assert.ok(!state.items.some((item) => item.id === "goal-1"), "the rewind removed the row");
  assert.deepEqual(
    state.turns.map((turn) => turn.turnId),
    ["T-1"]
  );
  assert.deepEqual(state.goal, { ...SHIP, updatedAt: set.payload.activity.updatedAt });

  const toZero = applyDomainEvent(state, ev("thread.reverted", { turnCount: 0 }));
  assert.equal(toZero.goal, state.goal);
});

test("an event that does not touch the goal keeps it by identity", () => {
  reset();
  const state = foldThread([created(), ...prompt(1), goalRow({ goal: SHIP, change: "set" })]);
  let next = state;
  for (const event of [
    toolRow(1),
    ev("thread.message-sent", {
      messageId: "a1",
      role: "assistant",
      text: "on it",
      streaming: true,
      turnId: "T-1"
    }),
    ev("thread.session-set", { session: session("ready", null) }),
    ev("thread.meta-updated", { title: "Renamed" })
  ]) {
    next = applyDomainEvent(next, event);
    assert.equal(next.goal, state.goal, event.type);
  }
});

// --- the snapshot ----------------------------------------------------------------

test("toThreadSnapshot carries the goal, and null when there is none", () => {
  reset();
  assert.equal(toThreadSnapshot(foldThread([created()])).goal, null);
  const state = foldThread([created(), goalRow({ goal: SHIP, change: "set" })]);
  assert.equal(toThreadSnapshot(state).goal, state.goal);
});

test("a state built before goals existed still folds, and its missing goal reads as null", () => {
  reset();
  const { goal: _goal, ...legacy } = foldThread([created()]);
  const next = applyDomainEvent(legacy, ev("thread.meta-updated", { title: "Renamed" }));
  assert.equal("goal" in next, false, "an absent goal stays absent until a goal row lands");
  assert.equal(toThreadSnapshot(next).goal, null);
  const withGoal = applyDomainEvent(next, goalRow({ goal: SHIP, change: "set" }));
  assert.equal(withGoal.goal?.objective, SHIP.objective);
});

test("the snapshot version moved to 3: every state.json written before the fold derived a goal is refolded once", () => {
  assert.equal(FOLD_SNAPSHOT_VERSION, 3);
});

test("a snapshot at ANY point plus the tail folds to the whole log's goal", () => {
  reset();
  const checked: AgentGoal = { ...SHIP, rounds: 1, lastCheck: "tests still fail" };
  const events: DomainEvent[] = [
    created(),
    ...prompt(1),
    goalRow({ goal: SHIP, change: "set" }, { turnId: "T-1" }),
    toolRow(1),
    goalRow({ goal: checked, change: "checked" }, { turnId: "T-1" }),
    goalRow("unparseable"),
    ev("thread.session-set", { session: session("ready", null) }),
    ...prompt(2),
    goalRow({ goal: { ...checked, rounds: 2, phase: "waiting-background" }, change: "progress" }),
    goalRow({ goal: null, change: "achieved", previous: { ...checked, status: "complete" } }),
    ev("thread.session-set", { session: session("ready", null) }),
    ...prompt(3),
    goalRow({ goal: { objective: "Next", status: "paused", tokenBudget: null }, change: "set" }),
    ev("thread.reverted", { turnCount: 1 }),
    toolRow(2)
  ];
  assert.equal(foldThread(events).goal?.objective, "Next");
  assert.deepEqual(splitDivergences(events, { literalAt: () => true }), []);
});
