/**
 * The goal chip, its popover and its actions, as pure functions of the
 * thread's goal (goals §8.2, `docs/superpowers/specs/2026-09-24-agent-goals-
 * design.md`).
 *
 * The goal is the PROVIDER's — Claude's `/goal` Stop hook, Codex's thread
 * goal, Grok's goal workflow — and the chip only mirrors what the fold holds:
 * it shows exactly the unfinished goals (`isUnfinishedGoal`), and every fact
 * in the popover is shown only when the provider reported it. An unknown count
 * is absent, never a zero.
 *
 * **An action is a message, not a side channel.** Each one is the text the
 * user could have typed — `/goal pause`, or "Continue working toward the
 * goal." — and the shell sends it through the composer's own send path, so it
 * appears as the user's message and reaches the host's `/turn` like any other
 * (goals §8.2). Which actions are offered is the §8.2 matrix below, and it is
 * the adapter's `capabilities.goals` that says which of them its provider
 * honours (goals §4.5).
 */

import {
  isUnfinishedGoal,
  type AdapterGoalSupport,
  type AgentGoal,
  type AgentGoalStatus,
  type GoalAction
} from "@orquester/api/agent-chat";

import { dismissWhenChatTabLeaves } from "../../../lib/agent-chat-active-tab";
import { clipGoalText } from "../../../lib/agent-chat/goal.logic";
import { formatWorkDuration } from "../../../lib/agent-chat/rows.logic";
import type { DropdownRole } from "../../ui/dropdown-logic";
import { formatRowTimestamp, formatRowTimestampTooltip } from "../timeline/timestamp-format";
import { formatContextTokens } from "./context-meter";

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

export type GoalChipTone = "info" | "warn";

export interface GoalChipModel {
  /**
   * What follows the word `Goal`: the goal waiting on background work, else
   * `round <n>`, else the phase — or what stopped the goal (`paused`,
   * `blocked`, `budget`, `limit`). `null` when there is nothing to add.
   */
  detail: string | null;
  /**
   * The same, short enough for a phone's status line (below `sm`): only the
   * background wait has a longer form to shorten. `null` exactly when
   * {@link detail} is.
   */
  detailShort: string | null;
  /** `<used>/<budget> tok`, only when both halves are known. */
  tokens: string | null;
  /** `info` while active, `warn` once the goal has stopped short. */
  tone: GoalChipTone;
  /** The label shimmers: the goal is active AND a turn is running. */
  live: boolean;
  /**
   * The chip's tooltip — the objective, which the chip never prints, capped at
   * 200 characters (`clipGoalText`; the popover carries all of it).
   */
  title: string;
  /**
   * What a screen reader hears, in one sentence: `Goal: <objective>
   * (<status>)`, then an active goal's detail and the tokens when there are
   * any. A stopped goal's detail only restates its status, so it is left out.
   * The objective is capped like the tooltip: objectives run to 4000
   * characters, and a name is read out whole.
   */
  ariaLabel: string;
}

/**
 * Claude defers its Stop-hook evaluation while background work runs (goals
 * §3.1, §6.1.4); the adapter says so with this phase.
 */
const WAITING_BACKGROUND_PHASE = "waiting-background";

/** Orquester's own phase names, spelled for a person. */
const KNOWN_PHASES: Readonly<Record<string, string>> = {
  [WAITING_BACKGROUND_PHASE]: "waiting on background work"
};

/** The background wait, short enough for a phone's status line. */
const WAITING_BACKGROUND_SHORT = "waiting";

/**
 * A provider phase as words: Orquester's own names read as a sentence, any
 * other (Grok's `planning`/`executing`/`verifying`/`idle`) with its
 * separators turned into spaces. `null` for none.
 */
export function formatGoalPhase(phase: string | null | undefined): string | null {
  const trimmed = phase?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return KNOWN_PHASES[trimmed] ?? trimmed.replace(/[-_]+/g, " ");
}

/** What stopped a goal short, as the chip names it (goals §8.2). */
const STOPPED_DETAIL: Readonly<Partial<Record<AgentGoalStatus, string>>> = {
  paused: "paused",
  blocked: "blocked",
  "budget-limited": "budget",
  "usage-limited": "limit"
};

