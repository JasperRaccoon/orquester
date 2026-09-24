import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_GOAL_STATUSES,
  type AdapterGoalSupport,
  type AgentGoal,
  type AgentGoalStatus,
  type GoalAction
} from "@orquester/api/agent-chat";

import { setActiveChatTab } from "../../../lib/agent-chat-active-tab.ts";
import { dropdownPanelAttributes } from "../../ui/dropdown-logic.ts";
import { formatRowTimestamp, formatRowTimestampTooltip } from "../timeline/timestamp-format.ts";
import {
  deriveGoalChip,
  deriveGoalPanel,
  formatGoalElapsed,
  formatGoalPhase,
  goalActions,
  goalActionsNote,
  GOAL_ACTION_TEXT,
  GOAL_ACTIONS_WAIT_NOTE,
  goalPopoverProps
} from "./goal-chip.ts";

const goal = (overrides: Partial<AgentGoal> = {}): AgentGoal => ({
  objective: "Make CI green",
  status: "active",
  ...overrides
});

// ---------------------------------------------------------------------------
// The chip (goals §8.2)
// ---------------------------------------------------------------------------

test("the chip shows exactly the unfinished goals", () => {
  assert.equal(deriveGoalChip(null, false), null);
  assert.equal(deriveGoalChip(undefined, false), null);
  assert.equal(deriveGoalChip(goal({ status: "complete" }), false), null, "an achieved goal has no chip");
  assert.equal(deriveGoalChip(goal({ status: "failed" }), false), null, "nor does one that can't be met");
  for (const status of ["active", "paused", "blocked", "budget-limited", "usage-limited"] as const) {
    assert.ok(deriveGoalChip(goal({ status }), false), status);
  }
});

test("the chip's detail, per status — the §8.2 table", () => {
  const cases: Array<[Partial<AgentGoal>, string | null]> = [
    // active ⇒ `round <n>` when rounds > 0, else the phase when set, else nothing
    [{ status: "active", rounds: 3 }, "round 3"],
    [{ status: "active", rounds: 3, phase: "verifying" }, "round 3"],
    [{ status: "active", rounds: 0, phase: "planning" }, "planning"],
    [{ status: "active", phase: "executing" }, "executing"],
    [{ status: "active", rounds: 0 }, null],
    [{ status: "active" }, null],
    // stopped short ⇒ what stopped it
    [{ status: "paused", rounds: 4, phase: "idle" }, "paused"],
    [{ status: "blocked" }, "blocked"],
    [{ status: "budget-limited" }, "budget"],
    [{ status: "usage-limited" }, "limit"]
  ];
  for (const [overrides, detail] of cases) {
    assert.equal(deriveGoalChip(goal(overrides), false)?.detail, detail, JSON.stringify(overrides));
  }
});

test("the chip adds `<used>/<budget> tok` only when both are known", () => {
  assert.equal(
    deriveGoalChip(goal({ tokensUsed: 12_400, tokenBudget: 50_000 }), false)?.tokens,
    "12k/50k tok"
  );
  assert.equal(
    deriveGoalChip(goal({ status: "budget-limited", tokensUsed: 1_250_000, tokenBudget: 1_000_000 }), false)
      ?.tokens,
    "1.3m/1m tok"
  );
  assert.equal(deriveGoalChip(goal({ tokensUsed: 12_400 }), false)?.tokens, null, "no budget");
  assert.equal(
    deriveGoalChip(goal({ tokensUsed: 12_400, tokenBudget: null }), false)?.tokens,
    null,
    "a cleared budget is no budget"
  );
  assert.equal(deriveGoalChip(goal({ tokenBudget: 50_000 }), false)?.tokens, null, "nothing used yet is unknown, not zero");
});

test("info while active, warn once the goal has stopped short", () => {
  assert.equal(deriveGoalChip(goal({ status: "active" }), false)?.tone, "info");
  for (const status of ["paused", "blocked", "budget-limited", "usage-limited"] as const) {
    assert.equal(deriveGoalChip(goal({ status }), false)?.tone, "warn", status);
  }
});

