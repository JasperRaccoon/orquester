import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";

import {
clipGoalText,
goalSummaryMarker,
isGoalHeldForUpdate
} from "./goal.logic";
import { resetBuilders } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("goalSummaryMarker — the tab marker, off `SessionSummary.goal` (goals §8.3)", () => {

  it("draws nothing for no goal or a finished one", () => {
    assert.equal(goalSummaryMarker(null), null);
    assert.equal(goalSummaryMarker(undefined), null);
    assert.equal(goalSummaryMarker({ objective: "x", status: "complete", continuing: false }), null);
    assert.equal(goalSummaryMarker({ objective: "x", status: "failed", continuing: false }), null);
  });

  it("validates the wire field-wise: anything it cannot read draws nothing, never a crash", () => {
    for (const broken of [
      "Make CI green",
      42,
      [],
      {},
      { objective: "", status: "active" },
      { objective: 7, status: "active" },
      { objective: "Make CI green" },
      { objective: "Make CI green", status: "done" }
    ]) {
      assert.equal(goalSummaryMarker(broken), null, JSON.stringify(broken));
    }
    // An older host's summary may omit `continuing`; the marker never read it.
    assert.ok(goalSummaryMarker({ objective: "Make CI green", status: "active" }));
  });
});

describe("final wave (5): an objective in an accessible name is capped at 200 characters", () => {

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(198)}😀tail`;
    const cut = clipGoalText(text);
    assert.ok(cut.length <= 200);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(cut), "no lone high surrogate before the ellipsis");
  });
});

describe("isGoalHeldForUpdate — a deploy HELD the goal between two of its turns (goals §5.7)", () => {
  const paused = { status: "paused" } as const;
  const active = { status: "active" } as const;
  /** `SessionSummary.goal` as the host sends it. */
  const summary = (status: string, continuing: unknown) => ({ objective: "Make CI green", status, continuing });

  it("paused in the fold while the host still reports it continuing: held", () => {
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("paused", true) }),
      true,
      "a paused goal is continuing only while the host holds it"
    );
  });

  it("paused and NOT continuing is an ordinary pause — the user's, a Stop's, a stall's", () => {
    assert.equal(isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("paused", false) }), false);
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("paused", false), goalHeldForHandover: true }),
      false,
      "the host's verdict wins over the head's mark, which only a snapshot refreshes: a Stop released the hold"
    );
  });

  it("an active goal is never held — the chip reads the fold, whatever the summary still says", () => {
    assert.equal(isGoalHeldForUpdate({ goal: active, summaryGoal: summary("active", true) }), false);
    assert.equal(
      isGoalHeldForUpdate({ goal: active, summaryGoal: summary("paused", true), goalHeldForHandover: true }),
      false,
      "the lease ran out and the goal is going again: the summary trails the fold by a poll"
    );
    assert.equal(isGoalHeldForUpdate({ goal: active, goalHeldForHandover: true }), false);
  });

  it("the head's mark decides only when the view has no summary verdict", () => {
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, goalHeldForHandover: true }),
      true,
      "a snapshot's head says held and no summary has arrived yet"
    );
    assert.equal(isGoalHeldForUpdate({ goal: paused, summaryGoal: undefined, goalHeldForHandover: true }), true);
    assert.equal(isGoalHeldForUpdate({ goal: paused }), false, "no mark, no summary: an ordinary pause");
    assert.equal(isGoalHeldForUpdate({ goal: paused, goalHeldForHandover: false }), false);
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, summaryGoal: null, goalHeldForHandover: true }),
      false,
      "`null` IS a verdict: the host holds no unfinished goal for the thread"
    );
  });

  it("a summary that has not caught up with the fold's pause is not a hold", () => {
    // The fold's `paused` arrives live, the summary on the daemon's next poll
    // (1.5 s): a user's Pause or Stop of a continuing goal reads exactly so in
    // between, and must not flash "paused for an Orquester update".
    assert.equal(isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("active", true) }), false);
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("active", true), goalHeldForHandover: true }),
      false,
      "a verdict is final: the head's mark does not reopen it"
    );
  });

  it("only a paused goal can be held: no goal, or one that stopped some other way, is not", () => {
    assert.equal(isGoalHeldForUpdate({ goal: null, summaryGoal: summary("paused", true) }), false);
    assert.equal(isGoalHeldForUpdate({ goal: undefined, goalHeldForHandover: true }), false);
    for (const status of ["blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) {
      assert.equal(
        isGoalHeldForUpdate({ goal: { status }, summaryGoal: summary(status, true), goalHeldForHandover: true }),
        false,
        status
      );
    }
  });

  it("reads the summary field-wise: what is not a verdict leaves the head's mark to decide", () => {
    for (const malformed of [
      summary("paused", "yes"),
      { objective: "Make CI green", status: "paused" },
      "Make CI green",
      7,
      [] as unknown[],
      {}
    ]) {
      assert.equal(
        isGoalHeldForUpdate({ goal: paused, summaryGoal: malformed, goalHeldForHandover: true }),
        true,
        `${JSON.stringify(malformed)} with the mark`
      );
      assert.equal(
        isGoalHeldForUpdate({ goal: paused, summaryGoal: malformed }),
        false,
        `${JSON.stringify(malformed)} without it`
      );
    }
    assert.equal(
      isGoalHeldForUpdate({ goal: paused, summaryGoal: summary("sleeping", true) }),
      false,
      "continuing, but the host's own status cannot be read as paused: never a claimed update"
    );
  });
});
