/**
 * Which roster rows render, in what order, and which of them are on their way
 * out (spec §7.6).
 *
 * Three rules govern this file and they pull against each other, which is why
 * the selection is pure and tested rather than inlined in the component:
 *
 *  1. **Spawn order is stable.** Rows update in place; a status change never
 *     re-sorts the list. *T3: `AgentsPanel.tsx:1-12`.*
 *  2. **Rows past five collapse behind "N more", and finished rows fade and
 *     disappear when the turn ends.** Both are ours — T3 renders every row
 *     forever — so they must not turn into the reshuffle rule 1 forbids:
 *     collapsing only ever *filters* the stable order, it never reorders it.
 *     *T3: `state/subagentRuntime.ts:847-848` — "must never reshuffle rows
 *     that remain visible".*
 *  3. **A live background row is exempt from both.** It outlives the turn that
 *     started it, so it is always rendered, it does not count towards the
 *     five, and hiding or showing the rest never moves it — which falls out of
 *     rule 2: everything is one filtered list in one stable order, never two
 *     partitioned groups.
 *
 * **Which rows survive is W11's `deriveRosterDockView`** (`lib/agent-chat/
 * roster.logic.ts`) — one implementation of the collapse, the fade and the
 * background exemption, shared with the rest of the client. This module adds
 * only what a *dock* needs on top of it: the stable order those rows render in
 * (the selector returns them partitioned), the intermediate `fading` phase
 * that the exit transition needs, and the presentational status mapping.
 */

import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import {
  ROSTER_VISIBLE_ROWS,
  deriveRosterDockView,
  isActiveSubagentStatus,
  isTerminalSubagentStatus
} from "../../../lib/agent-chat/roster.logic";
import type { ChatTone } from "../primitives/tone";

/** How many non-exempt rows render before the rest collapse behind "N more". */
export const ROSTER_COLLAPSED_ROWS = ROSTER_VISIBLE_ROWS;

/**
 * Where a finished row is in its exit.
 *
 * `visible` while the turn runs, `fading` for the one transition after the
 * turn settles, `removed` once it is over. Kept as an explicit phase rather
 * than a timestamp so the selection stays a pure function of its inputs.
 */
export type FinishedRowsPhase = "visible" | "fading" | "removed";

export interface RosterVisibleRow {
  agent: RuntimeSubagent;
  /** A live background row: never collapsed, never faded, never counted. */
  exempt: boolean;
  /** Rendered, but on its way out — the component applies the fade. */
  fading: boolean;
}

export interface RosterSelection {
  rows: RosterVisibleRow[];
  /** The "N more" count: non-exempt rows the collapse is holding back. */
  hiddenCount: number;
  /** Every row the fold gave us, exempt ones included. */
  totalCount: number;
  /** Rows in one of the three in-flight statuses. */
  liveCount: number;
  /** Rows in a terminal status. */
  finishedCount: number;
}

/** The three in-flight statuses — one steady "working" look (§7.6). */
export const isActiveStatus = isActiveSubagentStatus;

/**
 * Finished = terminal. `idle` is deliberately **not** finished: a resumable
 * child stays resumable, so it is muted but it does not fade away.
 * *T3: `state/subagentRuntime.ts:89-105`.*
 */
export function isFinishedRow(agent: Pick<RuntimeSubagent, "status">): boolean {
  return isTerminalSubagentStatus(agent.status);
}

/**
 * A shell row — a command the agent ran in the background, listed in the same
 * roster (§7.6, the deliberate difference from T3).
 *
 * Deliberately **status-blind**, unlike {@link isLiveBackgroundRow}: the
 * exemption from the collapse is about a row that outlives its turn, while
 * this is about what the row *is*. A finished shell is still a shell, and it
 * must keep the terminal glyph, the "shell" chip and its exit code while it
 * fades.
 */
export function isBackgroundShellRow(agent: Pick<RuntimeSubagent, "agentKind">): boolean {
  return agent.agentKind === "background";
}

/** A background task that is still running — the row exempt from both rules. */
export function isLiveBackgroundRow(
  agent: Pick<RuntimeSubagent, "agentKind" | "status">
): boolean {
  return agent.agentKind === "background" && isActiveStatus(agent.status);
}

/**
 * The roster's display order: first observation first, ties broken by the
 * order the fold produced.
 *
 * `firstSeenAt` never changes once a row exists, so this sort is invariant
 * under every later update — which is exactly what "spawn order is stable"
 * means. An unparseable stamp sorts by its incoming position rather than
 * jumping to one end.
 */
