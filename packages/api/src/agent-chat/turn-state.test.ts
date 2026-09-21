/**
 * The turn state machine (§5.1). Ported from T3 Code (MIT):
 * `apps/server/src/orchestration/projector.ts:101-115`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { Turn } from "./thread.ts";
import {
  applySessionStatusToTurn,
  deriveLatestTurn,
  isSettledTurnState,
  settledTurnStateForSessionStatus
} from "./turn-state.ts";

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

test("settledTurnStateForSessionStatus is T3's table", () => {
  assert.equal(settledTurnStateForSessionStatus("idle"), "completed");
  assert.equal(settledTurnStateForSessionStatus("ready"), "completed");
  assert.equal(settledTurnStateForSessionStatus("stopped"), "interrupted");
  assert.equal(settledTurnStateForSessionStatus("error"), "failed");
  assert.equal(settledTurnStateForSessionStatus("starting"), null);
  assert.equal(settledTurnStateForSessionStatus("running"), null);
});

test("isSettledTurnState covers exactly the four terminal states", () => {
  assert.equal(isSettledTurnState("completed"), true);
  assert.equal(isSettledTurnState("failed"), true);
  assert.equal(isSettledTurnState("interrupted"), true);
  assert.equal(isSettledTurnState("cancelled"), true);
  assert.equal(isSettledTurnState("running"), false);
  assert.equal(isSettledTurnState("pending"), false);
});

test("a running turn settles on the session leaving running", () => {
  const settled = applySessionStatusToTurn(turn(), "ready", "2026-01-01T00:00:09.000Z");
  assert.equal(settled.state, "completed");
  assert.equal(settled.completedAt, "2026-01-01T00:00:09.000Z");
});

test("a stopped session interrupts the turn but keeps its completedAt stamp", () => {
  const settled = applySessionStatusToTurn(turn(), "stopped", "2026-01-01T00:00:09.000Z");
  assert.equal(settled.state, "interrupted");
  assert.equal(settled.completedAt, "2026-01-01T00:00:09.000Z");
});

test("a still-running session returns the same turn reference", () => {
  const original = turn();
  assert.equal(applySessionStatusToTurn(original, "running", "x"), original);
  assert.equal(applySessionStatusToTurn(original, "starting", "x"), original);
});

test("a settled turn never moves again: a late transition cannot extend it", () => {
  const original = turn({
    state: "interrupted",
    completedAt: "2026-01-01T00:00:05.000Z"
  });
  const next = applySessionStatusToTurn(original, "ready", "2026-01-01T00:01:00.000Z");
  assert.equal(next, original);
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

test("deriveLatestTurn reads the last row, or null", () => {
  assert.equal(deriveLatestTurn([]), null);
  const latest = deriveLatestTurn([
    turn({ turnId: "old", state: "completed", completedAt: "a" }),
    turn({ turnId: "new", state: "running" })
  ]);
  assert.deepEqual(latest, {
    turnId: "new",
    state: "running",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: null
  });
});
