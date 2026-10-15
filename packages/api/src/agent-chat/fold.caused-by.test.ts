/**
 * `causedBy` on the turn-start event (unified MCP design 2026-10-15 §8.4): folded onto
 * `Turn.causedBy`, kept by the turn-only reducer and the snapshot cache, tolerant of older logs
 * (no field) and of a value that does not parse.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { applyTurnEvent, foldThread } from "./fold.ts";
import { deserializeFoldState, serializeFoldState } from "./fold-snapshot.ts";
import type { DomainEvent } from "./domain-events.ts";
import type { Turn } from "./thread.ts";
import { created, ev, resetSeq, session } from "./test-helpers.ts";

const exchange = { threadId: "requester", exchangeId: "ex-1", hop: 3 };

function log(causedBy?: unknown): DomainEvent[] {
  resetSeq();
  return [
    created(),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "u1",
      interactionMode: "default",
      ...(causedBy !== undefined ? { causedBy: causedBy as never } : {})
    }),
    ev("thread.session-set", { session: session("running", "T-1") }),
    ev("thread.session-set", { session: session("ready", null) })
  ];
}

test("an agent-caused turn keeps its causedBy through the fold, the turn reducer and the snapshot cache", () => {
  const events = log(exchange);
  const state = foldThread(events);
  assert.deepEqual(state.turns[0]?.causedBy, exchange);
  assert.equal(state.turns[0]?.state, "completed", "settling the turn keeps the field");

  let turns: Turn[] = [];
  for (const event of events) turns = applyTurnEvent(turns, event);
  assert.deepEqual(turns[0]?.causedBy, exchange);

  const restored = deserializeFoldState(JSON.parse(JSON.stringify(serializeFoldState(state))));
  assert.ok(restored);
  assert.deepEqual(restored.turns[0]?.causedBy, exchange);
});

test("a user-authored turn and every turn of an older log carry no causedBy", () => {
  const state = foldThread(log());
  assert.equal(state.turns.length, 1);
  assert.equal("causedBy" in state.turns[0]!, false);
});

test("a causedBy that does not parse is no exchange, and the turn still folds", () => {
  for (const bad of [{ threadId: "", exchangeId: "x", hop: 1 }, { threadId: "a", exchangeId: "x", hop: 0 }, "ex-1", null]) {
    const state = foldThread(log(bad));
    assert.equal(state.turns.length, 1);
    assert.equal("causedBy" in state.turns[0]!, false, JSON.stringify(bad));
  }
});