export function rosterDisplayOrder(
  agents: readonly RuntimeSubagent[]
): RuntimeSubagent[] {
  return agents
    .map((agent, index) => ({ agent, index, at: Date.parse(agent.firstSeenAt) }))
    .sort((left, right) => {
      const leftAt = Number.isNaN(left.at) ? Number.NaN : left.at;
      const rightAt = Number.isNaN(right.at) ? Number.NaN : right.at;
      if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) {
        return leftAt - rightAt;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.agent);
}

export interface SelectRosterRowsInput {
  agents: readonly RuntimeSubagent[];
  /** `false` collapses everything past {@link ROSTER_COLLAPSED_ROWS}. */
  expanded: boolean;
  /** Where finished rows are in their exit; `visible` while a turn runs. */
  finished: FinishedRowsPhase;
}

/**
 * Pick the rows to render, in the order they render in.
 *
 * The survivors come from W11's `deriveRosterDockView` — it owns the collapse,
 * the drop of finished rows and the background exemption — and are then **put
 * back into first-seen order**: the selector hands back `visible` and
 * `pinnedBackground` as separate lists, and rendering them one after the other
 * would move a live background row to the end of the dock every time the rest
 * collapsed, which is the reshuffle §7.6 forbids.
 *
 * The only rule this layer owns is the middle of the exit: during `fading` a
 * finished row is still passed to the selector (`turnSettled: false`), so it
 * keeps its slot and its place while its opacity runs out, and only the
 * `removed` phase drops it.
 */
export function selectRosterRows(input: SelectRosterRowsInput): RosterSelection {
  const ordered = rosterDisplayOrder(input.agents);

  let liveCount = 0;
  let finishedCount = 0;
  for (const agent of ordered) {
    if (isActiveStatus(agent.status)) liveCount += 1;
    if (isFinishedRow(agent)) finishedCount += 1;
  }

  const view = deriveRosterDockView({
    roster: ordered,
    expanded: input.expanded,
    turnSettled: input.finished === "removed"
  });
  const kept = new Set<string>();
  for (const agent of view.visible) kept.add(agent.id);
  for (const agent of view.pinnedBackground) kept.add(agent.id);

  const rows: RosterVisibleRow[] = [];
  for (const agent of ordered) {
    if (!kept.has(agent.id)) continue;
    const exempt = isLiveBackgroundRow(agent);
    rows.push({
      agent,
      exempt,
      fading: !exempt && isFinishedRow(agent) && input.finished === "fading"
    });
  }

  return {
    rows,
    hiddenCount: view.hiddenCount,
    totalCount: ordered.length,
    liveCount,
    finishedCount
  };
}

export interface RosterStatusVisual {
  tone: ChatTone;
  label: string;
  /** Only the in-flight look breathes; settled and idle are static. */
  pulse: boolean;
}

/**
 * Status → dot tone and status word.
 *
 * The three in-flight statuses collapse to one steady "Working": a queued or
 * waiting subagent is still the fleet doing its job, and the detail belongs in
 * the activity sub-line. `idle` reads as settled and **muted** — T3 shipped a
 * live-coloured idle dot and users read it as stuck.
 *
 * *T3: `AgentsPanel.tsx:32-49`.*
 */
export function rosterStatusVisual(status: RuntimeSubagentStatus): RosterStatusVisual {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return { tone: "info", label: "Working", pulse: true };
    case "idle":
      return { tone: "muted", label: "Idle · resumable", pulse: false };
    case "completed":
      return { tone: "ok", label: "Completed", pulse: false };
    case "failed":
      return { tone: "danger", label: "Failed", pulse: false };
    case "cancelled":
    case "interrupted":
      return { tone: "muted", label: "Stopped", pulse: false };
    default: {
      const exhaustive: never = status;
      void exhaustive;
      return { tone: "muted", label: "Unknown", pulse: false };
    }
  }
}

/**
 * The elapsed ticker runs for `running` and `waiting` only — narrower than
 * "not finished". A `pending` agent has not started, so counting up time it
 * never spent would be a lie the user cannot check.
 * *T3: `AgentsPanel.tsx:88`.*
 */
export function rosterRowTicks(status: RuntimeSubagentStatus): boolean {
  return status === "running" || status === "waiting";
}
