/**
 * Batch retention's contract with the fold snapshot (design
 * `docs/superpowers/specs/2026-09-23-fold-performance-design.md`, B), for the
 * windows agents own: two agents, each well past its own 200-row window again
 * and again, with their anchors, stable `tool-progress:` rows replaced in
 * place, rows stamped with another agent's instant, parent rows, messages and
 * turns — through serialize → JSON → deserialize at EVERY split point.
 * `splitDivergences` (`fold-logs.test-support.ts`) says what each split checks.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_WEIGHTS,
  fleetLog,
  landmarks,
  near,
  splitDivergences
} from "./fold-logs.test-support.ts";

test("an agents-window log: the snapshot at EVERY split point, through JSON, plus the tail, is the whole-log fold", () => {
  const events = fleetLog({ seed: 3, steps: 2_000, weights: AGENT_WEIGHTS, maxAgents: 2 });
  const { trims, reverts } = landmarks(events);
  assert.ok(trims.length >= 4, `trims: ${trims.length}`);
  const agentRows = events.filter(
    (event) => event.type === "thread.activity-appended" && event.payload.activity.agentId !== undefined
  ).length;
  assert.ok(agentRows >= 1_000, `agent-owned rows: ${agentRows}`);

  const landmark = near([...trims, ...reverts], 0);
  assert.deepEqual(
    splitDivergences(events, { literalAt: (split) => split % 100 === 0 || landmark(split) }),
    []
  );
});
