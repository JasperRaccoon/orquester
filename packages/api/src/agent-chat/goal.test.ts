/**
 * Provider-native goals — the normalised shape, its parsers and the row text
 * (goals §4.1, §4.3; `docs/superpowers/specs/2026-09-24-agent-goals-design.md`).
 *
 * Every parser here reads a provider- or disk-shaped value, so each is tested
 * against what it must refuse as much as against what it keeps.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_GOAL_CHANGES,
  AGENT_GOAL_STATUSES,
  GOAL_ACTIVITY_KIND,
  GOAL_COMMAND_FAILED_ACTIVITY_KIND,
  GOAL_STATUS_ACTIVITY_KIND,
  GOAL_SUMMARY_TEXT_CHARS,
  goalActivitySummary,
  isHiddenGoalChange,
  isUnfinishedGoal,
  parseAgentGoal,
  parseGoalUpdatedPayload,
  parseThreadGoal,
  sameGoalState
} from "./goal.ts";
import type { AgentGoal, AgentGoalChange, AgentGoalStatus, GoalUpdatedPayload } from "./goal.ts";

/** Fails to compile if `T` is not exactly `U`. */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

const FULL: AgentGoal = {
  objective: "Make CI green",
  status: "active",
  goalId: "goal-1",
  phase: "verifying",
  rounds: 2,
  lastCheck: "lint still fails",
  tokensUsed: 12_345,
  tokenBudget: 200_000,
  elapsedMs: 90_000,
  setAt: "2026-09-24T10:00:00.000Z"
};

function goal(objective: string, extra: Partial<AgentGoal> = {}): AgentGoal {
  return { objective, status: "active", ...extra };
}

// --- the vocabulary -----------------------------------------------------------

test("the goal vocabularies are exactly the goals spec's", () => {
  const statuses: Exact<
    AgentGoalStatus,
    "active" | "paused" | "blocked" | "budget-limited" | "usage-limited" | "complete" | "failed"
  > = true;
  const changes: Exact<
    AgentGoalChange,
    | "set"
    | "replaced"
    | "restored"
    | "progress"
    | "checked"
    | "paused"
    | "resumed"
    | "blocked"
    | "limited"
    | "achieved"
    | "failed"
    | "cleared"
  > = true;
  assert.ok(statuses && changes);
  assert.deepEqual(AGENT_GOAL_STATUSES, [
    "active",
    "paused",
    "blocked",
    "budget-limited",
    "usage-limited",
    "complete",
    "failed"
  ]);
  assert.deepEqual(AGENT_GOAL_CHANGES, [
    "set",
    "replaced",
    "restored",
    "progress",
    "checked",
    "paused",
    "resumed",
    "blocked",
    "limited",
    "achieved",
    "failed",
    "cleared"
  ]);
  assert.equal(GOAL_ACTIVITY_KIND, "goal.updated");
  assert.equal(GOAL_STATUS_ACTIVITY_KIND, "goal.status");
  assert.equal(GOAL_COMMAND_FAILED_ACTIVITY_KIND, "goal.command.failed");
  assert.equal(GOAL_SUMMARY_TEXT_CHARS, 200);
});

// --- parseAgentGoal -------------------------------------------------------------

test("parseAgentGoal keeps a full goal field for field", () => {
  assert.deepEqual(parseAgentGoal(FULL), FULL);
});

test("an objective and a status are all a goal needs", () => {
  assert.deepEqual(parseAgentGoal({ objective: "x", status: "paused" }), {
    objective: "x",
    status: "paused"
  });
  for (const status of AGENT_GOAL_STATUSES) {
    assert.deepEqual(parseAgentGoal({ objective: "x", status }), { objective: "x", status });
  }
});

test("a goal without a usable objective or status is no goal", () => {
  const rejected: Array<[string, unknown]> = [
    ["no objective", { status: "active" }],
    ["an empty objective", { objective: "", status: "active" }],
    ["a numeric objective", { objective: 5, status: "active" }],
    ["a null objective", { objective: null, status: "active" }],
    ["no status", { objective: "x" }],
    ["an unknown status", { objective: "x", status: "done" }],
    ["a provider's own spelling", { objective: "x", status: "budgetLimited" }],
    ["a status in another case", { objective: "x", status: "Active" }],
    ["a numeric status", { objective: "x", status: 1 }]
  ];
  for (const [label, value] of rejected) {
    assert.equal(parseAgentGoal(value), null, label);
  }
});

