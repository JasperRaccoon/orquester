import assert from "node:assert/strict";
import test from "node:test";

import type { Turn } from "./thread.ts";
import { startedTurns, turnOrdinal } from "./turns.ts";

function turn(turnId: string | null, extra: Partial<Turn> = {}): Turn {
  return {
    turnId,
    state: turnId === null ? "pending" : "completed",
    turnCount: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: turnId === null ? null : "2026-01-01T00:00:00.000Z",
    completedAt: null,
    assistantMessageId: null,
    ...extra
  };
}

test("startedTurns keeps only rows with a provider turn id, in order", () => {
  const turns = [turn("a"), turn(null), turn("b"), turn("c")];
  assert.deepEqual(
    startedTurns(turns).map((entry) => entry.turnId),
    ["a", "b", "c"]
  );
});

test("a duplicate id counts once, so later ordinals stay aligned", () => {
  const turns = [turn("a"), turn("b"), turn("b"), turn("c")];
  assert.deepEqual(
    startedTurns(turns).map((entry) => entry.turnId),
    ["a", "b", "c"]
  );
  assert.equal(turnOrdinal(turns, "c"), 3);
});

test("turnOrdinal is 1-based and null for a pending or unknown turn", () => {
  const turns = [turn("a"), turn(null), turn("b")];
  assert.equal(turnOrdinal(turns, "a"), 1);
  assert.equal(turnOrdinal(turns, "b"), 2);
  assert.equal(turnOrdinal(turns, "zzz"), null);
});