function knownCount(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The chip for the thread's goal, or `null` when there is none to show — no
 * goal, or one that is finished (achieved or impossible). `turnRunning` is the
 * status line's own "a turn is running", which is the only thing that makes
 * an active goal's label shimmer.
 */
export function deriveGoalChip(
  goal: AgentGoal | null | undefined,
  turnRunning: boolean
): GoalChipModel | null {
  if (!isUnfinishedGoal(goal) || !goal) return null;
  const active = goal.status === "active";
  // Why nothing is happening outranks how far the goal got: while it waits on
  // background work the round is stale news (the popover still shows both).
  const waiting = active && goal.phase?.trim() === WAITING_BACKGROUND_PHASE;
  const detail = active
    ? waiting
      ? KNOWN_PHASES[WAITING_BACKGROUND_PHASE]!
      : knownCount(goal.rounds) && goal.rounds > 0
        ? `round ${goal.rounds}`
        : formatGoalPhase(goal.phase)
    : (STOPPED_DETAIL[goal.status] ?? null);
  const tokens =
    knownCount(goal.tokensUsed) && knownCount(goal.tokenBudget)
      ? `${formatContextTokens(goal.tokensUsed)}/${formatContextTokens(goal.tokenBudget)} tok`
      : null;
  const objective = clipGoalText(goal.objective);
  const spoken = [
    `Goal: ${objective} (${goal.status})`,
    ...(active && detail !== null ? [detail] : []),
    ...(tokens !== null ? [tokens] : [])
  ];
  return {
    detail,
    detailShort: waiting ? WAITING_BACKGROUND_SHORT : detail,
    tokens,
    tone: active ? "info" : "warn",
    live: active && turnRunning,
    title: objective,
    ariaLabel: spoken.join(", ")
  };
}

// ---------------------------------------------------------------------------
// The popover's readout
// ---------------------------------------------------------------------------

const STATUS_LABEL: Readonly<Record<AgentGoalStatus, string>> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  "budget-limited": "Token budget reached",
  "usage-limited": "Usage limit reached",
  complete: "Achieved",
  failed: "Can't be met"
};

export interface GoalPanelModel {
  /** The WHOLE objective: the chip and the timeline both cut it. */
  objective: string;
  statusLabel: string;
  phase: string | null;
  /** Each of these is `null` when the provider did not report it. */
  rounds: string | null;
  lastCheck: string | null;
  tokens: string | null;
  elapsed: string | null;
  /** When the goal was set, day-aware like a row timestamp; the full stamp is the title. */
  setAt: string | null;
  setAtTitle: string | null;
}

/**
 * The goal's elapsed time, or `null` — left out at zero (a goal set a moment
 * ago has spent nothing worth a line) and `<1s` under a second, where the
 * turn fold's own formatter would print `1ms` or `400ms`.
 */
export function formatGoalElapsed(elapsedMs: number | null | undefined): string | null {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return elapsedMs < 1_000 ? "<1s" : formatWorkDuration(elapsedMs);
}

/** Tokens and budget, whichever halves are known. */
function formatGoalTokens(goal: AgentGoal): string | null {
  const used = knownCount(goal.tokensUsed) ? formatContextTokens(goal.tokensUsed) : null;
  const budget = knownCount(goal.tokenBudget) ? formatContextTokens(goal.tokenBudget) : null;
  if (used !== null) return budget !== null ? `${used} of ${budget}` : used;
  return budget !== null ? `${budget} budget` : null;
}

/** The popover's readout. `now` is injectable so the set time is testable. */
export function deriveGoalPanel(goal: AgentGoal, now: Date = new Date()): GoalPanelModel {
  const lastCheck = goal.lastCheck?.trim() ?? "";
  const setAt = goal.setAt ? formatRowTimestamp(goal.setAt, now) : "";
  return {
    objective: goal.objective,
    statusLabel: STATUS_LABEL[goal.status],
    phase: formatGoalPhase(goal.phase),
    rounds: knownCount(goal.rounds) ? String(goal.rounds) : null,
    lastCheck: lastCheck.length > 0 ? goal.lastCheck! : null,
    tokens: formatGoalTokens(goal),
    elapsed: formatGoalElapsed(goal.elapsedMs),
    // `formatRowTimestamp` answers "" for a stamp it cannot read.
    setAt: setAt.length > 0 ? setAt : null,
    setAtTitle: setAt.length > 0 && goal.setAt ? formatRowTimestampTooltip(goal.setAt) : null
  };
}

// ---------------------------------------------------------------------------
// The actions (goals §4.5, §8.2)
// ---------------------------------------------------------------------------

/** Exactly what each action sends, as the user's message (goals §8.2). */
export const GOAL_ACTION_TEXT: Readonly<Record<GoalAction, string>> = {
  continue: "Continue working toward the goal.",
  pause: "/goal pause",
  resume: "/goal resume",
  clear: "/goal clear"
};

const GOAL_ACTION_LABEL: Readonly<Record<GoalAction, string>> = {
  continue: "Continue",
  pause: "Pause",
  resume: "Resume",
  clear: "Clear goal"
};

