/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B) for the
 * two classes whose windows are 2 000 rows: many agents past the ceiling
 * across them, and messages past theirs.
 *
 * As with the fleet log, every split restores the prefix's fold without the
 * fold's caches, the splits around every trim and rewind — and one in 500 —
 * go through serialize → JSON → deserialize, and a few fold the whole tail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "./domain-events.ts";
import {
  AGENT_CEILING_WEIGHTS,
  MESSAGE_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";

function checkEverySplit(events: readonly DomainEvent[], minimumTrims: number): void {
  const { trims, reverts } = landmarks(events);
  assert.ok(trims.length >= minimumTrims, `trims: ${trims.length}`);
  const aroundLandmarks = near([...trims, ...reverts], 1);
  const literal = new Set([trims[0]! - 1, trims[0]!, trims.at(-1)!]);
  assert.deepEqual(
    splitDivergences(events, {
      jsonAt: (split) => aroundLandmarks(split) || split % 500 === 0,
      literalAt: (split) => literal.has(split)
    }),
    []
  );
}

test("agents past the ceiling across them: the fold restored at EVERY split point, plus the tail, is the whole-log fold", () => {
  checkEverySplit(fleetLog({ seed: 5, steps: 6_000, weights: AGENT_CEILING_WEIGHTS, maxAgents: 14 }), 6);
});

test("messages past their window: the fold restored at EVERY split point, plus the tail, is the whole-log fold", () => {
  checkEverySplit(fleetLog({ seed: 4, steps: 4_400, weights: MESSAGE_WEIGHTS }), 6);
});