test("anything that is not a record is no goal, and nothing makes the parser throw", () => {
  for (const value of [null, undefined, "goal", 5, true, [], [FULL], () => FULL, Symbol("g"), 5n]) {
    assert.equal(parseAgentGoal(value), null, `expected null for ${String(value)}`);
  }
  assert.equal(parseAgentGoal(Object.create(null)), null);
  assert.equal(parseAgentGoal(new Date()), null);
});

test("an optional field of the wrong type or range is dropped, and the goal kept", () => {
  const minimal = { objective: "x", status: "active" };
  const dropped: Array<[string, Record<string, unknown>]> = [
    ["a numeric goalId", { goalId: 5 }],
    ["an empty goalId", { goalId: "" }],
    ["an empty phase", { phase: "" }],
    ["a negative round count", { rounds: -1 }],
    ["a NaN round count", { rounds: Number.NaN }],
    ["an infinite round count", { rounds: Number.POSITIVE_INFINITY }],
    ["a round count spelled as a string", { rounds: "3" }],
    ["a lastCheck that is a record", { lastCheck: { reason: "x" } }],
    ["an empty lastCheck", { lastCheck: "" }],
    ["negative tokens", { tokensUsed: -5 }],
    ["a negative budget", { tokenBudget: -1 }],
    ["a budget spelled as a string", { tokenBudget: "100" }],
    ["a NaN elapsed time", { elapsedMs: Number.NaN }],
    ["a numeric setAt", { setAt: 0 }],
    ["an empty setAt", { setAt: "" }]
  ];
  for (const [label, extra] of dropped) {
    assert.deepEqual(parseAgentGoal({ ...minimal, ...extra }), minimal, label);
  }
});

test("a null token budget is kept — the goal has none — and zero is a count, not a gap", () => {
  assert.deepEqual(parseAgentGoal({ objective: "x", status: "active", tokenBudget: null }), {
    objective: "x",
    status: "active",
    tokenBudget: null
  });
  assert.deepEqual(
    parseAgentGoal({
      objective: "x",
      status: "active",
      rounds: 0,
      tokensUsed: 0,
      tokenBudget: 0,
      elapsedMs: 0
    }),
    { objective: "x", status: "active", rounds: 0, tokensUsed: 0, tokenBudget: 0, elapsedMs: 0 }
  );
});

test("unknown keys are dropped, a thread goal's updatedAt included", () => {
  const parsed = parseAgentGoal({ ...FULL, updatedAt: "2026-09-24T11:00:00.000Z", extra: { a: 1 } });
  assert.deepEqual(parsed, FULL);
  assert.equal(parsed !== null && "updatedAt" in parsed, false);
});

test("parsing is idempotent and never shares the input object", () => {
  const once = parseAgentGoal({ ...FULL, rounds: -1, junk: true });
  assert.ok(once !== null);
  assert.deepEqual(parseAgentGoal(once), once);
  assert.notEqual(parseAgentGoal(FULL), FULL);
});

// --- parseGoalUpdatedPayload ------------------------------------------------------

test("a payload with a goal, a change and the previous goal parses", () => {
  const payload: GoalUpdatedPayload = {
    goal: goal("Ship it", { rounds: 1 }),
    change: "replaced",
    previous: goal("Old aim")
  };
  assert.deepEqual(parseGoalUpdatedPayload(payload), payload);
});

test("a null goal is the thread having none any more", () => {
  const payload: GoalUpdatedPayload = {
    goal: null,
    change: "cleared",
    previous: goal("Ship it")
  };
  assert.deepEqual(parseGoalUpdatedPayload(payload), payload);
  assert.deepEqual(parseGoalUpdatedPayload({ goal: null, change: "cleared" }), {
    goal: null,
    change: "cleared"
  });
});

test("a goal that does not parse, or no goal field at all, is no payload", () => {
  assert.equal(parseGoalUpdatedPayload({ goal: { objective: "", status: "active" }, change: "set" }), null);
  assert.equal(parseGoalUpdatedPayload({ goal: "Ship it", change: "set" }), null);
  assert.equal(parseGoalUpdatedPayload({ change: "set" }), null);
  assert.equal(parseGoalUpdatedPayload({ goal: undefined, change: "set" }), null);
});

test("an unknown or missing change is no payload", () => {
  for (const change of ["done", "Set", "", 3, null, undefined]) {
    assert.equal(
      parseGoalUpdatedPayload({ goal: goal("x"), change }),
      null,
      `change ${String(change)}`
    );
  }
  for (const change of AGENT_GOAL_CHANGES) {
    assert.notEqual(parseGoalUpdatedPayload({ goal: goal("x"), change }), null, change);
  }
});

