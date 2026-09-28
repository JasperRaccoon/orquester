/**
 * Which roster rows render, in what order, and which of them are on their way
 * out (spec §7.6).
 *
 * Three rules govern this file and they pull against each other, which is why
 * the selection is pure and tested rather than inlined in the component:
 *
 *  1. **Active rows lead.** Within each liveness state, rows retain spawn
 *     order. This intentionally differs from T3's stable global order.
 *  2. **Rows past five collapse behind "N more", and finished rows fade and
 *     disappear when the turn ends.** Both are ours — T3 renders every row
 *     forever — so the cap filters the live-first order without a second
 *     reshuffle. A status change can move a row ahead of finished work.
 *  3. **A live background row is exempt from both.** It outlives the turn that
 *     started it, so it is always rendered, it does not count towards the
 *     five. Agent and shell rows are rendered in separate sections after
 *     selection, with active rows first within each section.
 *
 * **Which rows survive is W11's `deriveRosterDockView`** (`lib/agent-chat/
 * roster.logic.ts`) — one implementation of the collapse, the fade and the
 * background exemption, shared with the rest of the client. This module adds
 * only what a *dock* needs on top of it: the live-first order those rows render in
 * (the selector returns them partitioned), the intermediate `fading` phase
 * that the exit transition needs, and the presentational status mapping.
 */

import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import {
  deriveRosterDockView,
  isActiveSubagentStatus,
  isBackgroundShellRow,
  isTerminalSubagentStatus
} from "../../../lib/agent-chat/roster.logic";
import type { ChatTone } from "../primitives/tone";

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
  /** Rendered, but on its way out — the component applies the fade. */
  fading: boolean;
}

export interface RosterSelection {
  rows: RosterVisibleRow[];
  /** The "N more" count: non-exempt rows the collapse is holding back. */
  hiddenCount: number;
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
 * A shell row — a command the agent ran in the background (§7.6). Status-blind,
 * unlike {@link isLiveBackgroundRow}: it is about what the row *is*. W11's, in
 * `lib/agent-chat/roster.logic.ts`, because the drill-in's projection asks it
 * too; re-exported here, the path the roster's components import it by.
 */
export { isBackgroundShellRow };

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
function rosterDisplayOrder(
  agents: readonly RuntimeSubagent[]
): RuntimeSubagent[] {
  return agents
    .map((agent, index) => ({ agent, index, at: Date.parse(agent.firstSeenAt) }))
    .sort((left, right) => {
      const liveDifference = Number(isActiveStatus(right.agent.status)) - Number(isActiveStatus(left.agent.status));
      if (liveDifference !== 0) return liveDifference;
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
  /** `false` collapses rows beyond the dock selector's visible limit. */
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
      fading: !exempt && isFinishedRow(agent) && input.finished === "fading"
    });
  }

  return {
    rows,
    hiddenCount: view.hiddenCount
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
 * A row's dot and status word, by its kind as well as its status: a live loop
 * waits between its fires — `Scheduled`, and still, never the breathing
 * "Working" — and a live goal is `Active`. Once over, every row reads its
 * status as {@link rosterStatusVisual} says.
 */
export function rosterRowVisual(
  agent: Pick<RuntimeSubagent, "status"> & { kind?: RuntimeSubagent["kind"] }
): RosterStatusVisual {
  if (isActiveSubagentStatus(agent.status)) {
    if (agent.kind === "loop") return { tone: "info", label: "Scheduled", pulse: false };
    if (agent.kind === "goal") return { tone: "info", label: "Active", pulse: true };
  }
  return rosterStatusVisual(agent.status);
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
