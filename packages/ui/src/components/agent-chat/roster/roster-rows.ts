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
 */

import { ACTIVE_SUBAGENT_STATUSES, TERMINAL_SUBAGENT_STATUSES } from "@orquester/api/agent-chat";
import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import type { ChatTone } from "../primitives/tone";

/** How many non-exempt rows render before the rest collapse behind "N more". */
export const ROSTER_COLLAPSED_ROWS = 5;

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
export function isActiveStatus(status: RuntimeSubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

/**
 * Finished = terminal. `idle` is deliberately **not** finished: a resumable
 * child stays resumable, so it is muted but it does not fade away.
 * *T3: `state/subagentRuntime.ts:89-105`.*
 */
export function isFinishedRow(agent: Pick<RuntimeSubagent, "status">): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(agent.status);
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
  /** Test seam. Production always uses {@link ROSTER_COLLAPSED_ROWS}. */
  limit?: number;
}

/**
 * Pick the rows to render.
 *
 * Order of operations matters: **drop** removed rows, then **cap**. A finished
 * row that has already faded out must not still be occupying one of the five
 * slots, or a turn that ends with five completed children leaves the roster
 * showing "5 more" over an empty list.
 */
export function selectRosterRows(input: SelectRosterRowsInput): RosterSelection {
  const limit = input.limit ?? ROSTER_COLLAPSED_ROWS;
  const ordered = rosterDisplayOrder(input.agents);

  let liveCount = 0;
  let finishedCount = 0;
  for (const agent of ordered) {
    if (isActiveStatus(agent.status)) liveCount += 1;
    if (isFinishedRow(agent)) finishedCount += 1;
  }

  const rows: RosterVisibleRow[] = [];
  let shown = 0;
  let hiddenCount = 0;

  for (const agent of ordered) {
    const exempt = isLiveBackgroundRow(agent);
    const finished = isFinishedRow(agent);

    if (!exempt && finished && input.finished === "removed") continue;

    if (exempt) {
      // Always rendered, never counted, never faded — and still in its own
      // place in the stable order, so collapsing the rest cannot move it.
      rows.push({ agent, exempt: true, fading: false });
      continue;
    }

    if (!input.expanded && shown >= limit) {
      hiddenCount += 1;
      continue;
    }

    shown += 1;
    rows.push({ agent, exempt: false, fading: finished && input.finished === "fading" });
  }

  return {
    rows,
    hiddenCount,
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