test("the label shimmers only while an ACTIVE goal's turn is running", () => {
  assert.equal(deriveGoalChip(goal(), true)?.live, true);
  assert.equal(deriveGoalChip(goal(), false)?.live, false, "an idle active goal is not in motion");
  assert.equal(
    deriveGoalChip(goal({ status: "paused" }), true)?.live,
    false,
    "a paused goal does not shimmer just because some turn is running"
  );
});

test("the chip's title is the objective, and its spoken name says what state it is in", () => {
  const chip = deriveGoalChip(goal({ objective: "Ship the release", status: "usage-limited" }), false);
  assert.equal(chip?.title, "Ship the release");
  assert.equal(
    chip?.ariaLabel,
    "Goal: Ship the release (usage-limited)",
    "a stopped goal's detail only restates its status, so it is not said twice"
  );
  assert.equal(
    deriveGoalChip(goal({ rounds: 3, tokensUsed: 12_400, tokenBudget: 50_000 }), false)?.ariaLabel,
    "Goal: Make CI green (active), round 3, 12k/50k tok",
    "an active goal's detail and the tokens are part of what the chip says"
  );
});

test("a phase reads as words; the one Orquester itself names reads as a sentence", () => {
  assert.equal(formatGoalPhase("waiting-background"), "waiting on background work");
  assert.equal(formatGoalPhase("worker_round"), "worker round");
  assert.equal(formatGoalPhase("  "), null);
  assert.equal(formatGoalPhase(undefined), null);
  assert.equal(deriveGoalChip(goal({ phase: "waiting-background" }), false)?.detail, "waiting on background work");
});

// ---------------------------------------------------------------------------
// The popover's readout
// ---------------------------------------------------------------------------

test("the popover names the status, and the phase only when there is one", () => {
  const labels: Record<AgentGoalStatus, string> = {
    active: "Active",
    paused: "Paused",
    blocked: "Blocked",
    "budget-limited": "Token budget reached",
    "usage-limited": "Usage limit reached",
    complete: "Achieved",
    failed: "Can't be met"
  };
  for (const status of AGENT_GOAL_STATUSES) {
    const panel = deriveGoalPanel(goal({ status }));
    assert.equal(panel.statusLabel, labels[status], status);
    assert.equal(panel.phase, null, status);
  }
  assert.equal(deriveGoalPanel(goal({ phase: "verifying" })).phase, "verifying");
});