/** The spec's order, whatever order an adapter lists its actions in. */
const ACTION_ORDER: readonly GoalAction[] = ["continue", "pause", "resume", "clear"];

/** A stopped goal a `resume` can restart — never a spent budget. */
const RESUMABLE: ReadonlySet<AgentGoalStatus> = new Set(["paused", "blocked", "usage-limited"]);

export interface GoalActionModel {
  action: GoalAction;
  /** The button's label. */
  label: string;
  /** The message it sends — {@link GOAL_ACTION_TEXT}. */
  text: string;
  /**
   * Ends the goal (`clear`). Such a button is marked destructive, so the
   * popover never puts focus on it by itself: when it is the first — or only
   * — action, the panel takes focus instead, and a keyboard user's Enter
   * after opening clears nothing (fix round 2).
   */
  destructive: boolean;
}

/**
 * The props the goal chip hands its `Dropdown` (goals §8.2, fix rounds 1–2,
 * final wave, micro-fix): a labelled dialog — a readout with plain buttons is
 * not a menu — that takes focus when it opens, gives it back to the chip when
 * it closes, and closes by itself when its thread's tab is LEFT, so its
 * Pause/Clear never strand over another tab. Never when its own tab is
 * activated: in the grid view the click that opens it also activates its
 * cell (`dismissWhenChatTabLeaves`). Exported so the wiring is testable
 * without a DOM.
 */
export function goalPopoverProps(sessionId: string | null): {
  role: DropdownRole;
  ariaLabel: string;
  focusOnOpen: true;
  dismissOn: (dismiss: () => void) => () => void;
} {
  return {
    role: "dialog",
    ariaLabel: "Goal",
    focusOnOpen: true,
    dismissOn: dismissWhenChatTabLeaves(sessionId)
  };
}

export interface GoalActionsInput {
  goal: AgentGoal | null | undefined;
  /** The adapter's `capabilities.goals`; absent ⇒ no goal surface at all (OpenCode). */
  support: AdapterGoalSupport | null | undefined;
  /** A turn is running or pending — the composer's own `isTurnActive`. */
  turnRunning: boolean;
  /** Subagents or background shells are still live (`backgroundLiveness`). */
  backgroundLive: boolean;
}

/**
 * The §8.2 matrix: which of the adapter's actions the popover offers now.
 *
 *  - `continue` (Claude): the goal is active, no turn is running and no
 *    background work is live — Claude defers the goal's evaluation while
 *    anything runs in the background, so a nudge then only starts a turn the
 *    goal cannot finish on.
 *  - `pause` (Codex): the goal is active.
 *  - `resume` (Codex, Grok): the goal is paused, blocked or usage-limited.
 *  - `clear`: always where the host parses `/goal` (Codex); elsewhere only
 *    while no turn runs.
 *
 * **A provider-command adapter (Claude, Grok) offers nothing while a turn is
 * running**: its `/goal …` is an ordinary prompt, which would queue behind
 * the very turn the user wants to act on. The host parses Codex's, so a pause
 * lands on a running goal at once — which is what a pause is for.
 */
export function goalActions(input: GoalActionsInput): GoalActionModel[] {
  const { goal, support } = input;
  if (!support || !goal || !isUnfinishedGoal(goal)) return [];
  if (support.command === "provider" && input.turnRunning) return [];
  const offered = (action: GoalAction): boolean => {
    switch (action) {
      case "continue":
        return goal.status === "active" && !input.turnRunning && !input.backgroundLive;
      case "pause":
        return goal.status === "active";
      case "resume":
        return RESUMABLE.has(goal.status);
      case "clear":
        return support.command === "host" || !input.turnRunning;
      default: {
        const exhaustive: never = action;
        void exhaustive;
        return false;
      }
    }
  };
  return ACTION_ORDER.filter((action) => support.actions.includes(action) && offered(action)).map(
    (action) => ({
      action,
      label: GOAL_ACTION_LABEL[action],
      text: GOAL_ACTION_TEXT[action],
      destructive: action === "clear"
    })
  );
}

/** Why a provider-command adapter's popover has no buttons while its turn runs. */
export const GOAL_ACTIONS_WAIT_NOTE = "Goal actions wait until the agent is idle.";

/**
 * The popover's one-line explanation when the matrix withholds every action
 * because a provider-command turn is running — a control that silently is
 * not there reads as a bug. `null` whenever there is nothing to explain.
 */
export function goalActionsNote(input: GoalActionsInput): string | null {
  const { goal, support } = input;
  if (!support || !goal || !isUnfinishedGoal(goal)) return null;
  return support.command === "provider" && input.turnRunning && support.actions.length > 0
    ? GOAL_ACTIONS_WAIT_NOTE
    : null;
}
