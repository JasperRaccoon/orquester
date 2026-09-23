/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B): the
 * trigger is a function of the state alone, and the fold's caches live beside
 * the state, so the fold of any prefix — written to `state.json` and read back
 * — folded through the rest of the log is exactly the whole-log fold.
 *
 * Here a parent-window log, small enough to go through serialize → JSON →
 * deserialize at EVERY split point: parent rows past their window over and
 * over, message-mode questions answered long after they were asked, approvals,
 * compaction markers, `task-progress:` rows replaced in place, id collisions
 * between messages and activities, turns that settle or stop, and rewinds.
 * `splitDivergences` (`fold-logs.test-support.ts`) says what each split checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAN_PARENT_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";

test("a parent-window log: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 7, steps: 1_300, weights: LEAN_PARENT_WEIGHTS });
  const { trims, reverts } = landmarks(events);
  // What the log really holds.
  assert.ok(trims.length >= 5, `trims: ${trims.length}`);
  assert.ok(reverts.length >= 2, `rewinds: ${reverts.length}`);
  const kinds = new Map<string, number>();
  const seen = new Set<string>();
  let replacedInPlace = 0;
  for (const event of events) {
    if (event.type !== "thread.activity-appended") continue;
    const row = event.payload.activity;
    kinds.set(row.activityKind, (kinds.get(row.activityKind) ?? 0) + 1);
    if (seen.has(row.id)) replacedInPlace += 1;
    seen.add(row.id);
  }
  assert.ok((kinds.get("user-input.resolved") ?? 0) >= 5, "questions answered");
  assert.ok((kinds.get("context-compaction") ?? 0) >= 5, "compaction markers");
  assert.ok(replacedInPlace >= 100, `rows updated in place: ${replacedInPlace}`);

  const landmark = near([...trims, ...reverts], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