test("the popover carries the whole objective and every fact the provider reported — only those", () => {
  const long = "Refactor the payment module ".repeat(40).trim();
  const setAt = "2026-09-24T08:15:00.000Z";
  const now = new Date("2026-09-24T12:00:00.000Z");
  const full = deriveGoalPanel(
    goal({
      objective: long,
      rounds: 3,
      lastCheck: "two integration tests still fail",
      tokensUsed: 12_400,
      tokenBudget: 50_000,
      elapsedMs: 725_000,
      setAt
    }),
    now
  );
  assert.equal(full.objective, long, "the popover is where the uncut objective lives");
  assert.equal(full.rounds, "3");
  assert.equal(full.lastCheck, "two integration tests still fail");
  assert.equal(full.tokens, "12k of 50k");
  assert.equal(full.elapsed, "12m 5s");
  assert.equal(full.setAt, formatRowTimestamp(setAt, now));
  assert.equal(full.setAtTitle, formatRowTimestampTooltip(setAt));

  const bare = deriveGoalPanel(goal());
  assert.deepEqual(
    [bare.rounds, bare.lastCheck, bare.tokens, bare.elapsed, bare.setAt, bare.setAtTitle],
    [null, null, null, null, null, null],
    "an unknown fact is absent, never a zero"
  );

  assert.equal(deriveGoalPanel(goal({ rounds: 0 })).rounds, "0", "zero rounds is known: not yet evaluated");
  assert.equal(deriveGoalPanel(goal({ tokensUsed: 900 })).tokens, "900");
  assert.equal(deriveGoalPanel(goal({ tokenBudget: 50_000 })).tokens, "50k budget");
  assert.equal(deriveGoalPanel(goal({ tokensUsed: 900, tokenBudget: null })).tokens, "900");
  assert.equal(
    deriveGoalPanel(goal({ setAt: "not a date" })).setAt,
    null,
    "a malformed stamp shrinks the readout rather than printing Invalid Date"
  );
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

test("the order is the spec's, whatever order the adapter lists them in", () => {
  const shuffled: AdapterGoalSupport = {
    command: "host",
    actions: ["clear", "resume", "pause", "continue"],
    continuesAcrossTurns: true
  };
  assert.deepEqual(
    goalActions({ goal: goal(), support: shuffled, ...SITUATIONS.idle }).map((model) => model.action),
    ["continue", "pause", "clear"]
  );
});

test("each action sends exactly the §8.2 text, as the user's message", () => {
  assert.deepEqual(GOAL_ACTION_TEXT, {
    continue: "Continue working toward the goal.",
    pause: "/goal pause",
    resume: "/goal resume",
    clear: "/goal clear"
  });
  const models = goalActions({ goal: goal({ status: "paused" }), support: CODEX, ...SITUATIONS.idle });
  for (const model of models) {
    assert.equal(model.text, GOAL_ACTION_TEXT[model.action]);
    assert.ok(model.label.length > 0, `${model.action} has a button label`);
  }
});

test("the popover says why a provider-command adapter offers nothing while its turn runs", () => {
  assert.equal(GOAL_ACTIONS_WAIT_NOTE, "Goal actions wait until the agent is idle.");
  for (const support of [CLAUDE, GROK]) {
    assert.equal(
      goalActionsNote({ goal: goal(), support, ...SITUATIONS.running }),
      GOAL_ACTIONS_WAIT_NOTE
    );
    assert.equal(goalActionsNote({ goal: goal(), support, ...SITUATIONS.idle }), null);
  }
  assert.equal(
    goalActionsNote({ goal: goal(), support: CODEX, ...SITUATIONS.running }),
    null,
    "a host command never waits for the turn"
  );
  assert.equal(
    goalActionsNote({ goal: goal(), support: null, ...SITUATIONS.running }),
    null,
    "no goal support: there is nothing to wait for"
  );
  assert.equal(
    goalActionsNote({ goal: goal({ status: "complete" }), support: CLAUDE, ...SITUATIONS.running }),
    null
  );
});

test("fix round 1 (6): the chip's logic imports pure modules only — never a component", () => {
  // A `.tsx` import drags React (and whatever the component imports) into
  // every consumer of what is meant to be plain logic.
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "goal-chip.ts"), "utf8");
  const relative = [...source.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((match) => match[1]!);
  assert.ok(relative.length > 0, "the module has relative imports to check");
  for (const specifier of relative) {
    const base = resolve(here, specifier.replace(/\.tsx?$/, ""));
    assert.ok(existsSync(`${base}.ts`), `${specifier} is a pure .ts module`);
    assert.ok(!existsSync(`${base}.tsx`), `${specifier} is not a component module`);
  }
});

test("fix round 2 (1): Clear is the one destructive action — it is never the control that takes focus", () => {
  const support = { command: "host" as const, actions: ["pause", "resume", "clear"] as const, continuesAcrossTurns: true };
  for (const status of ["active", "paused", "budget-limited"] as const) {
    for (const model of goalActions({ goal: goal({ status }), support, turnRunning: false, backgroundLive: false })) {
      assert.equal(model.destructive, model.action === "clear", `${status} ${model.action}`);
    }
  }
  // The cases where Clear is the first — or only — action on offer.
  const onlyClear: Array<[string, Parameters<typeof goalActions>[0]]> = [
    [
      "an active Grok goal while idle",
      { goal: goal(), support: { command: "provider", actions: ["resume", "clear"], continuesAcrossTurns: false }, turnRunning: false, backgroundLive: false }
    ],
    [
      "a Claude goal with background work live",
      { goal: goal(), support: { command: "provider", actions: ["continue", "clear"], continuesAcrossTurns: false }, turnRunning: false, backgroundLive: true }
    ],
    [
      "a budget-limited Codex goal",
      { goal: goal({ status: "budget-limited" }), support, turnRunning: false, backgroundLive: false }
    ]
  ];
  for (const [label, input] of onlyClear) {
    const [first] = goalActions(input);
    assert.equal(first?.action, "clear", label);
    assert.equal(first?.destructive, true, `${label}: so the panel, not Clear, takes focus`);
  }
});

test("fix round 2 (2b): the goal popover is a labelled dialog that takes focus — the props the chip passes", () => {
  const props = goalPopoverProps("s1");
  assert.deepEqual(dropdownPanelAttributes(props), {
    role: "dialog",
    "aria-label": "Goal",
    tabIndex: -1
  });
  assert.equal(props.focusOnOpen, true);
});

// ---------------------------------------------------------------------------
// Final fix wave
// ---------------------------------------------------------------------------

test("final wave (6): waiting on background work wins the chip's detail over the round", () => {
  const waiting = deriveGoalChip(goal({ rounds: 3, phase: "waiting-background" }), false);
  assert.equal(waiting?.detail, "waiting on background work", "why nothing is happening outranks how far it got");
  assert.equal(waiting?.detailShort, "waiting", "the short form the chip shows below `sm`");
  // The popover still has both.
  const panel = deriveGoalPanel(goal({ rounds: 3, phase: "waiting-background" }));
  assert.equal(panel.rounds, "3");
  assert.equal(panel.phase, "waiting on background work");
  // Any other phase still yields to the round, and every other detail is its own short form.
  const verifying = deriveGoalChip(goal({ rounds: 3, phase: "verifying" }), false);
  assert.deepEqual([verifying?.detail, verifying?.detailShort], ["round 3", "round 3"]);
  const paused = deriveGoalChip(goal({ status: "paused" }), false);
  assert.deepEqual([paused?.detail, paused?.detailShort], ["paused", "paused"]);
  const none = deriveGoalChip(goal(), false);
  assert.deepEqual([none?.detail, none?.detailShort], [null, null]);
});

test("final wave (3): elapsed is left out at zero and reads `<1s` under a second", () => {
  assert.equal(formatGoalElapsed(0), null, "a fresh Codex goal has spent nothing");
  assert.equal(formatGoalElapsed(1), "<1s");
  assert.equal(formatGoalElapsed(400), "<1s");
  assert.equal(formatGoalElapsed(999), "<1s");
  assert.equal(formatGoalElapsed(1_000), "1.0s");
  assert.equal(formatGoalElapsed(725_000), "12m 5s");
  assert.equal(formatGoalElapsed(undefined), null);
  assert.equal(formatGoalElapsed(-5), null);
  assert.equal(formatGoalElapsed(Number.NaN), null);
  assert.equal(deriveGoalPanel(goal({ elapsedMs: 0 })).elapsed, null, "no `Elapsed 1ms`");
  assert.equal(deriveGoalPanel(goal({ elapsedMs: 400 })).elapsed, "<1s");
});

test("final wave (5): the chip's spoken name and tooltip cap the objective at 200 characters", () => {
  const objective = "Make the payment module retry every transient failure exactly once. ".repeat(60);
  const chip = deriveGoalChip(goal({ objective, rounds: 2 }), false);
  assert.ok(chip);
  const quoted = /^Goal: (.*) \(active\), round 2$/.exec(chip.ariaLabel)?.[1] ?? "";
  assert.ok(quoted.length <= 200, `the objective in the name is ${quoted.length} characters`);
  assert.ok(quoted.endsWith("…"), "and says it was cut");
  assert.ok(chip.title.length <= 200 && chip.title.endsWith("…"), "the tooltip too");
  const short = deriveGoalChip(goal({ objective: "Ship it" }), false);
  assert.equal(short?.title, "Ship it", "a short objective is untouched");
  assert.equal(
    deriveGoalPanel(goal({ objective })).objective,
    objective,
    "the popover still carries all of it"
  );
});

test("final wave (2) + micro-fix: the goal popover closes when its tab is LEFT, never when its tab is activated", () => {
  setActiveChatTab("other");
  let dismissed = 0;
  const stop = goalPopoverProps("s1").dismissOn(() => {
    dismissed += 1;
  });
  setActiveChatTab("s1");
  assert.equal(dismissed, 0, "a click in its unfocused grid cell activates its own tab: it stays open");
  setActiveChatTab("s2");
  assert.equal(dismissed, 1, "a switch to another thread closes it");
  stop();
  setActiveChatTab(null);
});