test("a previous goal that does not parse is dropped, and the payload kept", () => {
  for (const previous of [null, { status: "complete" }, "Ship it", 7]) {
    assert.deepEqual(
      parseGoalUpdatedPayload({ goal: null, change: "achieved", previous }),
      { goal: null, change: "achieved" },
      `previous ${JSON.stringify(previous)}`
    );
  }
});

test("unknown keys are dropped at every level of the payload", () => {
  assert.deepEqual(
    parseGoalUpdatedPayload({
      goal: { ...goal("x"), extra: 1 },
      change: "set",
      previous: { ...goal("y"), extra: 2 },
      turnId: "t-1"
    }),
    { goal: goal("x"), change: "set", previous: goal("y") }
  );
});

test("anything that is not a record is no payload", () => {
  for (const value of [null, undefined, "goal.updated", 1, [], true]) {
    assert.equal(parseGoalUpdatedPayload(value), null);
  }
});

// --- goalActivitySummary (§4.3) -----------------------------------------------------

test("the row text follows §4.3's table", () => {
  const cases: Array<[GoalUpdatedPayload, string]> = [
    [{ goal: goal("Ship it"), change: "set" }, "Goal set: Ship it"],
    [{ goal: goal("Ship it"), change: "replaced", previous: goal("Old") }, "Goal replaced: Ship it"],
    [{ goal: goal("Ship it"), change: "restored" }, "Goal restored: Ship it"],
    [{ goal: goal("Ship it", { rounds: 4 }), change: "progress" }, "Goal progress"],
    [
      { goal: goal("Ship it", { rounds: 3, lastCheck: "tests still fail" }), change: "checked" },
      "Goal check 3: not met — tests still fail"
    ],
    [{ goal: goal("Ship it", { rounds: 3 }), change: "checked" }, "Goal check 3: not met"],
    [{ goal: goal("Ship it", { status: "paused" }), change: "paused" }, "Goal paused"],
    [{ goal: goal("Ship it"), change: "resumed" }, "Goal resumed"],
    [
      { goal: goal("Ship it", { status: "blocked", lastCheck: "needs a deploy key" }), change: "blocked" },
      "Goal blocked: needs a deploy key"
    ],
    [{ goal: goal("Ship it", { status: "blocked" }), change: "blocked" }, "Goal blocked"],
    [
      { goal: goal("Ship it", { status: "budget-limited" }), change: "limited" },
      "Goal stopped: token budget reached"
    ],
    [
      { goal: goal("Ship it", { status: "usage-limited" }), change: "limited" },
      "Goal stopped: usage limit reached"
    ],
    [
      { goal: null, change: "achieved", previous: goal("Ship it", { status: "complete" }) },
      "Goal achieved: Ship it"
    ],
    [{ goal: goal("Ship it", { status: "complete" }), change: "achieved" }, "Goal achieved: Ship it"],
    [
      {
        goal: null,
        change: "failed",
        previous: goal("Ship it", { status: "failed", lastCheck: "the API was removed" })
      },
      "Goal can't be met: the API was removed"
    ],
    [{ goal: goal("Ship it", { status: "failed" }), change: "failed" }, "Goal can't be met"],
    [{ goal: null, change: "cleared", previous: goal("Ship it") }, "Goal cleared: Ship it"],
    [{ goal: null, change: "cleared" }, "Goal cleared"]
  ];
  for (const [payload, expected] of cases) {
    assert.equal(goalActivitySummary(payload), expected, `${payload.change}`);
  }
});

test("a row that names no goal still has a label", () => {
  for (const change of AGENT_GOAL_CHANGES) {
    const text = goalActivitySummary({ goal: null, change });
    assert.ok(text.startsWith("Goal"), `${change}: ${text}`);
    assert.ok(!text.endsWith(":") && !text.includes("undefined"), `${change}: ${text}`);
  }
});

test("a limit the goal does not name reads as the token budget", () => {
  // Grok's `budget_exceeded` may arrive before its status catches up.
  assert.equal(
    goalActivitySummary({ goal: goal("Ship it"), change: "limited" }),
    "Goal stopped: token budget reached"
  );
});

