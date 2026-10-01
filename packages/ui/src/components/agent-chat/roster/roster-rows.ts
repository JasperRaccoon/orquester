/** Roster selection and status visuals. Active rows lead; settled rows fade after the turn. */

import type { RuntimeSubagent, RuntimeSubagentStatus } from "@orquester/api/agent-chat";
import {
  deriveRosterDockView,
  isActiveSubagentStatus,
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

/**
 * Active rows first, then first observation, with ties broken by input order.
 * Invalid timestamps retain input order within the same liveness group.
 */
function rosterDisplayOrder(
  agents: readonly RuntimeSubagent[]
): RuntimeSubagent[] {
  return agents
    .map((agent, index) => ({ agent, index, at: Date.parse(agent.firstSeenAt) }))
    .sort((left, right) => {
      const liveDifference = Number(isActiveSubagentStatus(right.agent.status)) - Number(isActiveSubagentStatus(left.agent.status));
      if (liveDifference !== 0) return liveDifference;
      if (!Number.isNaN(left.at) && !Number.isNaN(right.at) && left.at !== right.at) {
        return left.at - right.at;
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
 * Keep the shared selector's survivors in display order. During the fading
 * phase, finished rows retain their slots until the exit transition ends.
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
    rows.push({
      agent,
      fading: isTerminalSubagentStatus(agent.status) && input.finished === "fading"
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
