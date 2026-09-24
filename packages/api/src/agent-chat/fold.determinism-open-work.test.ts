/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B) over
 * running work: tool calls and background shells that stay open while their
 * output chunks stream past the parent's window and an agent's own, whose
 * opening rows every trim keeps (`FOLD_SNAPSHOT_VERSION` 4) until the work
 * ends or a cap pushes them out — beside calls left open and quiet, turns and
 * a rewind — through serialize → JSON → deserialize at EVERY split point.
 * `splitDivergences` (`fold-logs.test-support.ts`) says what each split
 * checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAN_LONG_CALL_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  openWorkFate,
  splitDivergences
} from "./fold-logs.test-support.ts";

test("a log of long-running calls and shells: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 25, steps: 1_400, weights: LEAN_LONG_CALL_WEIGHTS, maxAgents: 1 });
  const { trims, reverts } = landmarks(events);
  // What the log really holds.
  assert.ok(trims.length >= 5, `trims: ${trims.length}`);
  assert.ok(reverts.length >= 1, `rewinds: ${reverts.length}`);
  const fate = openWorkFate(events);
  assert.ok(fate.callsKeptPastATrim >= 5, `calls' openings a trim reached past and kept: ${fate.callsKeptPastATrim}`);
  assert.ok(fate.tasksKeptPastATrim >= 1, `shells' starts a trim reached past and kept: ${fate.tasksKeptPastATrim}`);
  assert.ok(fate.droppedWhileOpen >= 2, `openings a cap pushed out: ${fate.droppedWhileOpen}`);
  assert.ok(fate.droppedAfterClose >= 2, `openings dropped once their work ended: ${fate.droppedAfterClose}`);

  const landmark = near([...trims, ...reverts], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
