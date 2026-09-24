/**
 * The fold's caches (design `docs/superpowers/specs/2026-09-23-fold-performance-design.md`,
 * A1/A2/A4): the id → position index, the retention counters and the roster
 * engine live beside each state, in a side table, never on it.
 *
 * Invariants pinned here:
 * - at every step, the caches the fold carried forward are exactly the caches
 *   rebuilt from the state's arrays (`__foldCacheConsistency`);
 * - nothing a returned state can reach is ever mutated: folding two different
 *   events onto one state gives two independent, correct states;
 * - the roster is re-derived exactly when it always was — a task row, a
 *   session-liveness change, a dropped activity — and is then exactly the
 *   whole-list roster fold; otherwise it keeps its identity.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { DomainEvent } from "./domain-events.ts";
import {
  __foldCacheConsistency,
  applyDomainEvent,
  createEmptyThreadState,
  foldThread,
  itemPositionOf,
  itemsDroppedByRetention
} from "./fold.ts";
import type { ThreadFoldState } from "./fold.ts";
import {
  FLEET_WEIGHTS,
  LEAN_PARENT_WEIGHTS,
  PARENT_WEIGHTS,
  TASK_WEIGHTS,
  activitiesMatchItems,
  fleetLog,
  seededRandom,
  withoutCaches
} from "./fold-logs.test-support.ts";
import { foldSubagentActivities } from "./roster.ts";
import type { ThreadItem } from "./thread.ts";
import { activity, created, ev, resetActivityIds, resetSeq } from "./test-helpers.ts";

const LIVE = new Set(["starting", "ready", "running"]);
const sessionLive = (state: ThreadFoldState): boolean => LIVE.has(state.head?.session.status ?? "idle");

/** Folds `events`, calling `check` after every step; returns the first failure. */
function everyStep(
  events: readonly DomainEvent[],
  check: (state: ThreadFoldState, previous: ThreadFoldState, event: DomainEvent) => string | null
): string | null {
  let state = createEmptyThreadState();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const next = applyDomainEvent(state, event);
    const problem = check(next, state, event);
    if (problem !== null) {
      return `event ${index} (${event.type}): ${problem}`;
    }
    state = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The caches equal the caches rebuilt from the arrays, at every step
// ---------------------------------------------------------------------------

test("a fleet log: the caches carried forward equal the caches rebuilt from the arrays, at every step", () => {
  const events = fleetLog({ seed: 1, steps: 6_500, weights: FLEET_WEIGHTS });
  let trims = 0;
  const failure = everyStep(events, (state) => {
    if (itemsDroppedByRetention(state).length > 0) trims += 1;
    return __foldCacheConsistency(state, { roster: false }) ?? (activitiesMatchItems(state) ? null : "the activity list drifted");
  });
  assert.equal(failure, null);
  assert.ok(trims >= 5, `trims: ${trims}`);
});

test("a parent-window log with rewinds, collisions and questions: the caches equal their rebuild at every step", () => {
  const events = fleetLog({ seed: 2, steps: 2_400, weights: PARENT_WEIGHTS });
  assert.ok(events.some((event) => event.type === "thread.reverted"), "the log rewinds");
  assert.equal(
    everyStep(events, (state) => __foldCacheConsistency(state, { roster: false })),
    null
  );
});

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/** Whether the fold re-derives the roster on this step (design A4: exactly as it always did). */
function rederivesRoster(state: ThreadFoldState, previous: ThreadFoldState, event: DomainEvent): boolean {
  if (event.type === "thread.reverted") return true;
  if (itemsDroppedByRetention(state).some((item) => item.kind === "activity")) return true;
  if (sessionLive(state) !== sessionLive(previous)) return true;
  return (
    event.type === "thread.activity-appended" &&
    ["task.started", "task.progress", "task.updated", "task.completed", "tool.progress"].includes(
      event.payload.activity.activityKind
    )
  );
}

test("a task-heavy log: the roster is the whole-list roster fold at every step, and keeps its identity otherwise", () => {
  const events = fleetLog({ seed: 6, steps: 2_500, weights: TASK_WEIGHTS, maxAgents: 110 });
  let rederived = 0;
  let kept = 0;
  let step = 0;
  const failure = everyStep(events, (state, previous, event) => {
    step += 1;
    const expected = foldSubagentActivities(state.activities, { sessionLive: sessionLive(state) });
    if (!isDeepStrictEqual(state.roster, expected)) {
      return "the roster is not the fold of the activity list";
    }
    if (rederivesRoster(state, previous, event)) {
      rederived += 1;
    } else if (state.roster !== previous.roster) {
      return "the roster moved on a step that re-derives nothing";
    } else {
      kept += 1;
    }
    // Every step the roster is re-derived, the engine's output was just
    // compared above; the engine itself — maintained on every activity change,
    // read or not — stands for the list under either liveness reading.
    return __foldCacheConsistency(state, { roster: step % 25 === 0 });
  });
  assert.equal(failure, null);
  assert.ok(rederived >= 1_000, `steps that re-derived the roster: ${rederived}`);
  assert.ok(kept >= 200, `steps that kept it: ${kept}`);
  const whole = foldThread(events);
  const tasks = new Set(
    events.flatMap((event) =>
      event.type === "thread.activity-appended" &&
      typeof (event.payload.activity.payload as { taskId?: unknown }).taskId === "string"
        ? [(event.payload.activity.payload as { taskId: string }).taskId]
        : []
    )
  );
  assert.ok(tasks.size > 100, `tasks: ${tasks.size} — past the roster's cap`);
  assert.equal(whole.roster.length, 100, "the roster is capped");
  assert.ok(events.some((event) => event.type === "thread.reverted"), "the log rewinds");
});

// ---------------------------------------------------------------------------
// Nothing a returned state reaches is ever mutated
// ---------------------------------------------------------------------------

function freeze(state: ThreadFoldState): void {
  Object.freeze(state.items);
  Object.freeze(state.activities);
  for (const item of state.items) {
    if (!Object.isFrozen(item)) Object.freeze(item);
  }
}

/** An event the log does not contain, folded onto `state` at `seq`: one of four shapes. */
function branchEvent(state: ThreadFoldState, seq: number, random: () => number): DomainEvent {
  const roll = random();
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length === 0 ? undefined : list[Math.floor(random() * list.length)];
  const messages = state.items.filter((item) => item.kind === "message");
  if (roll < 0.3 && state.activities.length > 0) {
    // An in-place replacement of a row the window holds.
    const row = pick(state.activities)!;
    return ev("thread.activity-appended", { activity: { ...row, summary: `branch ${seq}` } }, { seq });
  }
  if (roll < 0.55 && messages.length > 0) {
    // A streamed delta onto a message the window holds.
    const message = pick(messages)!;
    return ev(
      "thread.message-sent",
      { messageId: message.id, role: "assistant", text: " branch", streaming: true, turnId: null },
      { seq }
    );
  }
  if (roll < 0.8) {
    return ev(
      "thread.activity-appended",
      { activity: activity("tool.started", { toolUseId: `branch-${seq}` }, { id: `branch-row-${seq}` }) },
      { seq }
    );
  }
  return ev(
    "thread.message-sent",
    { messageId: `branch-message-${seq}`, role: "assistant", text: "branch", streaming: false, turnId: null },
    { seq }
  );
}

test("folding two different events onto one state gives two independent, correct states — at every step", () => {
  const events = fleetLog({ seed: 7, steps: 1_300, weights: LEAN_PARENT_WEIGHTS });
  const random = seededRandom(99);
  let state = createEmptyThreadState();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    // The state is frozen, rows and arrays: a fold that wrote to anything a
    // returned state reaches would throw here (ES modules are strict).
    freeze(state);
    const branch = branchEvent(state, event.seq, random);
    const branched = applyDomainEvent(state, branch);
    const next = applyDomainEvent(state, event);
    // Each branch is exactly what a fold with no caches makes of the same step…
    assert.ok(
      isDeepStrictEqual(branched, applyDomainEvent(withoutCaches(state), branch)),
      `event ${index}: the branch is not the fold of its own event`
    );
    assert.ok(
      isDeepStrictEqual(next, applyDomainEvent(withoutCaches(state), event)),
      `event ${index}: the main path is not the fold of its own event`
    );
    // …and all three states keep caches that agree with their arrays.
    for (const [label, candidate] of [["base", state], ["branch", branched], ["main", next]] as const) {
      const problem = __foldCacheConsistency(candidate, { roster: false });
      assert.equal(problem, null, `event ${index}, ${label}: ${problem}`);
    }
    state = next;
  }
  // The main path never noticed its branches.
  assert.deepEqual(state, foldThread(events));
});

