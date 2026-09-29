/**
 * The turn state machine (§5.1). Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/projector.ts:101-115`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Turn } from "./thread.ts";
import { applySessionStatusToTurn } from "./turn-state.ts";

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    turnId: "t1",
    state: "running",
    turnCount: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
    ...overrides
  };
}

test("a settled turn never moves again: a late transition cannot extend it", () => {
  const original = turn({
    state: "interrupted",
    completedAt: "2026-01-01T00:00:05.000Z"
  });
  const next = applySessionStatusToTurn(original, "ready", "2026-01-01T00:01:00.000Z");
  assert.equal(next.state, "interrupted");
  assert.equal(next.completedAt, "2026-01-01T00:00:05.000Z");
});

test("a pending turn (no turn id yet) settles too", () => {
  const settled = applySessionStatusToTurn(
    turn({ turnId: null, state: "pending", startedAt: null }),
    "error",
    "2026-01-01T00:00:09.000Z"
  );
  assert.equal(settled.state, "failed");
});
