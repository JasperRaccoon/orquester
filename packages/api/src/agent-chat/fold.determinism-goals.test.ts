/**
 * The goal's contract with the fold snapshot (goals §4.4): the fold of any
 * prefix — written to `state.json` and read back — folded through the rest of
 * the log reaches exactly the whole log's goal.
 *
 * Here the parent-window log of `fold.determinism.test.ts` with provider goal
 * updates mixed in: goals set, checked, cleared and set again, rows the fold
 * appends without adopting, goal rows aged out by retention, and goals that
 * outlive their own row when a rewind removes it — through serialize → JSON →
 * deserialize at EVERY split point. `splitDivergences`
 * (`fold-logs.test-support.ts`) says what each split checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyDomainEvent, createEmptyThreadState, itemsDroppedByRetention } from "./fold.ts";
import {
  GOAL_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";
import { GOAL_ACTIVITY_KIND } from "./goal.ts";

test("a log with goal rows: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold — goal included", () => {
  const events = fleetLog({ seed: 5, steps: 1_300, weights: GOAL_WEIGHTS });
  const { trims, reverts } = landmarks(events);
  assert.ok(trims.length >= 3, `trims: ${trims.length}`);
  assert.ok(reverts.length >= 2, `rewinds: ${reverts.length}`);

  // What the log really holds.
  let state = createEmptyThreadState();
  let goalRows = 0;
  let adopted = 0;
  let cleared = 0;
  let trimmedGoalRows = 0;
  let outlivedItsRow = 0;
  let adoptedFrom: string | null = null;
  const holds = (id: string | null, items: typeof state.items): boolean =>
    id !== null && items.some((item) => item.kind === "activity" && item.id === id);
  for (const event of events) {
    const next = applyDomainEvent(state, event);
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.activityKind === GOAL_ACTIVITY_KIND
    ) {
      goalRows += 1;
      if (next.goal !== state.goal) {
        adopted += 1;
        adoptedFrom = event.payload.activity.id;
        if (next.goal === null) cleared += 1;
      }
    }
    trimmedGoalRows += itemsDroppedByRetention(next).filter(
      (item) => item.kind === "activity" && item.activityKind === GOAL_ACTIVITY_KIND
    ).length;
    if (next.goal !== null && holds(adoptedFrom, state.items) && !holds(adoptedFrom, next.items)) {
      outlivedItsRow += 1;
    }
    state = next;
  }
  assert.ok(goalRows >= 30, `goal rows: ${goalRows}`);
  assert.ok(adopted >= 20 && adopted < goalRows, `adopted ${adopted} of ${goalRows}: some never parse`);
  assert.ok(cleared >= 3, `goals cleared: ${cleared}`);
  assert.ok(trimmedGoalRows >= 1, `goal rows aged out: ${trimmedGoalRows}`);
  assert.ok(outlivedItsRow >= 1, `goals that outlived their row: ${outlivedItsRow}`);
  assert.ok(state.goal !== null, "the log ends with a goal");

  const landmark = near([...trims, ...reverts], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
