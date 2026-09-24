import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { GOAL_ACTIVITY_KIND } from "@orquester/api/agent-chat";

import {
  clipGoalText,
  goalMarkerOf,
  goalSummaryMarker,
  goalUpdateOf,
  isHiddenGoalActivity
} from "./goal.logic";
import { activity, resetBuilders } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

const goalRow = (payload: unknown, summary = "Goal set: Make CI green") =>
  activity(GOAL_ACTIVITY_KIND, payload, { tone: "info", summary });

describe("goalUpdateOf — a goal row's payload, read through the shared parser (goals §4.3)", () => {
  it("parses a goal row, and only a goal row", () => {
    const row = goalRow({ goal: { objective: "Make CI green", status: "active" }, change: "set" });
    assert.deepEqual(goalUpdateOf(row), {
      goal: { objective: "Make CI green", status: "active" },
      change: "set"
    });
    assert.equal(
      goalUpdateOf(activity("goal.status", { goal: null, change: "cleared" })),
      null,
      "a host /goal status answer is not a goal update"
    );
    assert.equal(goalUpdateOf(activity("tool.completed", { change: "set", goal: null })), null);
  });

  it("is null for a row that does not parse — a newer change, a broken goal", () => {
    assert.equal(goalUpdateOf(goalRow({ goal: null, change: "edited" })), null);
    assert.equal(goalUpdateOf(goalRow({ goal: { objective: "" , status: "active" }, change: "set" })), null);
    assert.equal(goalUpdateOf(goalRow("Goal set")), null);
    assert.equal(goalUpdateOf(goalRow(null)), null);
  });

  it("parses each row once: the fold hands the same activity back on every projection", () => {
    const row = goalRow({ goal: { objective: "Make CI green", status: "active" }, change: "set" });
    assert.equal(goalUpdateOf(row), goalUpdateOf(row));
  });
});

describe("isHiddenGoalActivity — `progress` is the chip's heartbeat, not a row (goals §8.4)", () => {
  it("hides progress and nothing else", () => {
    const goal = { objective: "Make CI green", status: "active", rounds: 2 };
    assert.equal(isHiddenGoalActivity(goalRow({ goal, change: "progress" })), true);
    for (const change of ["set", "replaced", "restored", "checked", "paused", "resumed", "blocked", "limited"]) {
      assert.equal(isHiddenGoalActivity(goalRow({ goal, change })), false, change);
    }
    for (const change of ["achieved", "failed", "cleared"]) {
      assert.equal(isHiddenGoalActivity(goalRow({ goal: null, change, previous: goal })), false, change);
    }
  });

  it("never hides a row it cannot read: an unknown row renders as the generic row (goals §9)", () => {
    assert.equal(isHiddenGoalActivity(goalRow({ goal: null, change: "someday" })), false);
    assert.equal(isHiddenGoalActivity(activity("tool.completed", { change: "progress" })), false);
  });
});

describe("goalMarkerOf — what a marker row needs beyond its summary", () => {
  it("names the current goal", () => {
    assert.deepEqual(
      goalMarkerOf({
        goal: { objective: "Make CI green", status: "active", rounds: 2, lastCheck: "lint fails" },
        change: "checked"
      }),
      { change: "checked", objective: "Make CI green", rounds: 2 }
    );
  });

  it("reads the goal that ENDED when the row's own goal is null", () => {
    assert.deepEqual(
      goalMarkerOf({
        goal: null,
        change: "achieved",
        previous: {
          objective: "Make CI green",
          status: "complete",
          rounds: 4,
          elapsedMs: 725_000,
          tokensUsed: 1_250_000
        }
      }),
      {
        change: "achieved",
        objective: "Make CI green",
        rounds: 4,
        elapsedMs: 725_000,
        tokensUsed: 1_250_000
      }
    );
  });

  it("is the change alone for a row that names no goal at all", () => {
    assert.deepEqual(goalMarkerOf({ goal: null, change: "cleared" }), { change: "cleared" });
  });
});

describe("goalSummaryMarker — the tab marker, off `SessionSummary.goal` (goals §8.3)", () => {
  it("is the in-motion tone while active, the warn tone once stopped short", () => {
    assert.deepEqual(
      goalSummaryMarker({ objective: "Make CI green", status: "active", continuing: true }),
      { tone: "info", label: "Goal: Make CI green (active)" }
    );
    for (const status of ["paused", "blocked", "budget-limited", "usage-limited"]) {
      assert.deepEqual(
        goalSummaryMarker({ objective: "Make CI green", status, continuing: false }),
        { tone: "warn", label: `Goal: Make CI green (${status})` },
        status
      );
    }
  });

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
    assert.deepEqual(goalSummaryMarker({ objective: "Make CI green", status: "active" }), {
      tone: "info",
      label: "Goal: Make CI green (active)"
    });
  });
});

describe("final wave (5): an objective in an accessible name is capped at 200 characters", () => {
  it("clips with an ellipsis inside the cap, and leaves a short text alone", () => {
    assert.equal(clipGoalText("Ship it"), "Ship it");
    const exact = "x".repeat(200);
    assert.equal(clipGoalText(exact), exact, "exactly at the cap is not cut");
    const cut = clipGoalText("y".repeat(4000));
    assert.equal(cut.length, 200);
    assert.ok(cut.endsWith("…"));
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(198)}😀tail`;
    const cut = clipGoalText(text);
    assert.ok(cut.length <= 200);
    assert.ok(!/[\uD800-\uDBFF]…$/.test(cut), "no lone high surrogate before the ellipsis");
  });

  it("the tab marker's label quotes a capped objective", () => {
    const objective = "Refactor every payment provider onto one retry policy. ".repeat(80);
    const marker = goalSummaryMarker({ objective, status: "active", continuing: true });
    assert.ok(marker);
    const quoted = /^Goal: (.*) \(active\)$/.exec(marker.label)?.[1] ?? "";
    assert.ok(quoted.length <= 200, `${quoted.length} characters`);
    assert.ok(quoted.endsWith("…"));
  });
});
