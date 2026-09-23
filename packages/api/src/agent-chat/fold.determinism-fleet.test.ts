/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B) over a
 * fleet-shaped log: every retention class trimmed many times at once,
 * questions, markers, stable-id rows replaced in place, collisions, turns.
 *
 * Its window (~4 600 rows) is too big to push through JSON at each of its
 * thousands of splits, so every split restores the prefix's fold without the
 * fold's caches (`withoutCaches`: what a restore builds, minus the codec's
 * validation), the split at every trim — and one in 500 — goes through
 * serialize → JSON → deserialize, and a handful fold the whole tail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FLEET_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";

test("a fleet log: the fold restored at EVERY split point, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 1, steps: 6_500, weights: FLEET_WEIGHTS });
  const { trims } = landmarks(events);
  assert.ok(trims.length >= 5, `trims: ${trims.length}`);
  const atTrims = near(trims, 0);
  const literal = new Set([trims[0]! - 1, trims[0]!, Math.floor(events.length / 2), trims.at(-1)! + 1]);
  assert.deepEqual(
    splitDivergences(events, {
      jsonAt: (split) => atTrims(split) || split % 500 === 0,
      literalAt: (split) => literal.has(split)
    }),
    []
  );
});
