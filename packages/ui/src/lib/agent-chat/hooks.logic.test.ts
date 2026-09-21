/**
 * Fix-wave regression for the status line's live timer (E2E E1).
 *
 * `turnStartedAt` is the only signal the status line has that a turn is still
 * running; handing it a settled turn's `startedAt` made "● Working" tick
 * forever against a server that had already reported `ready`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ThreadSessionStatus, Turn, TurnState } from "@orquester/api/agent-chat";

import { turnStartedAt } from "./hooks";

const turn = (state: TurnState, startedAt: string | null = "2026-01-01T00:00:00.000Z"): Turn => ({
  turnId: "t1",
  state,
  turnCount: null,
  requestedAt: "2026-01-01T00:00:00.000Z",
  startedAt,
  completedAt: state === "running" || state === "pending" ? null : "2026-01-01T00:01:00.000Z",
  assistantMessageId: null
});

const at = (state: TurnState, session: ThreadSessionStatus | null): string | null =>
  turnStartedAt(turn(state), session);

describe("E1 — the status timer stops when the turn does", () => {
  it("ticks only while the turn is unsettled AND the session is live", () => {
    assert.equal(at("running", "running"), "2026-01-01T00:00:00.000Z");
    assert.equal(at("pending", "starting"), "2026-01-01T00:00:00.000Z");
  });

  it("stops on every settled turn state", () => {
    for (const state of ["completed", "failed", "interrupted", "cancelled"] as const) {
      assert.equal(at(state, "running"), null, `${state} must not tick`);
    }
  });

  it("stops when the session left `running`, even if the turn row still says running", () => {
    // Session teardown settles a turn by status and that write races
    // `turn.completed` (§5.1) — the timer must not wait for the loser.
    assert.equal(at("running", "ready"), null);
    assert.equal(at("running", "idle"), null);
    assert.equal(at("running", "stopped"), null);
    assert.equal(at("running", "error"), null);
    assert.equal(at("running", null), null);
  });

  it("is null with no turn, or a turn the provider never started", () => {
    assert.equal(turnStartedAt(null, "running"), null);
    assert.equal(turnStartedAt(undefined, "running"), null);
    assert.equal(turnStartedAt(turn("running", null), "running"), null);
  });
});
