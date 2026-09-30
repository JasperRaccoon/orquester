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
  goalActivitySummary,
  isGoalCommandText,
  isHiddenGoalChange,
  isUnfinishedGoal,
  parseAgentGoal,
  parseGoalUpdatedPayload,
  parseThreadGoal,
  sameGoalState
} from "./goal.ts";
import type { AgentGoal, GoalUpdatedPayload } from "./goal.ts";
import { parseGoalSupport } from "./adapter-types.ts";

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

// --- parseAgentGoal -------------------------------------------------------------

test("parseAgentGoal keeps a full goal field for field", () => {
  assert.deepEqual(parseAgentGoal(FULL), FULL);
});

test("an objective and a status are all a goal needs", () => {
  assert.deepEqual(parseAgentGoal({ objective: "x", status: "paused" }), {
    objective: "x",
    status: "paused"
  });
  for (const status of ["active", "paused", "blocked", "budget-limited", "usage-limited", "complete", "failed"] as const) {
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
  for (const change of ["set", "replaced", "restored", "progress", "checked", "paused", "resumed", "blocked", "limited", "achieved", "failed", "cleared"] as const) {
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

test("a truncated goal summary never splits a surrogate pair", () => {
  const emoji = goalActivitySummary({ goal: goal("🙂".repeat(150)), change: "set" });
  assert.ok(emoji.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), "no lone high surrogate");
});

// --- the predicates ------------------------------------------------------------

test("only a progress row is hidden", () => {
  assert.equal(isHiddenGoalChange("progress"), true);
  for (const change of ["set", "replaced", "restored", "checked", "paused", "resumed", "blocked", "limited", "achieved", "failed", "cleared"] as const) {
    assert.equal(isHiddenGoalChange(change), false, change);
  }
});

test("a goal is unfinished until it is complete or failed", () => {
  assert.equal(isUnfinishedGoal(null), false);
  assert.equal(isUnfinishedGoal(undefined), false);
  for (const status of ["active", "paused", "blocked", "budget-limited", "usage-limited"] as const) {
    assert.equal(isUnfinishedGoal(goal("x", { status })), true, status);
  }
  for (const status of ["complete", "failed"] as const) {
    assert.equal(isUnfinishedGoal(goal("x", { status })), false, status);
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

// ---------------------------------------------------------------------------
// The typed command (§5.1) and the capability block (§4.5)
// ---------------------------------------------------------------------------

test("isGoalCommandText is `/goal` then whitespace or nothing, in any case, after trimming", () => {
  for (const text of ["/goal", "/goal pause", "  /GOAL clear  ", "/Goal Make CI green", "/goal\nfix it", "/goal\tstatus"]) {
    assert.equal(isGoalCommandText(text), true, JSON.stringify(text));
  }
  for (const text of ["/goals", "/goalie", "goal pause", "fix it /goal x", "//goal", "", "   "]) {
    assert.equal(isGoalCommandText(text), false, JSON.stringify(text));
  }
});

test("parseGoalSupport keeps a well-formed block and only the actions this build knows", () => {
  assert.deepEqual(
    parseGoalSupport({ command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true }),
    { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true }
  );
  assert.deepEqual(
    parseGoalSupport({ command: "provider", actions: ["clear", "teleport", "continue", 7], continuesAcrossTurns: false, extra: 1 }),
    { command: "provider", actions: ["continue", "clear"], continuesAcrossTurns: false },
    "an unknown action is dropped, not the block; the order is the spec's; unknown keys go"
  );
});

test("parseGoalSupport reads a block that does not parse as none", () => {
  const good = { command: "host", actions: [], continuesAcrossTurns: true };
  const bad: unknown[] = [
    undefined,
    null,
    "host",
    [good],
    { ...good, command: "server" },
    { ...good, command: undefined },
    { ...good, actions: "pause" },
    { ...good, continuesAcrossTurns: "yes" },
    { command: "host", actions: [] }
  ];
  for (const value of bad) {
    assert.equal(parseGoalSupport(value), null, JSON.stringify(value) ?? String(value));
  }
});