test("an objective is cut to 200 characters with an ellipsis; the payload keeps it whole", () => {
  const long = "x".repeat(500);
  const payload: GoalUpdatedPayload = { goal: goal(long), change: "set" };
  const text = goalActivitySummary(payload);
  assert.equal(text, `Goal set: ${"x".repeat(GOAL_SUMMARY_TEXT_CHARS - 1)}…`);
  assert.equal(payload.goal?.objective, long, "the payload is never shortened");

  const exact = "y".repeat(GOAL_SUMMARY_TEXT_CHARS);
  assert.equal(goalActivitySummary({ goal: goal(exact), change: "set" }), `Goal set: ${exact}`);
  assert.equal(
    goalActivitySummary({ goal: null, change: "cleared", previous: goal(long) }),
    `Goal cleared: ${"x".repeat(GOAL_SUMMARY_TEXT_CHARS - 1)}…`
  );
});

test("the cut never splits a surrogate pair, and drops the whitespace before the ellipsis", () => {
  const emoji = goalActivitySummary({ goal: goal("🙂".repeat(150)), change: "set" });
  assert.ok(emoji.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), "no lone high surrogate");
  assert.ok(emoji.length <= "Goal set: ".length + GOAL_SUMMARY_TEXT_CHARS);

  const spaced = goalActivitySummary({
    goal: goal(`${"a".repeat(GOAL_SUMMARY_TEXT_CHARS - 3)}   tail`),
    change: "set"
  });
  assert.equal(spaced, `Goal set: ${"a".repeat(GOAL_SUMMARY_TEXT_CHARS - 3)}…`);
});

test("a long last check is cut the same way", () => {
  const reason = "r".repeat(1_000);
  assert.equal(
    goalActivitySummary({ goal: goal("x", { rounds: 1, lastCheck: reason }), change: "checked" }),
    `Goal check 1: not met — ${"r".repeat(GOAL_SUMMARY_TEXT_CHARS - 1)}…`
  );
});

// --- the predicates ------------------------------------------------------------

test("only a progress row is hidden", () => {
  for (const change of AGENT_GOAL_CHANGES) {
    assert.equal(isHiddenGoalChange(change), change === "progress", change);
  }
});

test("a goal is unfinished until it is complete or failed", () => {
  assert.equal(isUnfinishedGoal(null), false);
  assert.equal(isUnfinishedGoal(undefined), false);
  for (const status of AGENT_GOAL_STATUSES) {
    assert.equal(
      isUnfinishedGoal(goal("x", { status })),
      status !== "complete" && status !== "failed",
      status
    );
  }
});

test("sameGoalState compares objective, status, rounds, phase and last check — nothing else", () => {
  const base = goal("x", { rounds: 1, phase: "planning", lastCheck: "not yet" });
  assert.equal(
    sameGoalState(base, {
      ...base,
      goalId: "g",
      tokensUsed: 99,
      tokenBudget: null,
      elapsedMs: 5,
      setAt: "2026-09-24T10:00:00.000Z"
    }),
    true,
    "counters and ids are not state"
  );
  const moved: Array<[string, Partial<AgentGoal>]> = [
    ["objective", { objective: "y" }],
    ["status", { status: "paused" }],
    ["rounds", { rounds: 2 }],
    ["phase", { phase: "executing" }],
    ["lastCheck", { lastCheck: "still not" }]
  ];
  for (const [field, patch] of moved) {
    assert.equal(sameGoalState(base, { ...base, ...patch }), false, field);
  }
  const { rounds: _rounds, ...withoutRounds } = base;
  assert.equal(sameGoalState(base, withoutRounds), false, "a count that appears is a change");
});

test("sameGoalState reads no goal as no goal, whichever way it is spelled", () => {
  assert.equal(sameGoalState(null, null), true);
  assert.equal(sameGoalState(undefined, null), true);
  assert.equal(sameGoalState(null, goal("x")), false);
  assert.equal(sameGoalState(goal("x"), undefined), false);
});

// --- parseThreadGoal ------------------------------------------------------------------

test("a thread goal is a goal plus the string updatedAt of the row that produced it", () => {
  const stored = { ...FULL, updatedAt: "2026-09-24T11:00:00.000Z" };
  assert.deepEqual(parseThreadGoal(stored), stored);
  assert.deepEqual(parseThreadGoal({ objective: "x", status: "failed", updatedAt: "" }), {
    objective: "x",
    status: "failed",
    updatedAt: ""
  });
});

test("a thread goal without a string updatedAt, or whose goal does not parse, is none", () => {
  assert.equal(parseThreadGoal(FULL), null, "no updatedAt");
  assert.equal(parseThreadGoal({ ...FULL, updatedAt: 5 }), null);
  assert.equal(parseThreadGoal({ ...FULL, status: "done", updatedAt: "2026-09-24T11:00:00.000Z" }), null);
  for (const value of [null, undefined, "goal", []]) {
    assert.equal(parseThreadGoal(value), null);
  }
});
