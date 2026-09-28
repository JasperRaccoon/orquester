import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_GOAL_STATUSES,
  type AdapterGoalSupport,
  type AgentGoal,
  type AgentGoalStatus,
  type GoalAction
} from "@orquester/api/agent-chat";

import { goalActions } from "./goal-chip.ts";

const goal = (overrides: Partial<AgentGoal> = {}): AgentGoal => ({
  objective: "Make CI green",
  status: "active",
  ...overrides
});

// ---------------------------------------------------------------------------
// The action matrix (goals §4.5, §8.2)
// ---------------------------------------------------------------------------

const CLAUDE: AdapterGoalSupport = {
  command: "provider",
  actions: ["continue", "clear"],
  continuesAcrossTurns: false
};
const CODEX: AdapterGoalSupport = {
  command: "host",
  actions: ["pause", "resume", "clear"],
  continuesAcrossTurns: true
};
const GROK: AdapterGoalSupport = {
  command: "provider",
  actions: ["resume", "clear"],
  continuesAcrossTurns: false
};

type Situation = "idle" | "idle+background" | "running" | "running+background";
const SITUATIONS: Record<Situation, { turnRunning: boolean; backgroundLive: boolean }> = {
  idle: { turnRunning: false, backgroundLive: false },
  "idle+background": { turnRunning: false, backgroundLive: true },
  running: { turnRunning: true, backgroundLive: false },
  "running+background": { turnRunning: true, backgroundLive: true }
};

/** Expected actions per status × situation; a status missing from the table offers none. */
type Matrix = Partial<Record<AgentGoalStatus, Record<Situation, readonly GoalAction[]>>>;

const same = (actions: readonly GoalAction[]): Record<Situation, readonly GoalAction[]> => ({
  idle: actions,
  "idle+background": actions,
  running: actions,
  "running+background": actions
});

/** A provider-command adapter offers nothing while a turn runs: its prompts queue behind it. */
const idleOnly = (
  idle: readonly GoalAction[],
  idleWithBackground: readonly GoalAction[] = idle
): Record<Situation, readonly GoalAction[]> => ({
  idle,
  "idle+background": idleWithBackground,
  running: [],
  "running+background": []
});

const EXPECTED: Record<"claude" | "codex" | "grok", { support: AdapterGoalSupport; matrix: Matrix }> = {
  claude: {
    support: CLAUDE,
    matrix: {
      // `continue`: active, no turn running and no background liveness.
      active: idleOnly(["continue", "clear"], ["clear"]),
      paused: idleOnly(["clear"]),
      blocked: idleOnly(["clear"]),
      "budget-limited": idleOnly(["clear"]),
      "usage-limited": idleOnly(["clear"])
    }
  },
  codex: {
    support: CODEX,
    matrix: {
      // A host command: pause while active and clear always, running or not.
      active: same(["pause", "clear"]),
      paused: same(["resume", "clear"]),
      blocked: same(["resume", "clear"]),
      "usage-limited": same(["resume", "clear"]),
      // A budget is not something resuming can fix.
      "budget-limited": same(["clear"])
    }
  },
  grok: {
    support: GROK,
    matrix: {
      active: idleOnly(["clear"]),
      paused: idleOnly(["resume", "clear"]),
      blocked: idleOnly(["resume", "clear"]),
      "usage-limited": idleOnly(["resume", "clear"]),
      "budget-limited": idleOnly(["clear"])
    }
  }
};

for (const [adapter, { support, matrix }] of Object.entries(EXPECTED)) {
  test(`the action matrix — ${adapter} × every status × running/idle × background liveness`, () => {
    for (const status of AGENT_GOAL_STATUSES) {
      for (const [situation, flags] of Object.entries(SITUATIONS) as Array<
        [Situation, (typeof SITUATIONS)[Situation]]
      >) {
        const offered = goalActions({ goal: goal({ status }), support, ...flags }).map(
          (model) => model.action
        );
        assert.deepEqual(
          offered,
          matrix[status]?.[situation] ?? [],
          `${adapter} ${status} ${situation}`
        );
      }
    }
  });
}

test("no goal, a finished goal, or no goal support ⇒ no actions", () => {
  const idle = SITUATIONS.idle;
  assert.deepEqual(goalActions({ goal: null, support: CODEX, ...idle }), []);
  assert.deepEqual(goalActions({ goal: undefined, support: CODEX, ...idle }), []);
  assert.deepEqual(goalActions({ goal: goal({ status: "complete" }), support: CODEX, ...idle }), []);
  // OpenCode — and a snapshot from a host that predates goals — has no block.
  assert.deepEqual(goalActions({ goal: goal(), support: null, ...idle }), []);
  assert.deepEqual(goalActions({ goal: goal(), support: undefined, ...idle }), []);
});

test("only the actions an adapter honours are ever offered", () => {
  const onlyClear: AdapterGoalSupport = { command: "host", actions: ["clear"], continuesAcrossTurns: true };
  assert.deepEqual(
    goalActions({ goal: goal({ status: "paused" }), support: onlyClear, ...SITUATIONS.idle }).map(
      (model) => model.action
    ),
    ["clear"]
  );
  const none: AdapterGoalSupport = { command: "provider", actions: [], continuesAcrossTurns: false };
  assert.deepEqual(goalActions({ goal: goal(), support: none, ...SITUATIONS.idle }), []);
});

test("each action sends exactly the §8.2 text, as the user's message", () => {
  const text = (status: AgentGoalStatus, support: AdapterGoalSupport) =>
    Object.fromEntries(goalActions({ goal: goal({ status }), support, ...SITUATIONS.idle })
      .map((model) => [model.action, model.text]));
  assert.deepEqual(text("active", CLAUDE), {
    continue: "Continue working toward the goal.",
    clear: "/goal clear"
  });
  assert.deepEqual(text("active", CODEX), { pause: "/goal pause", clear: "/goal clear" });
  assert.deepEqual(text("paused", CODEX), { resume: "/goal resume", clear: "/goal clear" });
});
