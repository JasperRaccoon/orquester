/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B) over an
 * older log's thread-state rows: the legacy compaction marker
 * (`thread.state.changed {state: "compacted"}`), which the parent window keeps
 * whatever its age since `FOLD_SNAPSHOT_VERSION` 3, as it keeps
 * `context-compaction`; every other state, which it drops like any row; and
 * rows replaced in place across that exemption, which move between the
 * droppable and the kept class where they stand — beside the parent-window
 * traffic of `fold.determinism.test.ts`, through serialize → JSON →
 * deserialize at EVERY split point. `splitDivergences`
 * (`fold-logs.test-support.ts`) says what each split checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_PARENT_WEIGHTS,
  fleetLog,
  landmarks,
  legacyStateFate,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";

test("a log with legacy compaction markers: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 10, steps: 1_300, weights: LEGACY_PARENT_WEIGHTS });
  const { trims, reverts } = landmarks(events);
  // What the log really holds.
  assert.ok(trims.length >= 5, `trims: ${trims.length}`);
  assert.ok(reverts.length >= 2, `rewinds: ${reverts.length}`);
  const fate = legacyStateFate(events);
  assert.equal(fate.droppedParentMarkers, 0, "retention never drops a parent's legacy marker");
  assert.ok(fate.keptPastATrim >= 5, `legacy markers a trim reached past: ${fate.keptPastATrim}`);
  assert.ok(fate.droppedOtherStates >= 5, `other thread-state rows dropped: ${fate.droppedOtherStates}`);
  assert.ok(fate.movedInPlace >= 5, `rows moved across the exemption in place: ${fate.movedInPlace}`);

  const landmark = near([...trims, ...reverts], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
