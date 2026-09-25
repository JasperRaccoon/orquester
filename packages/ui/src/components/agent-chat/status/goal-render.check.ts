/**
 * Render smoke checks for the goal surfaces (goals §8.2–§8.5, and §5.7's goal
 * held for an Orquester update).
 *
 * `goal-chip.test.ts`, `goal.logic.test.ts` and the row/menu tests own the
 * rules; this exists because "the chip sits before the plan chip", "it is a
 * click popover, not a hover readout", "the tab marker is a 9px target before
 * the dot", "a goal that can't be met reads in the danger tone" and "a held
 * goal reaches the chip through the status line" are claims about *markup* —
 * and a React prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentChatGoalSummary, ThreadGoal } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { SessionStatusDot } from "../../ui/session-status-dot";
import { ComposerTokenMenu } from "../composer/ComposerTokenMenu";
import { buildSlashMenuItems } from "../composer/composer-menu";
import { GoalMarkerRow } from "../timeline/rows/StructureRows";
import { ChatStatusLine } from "./ChatStatusLine";
import { ContextMeter } from "./ContextMeter";
import { deriveContextMeter } from "./context-meter";
import { GoalChip, GoalPanel } from "./GoalChip";
import { goalActions } from "./goal-chip";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * The chip's `Dropdown` uses `useLayoutEffect`, which the static renderer
 * warns about because it cannot encode the effect for hydration. This script
 * never hydrates, so that one warning is noise — filtered by its exact text so
 * every other console error still surfaces (the roster check's filter).
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

const noop = (): void => {};

const active: ThreadGoal = {
  objective: "Make CI green",
  status: "active",
  rounds: 3,
  tokensUsed: 12_400,
  tokenBudget: 50_000,
  updatedAt: "2026-09-24T10:00:00.000Z"
};
const paused: ThreadGoal = { ...active, status: "paused" };

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

const running = render(createElement(GoalChip, { goal: active, turnRunning: true, actions: [], onAction: noop }));
assert.ok(running.includes("lucide-target"), "the chip carries the target glyph");
assert.ok(running.includes(">Goal<"), "and the word Goal");
assert.ok(running.includes("round 3"), "an active goal names its round");
assert.ok(running.includes("12k/50k tok"), "and its token budget when both halves are known");
assert.ok(running.includes("text-info-300"), "active is the in-motion tone");
assert.ok(running.includes('<span class="ac-shimmer">Goal</span>'), "the label shimmers while a turn runs");
assert.ok(running.includes('title="Make CI green"'), "the objective is one hover away");
assert.ok(
  running.includes('<span class="sr-only">Goal: Make CI green (active), round 3, 12k/50k tok</span>'),
  "a screen reader hears one sentence, objective included"
);
assert.ok(
  running.includes('<span aria-hidden="true" class="inline-flex'),
  "and not the visible fragments a second time"
);
assert.ok(running.includes("<button"), "the chip is a control: click opens the popover");
assert.ok(
  !running.includes('data-hover-open="true"'),
  "a popover with actions is a decision, not a glance — click only"
);
// Fix round 1 (2): a readout with plain buttons is a dialog, not a menu, and
// it takes focus when it opens (its first action, else itself) and gives it
// back to the chip when it closes.
assert.ok(running.includes('aria-haspopup="dialog"'), "the trigger announces a dialog");
assert.ok(running.includes('data-focus-on-open="true"'), "the popover takes focus when it opens");
const meterModel = deriveContextMeter({
  usedTokens: 50_000,
  maxTokens: 200_000,
  autoCompactAtTokens: null,
  totalProcessedTokens: null,
  reportsContextWindow: true
});
assert.ok(meterModel);
const meter = render(createElement(ContextMeter, { model: meterModel, onCompact: noop }));
assert.ok(!meter.includes("aria-haspopup"), "every other dropdown keeps its default role");
assert.ok(!meter.includes("data-focus-on-open"), "…and its default focus behaviour");

const idle = render(createElement(GoalChip, { goal: active, turnRunning: false, actions: [], onAction: noop }));
assert.ok(
  idle.includes('<span class="ac-shimmer-settled text-info-300">Goal</span>'),
  "an idle goal does not shimmer: the settled label, in its tone"
);

const stopped = render(createElement(GoalChip, { goal: paused, turnRunning: true, actions: [], onAction: noop }));
assert.ok(stopped.includes("paused"), "a stopped goal says what stopped it");
assert.ok(stopped.includes("text-warn-300"), "in the warn tone");
assert.ok(!stopped.includes("text-info-300"));

assert.equal(
  render(
    createElement(GoalChip, {
      goal: { ...active, status: "complete" },
      turnRunning: false,
      actions: [],
      onAction: noop
    })
  ),
  "",
  "an achieved goal has no chip"
);

// ---------------------------------------------------------------------------
// The popover
// ---------------------------------------------------------------------------

const longObjective = "Refactor the payment module so every provider shares one retry policy. ".repeat(20);
const codexActions = goalActions({
  goal: active,
  support: { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true },
  turnRunning: true,
  backgroundLive: false
});
const panel = render(
  createElement(GoalPanel, {
    goal: {
      ...active,
      objective: longObjective,
      phase: "executing",
      lastCheck: "two integration tests still fail",
      elapsedMs: 725_000,
      setAt: "2026-09-24T09:00:00.000Z"
    },
    actions: codexActions,
    onAction: noop
  })
);
assert.ok(panel.includes(longObjective.trim()), "the popover carries the WHOLE objective");
assert.ok(panel.includes("overflow-y-auto"), "and scrolls it past a dozen lines rather than growing");
assert.ok(panel.includes("Active"), "the status");
assert.ok(panel.includes("executing"), "and the phase");
assert.ok(panel.includes("two integration tests still fail"), "the last check");
assert.ok(panel.includes("12k of 50k"), "tokens against the budget");
assert.ok(panel.includes("12m 5s"), "elapsed");
assert.ok(panel.includes("Pause"), "Codex offers pause while active…");
assert.ok(panel.includes("Clear goal"), "…and clear, always");
assert.ok(!panel.includes("Resume"), "never resume on an active goal");
assert.ok(panel.includes("/goal pause"), "each action says what it will send");
// Fix round 2 (1): Clear is marked destructive, so the popover's focus-on-open
// never lands on it (`dropdownFocusTarget` then focuses the panel itself).
const clearButton = /<button[^>]*>Clear goal<\/button>/.exec(panel)?.[0] ?? "";
assert.ok(clearButton.includes('data-destructive="true"'), "Clear is marked destructive");
const pauseButton = /<button[^>]*>Pause<\/button>/.exec(panel)?.[0] ?? "";
assert.ok(pauseButton.length > 0, "the Pause button renders");
assert.ok(!pauseButton.includes("data-destructive"), "Pause is not destructive");

const claudeRunning = render(
  createElement(GoalPanel, {
    goal: active,
    actions: [],
    actionsNote: "Goal actions wait until the agent is idle.",
    onAction: noop
  })
);
assert.ok(!claudeRunning.includes("<button"), "no action while a provider-command turn runs");
assert.ok(
  claudeRunning.includes("Goal actions wait until the agent is idle."),
  "and the popover says why, rather than silently offering nothing"
);

// ---------------------------------------------------------------------------
// The status line slot — before the plan chip
// ---------------------------------------------------------------------------

const lineProps = {
  sessionId: "s1",
  connection: "synchronized" as const,
  turnStartedAt: "2026-09-24T10:00:00.000Z",
  activityLabel: "Running tests",
  tokensUsed: null,
  contextMaxTokens: null,
  autoCompactAtTokens: null,
  totalProcessedTokens: null,
  reportsContextWindow: true,
  activePlan: {
    createdAt: "2026-09-24T10:00:00.000Z",
    turnId: "t1",
    steps: [
      { step: "one", status: "completed" as const },
      { step: "two", status: "inProgress" as const }
    ]
  },
  onCompact: noop,
  latestCheckpoint: null
};
const withGoal = render(
  createElement(ChatStatusLine, { ...lineProps, goal: active, goalActions: [], onGoalAction: noop })
);
assert.ok(withGoal.includes("lucide-target"), "the status line shows the chip");
assert.ok(
  withGoal.indexOf("lucide-target") < withGoal.indexOf("1/2"),
  "in its stable slot, before the plan chip"
);
assert.ok(
  withGoal.includes('<span class="ac-shimmer">Goal</span>'),
  "the line's own running turn is what makes an active goal's label live"
);
const settledLine = render(
  createElement(ChatStatusLine, { ...lineProps, turnStartedAt: null, goal: active })
);
assert.ok(
  settledLine.includes("ac-shimmer-settled text-info-300\">Goal<"),
  "no turn, no shimmer"
);
const withoutGoal = render(createElement(ChatStatusLine, { ...lineProps, goal: null }));
assert.ok(!withoutGoal.includes("lucide-target"), "no goal, no chip");
const finished = render(
  createElement(ChatStatusLine, { ...lineProps, goal: { ...active, status: "failed" } })
);
assert.ok(!finished.includes("lucide-target"), "a goal that can't be met has no chip either");

// ---------------------------------------------------------------------------
// The tab marker (goals §8.3)
// ---------------------------------------------------------------------------

const summary: AgentChatGoalSummary = { objective: "Make CI green", status: "active", continuing: true };
const dot = render(createElement(SessionStatusDot, { sessionId: "s1", status: "running", goal: summary }));
assert.ok(dot.includes("lucide-target"), "a 9px target before the dot");
assert.ok(dot.includes('width="9"'), "at 9px");
assert.ok(dot.indexOf("lucide-target") < dot.indexOf("lucide-circle"), "before the dot, not after it");
assert.ok(dot.includes('aria-label="Goal: Make CI green (active)"'));
assert.ok(dot.includes('title="Goal: Make CI green (active)"'));
assert.ok(dot.includes("text-info-300"), "active is the in-motion tone");
const stalledDot = render(
  createElement(SessionStatusDot, {
    sessionId: "s1",
    status: "running",
    goal: { ...summary, status: "usage-limited", continuing: false }
  })
);
assert.ok(stalledDot.includes("text-warn-300"), "a stalled goal is the warn tone");
const plainDot = render(createElement(SessionStatusDot, { sessionId: "s1", status: "running" }));
assert.ok(!plainDot.includes("lucide-target"), "no goal: the dot is exactly what it was");
assert.ok(plainDot.startsWith("<svg"), "no wrapper around a plain dot — callers' layouts are untouched");
const junkDot = render(
  createElement(SessionStatusDot, {
    sessionId: "s1",
    status: "running",
    goal: { objective: "", status: "active" } as unknown as AgentChatGoalSummary
  })
);
assert.ok(!junkDot.includes("lucide-target"), "a goal it cannot read draws nothing, never a crash");
const exitedDot = render(
  createElement(SessionStatusDot, { sessionId: "s1", status: "exited", goal: summary })
);
assert.ok(exitedDot.includes("lucide-target"), "the goal outlives the process: an exited tab still has it");
assert.ok(exitedDot.includes('aria-label="Exited"'), "beside the exited dot");

// ---------------------------------------------------------------------------
// The timeline marker (goals §8.4)
// ---------------------------------------------------------------------------

type GoalMarker = Extract<AgentChatTimelineRow, { kind: "goal-marker" }>;
const marker = (overrides: Partial<GoalMarker>): GoalMarker => ({
  kind: "goal-marker",
  id: "g1",
  createdAt: "2026-09-24T10:00:00.000Z",
  turnId: "t1",
  label: "Goal set: Make CI green",
  change: "set",
  objective: "Make CI green",
  ...overrides
});

const set = render(createElement(GoalMarkerRow, { row: marker({}) }));
assert.ok(set.includes("lucide-target"), "the marker carries the target glyph");
assert.ok(set.includes("Goal set: Make CI green"), "and the row's own summary");
assert.ok(set.includes('role="separator"'), "a compact marker, like the compaction marker");
assert.ok(!set.includes("text-danger"), "a set goal is not an error");

const achieved = render(
  createElement(GoalMarkerRow, {
    row: marker({
      label: "Goal achieved: Make CI green",
      change: "achieved",
      rounds: 4,
      elapsedMs: 725_000,
      tokensUsed: 1_250_000
    })
  })
);
assert.ok(achieved.includes("4 rounds · 12m 5s · 1.3m tokens"), "an ended goal says what it cost");

const failed = render(
  createElement(GoalMarkerRow, {
    row: marker({ label: "Goal can't be met: tests are flaky", change: "failed" })
  })
);
assert.ok(failed.includes("text-danger"), "a goal that can't be met reads in the danger tone");
assert.ok(!failed.includes(" · "), "no stats line when nothing about the cost is known");

// ---------------------------------------------------------------------------
// The composer menu row (goals §8.5)
// ---------------------------------------------------------------------------

const menu = render(
  createElement(ComposerTokenMenu, {
    id: "m",
    items: buildSlashMenuItems({
      slashCommands: [],
      skills: [],
      showPlanModeToggle: false,
      hasEffortOption: false,
      compactAvailable: false,
      showSkillsInSlashMenu: false,
      isAtPromptStart: true,
      query: "goal",
      hostGoalCommand: true
    }),
    highlightedIndex: 0,
    onHighlight: noop,
    onPick: noop,
    emptyLabel: "none"
  })
);
assert.ok(menu.includes("/goal"), "Codex's host-parsed /goal is in the menu");
assert.ok(menu.includes("Set, check, pause, resume or clear a goal"), "with its description");
assert.ok(
  menu.includes("&lt;objective&gt; | pause | resume | clear | edit &lt;objective&gt;"),
  "and its argument hint"
);
assert.ok(menu.includes("lucide-target"), "under the goal glyph, not the generic wand");

// ---------------------------------------------------------------------------
// Final fix wave: the 360 px status line (1), the chip detail (6), focus rings (7)
// ---------------------------------------------------------------------------

/** The class list of the first `<button>` in some markup — a Dropdown's trigger. */
const triggerClasses = (markup: string): string[] =>
  (/<button[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "").split(/\s+/);

const FOCUS_RING = ["focus:outline-none", "focus-visible:ring-1", "focus-visible:ring-neutral-500"];

const chipTrigger = triggerClasses(running);
assert.ok(
  chipTrigger.includes("min-w-0") && chipTrigger.includes("shrink"),
  "the chip's trigger may shrink below its content, so its detail can truncate at 360 px"
);
for (const ring of FOCUS_RING) {
  assert.ok(chipTrigger.includes(ring), `the chip's trigger shows a focus ring (${ring})`);
}
const meterTrigger = triggerClasses(meter);
for (const ring of FOCUS_RING) {
  assert.ok(meterTrigger.includes(ring), `the context meter's trigger shows a focus ring (${ring})`);
}
assert.ok(!meterTrigger.includes("shrink"), "the meter keeps its size: it is the line's anchor");

const waitingChip = render(
  createElement(GoalChip, {
    goal: { ...active, phase: "waiting-background" },
    turnRunning: false,
    actions: [],
    onAction: noop
  })
);
assert.ok(
  /<span class="[^"]*\bmax-w-\[4\.5rem\][^"]*\bsm:hidden\b[^"]*">waiting<\/span>/.test(waitingChip),
  "below `sm` the detail is the short form, capped at 4.5rem"
);
assert.ok(
  /<span class="[^"]*\bhidden\b[^"]*\bsm:inline\b[^"]*">waiting on background work<\/span>/.test(waitingChip),
  "from `sm` up it is the whole phrase — and it wins over `round 3`"
);
assert.ok(!waitingChip.includes(">round 3<"), "the round is the popover's to show here");

