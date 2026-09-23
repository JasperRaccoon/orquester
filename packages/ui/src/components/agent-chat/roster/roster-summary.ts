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
 * The roster's count line: `4 agents (2 working) · 1 shell (1 running)`.
 */
export function rosterCountLabels(counts: RosterKindCounts): {
  agents: string | null;
  working: string | null;
  shells: string | null;
  running: string | null;
} {
  return {
    agents: counts.agents > 0 ? plural(counts.agents, "agent") : null,
    working: counts.liveAgents > 0 ? `${counts.liveAgents} working` : null,
    shells: counts.shells > 0 ? plural(counts.shells, "shell") : null,
    running: counts.liveShells > 0 ? `${counts.liveShells} running` : null
  };
}

export function collapsedRosterLabel(counts: RosterKindCounts): string {
  const labels = rosterCountLabels(counts);
  const parts: string[] = [];
  if (labels.agents) parts.push(labels.agents + (labels.working ? ` (${labels.working})` : ""));
  if (labels.shells) parts.push(labels.shells + (labels.running ? ` (${labels.running})` : ""));
  return parts.length > 0 ? parts.join(" · ") : "Agents";
}

/** A kind-only title for callers that need one instead of the count line. */
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
 * Split rendered rows by kind. The selection has already put active rows
 * first; this keeps that order within the agent and shell sections.
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
