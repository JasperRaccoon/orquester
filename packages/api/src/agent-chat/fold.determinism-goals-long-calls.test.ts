/**
 * The two fold changes a merge once had to renumber together
 * (`FOLD_SNAPSHOT_VERSION` 5: the goals build's 4 and the open-work build's 4)
 * in ONE log: provider goal updates — the thread's goal, which no trim and no
 * rewind touches — among long-running calls and background shells whose
 * opening rows every trim keeps, all of them spending slots of the same parent
 * window. The fold of any prefix — written to `state.json` and read back —
 * folded through the rest of the log reaches exactly the whole log's fold,
 * goal and kept openings included, through serialize → JSON → deserialize at
 * EVERY split point. `splitDivergences` (`fold-logs.test-support.ts`) says what
 * each split checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyDomainEvent, createEmptyThreadState, itemsDroppedByRetention } from "./fold.ts";
import {
  GOAL_LONG_CALL_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  openWorkFate,
  splitDivergences
} from "./fold-logs.test-support.ts";
import { GOAL_ACTIVITY_KIND } from "./goal.ts";

test("goal rows among long-running calls and shells: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 195, steps: 1_400, weights: GOAL_LONG_CALL_WEIGHTS, maxAgents: 1 });
  const { trims, reverts } = landmarks(events);
  // What the log really holds — the open work's side…
  assert.ok(trims.length >= 5, `trims: ${trims.length}`);
  assert.ok(reverts.length >= 2, `rewinds: ${reverts.length}`);
  const fate = openWorkFate(events);
  assert.ok(fate.callsKeptPastATrim >= 10, `calls' openings a trim reached past and kept: ${fate.callsKeptPastATrim}`);
  assert.ok(fate.tasksKeptPastATrim >= 1, `shells' starts a trim reached past and kept: ${fate.tasksKeptPastATrim}`);
  assert.ok(fate.droppedWhileOpen >= 1, `openings a cap pushed out: ${fate.droppedWhileOpen}`);
  assert.ok(fate.droppedAfterClose >= 1, `openings dropped once their work ended: ${fate.droppedAfterClose}`);

  // …and the goal's: goals set, cleared and set again, rows the fold appends
  // without adopting, goal rows the same trims aged out, and a goal that
  // outlived the row it came from.
  let state = createEmptyThreadState();
  let goalRows = 0;
  let adopted = 0;
  let cleared = 0;
  let trimmedGoalRows = 0;
  let outlivedItsRow = 0;
  let adoptedFrom: string | null = null;
  let lastAdoption = -1;
  const holds = (id: string | null, items: typeof state.items): boolean =>
    id !== null && items.some((item) => item.kind === "activity" && item.id === id);
  for (const [index, event] of events.entries()) {
    const next = applyDomainEvent(state, event);
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.activityKind === GOAL_ACTIVITY_KIND
    ) {
      goalRows += 1;
      if (next.goal !== state.goal) {
        adopted += 1;
        adoptedFrom = event.payload.activity.id;
        lastAdoption = index;
        if (next.goal === null) cleared += 1;
      }
    }
    trimmedGoalRows += itemsDroppedByRetention(next).filter(
      (item) => item.kind === "activity" && item.activityKind === GOAL_ACTIVITY_KIND
    ).length;
    if (next.goal != null && holds(adoptedFrom, state.items) && !holds(adoptedFrom, next.items)) {
      outlivedItsRow += 1;
    }
    state = next;
  }
  assert.ok(goalRows >= 30, `goal rows: ${goalRows}`);
  assert.ok(adopted >= 20 && adopted < goalRows, `adopted ${adopted} of ${goalRows}: some never parse`);
  assert.ok(cleared >= 3, `goals cleared: ${cleared}`);
  assert.ok(trimmedGoalRows >= 1, `goal rows aged out: ${trimmedGoalRows}`);
  assert.ok(outlivedItsRow >= 1, `goals that outlived their row: ${outlivedItsRow}`);
  assert.ok(state.goal != null, "the log ends with a goal");

  // Literally folded through the whole tail at every hundredth split, at every
  // trim and rewind, and right after the last goal row the fold adopted: from
  // there on only the snapshot can carry the goal to the log's end.
  const landmark = near([...trims, ...reverts, lastAdoption + 1], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