const withCheckpoint = render(
  createElement(ChatStatusLine, {
    ...lineProps,
    goal: active,
    latestCheckpoint: {
      turnId: "t1",
      checkpointTurnCount: 3,
      checkpointRef: "refs/orquester/checkpoints/x/turn/3",
      status: "ready",
      files: [{ path: "src/index.ts", additions: 4, deletions: 1 }],
      assistantMessageId: null,
      completedAt: "2026-09-24T10:01:00.000Z"
    }
  })
);
const checkpointClasses = (
  /<span class="([^"]*)" title="Checkpoint at turn 3">/.exec(withCheckpoint)?.[1] ?? ""
).split(/\s+/);
assert.ok(
  checkpointClasses.includes("hidden") && checkpointClasses.includes("sm:flex"),
  "the checkpoint readout gives its width back below `sm`"
);

// ---------------------------------------------------------------------------
// Goals §5.7: a goal a deploy HELD between two of its turns
// ---------------------------------------------------------------------------

const heldChip = render(
  createElement(GoalChip, { goal: paused, turnRunning: true, heldForUpdate: true, actions: [], onAction: noop })
);
assert.ok(
  /<span class="[^"]*\bhidden\b[^"]*\bsm:inline\b[^"]*">paused for update<\/span>/.test(heldChip),
  "a held goal says it is paused for an update, not that the user paused it"
);
assert.ok(
  /<span class="[^"]*\bmax-w-\[4\.5rem\][^"]*\bsm:hidden\b[^"]*">update<\/span>/.test(heldChip),
  "below `sm`, `update`"
);
assert.ok(heldChip.includes("text-info-300"), "in the in-motion tone: nothing went wrong");
assert.ok(!heldChip.includes("text-warn-300"), "never the warn tone of a pause the user made");
assert.ok(
  heldChip.includes('<span class="ac-shimmer-settled text-info-300">Goal</span>'),
  "and never live, even while the turn the hold lets finish is running"
);
assert.ok(
  heldChip.includes(
    '<span class="sr-only">Goal: Make CI green (paused for an Orquester update — it resumes by itself), 12k/50k tok</span>'
  ),
  "a screen reader hears whose pause it is, and that it ends by itself"
);