test("branches off a state about to trim: a trim, a delta, a replacement and a rewind, each independent", () => {
  const events = fleetLog({ seed: 1, steps: 6_500, weights: FLEET_WEIGHTS });
  let state = createEmptyThreadState();
  let trimAt = -1;
  for (let index = 0; index < events.length; index += 1) {
    const next = applyDomainEvent(state, events[index]!);
    if (itemsDroppedByRetention(next).length > 0 && index > 0) {
      trimAt = index;
      break;
    }
    state = next;
  }
  assert.ok(trimAt > 0, "the log trims");
  freeze(state);
  const prefix = events.slice(0, trimAt);
  const seq = events[trimAt]!.seq;
  let message: (ThreadItem & { kind: "message" }) | undefined;
  for (let position = state.items.length - 1; message === undefined; position -= 1) {
    const item = state.items[position]!;
    if (item.kind === "message") message = item;
  }
  const branches: DomainEvent[] = [
    events[trimAt]!,
    ev(
      "thread.message-sent",
      { messageId: message.id, role: "assistant", text: " more", streaming: true, turnId: message.turnId },
      { seq }
    ),
    ev("thread.activity-appended", { activity: { ...state.activities.at(-3)!, summary: "replaced" } }, { seq }),
    ev("thread.reverted", { turnCount: 1 }, { seq })
  ];
  const results = branches.map((branch) => applyDomainEvent(state, branch));
  assert.ok(itemsDroppedByRetention(results[0]!).length > 0, "the first branch trims");
  assert.deepEqual(itemsDroppedByRetention(results[1]!), [], "the delta does not");
  results.forEach((result, index) => {
    assert.deepEqual(result, foldThread([...prefix, branches[index]!]), `branch ${index}`);
    assert.equal(__foldCacheConsistency(result, { roster: false }), null);
  });
  // The base is untouched by all four, and folds the next event as if nothing happened.
  assert.equal(__foldCacheConsistency(state, { roster: false }), null);
  assert.deepEqual(applyDomainEvent(state, events[trimAt]!), results[0]);
  // Each branch goes on folding on its own.
  const rest = events.slice(trimAt + 1, trimAt + 400);
  let continued = results[0]!;
  for (const event of rest) continued = applyDomainEvent(continued, event);
  assert.deepEqual(continued, foldThread([...prefix, events[trimAt]!, ...rest]));
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

test("itemPositionOf finds every row at its last position, through the index's tail and its compactions", () => {
  resetSeq();
  resetActivityIds();
  // Hundreds of appends with no trim: the index's tail grows, compacts into a
  // new base, and grows again. Some ids are shared by a message and an
  // activity, where the LAST row wins.
  const events: DomainEvent[] = [created()];
  for (let index = 0; index < 1_500; index += 1) {
    if (index % 5 === 0) {
      events.push(
        ev("thread.activity-appended", {
          activity: activity("tool.started", { toolUseId: `t${index}` }, { id: index % 50 === 0 ? `m-${index - 5}` : `a-${index}` })
        })
      );
    } else {
      events.push(
        ev("thread.message-sent", { messageId: `m-${index}`, role: "assistant", text: "x", streaming: false, turnId: null })
      );
    }
  }
  let state = createEmptyThreadState();
  events.forEach((event, index) => {
    state = applyDomainEvent(state, event);
    const last = state.items.at(-1);
    if (last !== undefined) assert.equal(itemPositionOf(state, last.id), state.items.length - 1);
    if (index % 97 === 0 || index === events.length - 1) {
      const expected = new Map<string, number>();
      state.items.forEach((item, position) => expected.set(item.id, position));
      for (const [id, position] of expected) {
        assert.equal(itemPositionOf(state, id), position, `event ${index}: ${id}`);
      }
      assert.equal(__foldCacheConsistency(state, { roster: false }), null);
    }
  });
  assert.equal(itemPositionOf(state, "nowhere"), undefined);
  // A state nothing has folded onto (a hand-built one) builds its index on first use.
  const handBuilt: ThreadFoldState = { ...state, activities: state.activities.slice() };
  const lastPosition = (id: string): number =>
    state.items.reduce((found, item, position) => (item.id === id ? position : found), -1);
  // "m-45" is both a message and, later, an activity: the activity's position wins.
  for (const id of ["m-11", "m-45", "a-1495"]) {
    assert.notEqual(lastPosition(id), -1, `${id} is in the window`);
    assert.equal(itemPositionOf(handBuilt, id), lastPosition(id), id);
  }
  assert.equal(state.items[lastPosition("m-45")]?.kind, "activity");
});
