/**
 * The roster's kind-aware counts and labels (spec §7.6).
 *
 * A background shell is listed in the roster on purpose — the deliberate
 * difference from T3, which keeps shells in the work log — so the roster has
 * two kinds of row, and every number it prints must say which kind it
 * counted: "5 agents" for four subagents and one background command was a lie
 * about what the user had running (owner report, 2026-09-22). Pure, so the
 * folded summary, the section caption and the footer cannot drift apart.
 */

import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import { isActiveSubagentStatus } from "../../../lib/agent-chat/roster.logic";

export interface RosterKindCounts {
  /** Subagents and workflow rows — everything that is not a shell. */
  agents: number;
  /** Background commands (`agentKind: "background"`). */
  shells: number;
  /** Agents in one of the three in-flight statuses. */
  liveAgents: number;
  /** Shells still running. */
  liveShells: number;
}

export function rosterKindCounts(
  rows: readonly Pick<RuntimeSubagent, "agentKind" | "status">[]
): RosterKindCounts {
  const counts: RosterKindCounts = { agents: 0, shells: 0, liveAgents: 0, liveShells: 0 };
  for (const row of rows) {
    const live = isActiveSubagentStatus(row.status);
    if (row.agentKind === "background") {
      counts.shells += 1;
      if (live) counts.liveShells += 1;
    } else {
      counts.agents += 1;
      if (live) counts.liveAgents += 1;
    }
  }
  return counts;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The folded roster's one line: `4 agents · 1 shell running`.
 *
 * Shells say whether they still run because that is the one thing a folded
 * roster hides that the user may be waiting on; agents do not, because the
 * footer beside this label already counts the working ones.
 */
export function collapsedRosterLabel(counts: RosterKindCounts): string {
  const parts: string[] = [];
  if (counts.agents > 0) parts.push(plural(counts.agents, "agent"));
  if (counts.shells > 0) {
    const shells = plural(counts.shells, "shell");
    if (counts.liveShells === 0) parts.push(shells);
    else if (counts.liveShells === counts.shells) parts.push(`${shells} running`);
    else parts.push(`${shells} (${counts.liveShells} running)`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Agents";
}

/** The unfolded roster's toggle label: what the list is a list of. */
export function expandedRosterLabel(counts: RosterKindCounts): string {
  if (counts.agents === 0 && counts.shells > 0) return counts.shells === 1 ? "Shell" : "Shells";
  return "Agents";
}

/** The caption above the shell rows, and how many of them still run. */
export function shellSectionLabel(counts: RosterKindCounts): { title: string; detail: string | null } {
  return {
    title: counts.shells === 1 ? "Shell" : "Shells",
    detail: counts.liveShells > 0 ? `${counts.liveShells} running` : null
  };
}

/**
 * Split rendered rows by kind **without reordering either kind**: the agents
 * keep their spawn order above, the shells keep theirs below. The partition is
 * by a property that never changes, so a status change never moves a row
 * between the two lists (§7.6 "never reshuffle rows that stay visible").
 */
export function partitionRosterRows<T extends { agent: Pick<RuntimeSubagent, "agentKind"> }>(
  rows: readonly T[]
): { agentRows: T[]; shellRows: T[] } {
  const agentRows: T[] = [];
  const shellRows: T[] = [];
  for (const row of rows) {
    (row.agent.agentKind === "background" ? shellRows : agentRows).push(row);
  }
  return { agentRows, shellRows };
}