const heldPanel = render(
  createElement(GoalPanel, {
    goal: paused,
    heldForUpdate: true,
    actions: goalActions({
      goal: paused,
      support: { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true },
      turnRunning: true,
      backgroundLive: false
    }),
    onAction: noop
  })
);
assert.ok(
  heldPanel.includes("Paused for an Orquester update — it resumes by itself"),
  "the popover's status says the pause is Orquester's"
);
assert.ok(!heldPanel.includes(">Paused<"), "not the bare status of a user's pause");
assert.ok(
  heldPanel.includes(">Resume</button>") && heldPanel.includes(">Clear goal</button>"),
  "the user wins: Resume and Clear, as for any paused goal"
);

const heldLine = render(
  createElement(ChatStatusLine, { ...lineProps, goal: paused, goalHeldForUpdate: true })
);
assert.ok(heldLine.includes(">paused for update<"), "the status line hands the hold to its chip");
const pausedLine = render(createElement(ChatStatusLine, { ...lineProps, goal: paused }));
assert.ok(
  pausedLine.includes(">paused<") && pausedLine.includes("text-warn-300"),
  "an ordinary pause is unchanged"
);

const heldDot = render(
  createElement(SessionStatusDot, {
    sessionId: "s1",
    status: "running",
    goal: { ...summary, status: "paused", continuing: true }
  })
);
assert.ok(heldDot.includes("text-info-300"), "the tab's target keeps the in-motion tone beside its working dot");
assert.ok(
  heldDot.includes('aria-label="Goal: Make CI green (paused for an Orquester update — it resumes by itself)"'),
  "and says why the goal is paused"
);
const pausedDot = render(
  createElement(SessionStatusDot, {
    sessionId: "s1",
    status: "running",
    goal: { ...summary, status: "paused", continuing: false }
  })
);
assert.ok(pausedDot.includes("text-warn-300"), "a pause the user made is still the warn tone");
assert.ok(pausedDot.includes('aria-label="Goal: Make CI green (paused)"'));

console.error = consoleError;
console.log("goal render checks passed");
